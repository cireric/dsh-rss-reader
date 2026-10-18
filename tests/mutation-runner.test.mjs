import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const src = readFileSync('scripts/mutation-test.mjs', 'utf8')
test('runner 已函数化且走 worker_threads', () => {
  for (const anchor of ["import { Worker } from 'node:worker_threads'", 'function parseArgs(', 'function runSuite(', 'function applyMutation(', 'function classify(', 'function collectResults(', 'function partitionMutations(', 'function buildWorkerScript(']) assert.ok(src.includes(anchor), '缺锚点: ' + anchor)
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
test('内环无墙钟断言（timing 判据全部住在 tests/perf/）', () => {
  assert.ok(!readFileSync('tests/overview-scale.test.mjs', 'utf8').includes('OVERVIEW_BUDGET_MS'), '内环仍有墙钟判据（终审 I1：负载刀口）')
  assert.ok(readFileSync('tests/perf/overview-scale.test.mjs', 'utf8').includes('OVERVIEW_BUDGET_MS'), 'perf 侧未收编 timing 判据')
})
