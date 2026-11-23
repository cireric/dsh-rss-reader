/**
 * R8a 04：Radar 规则缓存（spec §4.4 / §7 A7–A8 / §11 D8）。
 *
 * 直接钉 `lookupRadarRules` 这一层的缓存语义：成功（含空规则）6h、失败 60s、键含实例地址、
 * 上限 64 按插入序淘汰。时钟注入推进，不靠 sleep。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { clearRadarCache, lookupRadarRules, radarRulesUrl } from '../lib/radar.js'

const BASE = 'https://hub.test'
const LIMITS = { timeoutMs: 1000, maxBytes: 1024 * 1024, trustedTarget: true }
const RULES = JSON.stringify({
  _name: '示例站',
  '.': [{ title: '帖子', source: ['/p/:id'], target: '/example/p/:id' }],
})

const radarUrl = (base, domain) => base + '/api/radar/rules/' + domain

/** 真实回包形状：ok 必须带 finalUrl（发现流程要用它解析相对链接 / 取 Radar 域名）。 */
function stubFetch(map) {
  const calls = []
  const impl = async (url, validators, limits) => {
    calls.push({ url, validators, limits })
    const outcome = map[url]
    if (outcome === undefined) return { kind: 'failed', reason: 'HTTP 500' }
    return outcome.kind === 'ok' ? { ...outcome, finalUrl: outcome.finalUrl ?? url } : outcome
  }
  impl.calls = calls
  return impl
}

/** 可注入时钟：不 sleep，直接推进毫秒。 */
function clock(start = 1_000_000) {
  let current = start
  return {
    now: () => current,
    advance: (ms) => { current += ms },
  }
}

beforeEach(() => clearRadarCache())

test('同域名第二次零请求（桩件计数 1）', async () => {
  const fetchImpl = stubFetch({ [radarUrl(BASE, 'site.test')]: { kind: 'ok', body: RULES } })
  const first = await lookupRadarRules(BASE, 'site.test', LIMITS, fetchImpl)
  const second = await lookupRadarRules(BASE, 'site.test', LIMITS, fetchImpl)

  assert.equal(fetchImpl.calls.length, 1, '第二次必须命中缓存、零请求')
  assert.equal(first.kind, 'rules')
  assert.equal(first.domain, 'site.test')
  assert.deepEqual(second, first, '缓存返回同一份规则')
})

test('成功缓存 6h：6h 内不请求，6h+1 后重新请求', async () => {
  const fetchImpl = stubFetch({ [radarUrl(BASE, 'site.test')]: { kind: 'ok', body: RULES } })
  const time = clock()
  await lookupRadarRules(BASE, 'site.test', LIMITS, fetchImpl, { now: time.now })

  time.advance(6 * 60 * 60 * 1000 - 1)
  await lookupRadarRules(BASE, 'site.test', LIMITS, fetchImpl, { now: time.now })
  assert.equal(fetchImpl.calls.length, 1, '6h 内必须命中缓存')

  time.advance(2)
  await lookupRadarRules(BASE, 'site.test', LIMITS, fetchImpl, { now: time.now })
  assert.equal(fetchImpl.calls.length, 2, '6h+1 后必须重新请求')
})

test('失败只缓存 60s：网络错误 / 非 JSON / 非对象都不钉死长 TTL', async () => {
  const cases = [
    { name: '网络错误', outcome: { kind: 'failed', reason: 'HTTP 503' }, failure: 'HTTP 503' },
    { name: '非 JSON', outcome: { kind: 'ok', body: '<html>not json</html>' }, failure: '响应不是 Radar 规则 JSON' },
    { name: '非对象', outcome: { kind: 'ok', body: '[]' }, failure: '响应不是 Radar 规则对象' },
  ]
  for (const item of cases) {
    clearRadarCache()
    const fetchImpl = stubFetch({ [radarUrl(BASE, 'site.test')]: item.outcome })
    const time = clock()
    const first = await lookupRadarRules(BASE, 'site.test', LIMITS, fetchImpl, { now: time.now })
    assert.equal(first.kind, 'failure', item.name + '：第一次如实报失败')
    assert.equal(first.reason, item.failure, item.name + '：第一次如实报失败原因')

    time.advance(60 * 1000 - 1)
    const cached = await lookupRadarRules(BASE, 'site.test', LIMITS, fetchImpl, { now: time.now })
    assert.equal(fetchImpl.calls.length, 1, item.name + '：60s 内零重试')
    assert.equal(cached.kind, 'failure', item.name + '：缓存返回同一失败状态')
    assert.equal(cached.reason, item.failure, item.name + '：缓存返回同一失败原因')

    time.advance(1001)
    await lookupRadarRules(BASE, 'site.test', LIMITS, fetchImpl, { now: time.now })
    assert.equal(fetchImpl.calls.length, 2, item.name + '：61s 后重试')
  }
})

test('空 body（该域没规则）也缓存 6h：第二次不请求', async () => {
  const fetchImpl = stubFetch({ [radarUrl(BASE, 'site.test')]: { kind: 'ok', body: '' } })
  const time = clock()
  const first = await lookupRadarRules(BASE, 'site.test', LIMITS, fetchImpl, { now: time.now })
  assert.deepEqual(first, { kind: 'empty' }, '空 body = 该域没规则')

  const second = await lookupRadarRules(BASE, 'site.test', LIMITS, fetchImpl, { now: time.now })
  assert.deepEqual(second, { kind: 'empty' }, '第二次仍返回「没规则」')
  assert.equal(fetchImpl.calls.length, 1, '空结果也必须命中缓存')

  time.advance(6 * 60 * 60 * 1000 + 1)
  await lookupRadarRules(BASE, 'site.test', LIMITS, fetchImpl, { now: time.now })
  assert.equal(fetchImpl.calls.length, 2, '空结果同样按 6h 过期')
})

