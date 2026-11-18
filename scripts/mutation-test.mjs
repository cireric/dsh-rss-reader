/**
 * 变异测试：把已经修好的关键判定**逐个改坏**，看测试套件是否见红。
 *
 * 为什么值得固化：这次评审里最有价值的产出不是「测试全绿」，而是**量出了绿的可信边界**——
 * 只断言 store 的客户端测试让三条接线变异全部幸存（P1-5 之前）；正文缓存闸门因为喂的是废弃的
 * 数据形态而永不触发（P0-3 之前）。这两类问题「跑测试」发现不了，只有「改坏它看有没有人喊」
 * 才能发现。
 *
 * 用法：npm run mutation（需先 npm run build + npm run build:client —— 改的是 lib/ 产物）。
 * 判据：**每一条变异都必须被抓到**；有幸存者就以非零码退出，并指出是哪条漏了。
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, mkdtempSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execSync, execFileSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import os from 'node:os'
import path from 'node:path'
import { MUTATIONS } from './mutation/table.mjs'

const ROOT = process.cwd()

/**
 * 每条只改一处。刻意**不含等价变异** —— 例如 selectArticleEvictions 里把 total 与上限的
 * 比较从小于等于改成小于：两者在相等时的返回值同为「不清」，行为完全相同，它幸存不是测试
 * 缺口。等价变异混进来会让这道门槛变成狼来了。
 */
// ── 函数化 + 并行化（2026-10-15 变异测试提速，杠杆 B；spec docs/mutation-test-speedup-plan.md）──
// 为什么：原实现是顶层直跑、串行 + 每次全量（138 条 ≈ 14.6min）。提速三杠杆（分层 perf gate /
// 并行 worker / judges 反查）需要同一套判定逻辑服务多条路径，所以拆成下面的可复用函数；
// MUTATIONS 表与崩溃分类器的判定逐字保留（分类器三坑注释原样随迁，改任一条都要重跑）。

// 终审 C1（2026-10-15 实测挂死 40+ 分钟，K=4 干净复跑零推进）：套件与 worker 都必须有时限——
// 否则任一套件在负载下卡死 = 整个门槛无输出、无退出码地永久挂死。
const SUITE_TIMEOUT_MS = 120_000        // 单次套件墙钟上限（正常 ≈7s；超时 ⇒ 判定无效记「套件超时」）
const WORKER_BUDGET_MS = 15 * 60_000    // 单个 worker 总预算（正常全量 ≈4min；超时强制回收并 sweep）

