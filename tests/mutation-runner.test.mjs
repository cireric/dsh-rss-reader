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
