/**
 * 导入校验的编排语义：**坏源不阻断其余**（§3.1 的硬要求）、并发受控、200 的网页不算 feed。
 * 用桩抓取函数覆盖，不出网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateSubscriptions } from '../lib/subscribe.js'

const LIMITS = { timeoutMs: 1000, maxBytes: 1024 * 1024 }
const RSS = '<?xml version="1.0"?><rss version="2.0"><channel><title>合法源</title><item><title>a</title><link>https://ex.test/a</link><guid>g1</guid></item></channel></rss>'

/** 桩：按 URL 决定返回什么。 */
function stubFetch(map) {
  return async (url) => {
    const outcome = map[url]
    if (outcome === undefined) return { kind: 'failed', reason: 'HTTP 404' }
    return outcome
  }
}

test('坏源单独标注、不阻断其余（§3.1 的硬要求）', async () => {
  const map = {
    'https://good.test/feed': { kind: 'ok', body: RSS },
    'https://notfeed.test/page': { kind: 'ok', body: '<html><body>这是一个普通网页</body></html>' },
  }
  const results = await validateSubscriptions(
    ['https://good.test/feed', 'https://notfeed.test/page', 'https://missing.test/feed', 'not a url'],
    { limits: LIMITS, concurrency: 2, fetchImpl: stubFetch(map) },
  )

  assert.equal(results.length, 4, '每个输入都必须有结果，一个都不能少')
  assert.equal(results[0].ok, true)
  assert.equal(results[0].title, '合法源', '标题应当取自 feed 本身')
  assert.equal(results[0].format, 'rss2')
  assert.equal(results[1].ok, false)
  assert.match(results[1].reason, /不是可识别的 feed/, '200 的普通网页必须被判为不可订阅')
  assert.equal(results[2].ok, false)
  assert.match(results[2].reason, /404/)
  assert.equal(results[3].ok, false)
  assert.match(results[3].reason, /不是合法 URL/)
})

test('结果顺序与输入一致（并发不能打乱对应关系）', async () => {
  const map = {
    'https://a.test/feed': { kind: 'ok', body: RSS },
    'https://b.test/feed': { kind: 'ok', body: RSS },
  }
  const results = await validateSubscriptions(
    ['https://a.test/feed', 'https://missing.test/feed', 'https://b.test/feed'],
    { limits: LIMITS, concurrency: 3, fetchImpl: stubFetch(map) },
  )
  assert.deepEqual(results.map((r) => r.ok), [true, false, true])
  assert.equal(results[0].url, 'https://a.test/feed')
  assert.equal(results[2].url, 'https://b.test/feed')
})

test('并发受控：同时在飞的请求数不超过上限', async () => {
  let inFlight = 0
  let peak = 0
  const slowFetch = async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 5))
    inFlight -= 1
    return { kind: 'ok', body: RSS }
  }
  const urls = Array.from({ length: 12 }, (_, i) => 'https://f' + i + '.test/feed')
  await validateSubscriptions(urls, { limits: LIMITS, concurrency: 4, fetchImpl: slowFetch })
  assert.ok(peak <= 4, '并发峰值 ' + peak + ' 超过上限 4')
  assert.ok(peak >= 2, '并发峰值只有 ' + peak + '，说明没有真正并行（≥20 源会很慢）')
})

test('304 不该被当成校验通过（校验时不带条件请求，出现 304 属异常）', async () => {
  const results = await validateSubscriptions(['https://x.test/feed'], {
    limits: LIMITS,
    concurrency: 1,
    fetchImpl: async () => ({ kind: 'not-modified' }),
  })
  assert.equal(results[0].ok, false)
  assert.match(results[0].reason, /304/)
})

test('空输入返回空数组，不抛异常', async () => {
  const results = await validateSubscriptions([], { limits: LIMITS, concurrency: 4, fetchImpl: async () => ({ kind: 'failed', reason: 'x' }) })
  assert.deepEqual(results, [])
})