// ── 宿主资源闸（2026-10-18 整机死机排障轮）────────────────────────────────────────
// 为什么：这条门槛的**进程数**从来没有上限，而它是本仓库唯一会把整机拖垮的东西。
// 实测（M4 / 16 GB / 10 核）：K=6 时峰值 ≈ 1 主进程 + 6 worker 线程 +
// 6 × (1 runner + node --test 的文件级并发上限 availableParallelism()=10) ≈ 60 个 node 进程；
// 每个测试子进程默认堆上限 4288 MB（NODE_OPTIONS 有没有都一样），而本机 vm.swapusage = 0
// （/System/Volumes/VM 无 swapfile）⇒ 需求一旦超过物理内存就是直接进 compressor 争抢，
// 没有磁盘缓冲垫。历史现场：2026-10-16 一晚 14 个 JetsamEvent（reason=vm-compressor-space-shortage、
// largestProcess=node），紧接 00:24 一次 panic + shutdown stall。
// ⇒ 三道闸，都只压「上限」不压「按需」（单套件实测峰值仅 332 MB，正常路径完全够用）：
//   ① worker 数随核数与内存收敛（不再固定 6）；
//   ② 套件内的文件级并发封顶（默认 10 降到 3，实测单套件 7s→8s，可忽略）；
//   ③ 每个套件子进程带堆上限 —— 超限由 V8 自己 abort（可诊断、可重跑），
//      而不是让它一路涨到整机 compressor 崩掉（那才是「死机」的形态）。
const HOST_CPUS = os.availableParallelism()
const HOST_GB = os.totalmem() / 1024 ** 3
const SUITE_CONCURRENCY = Math.max(2, Math.min(4, Math.floor(HOST_CPUS / 3)))
const SUITE_HEAP_MB = 1024
// 低内存看门狗：可用内存低于此值即强制回收全部 worker（宁可本轮判定无效，也不让整机进死亡螺旋）
const HOST_FLOOR_MB = 512
function defaultWorkers() {
  return Math.max(1, Math.min(6, Math.floor(HOST_CPUS / 3), Math.floor(HOST_GB / 4)))
}
// 可用内存（MB）。⚠️ 不能用 os.freemem()：macOS 上它只数 Pages free（实测 1546 MB，
// 而 free+inactive 是 5319 MB）—— 空闲内存大半躺在 inactive/file cache 里，
// 按 Pages free 设水位会在套件刚起步时就误触发（实测首轮门真的把 138 条全判成「崩了」）。
function hostFreeMB() {
  try {
    const stat = execSync('vm_stat', { encoding: 'utf8', timeout: 5000 })
    const pageSize = Number(/page size of (\d+)/.exec(stat)?.[1] ?? 16384)
    const pages = (label) => Number(new RegExp(label + ':\\s+(\\d+)').exec(stat)?.[1]?.replace(/\./g, '') ?? 0)
    return Math.round((pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * pageSize / 1048576)
  } catch {
    // vm_stat 起不来（非 macOS / 沙箱拒绝）⇒ 无从判断水位，退回「不干预」：宁可少一道闸，
    // 也不许把整轮判定误伤成「崩了」。
    return Number.POSITIVE_INFINITY
  }
}

// 「跑一次套件」。root 参数化（隔离副本跑副本、源目录跑基线）。
// spec 省缺 = 全量内环 glob；{ files } = 只跑这些文件；{ files, patterns } 再叠加测试名过滤（P1）。
// 为什么把测试名过滤放在这一层：runSuite 是 gate / fast / 基线三条路径共用的唯一执行点，
// 过滤只有落在这里，才不会出现「gate 跑一套、fast 跑另一套」的双份语义。
function runSuite(root, spec) {
  const files = spec?.files
  // 测试名过滤（P1）：judgeTests 是**子串**，node 的 --test-name-pattern 按正则吃，所以逐个转义。
  const patterns = (spec?.patterns ?? []).map((name) => String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  // 显式文件列表：不经过 shell，就没有引号转义这一层（测试名里有 ：+ ? ( ) 这些字符）。
  const targets = files ?? readdirSync(path.join(root, "tests")).filter((name) => name.endsWith(".test.mjs")).sort().map((name) => "tests/" + name)
  const argv = ["--test", "--test-concurrency=" + SUITE_CONCURRENCY]
  for (const pattern of patterns) argv.push("--test-name-pattern=" + pattern)
  argv.push(...targets)
  // 子进程显式带上堆上限：NODE_OPTIONS 会被 execSync → node → node --test 三层原样继承
  // （实测：父设 512 时孙进程 heap_size_limit 也是 704 MB）。继承来的堆上限必须先**摘掉**再追加——
  // 只靠「后面的覆盖前面的」虽然实测有效（4096+1024 ⇒ 1216 MB），但那依赖 V8 的取值次序，太脆。
  const inherited = (process.env.NODE_OPTIONS ?? '').replace(/--max-old-space-size=\d+/g, '').trim()
  const nodeOptions = (inherited + ' --max-old-space-size=' + SUITE_HEAP_MB).trim()
  try {
    const out = execFileSync(process.execPath, argv, { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, timeout: SUITE_TIMEOUT_MS, env: { ...process.env, NODE_OPTIONS: nodeOptions } })
    return { ok: true, out: out }
  } catch (error) {
    // 超时（SIGTERM 杀）也是「判定无效」：分类器见 timeout 标志记 crashed——红 ≠ 被抓住。
    // ⚠️ signal 要排除 null：正常非零退出的 error.signal 是 null 而不是 undefined（实测踩过：
    //    判式写成 !== undefined 时每一条正常的套件红都被误判成「套件超时」，138 条全 crashed）
    return { ok: false, timeout: error.killed === true || Boolean(error.signal), out: String(error.stdout || '') + String(error.stderr || '') }
  }
}

// 分类器：原 :1009-1023 逐字搬入（含三坑注释）。res.ok 参与 caught/survived 的区分，故入参是 res。
function classify(res, m) {
  if (res.timeout) return 'crashed'
  const mutatedFile = m.file.split('/').pop()
  const outLines = res.out.split('\n')
  // ⚠️ `\\s+`（不是 `\\s*`）：见上面 ② 的两种列 0 形状。
  const errorAt = outLines.findIndex((line) => /^\s+(ReferenceError|SyntaxError):/.test(line))
  const stackMentionsMutatedFile = errorAt >= 0 && outLines
    .slice(Math.max(0, errorAt - 6), errorAt + 7)
    .some((line) => line.includes(mutatedFile))
  if (errorAt >= 0 && stackMentionsMutatedFile) return 'crashed'
  return res.ok ? 'survived' : 'caught'
}

// 崩溃错误名（打印用，与 classify 同一条错误行正则）。
function crashName(res) {
  if (res.timeout) return res.deterministic === true ? '套件超时（确定性：重试仍超时）' : '套件超时'
  const hit = res.out.split('\n').find((line) => /^\s+(ReferenceError|SyntaxError):/.test(line))
  return (hit && hit.match(/\b(ReferenceError|SyntaxError)\b/) || [])[1] || '未知'
}

// 翻红 → 测试文件基名（去重排序）。gate 校准与 fast 消费同一份口径。
// 实测（2026-10-15 scratch 失败用例）：reporter 的 ✖ 行印的是**测试名**不是文件名；
// 文件名印在紧邻的「test at tests/…」行（失败汇总里在其上方 1 行）与断言栈帧里
// （file:///…/tests/foo.test.mjs:4:10）。⇒ 对每个 ✖ 行在 ±6 行窗口内就近找 tests/*.test.mjs
// 引用，先上后下（汇总节的 at 行在上；就地节的栈帧在下）。
function judgesFromFails(out) {
  const lines = out.split('\n')
  const judges = new Set()
  lines.forEach((line, i) => {
    if (!/^\s*✖/.test(line)) return
    for (let d = 1; d <= 6; d++) {
      for (const j of [i - d, i + d]) {
        if (j < 0 || j >= lines.length) continue
        const m = lines[j].match(/tests\/([\w.-]+\.test\.mjs)/)
        if (m) { judges.add(m[1]); d = 7; break }
      }
    }
  })
  return [...judges].sort()
}

// 隔离副本骨架（docs/pitfalls.md §1.3：变异门槛绝不在源目录改 lib/）。
// 副本必须忠实于「测试可见面」（两条实测教训，2026-10-15 校准轮）：
//   · node_modules——tests/lib import zod 等第三方包，缺了假红；
//   · src/——article.test.mjs:254 与 client-bundle.test.mjs:266 直接读源树文件
//     （抽取版本守护、产物 mtime 新鲜度），缺了这两个用例对**任何**变异都翻红，
//     快照里 138 条全部带噪声（探针：keys 变异下两用例必炸，非断言看见缺陷）。
// .git / .worktrees 不拷（worktree 里是整份检出副本，拷了既慢又可能级联）。
function seedWorkerCopy(workerRoot) {
  // .gitignore 也在清单里：tests/mutation-runner.test.mjs 会读它（P2 的缓存文件必须不入 VCS），
  // 副本少这一份 ⇒ 副本基线红 ⇒ 全部门槛记「判定无效」（2026-11-15 实测踩到）。
  for (const entry of ['lib', 'tests', 'scripts', 'src', 'node_modules', 'package.json', '.gitignore']) {
    cpSync(path.join(ROOT, entry), path.join(workerRoot, entry), { recursive: true, preserveTimestamps: true })
  }
}

// 应用一条变异（原 :953-963 的逐条子逻辑）。ok:false = 「未应用」——比幸存更隐蔽（pitfalls 二、2.7）。
//
// `from` 必须**恰好**命中一次：`String.replace` 只替换第一处，命中多处时变异会落到别的副本上，
// 测试红不红都不再证明条目标的那条判定（2026-11-17 复核发现 5 条旧锚点命中 2–3 处）。
// 这里把「唯一定位」变成硬前提，宁可报未应用，也不让一条模糊变异冒充证据。
function applyMutation(root, m) {
  const target = path.join(root, m.file)
  const original = readFileSync(target, 'utf8')
  if (original.split(m.from).length - 1 !== 1) return { ok: false, original }
  const mutated = original.replace(m.from, m.to)
  writeFileSync(target, mutated)
  return { ok: true, original }
}

// 大头在前：同文件条目经排序后轮转均分 ⇒ 任何单 worker 都不会独吞整个 client 族（50 条是大头）。
const FILE_PREFIXES = ['lib/client.js', 'lib/store-sqlite.js', 'lib/refresh.js', 'lib/keys.js',
  'lib/retention.js', 'lib/store.js', 'lib/endpoints.js', 'lib/lifecycle.js', 'lib/identity-repair.js',
  'lib/feed/', 'lib/storage/', 'lib/article.js', 'lib/list-scroll.js', 'lib/index.js',
  'lib/domain.js', 'lib/shared.js', 'lib/subscribe.js', 'lib/config.js']
function partitionMutations(mutations, n) {
  const rank = (file) => { const i = FILE_PREFIXES.findIndex((p) => file.startsWith(p)); return i === -1 ? FILE_PREFIXES.length : i }
  const sorted = [...mutations].sort((a, b) => rank(a.file) - rank(b.file))
  return Array.from({ length: n }, () => []).map((_, i) => sorted.filter((__, j) => j % n === i))
}

// worker 侧脚本：把主进程的 runSuite / classify / applyMutation / crashName **函数源码序列化**进去
// （Function.prototype.toString）——三条路径共用同一份实现，worker 里不维护第二份判定逻辑。
// 结果用 postMessage 回传；worker 内任何异常都记成 crashed，不许静默吞掉一条变异。
function buildWorkerScript(workerRoot, mutations) {
  return `
const { execFileSync } = require('node:child_process')
const { readFileSync, writeFileSync, existsSync, readdirSync } = require('node:fs')
const path = require('node:path')
const { parentPort } = require('node:worker_threads')
const root = ${JSON.stringify(workerRoot)}
// 时限常量随函数一起序列化（C1 修复轮实测：runSuite 引用而模板缺失 ⇒ worker 里 ReferenceError
// 被 runSuite 的 try/catch 吞成 ok:false ⇒ 基线卫兵判「副本基线红」——卫兵拦下了它，但不能靠它兜）
const SUITE_TIMEOUT_MS = ${JSON.stringify(SUITE_TIMEOUT_MS)}
const WORKER_BUDGET_MS = ${JSON.stringify(WORKER_BUDGET_MS)}
const SUITE_CONCURRENCY = ${JSON.stringify(SUITE_CONCURRENCY)}
const SUITE_HEAP_MB = ${JSON.stringify(SUITE_HEAP_MB)}
const mutations = ${JSON.stringify(mutations)}
const runSuite = ${runSuite.toString()}
const classify = ${classify.toString()}
const crashName = ${crashName.toString()}
const judgesFromFails = ${judgesFromFails.toString()}
const applyMutation = ${applyMutation.toString()}
// 副本基线卫兵：副本不忠实（如 mtime 反超让 client-bundle:265 必红）⇒ 每条变异的套件必红 ⇒
// 「幸存 0」就是空洞判据。基线红 ⇒ 本副本全部变异记 worker_error，主进程计入失败清单。
// P1（gate 调优轮）：变异只被**它自己的 judges** 审 —— 与 fast 通道同一语义。
// 为什么这是正解而不是优化：全量 glob 让「一条 judge 挂死/变慢」污染 worker 里全部变异的判定
//（helpOpen/Esc 的 scroll-dom 挂死形态拖过 120s 悬崖的现场），也让 fast 绿 ≠ gate 绿。
// 保守回落：judges 缺失（漂移）⇒ 回落全量 —— 判据变窄比判定无效更危险，漂移兜底交给
// 主进程的「未应用」通道与 mutation:calibrate。
// 判据入口：judges（文件级，权威）+ 可选 judgeTests（测试名子串，P1 的细化）。
// 漂移兜底与以前一致：judges 缺失或指向不存在的文件 ⇒ 回落全量。
// judgeTests 缺失/为空 ⇒ 整文件（老行为）；有则交给 runSuite 走 --test-name-pattern。
function judgeSpec(m) {
  const declared = [...new Set(m.judges ?? [])]
  if (declared.length === 0) return undefined
  const files = declared.filter((f) => existsSync(path.join(root, 'tests', f)))
  if (files.length !== declared.length) return undefined
  const patterns = (m.judgeTests ?? []).filter((name) => typeof name === 'string' && name.length > 0)
  if (patterns.length === 0) return { files: files.map((f) => 'tests/' + f), patterns: [], drift: false }
  // 漂移校验必须在跑之前做：node --test 在「pattern 一条都没匹配上」时**照样报 pass**
  // （它把文件本身算成一条通过的测试，实测 tests=1 / pass=1），所以靠输出识别不出来。
  // 判据取「名字字面量是否还在这些 judge 文件里」—— 改名/删除都会当场被抓到。
  const sources = files.map((f) => readFileSync(path.join(root, 'tests', f), 'utf8'))
  const missing = patterns.filter((name) => !sources.some((src) => src.includes("test('" + name + "'") || src.includes('test("' + name + '"')))
  if (missing.length > 0) return { files: files.map((f) => 'tests/' + f), patterns: [], drift: true, missing }
  return { files: files.map((f) => 'tests/' + f), patterns, drift: false }
}
const base = runSuite(root)
if (!base.ok) {
  for (const m of mutations) parentPort.postMessage({ id: m.id, status: 'worker_error', crash: '副本基线红', fails: [], judges: [] })
} else for (const m of mutations) {
  try {
    const applied = applyMutation(root, m)
    if (!applied.ok) { parentPort.postMessage({ id: m.id, status: 'unapplied' }); continue }
    const spec = judgeSpec(m)
    let res
    let narrowed = false
    const startedAt = Date.now()
    try {
      res = runSuite(root, spec)
      // 测试名漂移兜底（P1）：judgeSpec 在跑之前已经校验过名字还在不在。
      // 名字找不到 ⇒ 退回整文件（老语义），并在输出里点名缺了哪条 —— 不许静默跳过。
      if (spec?.drift) {
        console.log('  · ' + m.id.padEnd(26) + ' → judgeTests 与测试文件漂移（缺：' + (spec.missing ?? []).join(' / ') + '），回退整文件')
      }
      narrowed = (spec?.patterns?.length ?? 0) > 0
      // P2（gate 调优轮）：超时重试一次 —— C4-a 实测过并行负载下的**偶发**假超时（2 条），
      // 与 C4-b 的**确定性**超时（jsdom×runner 挂死）必须区分：偶发重试即愈，确定性连超 2 次
      // 仍记 crashed 且文案标「确定性」，人工判读不再需要复跑排除。
      if (res.timeout) {
        console.log('  · ' + m.id.padEnd(26) + ' → 套件超时，重试一次…')
        res = runSuite(root, spec)
        if (res.timeout) res = { ...res, deterministic: true }
      }
    } finally { writeFileSync(path.join(root, m.file), applied.original) }
    const fails = res.out.split('\\n').filter((l) => /^\\s*✖/.test(l)).map((l) => l.trim().replace(/\\s*\\(\\d.*$/, ''))
    const judges = judgesFromFails(res.out)
    const verdict = classify(res, m)
    // 逐条回传即打印（终审 C1 教训：挂死 40 分钟零输出——进度必须实时可见；worker stdout 直通主进程）
    console.log('  · ' + m.id.padEnd(26) + ' → ' + verdict + '（' + (Date.now() - startedAt) + 'ms）')
    parentPort.postMessage(verdict === 'crashed' ? { id: m.id, status: 'crashed', crash: crashName(res), fails, judges, narrowed, ms: Date.now() - startedAt } : { id: m.id, status: verdict, fails, judges, narrowed, ms: Date.now() - startedAt })
  } catch (error) {
    parentPort.postMessage({ id: m.id, status: 'crashed', crash: 'worker 内异常：' + error.message, fails: [] })
  }
}
`
}

function runWorker(workerRoot, mutations) {
  return new Promise((resolve) => {
    const worker = new Worker(buildWorkerScript(workerRoot, mutations), { eval: true })
    const results = []
    let guardTimer
    const sweep = (why) => {
      clearTimeout(deadline)
      clearInterval(guardTimer)
      // worker 本体崩了（eval 失败 / 未捕获异常 / 非零退出 / 超预算）：没回传结果的变异全部记 crashed，不许静默丢
      for (const m of mutations) {
        if (!results.some((r) => r.id === m.id)) results.push({ id: m.id, status: 'crashed', crash: why, fails: [] })
      }
      resolve(results)
    }
    // worker 总预算（终审 C1 第二道网）：卡死的 worker 强制回收，由 sweep 收尾
    const deadline = setTimeout(() => { worker.terminate(); sweep('worker 超预算 ' + WORKER_BUDGET_MS + 'ms——强制回收') }, WORKER_BUDGET_MS)
    // 宿主资源闸（2026-10-18）：可用内存跌破底线就整体收手 —— 判定无效(refund)远好过整机进 compressor 死亡螺旋。
    // 为什么不在 runSuite 里判：单套件峰值实测仅 332 MB，真正会涨的是被留下继续跑的子进程树，
    // 只有主进程看得到全局（worker 之间互相看不见）。
    guardTimer = setInterval(() => {
      const free = hostFreeMB()
      if (free < HOST_FLOOR_MB) {
        worker.terminate()
        sweep('宿主可用内存 ' + free + 'MB < ' + HOST_FLOOR_MB + 'MB——强制回收保护整机')
      }
    }, 3000)
    worker.on('message', (r) => results.push(r))
    worker.on('error', (error) => sweep('worker 未捕获：' + error.message))
    worker.on('exit', (code) => { if (code !== 0) sweep('worker exit ' + code); else { clearTimeout(deadline); clearInterval(guardTimer); resolve(results) } })
  })
}

function parseArgs(argv) {
  // 默认 K 由宿主编译期约束算出（见 defaultWorkers）：旧口径固定 min(6, cpus-2) 在本机会给到 6，
  // 叠加 node --test 的文件级并发 10 ⇒ 约 60 个 node 进程，16 GB 无 swap 的机器扛不住。
  const args = { mode: 'gate', workers: defaultWorkers(), dumpJudges: undefined, only: undefined, changed: false, incremental: false, timings: undefined, meta: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--mode') args.mode = argv[++i]
    // ⚠️ 显式 --workers 必须**同样受资源闸约束**：它是绕过 defaultWorkers 的唯一入口，
    // 放任 `--workers 8` 就等于把整机重新推回「几十个 node × 4 GB 堆」的死亡螺旋。
    // 不静默改数：超上限时明确打印夹到多少（2026-10-18 自审轮实测抓到的洞）。
    else if (a === '--workers') {
      const asked = Number(argv[++i])
      const ceiling = defaultWorkers()
      args.workers = Math.max(1, Math.min(Number.isFinite(asked) ? asked : 1, ceiling))
      if (Number.isFinite(asked) && asked > ceiling) console.error('--workers ' + asked + ' 超过宿主资源闸上限 ' + ceiling + '，已夹到 ' + args.workers + '（保护整机）')
    }
    else if (a === '--dump-judges') args.dumpJudges = argv[++i] ?? true
    else if (a === '--changed') args.changed = true
    else if (a === '--timings') args.timings = argv[++i] ?? true
    else if (a === '--incremental') args.incremental = true
    else if (a === '--mutations') args.only = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean)
    else { console.error('未知参数: ' + a); process.exit(2) }
  }
  return args
}

// ── P2：增量模式（opt-in）────────────────────────────────────────────────
// 为什么默认关：gate 的判据是「这一轮真的把每条都改坏了一次」。缓存只服务开发内环
//（改一个文件后只重跑受影响的那几条），全量 gate 永远走完整路径（不传 --changed/--incremental）。
const CACHE_PATH = path.join(ROOT, '.mutation-cache.json')

// 脚本自身进 key：判定逻辑或条目改过，旧缓存必须整体失效。
function scriptVersion() {
  return createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex').slice(0, 16)
}

// src/x.ts → lib/x.js；src/client/** 整体产物是单文件 lib/client.js。
function libOfSource(file) {
  if (file.startsWith('src/client/')) return 'lib/client.js'
  const matched = /^src\/(.+)\.tsx?$/.exec(file)
  return matched === null ? undefined : 'lib/' + matched[1] + '.js'
}

// git 里的改动 → 受影响的变异。判据只有两条（用户裁决的口径）：
//   改了某个 lib 文件 → 跑该文件的全部变异；改了测试文件 → 让所有 judge 含该测试的变异失效。
// 其余（文档/AGENTS 等）不影响判据。
function affectedPredicate(files) {
  const libFiles = new Set()
  const testFiles = new Set()
  let all = false
  for (const file of files) {
    if (file.startsWith('lib/')) libFiles.add(file)
    else if (file.startsWith('tests/')) testFiles.add(file.split('/').pop())
    else if (file.startsWith('src/')) {
      const lib = libOfSource(file)
      if (lib === undefined) all = true
      else libFiles.add(lib)
    } else if (file === 'package.json' || file === 'scripts/mutation-test.mjs' || file === 'scripts/build.sh') all = true
  }
  return (m) => all || libFiles.has(m.file) || (m.judges ?? []).some((judge) => testFiles.has(judge))
}

function gitChangedFiles() {
  try {
    const tracked = execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const lines = (tracked + String.fromCharCode(10) + untracked).split(String.fromCharCode(10))
    return [...new Set(lines.map((line) => line.trim()).filter(Boolean))]
  } catch (error) {
    console.error('--changed 需要可用的 git：' + error.message)
    return undefined
  }
}

function sha256OfFile(file) {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'missing'
}

// key 至少含：变异 id / from / to / 目标文件内容 / judge 文件内容 / Node 主版本 / 脚本版本。
function mutationCacheKey(m, version) {
  const parts = [m.id, m.file, m.from, m.to, process.versions.node.split('.')[0], version, sha256OfFile(path.join(ROOT, m.file))]
  for (const judge of [...new Set(m.judges ?? [])].sort()) parts.push(judge + ':' + sha256OfFile(path.join(ROOT, 'tests', judge)))
  return createHash('sha256').update(parts.join(String.fromCharCode(0))).digest('hex')
}

function loadCache() {
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
    return raw !== null && typeof raw === 'object' && typeof raw.entries === 'object' ? raw : { entries: {} }
  } catch {
    // 缓存损坏/不存在都退回空缓存：它是加速件，不是判据（entries 为空 ⇒ 全部重跑）
    return { entries: {} }
  }
}

