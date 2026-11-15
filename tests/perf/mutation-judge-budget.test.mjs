/**
 * 判据套件的墙钟预算（性能回归闸）。
 *
 * 为什么放 tests/perf/ 而不是内环：墙钟断言在并行内环会站在刀口两侧（本仓库踩过：
 * 8 并发下 111–122ms 翻红、预算 100ms）。这里是**单一职责**的观测通道：
 * `npm run test:perf` 单独跑，回答「judge 套件有没有悄悄退回 sleep 时代的慢」。
 *
 * 预算怎么定的：2026-11-15 提速后实测 scroll-dom ≈ 3.0s、client-bundle ≈ 0.41s、
 * unread-accounting ≈ 0.10s。预算取 2.7× / 4.9× / 10× 余量 —— 目标是抓「数量级回退」
 *（例如有人把 150ms 固定 sleep 加回来：scroll-dom 会直接回到 12s+），不抓机器噪声。
 *
 * ⚠️ 子进程用「直接执行测试文件」而不是 `node --test <file>`：在 `node --test` 里再起
 * `node --test` 会被 node 判成递归调用并**直接跳过**（实测：仅 25ms、exit 0，一行都没跑）。
 * 那会让这个闸门变成永远通过的空转 —— 属于「看着有判据、其实没有」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function judgeMs(file) {
  const started = process.hrtime.bigint()
  const env = { ...process.env, HOME: process.env.HOME ?? homedir() }
  // 递归保护变量必须摘掉：带着它，子进程即使直接执行文件也会走 test 运行器的跳过分支。
  delete env.NODE_TEST_CONTEXT
  execFileSync(process.execPath, [join("tests", file)], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000, env })
  return Number(process.hrtime.bigint() - started) / 1e6
}

test('judge 套件墙钟预算：scroll-dom / client-bundle / unread-accounting / refresh', () => {
  const budgets = [
    ['scroll-dom.test.mjs', 8000],
    ['client-bundle.test.mjs', 2000],
    ['unread-accounting.test.mjs', 1000],
    ['refresh.test.mjs', 1000],
  ]
  const measured = []
  for (const [file, budget] of budgets) {
    const ms = Math.round(judgeMs(file))
    measured.push(file + ' ' + ms + 'ms/' + budget + 'ms')
    assert.ok(ms < budget, file + ' 超预算：' + ms + 'ms >= ' + budget + 'ms（判据套件退回固定等待了？见 docs/pitfalls.md 2.13）')
  }
  console.log('judge 墙钟：' + measured.join(' · '))
})
