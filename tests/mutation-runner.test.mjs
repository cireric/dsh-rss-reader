import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

/**
 * 结构判据：入口 + scripts/mutation/ 下全部模块。
 *
 * 2026-11-18 拆分后这里不再读单文件——但**断言的内容不变**：它们守的是「别把资源闸 /
 * 超时 / 漂移兜底 / worker 预算删掉」，这些失效形态都**不会让任何行为用例变红**，
 * 只有结构判据挡得住（docs/pitfalls.md §1.10 / §2.13）。拆文件只改读取面，不改判据。
 */
const ENTRY = 'scripts/mutation-test.mjs'
const DIR = 'scripts/mutation'
const MODULES = readdirSync(DIR).filter((name) => name.endsWith('.mjs')).sort().map((name) => DIR + '/' + name)
const sources = [ENTRY, ...MODULES].map((file) => ({ file, text: readFileSync(file, 'utf8') }))
const src = sources.map((s) => s.text).join('\n\n')
const sourceOf = (file) => {
  const found = sources.find((s) => s.file === file)
  assert.ok(found, '缺模块: ' + file)
  return found.text
}

test('runner 已函数化且走 worker_threads', () => {
  for (const anchor of ["import { Worker } from 'node:worker_threads'", 'function parseArgs(', 'function runSuite(', 'function applyMutation(', 'function classify(', 'function collectResults(', 'function partitionMutations(', 'function buildWorkerScript(']) assert.ok(src.includes(anchor), '缺锚点: ' + anchor)
})
test('拆分后入口只留 CLI/装配：表与运行器都不许回流', () => {
  const entry = sourceOf(ENTRY)
  assert.ok(entry.includes('async function main()'), '入口必须仍是 CLI 入口')
  assert.ok(!entry.includes('function runSuite('), 'runSuite 不许回流入口（应在 suite.mjs）')
  assert.ok(!entry.includes('id: \'link-协议白名单失效\''), '1,956 行数据表不许回流入口（应在 table.mjs）')
  assert.ok(sourceOf('scripts/mutation/table.mjs').includes('export const MUTATIONS'), 'table.mjs 必须导出 MUTATIONS')
})
test('缓存版本必须枚举模块目录，不许只哈希入口', () => {
  const incremental = sourceOf('scripts/mutation/incremental.mjs')
  assert.ok(incremental.includes('RUNNER_FILES'), '缺 RUNNER_FILES（脚本版本的文件清单）')
  assert.ok(incremental.includes('readdirSync'), '缺目录枚举：新增模块必须自动进版本哈希')
  assert.ok(incremental.includes("file.startsWith('scripts/mutation/')"), '--changed 必须把整个模块目录算作「全部」')
})
test('隔离副本只拷必要目录、不拷 node_modules/.git/.worktrees', () => {
  assert.ok(src.includes("mkdtempSync(") && src.includes(".worktrees"))
})
test('gate 轮可回收 judges 快照（--dump-judges + mutation:calibrate 入口）', () => {
  assert.ok(src.includes('function writeJudgesDump('), '缺 writeJudgesDump')
  const pkg = readFileSync('package.json', 'utf8')
  assert.ok(pkg.includes('"mutation:calibrate"'), 'package.json 缺 mutation:calibrate')
})
test('fast 模式与退出码契约（fast 恒非 0；judges 漂移不静默）', () => {
  assert.ok(src.includes('function exitCodeFor('), '缺 exitCodeFor')
  assert.ok(src.includes('只跑 judges 并集'), '缺 fast 内环')
  assert.ok(src.includes('judges 缺失或指向不存在的测试文件'), '缺漂移兜底')
  assert.ok(src.includes('? 3 : 4') && src.includes('? 0 : 1'), '退出码契约形状不对')
})
test('副本忠实化：mtime 镜像 + 副本基线红必须使判定无效', () => {
  assert.ok(src.includes('preserveTimestamps: true'), '缺 preserveTimestamps（mtime 反超会让 client-bundle:265 对任何变异必红）')
  assert.ok(src.includes('副本基线红'), '缺 worker 副本基线卫兵')
})
test('套件挂死不许挂死门槛：execSync 时限 + worker 预算 + 逐条流式打印', () => {
  assert.ok(src.includes('SUITE_TIMEOUT_MS'), '缺套件时限（终审 C1 实测挂死 40+ 分钟）')
  assert.ok(src.includes('套件超时'), '缺超时判名')
  assert.ok(src.includes('worker 超预算'), '缺 worker 预算兜底')
  assert.ok(src.includes("'  · '"), '缺逐条回传即打印的可观测性')
})
test('宿主资源闸：并发/堆/内存水位都必须在脚本里（2026-10-18 整机死机轮）', () => {
  // 为什么钉这三处：它们不改变任何判定语义，改坏之后**套件照样全绿**，但门槛会重新变成
  // 「约 60 个 node 进程 × 每个 4 GB 堆上限」——那正是把整机拖进 compressor 死亡螺旋的形态。
  assert.ok(src.includes('--test-concurrency='), '缺套件内并发封顶（默认 10 会与 worker 数相乘）')
  assert.ok(src.includes("' --max-old-space-size=' + SUITE_HEAP_MB"), '缺子进程堆上限（NODE_OPTIONS 会被 execSync→node→node --test 三层继承）')
  // ⚠️ 必须钉**字面量**而不是前缀：本轮实测踩过 —— 模板字符串把 \d 吃成 d，正则变成
  // /--max-old-space-size=d+/ ⇒ 永远匹配不到东西、摘除静默失效。而「前缀存在」式断言在
  // 那个坏形态下照样绿（自审实测）⇒ 等于没钉住。
  assert.ok(src.includes('replace(/--max-old-space-size=\\d+/g'), '摘除正则必须逐字是 \\d+：转义写错一个字符就静默失效')
  assert.ok(src.includes('HOST_FLOOR_MB'), '缺宿主低内存看门狗')
  assert.ok(src.includes("function defaultWorkers()"), 'worker 数必须由宿主资源算出')
  assert.ok(!src.includes('os.cpus().length - 2'), 'worker 数不许退回固定 cpus-2（本机会给到 6）')
  // 显式 --workers 是绕过 defaultWorkers 的唯一入口，必须同样被夹（自审轮实测：旧实现里
  // `--workers 8` 畅通无阻，资源闸形同虚设）。
  assert.ok(src.includes('const ceiling = defaultWorkers()'), '--workers 必须受同一资源闸夹取')
})
test('P1：judgeTests 细化必须带「跑前漂移校验」，不许靠 pattern 静默跳过', () => {
  // 为什么钉这两处：node --test 在 pattern 一条都没匹配上时**照样报 pass**（实测：
  // `ℹ tests 1 / pass 1`，文件自身被算成一条通过的测试）⇒ 只靠输出识别不出 0 命中，
  // 失效形态就是「变异看起来幸存」。判据必须在跑之前查名字还在不在。
  assert.ok(src.includes('judgeSpec('), '缺 judgeSpec（judges + judgeTests 的唯一入口）')
  assert.ok(src.includes('judgeTests'), '缺 judgeTests')
  assert.ok(src.includes('--test-name-pattern='), '缺测试名过滤')
  assert.ok(src.includes("src.includes(\"test('\" + name"), '缺跑前存在性校验（漂移兜底）')
  assert.ok(src.includes('drift'), '缺漂移回退标记')
  assert.ok(src.includes('回退整文件'), '漂移时必须回退整文件，不许静默跳过')
})