function saveCache(cache) {
  // 只缓存 caught：survived / crashed / unapplied 永远重跑（它们本来就该让 gate 红）。
  writeFileSync(CACHE_PATH, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), entries: cache.entries }, null, 2) + String.fromCharCode(10))
}
// ── 耗时报表（opt-in，--timings <file>）──────────────────────────────────
// 为什么要它：门槛快下去之后，「下次改动会不会又变慢」只能靠**趋势**回答。
// 报表记的是每条变异的墙钟与分档（<=300ms / 300ms–1s / >=1s）——
// 优化空间几乎总在「>=1s 的那几条占了多少比例」这个数上，而不是平均值。
function writeTimings(file, results, wallMs, workers) {
  const rows = results
    .filter((r) => typeof r.ms === 'number')
    .map((r) => ({ id: r.id, ms: r.ms, status: r.status, narrowed: r.narrowed === true }))
    .sort((a, b) => b.ms - a.ms)
  const totalMs = rows.reduce((acc, r) => acc + r.ms, 0)
  const slow = rows.filter((r) => r.ms >= 1000)
  const slowMs = slow.reduce((acc, r) => acc + r.ms, 0)
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.versions.node,
    workers,
    wallMs,
    mutationMs: totalMs,
    count: rows.length,
    slowCount: slow.length,
    slowShare: totalMs === 0 ? 0 : Math.round((slowMs / totalMs) * 100),
    narrowedCount: rows.filter((r) => r.narrowed).length,
    etaSecondsByWorkers: Object.fromEntries([1, 2, 3, 4].map((n) => [n, Math.round(totalMs / n / 1000)])),
    slowest: rows.slice(0, 15),
  }
  writeFileSync(file, JSON.stringify(report, null, 2) + String.fromCharCode(10))
  console.log('')
  console.log('耗时报表已写入 ' + file + '（' + rows.length + ' 条，合计 ' + (totalMs / 1000).toFixed(1) + 's，墙钟 ' + (wallMs / 1000).toFixed(1) + 's）')
  console.log('  >=1s 的 ' + slow.length + ' 条占了 ' + report.slowShare + '%：')
  for (const r of slow.slice(0, 8)) console.log('    ' + String(r.ms).padStart(6) + 'ms  ' + r.id)
  console.log('  按当前分布估算（不含基线）：1 worker ≈ ' + report.etaSecondsByWorkers[1] + 's · 2 ≈ ' + report.etaSecondsByWorkers[2] + 's · 3 ≈ ' + report.etaSecondsByWorkers[3] + 's')
}

