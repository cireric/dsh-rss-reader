/**
 * worker 池：隔离副本、逐条改坏、并行回传。
 *
 * worker 代码仍是**字符串 + eval**（`new Worker(script, { eval: true })`），用
 * Function.prototype.toString 把判定函数注入 —— 拆文件只搬位置，不换机制。
 * 为什么保留：换成真 worker 文件会改变加载方式与 `buildWorkerScript` 的契约，属于另一次改动；
 * 现在 worker 的「副本基线红」卫兵会抓住任何自由变量缺失（缺一个 require 就会当场红）。
 *
 * ⚠️ 被 toString 注入的函数必须自包含：自由变量只能来自模板里的 require 头与序列化常量。
 */
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { HOST_FLOOR_MB, ROOT, SUITE_CONCURRENCY, SUITE_HEAP_MB, SUITE_TIMEOUT_MS, WORKER_BUDGET_MS, hostFreeMB } from './host.mjs'
import { classify, crashName, judgesFromFails, runSuite } from './suite.mjs'

// 隔离副本骨架（docs/pitfalls.md §1.3：变异门槛绝不在源目录改 lib/）。
// 副本必须忠实于「测试可见面」（两条实测教训，2026-10-15 校准轮）：
//   · node_modules——tests/lib import zod 等第三方包，缺了假红；
//   · src/——article.test.mjs:254 与 client-bundle.test.mjs:266 直接读源树文件
//     （抽取版本守护、产物 mtime 新鲜度），缺了这两个用例对**任何**变异都翻红，
//     快照里 138 条全部带噪声（探针：keys 变异下两用例必炸，非断言看见缺陷）。
// .git / .worktrees 不拷（worktree 里是整份检出副本，拷了既慢又可能级联）。
export function seedWorkerCopy(workerRoot) {
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
export function applyMutation(root, m) {
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
export function partitionMutations(mutations, n) {
  const rank = (file) => { const i = FILE_PREFIXES.findIndex((p) => file.startsWith(p)); return i === -1 ? FILE_PREFIXES.length : i }
  const sorted = [...mutations].sort((a, b) => rank(a.file) - rank(b.file))
  return Array.from({ length: n }, () => []).map((_, i) => sorted.filter((__, j) => j % n === i))
}

// worker 侧脚本：把主进程的 runSuite / classify / applyMutation / crashName **函数源码序列化**进去
// （Function.prototype.toString）——三条路径共用同一份实现，worker 里不维护第二份判定逻辑。
// 结果用 postMessage 回传；worker 内任何异常都记成 crashed，不许静默吞掉一条变异。
export function buildWorkerScript(workerRoot, mutations) {
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

export function runWorker(workerRoot, mutations) {
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
