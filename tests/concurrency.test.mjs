/**
 * 有界并发映射的单测。
 *
 * 重点是最后一条：limit 缺失/非法时必须**退化成串行**，而不是一个任务都不跑。
 * 2026-10-07 实测踩到过：refresh.ts 新增的并发选项漏传时，Array.from({ length: NaN })
 * 产出空 worker 列表，刷新静默变成空操作、调用方拿到一列空结果却没有报错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapConcurrent } from '../lib/concurrency.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('结果与输入按下标一一对应（并发不打乱对应关系）', async () => {
  const out = await mapConcurrent([30, 5, 20, 1], 4, async (n) => {
    await delay(n)
    return n * 2
  })
  assert.deepEqual(out, [60, 10, 40, 2])
})

test('并发上限被遵守：峰值不超过 limit', async () => {
  let inFlight = 0
  let peak = 0
  await mapConcurrent(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await delay(5)
    inFlight -= 1
    return null
  })
  assert.ok(peak >= 2, '峰值只有 ' + peak + '，并发没生效')
  assert.ok(peak <= 4, '峰值 ' + peak + ' 超过上限 4')
})

test('空输入返回空数组，不残留 worker', async () => {
  assert.deepEqual(await mapConcurrent([], 4, async () => 1), [])
})

test('limit 缺失或非法时退化为串行，但必须把每个任务都跑完', async () => {
  for (const bad of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const seen = []
    const out = await mapConcurrent(['a', 'b', 'c'], bad, async (item) => {
      seen.push(item)
      return item.toUpperCase()
    })
    assert.deepEqual(out, ['A', 'B', 'C'], 'limit=' + String(bad) + ' 时必须仍然跑完全部任务')
    assert.deepEqual(seen, ['a', 'b', 'c'], 'limit=' + String(bad) + ' 时必须仍然跑完全部任务')
  }
})