// 汇总（原 :1032-1040 的判定与文案逐字保留；applied 口径 = 除「未应用」外全部计入，同原实现）。
function collectResults(results) {
  const survivors = []
  let applied = 0
  let cached = 0
  for (const r of results) {
    if (r.status === 'unapplied') {
      console.log('  ?  ' + r.id.padEnd(26) + ' 未应用（产物里形状与预期不符，请同步更新本条）')
      survivors.push(r.id + '（未应用）')
    } else if (r.status === 'crashed') {
      applied += 1
      console.log('  !  ' + r.id.padEnd(26) + ' 崩了（' + (r.crash || '未知') + '：变异 `to` 自己写错了，不算被抓住 —— 请改 `to`）')
      survivors.push(r.id + '（崩了：' + (r.crash || '未知') + '）')
    } else if (r.status === 'worker_error') {
      applied += 1
      console.log('  !  ' + r.id.padEnd(26) + ' 副本基线红（判定无效——先修副本忠实化，重跑门槛）')
      survivors.push(r.id + '（副本基线红）')
    } else if (r.status === 'cached') {
      // 缓存命中：**独立计数**，既不进 applied，也不进 survivors ——
      // 它证明的是「这条以前被抓到过」，不是「本轮抓到了」。两者混在一起就是伪绿。
      cached += 1
    } else if (r.status === 'survived') {
      applied += 1
      console.log('  x  ' + r.id.padEnd(26) + ' 幸存（套件仍然全绿）')
      survivors.push(r.id)
    } else {
      applied += 1
      console.log('  v  ' + r.id.padEnd(26) + ' 被抓到（' + (r.fails?.length ?? 0) + ' 条翻红：' + (r.fails?.[0] || '').slice(0, 44) + '）')
    }
  }
  return { applied, survivors, cached }
}

