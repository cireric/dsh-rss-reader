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