test('P2：增量模式 opt-in，gate 默认路径不读缓存，且只缓存 caught', () => {
  // 三条判据：① 默认（不传 --changed/--incremental）完全不知道缓存存在；
  // ② 缓存只收 caught（survived/crashed/unapplied 永远重跑）；③ 缓存文件不进 VCS。
  assert.ok(src.includes("a === '--changed'"), '缺 --changed')
  assert.ok(src.includes("a === '--incremental'"), '缺 --incremental')
  assert.ok(src.includes('const useCache = args.changed || args.incremental'), 'gate 默认路径不许读缓存')
  assert.ok(src.includes("if (r.status !== 'caught') continue"), '缓存只许收 caught')
  assert.ok(readFileSync('.gitignore', 'utf8').includes('.mutation-cache.json'), '.mutation-cache.json 必须进 .gitignore')
})
test('P0：judge 套件不得退回固定 sleep（等待必须是 waitFor/settle）', () => {
  // 为什么钉这个：固定 sleep 是**同步点**，不是保险丝（docs/pitfalls.md §2.13）。
  // 它一旦被复制回来，scroll-dom 会从 3s 退回 15s，而且不会有任何断言变红 ——
  // 只有结构判据挡得住。
  const scroll = readFileSync('tests/scroll-dom.test.mjs', 'utf8')
  assert.ok(!scroll.includes('await sleep('), 'scroll-dom 出现了裸 sleep：等待请用 waitFor(业务条件) / settle()')
  assert.ok(scroll.includes('const settle = async'), '缺 settle()')
  assert.ok(scroll.includes('async function waitFor('), '缺 waitFor()')
  for (const file of ['tests/client-bundle.test.mjs', 'tests/unread-accounting.test.mjs']) {
    assert.ok(readFileSync(file, 'utf8').includes('UNDO_WINDOW_MS'), file + ' 缺撤销窗口捕获（5000ms 定时器必须只捕获不排程）')
  }
})

test('P3：--timings 报表可算出 >=1s 占比与 ETA（观察优化空间的唯一入口）', () => {
  assert.ok(src.includes("a === '--timings'"), '缺 --timings')
  assert.ok(src.includes('function writeTimings('), '缺 writeTimings')
  assert.ok(src.includes('slowShare'), '缺 >=1s 占比（优化空间就看这个数）')
  assert.ok(src.includes('etaSecondsByWorkers'), '缺 ETA')
})
test('内环无墙钟断言（timing 判据全部住在 tests/perf/）', () => {
  assert.ok(!readFileSync('tests/overview-scale.test.mjs', 'utf8').includes('OVERVIEW_BUDGET_MS'), '内环仍有墙钟判据（终审 I1：负载刀口）')
  assert.ok(readFileSync('tests/perf/overview-scale.test.mjs', 'utf8').includes('OVERVIEW_BUDGET_MS'), 'perf 侧未收编 timing 判据')
})