// judges 快照落盘（杠杆 A 前置）：gate 全量轮的实测翻红就是「哪些测试看着这条变异」的快照——
// fast 只跑这些文件的前提是快照采自 gate（gateRed ⊆ judges 由构造成立，spec §5）。
// crashed / survived / unapplied 不进快照：它们本来就令 gate exit 1，没有「看着谁」可言。
// 翻红用例名：worker 回传的是原始 ✖ 行（含 "✖ failing tests:" 表头、重复项、尾部耗时），
// 校准要的是「能直接当 --test-name-pattern 用的名字」，所以在这里统一清洗。
function cleanFails(raw) {
  const names = []
  for (const line of raw ?? []) {
    const name = String(line).replace(/^\s*✖\s*/, '').replace(/\s*\(\d+(\.\d+)?ms\)\s*$/, '').trim()
    if (name === '' || name === 'failing tests:' || names.includes(name)) continue
    names.push(name)
  }
  return names
}

function writeJudgesDump(file, results, selected) {
  const mutations = {}
  for (const r of results) {
    if (r.status !== 'caught') continue
    const m = selected.find((x) => x.id === r.id)
    mutations[r.id] = { file: m ? m.file : '', judges: r.judges ?? [], judgeTests: m?.judgeTests ?? [], fails: cleanFails(r.fails) }
  }
  writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), suiteGlob: 'tests/*.test.mjs', mutations }, null, 2))
  console.log('judges 快照已写入 ' + file + '（' + Object.keys(mutations).length + ' 条）')
}

