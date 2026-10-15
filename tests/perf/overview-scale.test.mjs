/**
 * 规模判据（墙钟预算）：10 万行下打开面板的耗时上界。
 *
 * 2026-10-15 终审 I1 从内环 tests/overview-scale.test.mjs 搬入 —— 与 article-perf 同一条教训：
 * 墙钟断言留在并行内环会站在预算刀口两侧（8 并发下实测 111–122ms 翻红，预算 100ms），
 * 误伤「同一套件里别的判定」。它继续在 npm test 全量收编（tests/perf/*.test.mjs）里守回归：
 * 改造前实测 215–238 ms（每次开面板一次全表物化），预算 100 ms 留了 ~5 倍余量：
 * 二次实现会稳定超界，而慢机器不会误报。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { freshLargeStore, counting, deps, OVERVIEW_BUDGET_MS } from '../helpers/overview-scale-fixture.mjs'
import { createDispatch } from '../../lib/endpoints.js'
import { Config } from '../../lib/config.js'

test('10 万行：overview 耗时在预算内（规模判据，二次实现稳定超界）', async () => {
  const { store, db, dir } = await freshLargeStore('perf-overview')
  try {
    const spy = counting(store)
    const dispatch = createDispatch(deps(spy.store, Config({})))

    const started = process.hrtime.bigint()
    const result = await dispatch('overview', {})
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

    assert.equal(result.ok, true, 'overview 应当成功')
    // 结构性前提：全表物化退回时这里稳定超界；结构性判据本体在内环（allItems 计数）。
    assert.equal(spy.calls.allItems, 0, '全表物化退回的前提判据')
    assert.ok(elapsedMs < OVERVIEW_BUDGET_MS,
      'overview 耗时 ' + elapsedMs.toFixed(1) + ' ms，超过预算 ' + OVERVIEW_BUDGET_MS +
      ' ms —— 疑似又退回全表物化（改造前实测 ~230 ms，改造后 ~15 ms）')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
