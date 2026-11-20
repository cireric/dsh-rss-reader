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
import { freshLargeStore, counting, deps, OVERVIEW_BUDGET_MS, DEFAULTS, recentWindow } from '../helpers/overview-scale-fixture.mjs'
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

/**
 * 窗口版预算（R1 05）：窗口覆盖基准夹具 2/3 的行（窗口 SQL 走 i2 范围扫描）。
 * 预算沿用 OVERVIEW_BUDGET_MS，**不因为「加了窗口」就放宽** —— 放宽预算等于把规模判据作废。
 */
test('10 万行：窗口版 overview 耗时在既有预算内', async () => {
  const { store, db, dir } = await freshLargeStore('perf-window')
  try {
    const { from, to } = recentWindow()
    const spy = counting(store)
    const dispatch = createDispatch(deps(spy.store, Config({})))

    const started = process.hrtime.bigint()
    const result = await dispatch('overview', { from, to })
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

    assert.equal(result.ok, true, '带窗 overview 应当成功')
    assert.equal(spy.calls.allItems, 0, '全表物化退回的前提判据')
    assert.equal(result.value.items.length, DEFAULTS.maxItemsShown, '窗口内仍是满一页（窗口真的覆盖大部分行）')
    assert.ok(elapsedMs < OVERVIEW_BUDGET_MS,
      '窗口版 overview 耗时 ' + elapsedMs.toFixed(1) + ' ms，超过预算 ' + OVERVIEW_BUDGET_MS + ' ms')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 带拆分的账目预算（R1 05）：`todayFrom` 让每次带账回包多一条 `unreadSplit` 聚合 SQL。
 * 用写端点（toggleStar）而不是 overview 计量：这条 SQL 挂在**每次手势的回包**上，
 * 而写端点没有列表取数可分摊，最能暴露「拆分成全表物化」那种退回。
 */
test('10 万行：带拆分的账目（写端点回包）耗时在既有预算内', async () => {
  const { store, db, dir } = await freshLargeStore('perf-split')
  try {
    const { from } = recentWindow()
    const spy = counting(store)
    const dispatch = createDispatch(deps(spy.store, Config({})))

    const started = process.hrtime.bigint()
    const result = await dispatch('toggleStar', { itemId: 'item-0-1', todayFrom: from })
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

    assert.equal(result.ok, true, '带 todayFrom 的 toggleStar 应当成功')
    assert.equal(spy.calls.allItems, 0, '拆分账目不许物化全表')
    assert.equal(result.value.unreadSplit.today + result.value.unreadSplit.earlier + result.value.unreadSplit.noDate,
      result.value.unread, '前置条件：三分恒等于全部未读（否则量到的不是那份账）')
    assert.ok(elapsedMs < OVERVIEW_BUDGET_MS,
      '带拆分的账目耗时 ' + elapsedMs.toFixed(1) + ' ms，超过预算 ' + OVERVIEW_BUDGET_MS + ' ms')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