// 退出码契约（spec §0）：gate 干净=0 / gate 失败=1 / 基线红=2；fast 一律非 0——全抓到=3、
// 有任何非抓到=4。fast 通过 ≠ gate 通过：fast 是建议通道，只有 gate 干净才允许 exit 0。
function exitCodeFor(mode, ok) {
  return mode === 'fast' ? (ok ? 3 : 4) : (ok ? 0 : 1)
}

// fast 内环（杠杆 A）：judges 是 gate 轮的快照，只跑每条变异真正翻红的文件并集。
// 漂移兜底（spec §7）：judges 缺失或指向不存在的文件 ⇒ 计「未应用」入失败清单，绝不静默跳过；
// 副本基线红 ⇒ 全部记失败，本轮不给出任何建议。结论只是建议，gate 永远权威。
async function runFast(args, selected) {
  const workerRoot = mkdtempSync(path.join(os.tmpdir(), 'mutation-fast-'))
  const results = []
  try {
    const sub = path.join(workerRoot, 'w0')
    mkdirSync(sub, { recursive: true })
    seedWorkerCopy(sub)
    const baseline = runSuite(sub)
    if (!baseline.ok) {
      console.error('fast：隔离副本基线红——副本或快照不可信，本轮不给出建议。')
      for (const m of selected) results.push({ id: m.id, status: 'crashed', crash: '副本基线红', fails: [], judges: [] })
    } else {
      console.log('fast：基线绿。只跑 judges 并集（' + selected.length + ' 条；建议通道，gate 永远权威）：')
      console.log('')
      for (const m of selected) {
        const declared = [...new Set(m.judges ?? [])]
        const files = declared.filter((f) => existsSync(path.join(sub, 'tests', f)))
        if (declared.length === 0 || files.length !== declared.length) {
          console.log('  ?  ' + m.id.padEnd(26) + ' judges 缺失或指向不存在的测试文件——计「未应用」（漂移兜底：重跑 mutation:calibrate）')
          results.push({ id: m.id, status: 'unapplied', fails: [], judges: [] })
          continue
        }
        const applied = applyMutation(sub, m)
        if (!applied.ok) {
          console.log('  ?  ' + m.id.padEnd(26) + ' 未应用（产物里形状与预期不符，请同步更新本条）')
          results.push({ id: m.id, status: 'unapplied', fails: [], judges: [] })
          continue
        }
        let res
        const patterns = (m.judgeTests ?? []).filter((name) => typeof name === 'string' && name.length > 0)
        try { res = runSuite(sub, { files: files.map((f) => 'tests/' + f), patterns }) } finally { writeFileSync(path.join(sub, m.file), applied.original) }
        const fails = res.out.split('\n').filter((l) => /^\s*✖/.test(l)).map((l) => l.trim().replace(/\s*\(\d.*$/, ''))
        const verdict = classify(res, m)
        const redJudges = judgesFromFails(res.out).filter((j) => files.includes(j))
        const mark = verdict === 'caught' ? 'v' : verdict === 'crashed' ? '!' : 'x'
        const label = verdict === 'caught'
          ? '被 ' + (redJudges.join('、') || '未知文件') + ' 翻红（' + fails.length + ' 条）'
          : verdict === 'crashed'
            ? '崩了（' + crashName(res) + '：变异 `to` 自己写错了，不算被抓住）'
            : '幸存（judges 文件全绿——建议仅供参考，以 gate 为准）'
        console.log('  ' + mark + '  ' + m.id.padEnd(26) + ' ' + label)
        results.push({ id: m.id, status: verdict, fails, judges: redJudges })
      }
    }
  } finally {
    rmSync(workerRoot, { recursive: true, force: true })
  }
  const applied = results.filter((r) => r.status !== 'unapplied').length
  const survivors = results
    .filter((r) => r.status !== 'caught')
    .map((r) => r.id + (r.status === 'unapplied' ? '（未应用）' : r.status === 'crashed' ? '（崩了：' + (r.crash || '') + '）' : ''))
  console.log('')
  console.log('应用 ' + applied + '/' + selected.length + ' 条 · 幸存 ' + survivors.length + ' 条（fast 退出码恒非 0——fast 通过 ≠ gate 通过）')
  if (survivors.length > 0) console.error('幸存清单：' + survivors.join('、'))
  process.exitCode = exitCodeFor('fast', survivors.length === 0)
}

async function main() {
  const runStartedAt = Date.now()
  const args = parseArgs(process.argv.slice(2))
  let selected = args.only ? MUTATIONS.filter((m) => args.only.includes(m.id)) : MUTATIONS
  if (selected.length === 0) { console.error('--mutations 没匹配到任何条目'); process.exitCode = 2; return }
  // P2（opt-in）：--changed 只跑受影响的那几条；--incremental 允许复用缓存里的 caught 结论。
  // 两者都不传 = 全量 gate 的原路径（完全不知道缓存存在）。
  const useCache = args.changed || args.incremental
  if (args.changed) {
    const changed = gitChangedFiles()
    if (changed === undefined) { process.exitCode = 2; return }
    const predicate = affectedPredicate(changed)
    selected = selected.filter(predicate)
    console.log('--changed：' + changed.length + ' 个改动文件 → 命中 ' + selected.length + ' 条变异')
    if (selected.length === 0) { console.log('没有受影响的变异（改动的文件不进判据）。'); return }
  }
  if (args.mode === 'fast') { await runFast(args, selected); return }
  if (args.mode !== 'gate') { console.error('--mode ' + args.mode + ' 不认识（gate | fast）'); process.exitCode = 2; return }

  const baseline = runSuite(ROOT)
  if (!baseline.ok) {
    console.error('基线不是绿的 —— 先修好再跑变异。')
    console.error(baseline.out.split('\n').filter((l) => /^\s*(✖|not ok)/.test(l)).slice(0, 5).join('\n'))
    process.exitCode = 2
    return
  }
  console.log('基线绿。逐条改坏关键判定，看套件是否见红：')
  console.log('')

  // 缓存命中在这时结算：只认 caught，其余一律重跑（survived/crashed/unapplied 不缓存）。
  let cachedResults = []
  let toRun = selected
  let cache = { entries: {} }
  if (useCache) {
    cache = loadCache()
    const version = scriptVersion()
    const residual = []
    for (const m of selected) {
      const key = mutationCacheKey(m, version)
      m.cacheKey = key
      if (cache.entries[key]?.status === 'caught') cachedResults.push({ id: m.id, status: 'cached', key })
      else residual.push(m)
    }
    toRun = residual
    console.log('缓存命中 ' + cachedResults.length + ' 条（不重跑，不计入本轮抓到）')
  }

  const workerRoot = mkdtempSync(path.join(os.tmpdir(), 'mutation-gate-'))
  let results
  try {
    // 全部命中缓存时不建 worker：连副本基线那一次都省掉（否则「零变更」还要跑一遍空集）。
    if (toRun.length === 0) {
      results = [...cachedResults]
    } else {
      const n = Math.max(1, Math.min(args.workers || 1, toRun.length))
      const buckets = partitionMutations(toRun, n)
      const running = []
      for (let i = 0; i < buckets.length; i++) {
        if (buckets[i].length === 0) continue
        const sub = path.join(workerRoot, 'w' + i)
        mkdirSync(sub, { recursive: true })
        seedWorkerCopy(sub)
        running.push(runWorker(sub, buckets[i]))
      }
      results = [...cachedResults, ...(await Promise.all(running)).flat()]
    }
  } finally {
    rmSync(workerRoot, { recursive: true, force: true })
  }

  // 打印顺序对齐 MUTATIONS 定义序（并行回传顺序不定）
  const order = new Map(selected.map((m, i) => [m.id, i]))
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  // 把 key 贴回结果（worker 不需要知道缓存的存在）：缓存落盘只认本轮真跑过的 caught。
  const keyById = new Map(selected.filter((m) => typeof m.cacheKey === 'string').map((m) => [m.id, m.cacheKey]))
  for (const r of results) if (keyById.has(r.id)) r.key = keyById.get(r.id)
  const { applied, survivors, cached } = collectResults(results)
  if (args.timings !== undefined) writeTimings(args.timings === true ? 'mutation-timings.json' : args.timings, results, Date.now() - runStartedAt, args.workers)
  if (args.dumpJudges !== undefined) writeJudgesDump(args.dumpJudges === true ? 'judges-dump.json' : args.dumpJudges, results, selected)

  // 落盘缓存：只收「本轮真的抓到」的那部分，且只收带 key 的（= 增量路径）。
  if (useCache) {
    const now = new Date().toISOString()
    for (const r of results) {
      if (r.status !== 'caught') continue
      if (typeof r.key !== 'string') continue
      cache.entries[r.key] = { status: 'caught', id: r.id, at: now }
    }
    saveCache(cache)
  }

  const after = runSuite(ROOT)
  console.log('')
  console.log('应用 ' + applied + '/' + selected.length + ' 条 · 幸存 ' + survivors.length + ' 条' +
    (useCache ? ' · 缓存命中 ' + cached + ' 条（未重跑，不计入本轮抓到）' : '') +
    ' · 恢复后基线 ' + (after.ok ? '仍然绿' : '没恢复干净！'))
  if (survivors.length > 0) {
    console.error('幸存清单：' + survivors.join('、'))
    console.error('-> 标「幸存」的是测试没覆盖到的判定（补一条会翻红的断言，或确认它是等价变异）；')
    console.error('   标「崩了」的：变异 `to` 自己写错了（ReferenceError / SyntaxError），那种红不算被抓住（docs/pitfalls.md 二、2.7b）。')
    process.exitCode = 1
    return
  }
  console.log('全部被抓到。')
}

main().then(() => process.exit(process.exitCode ?? 0))