test('域名回退中的空 body 也缓存：第二次整条查询零请求', async () => {
  const fetchImpl = stubFetch({
    [radarUrl(BASE, 'zhihu.com')]: { kind: 'ok', body: '' },
    [radarUrl(BASE, 'www.zhihu.com')]: { kind: 'ok', body: RULES },
  })
  const time = clock()
  const first = await lookupRadarRules(BASE, 'www.zhihu.com', LIMITS, fetchImpl, { now: time.now })
  assert.equal(first.kind, 'rules')
  assert.equal(first.domain, 'www.zhihu.com')
  assert.equal(fetchImpl.calls.length, 2, '先查 zhihu.com（空）再查 www.zhihu.com（有规则）')

  const second = await lookupRadarRules(BASE, 'www.zhihu.com', LIMITS, fetchImpl, { now: time.now })
  assert.equal(second.kind, 'rules')
  assert.equal(second.domain, 'www.zhihu.com')
  assert.equal(fetchImpl.calls.length, 2, '两级结果都在缓存里，整条查询零请求')
})

test('换 base ⇒ 旧条目不被复用，旧实例的规则不进入新实例结果', async () => {
  const other = 'https://hub2.test'
  const fetchImpl = stubFetch({
    [radarUrl(BASE, 'site.test')]: { kind: 'ok', body: RULES },
    [radarUrl(other, 'site.test')]: { kind: 'ok', body: '' },
  })
  const time = clock()
  const oldLookup = await lookupRadarRules(BASE, 'site.test', LIMITS, fetchImpl, { now: time.now })
  const newLookup = await lookupRadarRules(other, 'site.test', LIMITS, fetchImpl, { now: time.now })

  assert.deepEqual(fetchImpl.calls.map((call) => call.url),
    [radarUrl(BASE, 'site.test'), radarUrl(other, 'site.test')],
    '换实例必须重新请求，不能复用旧实例的缓存')
  assert.equal(oldLookup.kind, 'rules')
  assert.deepEqual(oldLookup.rules, JSON.parse(RULES))
  assert.deepEqual(newLookup, { kind: 'empty' }, '新实例的空结果里不许冒出新实例没给过的旧规则')

  // 反向也隔离：再查旧实例仍是它自己的缓存，不会被新实例的空结果污染。
  await lookupRadarRules(BASE, 'site.test', LIMITS, fetchImpl, { now: time.now })
  assert.equal(fetchImpl.calls.length, 2, '旧实例的条目仍在，各自独立命中')
})

test('上限 64：第 65 个域名挤掉最旧，被挤掉的再查重新请求', async () => {
  const map = {}
  for (let i = 1; i <= 65; i += 1) {
    map[radarUrl(BASE, 'd' + i + '.test')] = { kind: 'ok', body: RULES }
  }
  const fetchImpl = stubFetch(map)
  const time = clock()
  for (let i = 1; i <= 65; i += 1) {
    await lookupRadarRules(BASE, 'd' + i + '.test', LIMITS, fetchImpl, { now: time.now })
  }
  assert.equal(fetchImpl.calls.length, 65)

  // 第 2 个还在缓存里（被挤掉的是第 1 个）。
  await lookupRadarRules(BASE, 'd2.test', LIMITS, fetchImpl, { now: time.now })
  assert.equal(fetchImpl.calls.length, 65, 'd2 仍命中缓存')

  await lookupRadarRules(BASE, 'd1.test', LIMITS, fetchImpl, { now: time.now })
  assert.equal(fetchImpl.calls.length, 66, '最旧的 d1 被挤掉，必须重新请求')
})

test('缓存不携带 limits：过期后重查按本次调用重建请求参数，绝不带 trustedTarget', async () => {
  const fetchImpl = stubFetch({ [radarUrl(BASE, 'site.test')]: { kind: 'ok', body: RULES } })
  const time = clock()
  await lookupRadarRules(BASE, 'site.test', { timeoutMs: 111, maxBytes: 222, trustedTarget: true },
    fetchImpl, { now: time.now })
  time.advance(6 * 60 * 60 * 1000 + 1)
  await lookupRadarRules(BASE, 'site.test', { timeoutMs: 333, maxBytes: 444, trustedTarget: true },
    fetchImpl, { now: time.now })

  assert.deepEqual(fetchImpl.calls[0].limits, { timeoutMs: 111, maxBytes: 222 },
    '第一次请求只带超时与体积')
  assert.deepEqual(fetchImpl.calls[1].limits, { timeoutMs: 333, maxBytes: 444 },
    '第二次未命中时用本次调用的 limits，不是缓存里第一次的')
})

test('radarRulesUrl：`{base}/api/radar/rules/{domain}` 只有这一处拼法', () => {
  assert.equal(radarRulesUrl('https://hub.test', 'zhihu.com'), 'https://hub.test/api/radar/rules/zhihu.com')
})
