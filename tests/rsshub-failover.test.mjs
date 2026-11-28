/**
 * R15 03：刷新失败切换与冷却（spec §4.1.4 / §6 A1–A4）。
 *
 * 判据是**请求次数**与**请求了哪几个实例**，不是「最终成功」：只测「成功了」的实现
 * 可以每次把池子试满、或者对非 RSSHub 源也切实例，用户只会在延迟与隐私面上受损。
 * 所以这里的每个用例都同时看 fetchFeedImpl 桩收到的调用与 FeedOutcome.instancesAttempted。
 *
 * 时间全部走注入：`clock` 是 20 s 预算的单调时钟，`now` 是连败/冷却的墙钟。
 * 预算用例不敢真 sleep —— 12 s + 8 s 的真等会让这个文件在门槛里跑不动。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { refreshFeeds } from '../lib/refresh.js'
import {
  RSSHUB_ATTEMPT_TIMEOUT_MS,
  RSSHUB_FAILURE_MAX_CHARS,
  createRsshubCooldown,
  rsshubFailureSummary,
  rsshubInstanceOrder,
  rsshubInstanceUrl,
} from '../lib/rsshub-failover.js'
import { strictMemoryStore } from './helpers/reader-store-memory.mjs'

const LIMITS = { timeoutMs: 2000, maxBytes: 1_000_000, trustedTarget: true }
const BASE_OPTIONS = {
  limits: LIMITS,
  maxItemsPerFeed: 100,
  maxSeenPerFeed: 1000,
  maxContentChars: 100000,
  maxArticleCacheChars: 1000000,
  refreshConcurrency: 1,
}

/** 一个最小可解析的 RSS 2.0 文档；title 用来确认「内容真的来自那台实例」。 */
function rss(title) {
  return '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>' + title
    + '</title><item><title>' + title + '-条目</title><link>https://ex.test/' + encodeURIComponent(title)
    + '</link><guid>g-' + title + '</guid></item></channel></rss>'
}

/**
 * 按 URL 分派的 fetchFeed 桩：记录每一次调用（url / validators / limits），
 * 让「请求数 = 2」「第二个的 timeoutMs = 8000」这类判据直接可见。
 */
function fetchStub(routes) {
  const calls = []
  const impl = async (url, validators, limits) => {
    calls.push({ url, validators, limits })
    const route = routes[url]
    if (route === undefined) return { kind: 'failed', reason: '测试桩没有为这个地址准备响应：' + url }
    return typeof route === 'function' ? route(calls.length) : route
  }
  return { impl, calls }
}

function failReason(url) {
  return 'HTTP 503（' + url + '）'
}

// ── 纯函数：候选顺序、跨实例地址、冷却、摘要 ────────────────────────────────

test('候选顺序：上次成功的实例（仍在池中）排第一，其余按池序；冷却中的实例稳定后移', () => {
  const pool = ['https://a.test', 'https://b.test', 'https://c.test']
  assert.deepEqual(
    rsshubInstanceOrder('https://b.test', pool, () => false),
    ['https://b.test', 'https://a.test', 'https://c.test'],
    '记录实例仍在池中 ⇒ 排第一（A2 的首选就是它）',
  )
  assert.deepEqual(
    rsshubInstanceOrder('https://gone.test', pool, () => false),
    pool,
    '记录实例已不在池中 ⇒ 不尝试它，按池顺序',
  )
  assert.deepEqual(
    rsshubInstanceOrder('https://a.test', pool, (instance) => instance === 'https://b.test'),
    ['https://a.test', 'https://c.test', 'https://b.test'],
    '冷却只改排序、不删除：冷却中的实例排在最后，其余保持相对顺序',
  )
  assert.deepEqual(
    rsshubInstanceOrder('https://a.test', ['https://a.test'], () => true),
    ['https://a.test'],
    '源只配一个实例时，哪怕在冷却期也照常尝试（冷却不是拉黑）',
  )
})

test('跨实例地址：同一路由搬到另一台实例，path 与 query 取自订阅 URL 本身', () => {
  assert.equal(
    rsshubInstanceUrl('https://a.test/baoyu/blog?limit=10', 'https://b.test'),
    'https://b.test/baoyu/blog?limit=10',
    '换实例不能丢筛选参数（query 是路由的一部分）',
  )
  assert.equal(
    rsshubInstanceUrl('https://a.test/baoyu/blog', 'https://a.test'),
    'https://a.test/baoyu/blog',
    '同一实例沿用原地址（A2：不该因为拼接产生任何字节差异）',
  )
})

test('冷却：同一源对同一实例连续失败 2 次才进入 10 分钟冷却；成功一次即清零；到期恢复', () => {
  const cooldown = createRsshubCooldown()
  const feedId = 'https://a.test/baoyu/blog'
  const instance = 'https://a.test'
  const t0 = Date.parse('2026-11-28T00:00:00.000Z')

  assert.equal(cooldown.isCooling(feedId, instance, t0), false, '没失败过不冷却')
  cooldown.recordFailure(feedId, instance, t0)
  assert.equal(cooldown.isCooling(feedId, instance, t0 + 1000), false, '只失败 1 次还不冷却')
  cooldown.recordFailure(feedId, instance, t0 + 1000)
  assert.equal(cooldown.isCooling(feedId, instance, t0 + 2000), true, '连续失败 2 次 ⇒ 进入冷却（排到最后）')
  // 冷却窗口从第 2 次失败的时刻（t0+1000）起算 10 分钟。
  assert.equal(cooldown.isCooling(feedId, instance, t0 + 1000 + 10 * 60 * 1000 - 1), true,
    '10 分钟整仍在冷却期内')
  assert.equal(cooldown.isCooling(feedId, instance, t0 + 1000 + 10 * 60 * 1000 + 1), false,
    '10 分钟后必须恢复（冷却只是排序优化，不是永久拉黑）')

  // 成功一次清零：之前累计的连败不许在下次失败时「续上」。
  cooldown.recordFailure(feedId, instance, t0 + 20 * 60 * 1000)
  cooldown.recordSuccess(feedId, instance)
  cooldown.recordFailure(feedId, instance, t0 + 21 * 60 * 1000)
  assert.equal(cooldown.isCooling(feedId, instance, t0 + 22 * 60 * 1000), false,
    '成功过之后重新从 1 数起，不许立刻再判冷却')
})

test('全失败摘要：一行 `实例: 原因；实例: 原因`，超长时截断到 200 字符', () => {
  assert.equal(
    rsshubFailureSummary([
      { instance: 'https://hub.slarker.me', reason: '超时（12000ms）' },
      { instance: 'https://rsshub.rss.tips', reason: 'HTTP 503' },
    ]),
    'hub.slarker.me: 超时（12000ms）；rsshub.rss.tips: HTTP 503',
    '摘要用主机名（不带协议），两个实例都要出现',
  )

  const long = rsshubFailureSummary([
    { instance: 'https://a.test', reason: 'x'.repeat(500) },
    { instance: 'https://b.test', reason: 'HTTP 503' },
  ])
  assert.equal(long.length, RSSHUB_FAILURE_MAX_CHARS + 1, '超长摘要 = 200 字符正文 + 一个省略号')
  assert.ok(long.endsWith('…'), '截断必须有可辨认的省略号，不能看起来像完整的错误串')
})

// ── 装配：A1–A4 与预算 ──────────────────────────────────────────────────

test('A1：首选 503、次选 200 ⇒ 刷新成功、请求 2 次、当前实例改写为实际成功的那台', async () => {
  const store = strictMemoryStore()
  const feedUrl = 'https://hub-a.test/a1/baoyu'
  const pool = ['https://hub-a.test', 'https://hub-b.test']
  await store.saveFeed(feedUrl, {
    url: feedUrl,
    title: '博客',
    rsshub: { namespace: 'a1', path: '/a1/baoyu', instance: 'https://hub-a.test' },
  })
  const { impl, calls } = fetchStub({
    [feedUrl]: { kind: 'failed', reason: 'HTTP 503' },
    ['https://hub-b.test/a1/baoyu']: { kind: 'ok', body: rss('来自次选'), finalUrl: 'https://hub-b.test/a1/baoyu' },
  })

  const outcomes = await refreshFeeds([feedUrl], store, { ...BASE_OPTIONS, instances: pool, fetchFeedImpl: impl })

  assert.equal(calls.length, 2, 'A1 的判据是请求数：首选 503 后必须且只能再请求次选')
  assert.deepEqual(calls.map((call) => call.url), [feedUrl, 'https://hub-b.test/a1/baoyu'])
  assert.deepEqual(outcomes[0].instancesAttempted, pool, '两个实例按顺序各试一次')
  assert.equal(outcomes[0].status, 'added')
  assert.equal(outcomes[0].added, 1)
  assert.equal(store.feed(feedUrl).rsshub.instance, 'https://hub-b.test',
    '成功实例必须写回 rsshub.instance —— 否则界面永远显示旧实例')
  assert.equal(store.feed(feedUrl).failureCount, 0, '成功后 failureCount 归零')
  assert.equal(store.feed(feedUrl).lastFailure, undefined, '成功后旧失败原因必须清掉')
  assert.equal(store.items.size, 1, '次选拿到的条目正常入库')
})

test('A2：首选 200 ⇒ 只请求首选，不请求次选', async () => {
  const store = strictMemoryStore()
  const feedUrl = 'https://hub-a.test/a2/baoyu'
  const pool = ['https://hub-a.test', 'https://hub-b.test']
  await store.saveFeed(feedUrl, {
    url: feedUrl,
    title: '博客',
    rsshub: { namespace: 'a2', path: '/a2/baoyu', instance: 'https://hub-a.test' },
  })
  const { impl, calls } = fetchStub({
    [feedUrl]: { kind: 'ok', body: rss('首选'), finalUrl: feedUrl },
    ['https://hub-b.test/a2/baoyu']: { kind: 'ok', body: rss('次选'), finalUrl: 'https://hub-b.test/a2/baoyu' },
  })

  const outcomes = await refreshFeeds([feedUrl], store, { ...BASE_OPTIONS, instances: pool, fetchFeedImpl: impl })

  assert.equal(calls.length, 1, '首选成功 ⇒ 只发一个请求（不许预探活、不许试满池子）')
  assert.equal(calls[0].url, feedUrl)
  assert.deepEqual(outcomes[0].instancesAttempted, ['https://hub-a.test'])
  assert.equal(store.feed(feedUrl).rsshub.instance, 'https://hub-a.test')
})

test('A3：两个实例都失败 ⇒ 保留旧条目与 lastFetchedAt、failureCount+1、摘要含两实例', async () => {
  const store = strictMemoryStore()
  const feedUrl = 'https://hub-a.test/a3/baoyu'
  const oldFetchedAt = '2026-01-01T00:00:00.000Z'
  const pool = ['https://hub-a.test', 'https://hub-b.test', 'https://hub-c.test']
  await store.saveFeed(feedUrl, {
    url: feedUrl,
    title: '博客',
    lastFetchedAt: oldFetchedAt,
    lastAttemptedAt: oldFetchedAt,
    failureCount: 1,
    rsshub: { namespace: 'a3', path: '/a3/baoyu', instance: 'https://hub-a.test' },
  })
  await store.saveItem('old-item', {
    feedId: feedUrl, title: '旧条目', link: 'https://ex.test/old', fetchedAt: oldFetchedAt, starred: false,
  })
  const { impl, calls } = fetchStub({
    [feedUrl]: { kind: 'failed', reason: '超时（12000ms）' },
    ['https://hub-b.test/a3/baoyu']: { kind: 'failed', reason: 'HTTP 503' },
    ['https://hub-c.test/a3/baoyu']: { kind: 'failed', reason: 'HTTP 500' },
  })

  const outcomes = await refreshFeeds([feedUrl], store, {
    ...BASE_OPTIONS, instances: pool, fetchFeedImpl: impl,
    now: () => new Date('2026-11-28T00:00:00.000Z'),
  })

  assert.equal(calls.length, 2, '最多 2 个实例：池里配了 3 个也不许试满（切换无预算的判据）')
  assert.deepEqual(outcomes[0].instancesAttempted, [pool[0], pool[1]])
  assert.equal(outcomes[0].status, 'failed')
  assert.equal(store.items.size, 1, '全失败不得删除旧条目')
  assert.equal(store.item('old-item').title, '旧条目')
  const record = store.feed(feedUrl)
  assert.equal(record.lastFetchedAt, oldFetchedAt, '全失败不许改「上次成功」')
  assert.equal(record.lastAttemptedAt, '2026-11-28T00:00:00.000Z', '失败的尝试仍要盖 lastAttemptedAt（防饿死）')
  assert.equal(record.failureCount, 2, '连续失败次数 +1')
  assert.match(record.lastFailure, /hub-a\.test: 超时（12000ms）/, '摘要含第一个实例与原因')
  assert.match(record.lastFailure, /hub-b\.test: HTTP 503/, '摘要含第二个实例与原因')
  assert.doesNotMatch(record.lastFailure, /hub-c\.test/, '没尝试的第三个实例不该出现在摘要里')
  assert.equal(outcomes[0].reason, record.lastFailure, 'outcome 与落库的失败原因同一份摘要')
})

test('A4：非 RSSHub 源 + 已配置实例池 ⇒ 请求次数、超时与错误文案逐字不变', async () => {
  const store = strictMemoryStore()
  const feedUrl = 'https://site.test/feed.xml'
  const pool = ['https://hub-a.test', 'https://hub-b.test']
  await store.saveFeed(feedUrl, { url: feedUrl, title: '原生源', lastFetchedAt: '2026-01-01T00:00:00.000Z' })
  const failStub = fetchStub({ [feedUrl]: { kind: 'failed', reason: 'HTTP 500' } })

  const failed = await refreshFeeds([feedUrl], store, {
    ...BASE_OPTIONS, instances: pool, fetchFeedImpl: failStub.impl,
    now: () => new Date('2026-11-28T00:00:00.000Z'),
  })

  assert.equal(failStub.calls.length, 1, '非 RSSHub 源只有一个请求：池子与它无关')
  assert.equal(failStub.calls[0].url, feedUrl, '请求的仍是订阅地址本身')
  assert.equal(failStub.calls[0].limits.timeoutMs, LIMITS.timeoutMs,
    '超时必须还是原来那份 limits（不许被 12 s 的 RSSHub 超时顶替）')
  assert.equal(failed[0].instancesAttempted, undefined, '非 RSSHub 源不许出现「尝试过哪些实例」')
  assert.equal(failed[0].reason, 'HTTP 500', '错误文案逐字不变')
  assert.equal(store.feed(feedUrl).lastFailure, 'HTTP 500')
  assert.equal(store.feed(feedUrl).lastFetchedAt, '2026-01-01T00:00:00.000Z')

  // 成功路径同样只请求一次，且不写来源字段。
  const okStore = strictMemoryStore()
  await okStore.saveFeed(feedUrl, { url: feedUrl, title: '原生源' })
  const okStub = fetchStub({ [feedUrl]: { kind: 'ok', body: rss('原生'), finalUrl: feedUrl } })
  const succeeded = await refreshFeeds([feedUrl], okStore, {
    ...BASE_OPTIONS, instances: pool, fetchFeedImpl: okStub.impl,
  })
  assert.equal(okStub.calls.length, 1)
  assert.equal(succeeded[0].status, 'added')
  assert.equal(okStore.feed(feedUrl).rsshub, undefined, '非 RSSHub 源不许被标成 RSSHub')
})

test('池子为空：RSSHub 源按原地址单请求刷新（不切换、不改写来源里的历史实例）', async () => {
  // 明确一条边界（不是漏测）：空池关闭的是 Radar / 探索 / 新订阅这些 RSSHub 能力，不替用户
  // 静默停掉已经订好的源。没有候选实例时不切换，按订阅地址本身发一个请求（与加本票之前一致）。
  const store = strictMemoryStore()
  const feedUrl = 'https://hub-a.test/empty/baoyu'
  await store.saveFeed(feedUrl, {
    url: feedUrl,
    title: '博客',
    rsshub: { namespace: 'empty', path: '/empty/baoyu', instance: 'https://old.test' },
  })
  const { impl, calls } = fetchStub({ [feedUrl]: { kind: 'ok', body: rss('空池'), finalUrl: feedUrl } })

  const outcomes = await refreshFeeds([feedUrl], store, { ...BASE_OPTIONS, instances: [], fetchFeedImpl: impl })

  assert.equal(calls.length, 1, '空池没有候选可切：仍然只发一个请求')
  assert.equal(calls[0].url, feedUrl)
  assert.equal(outcomes[0].status, 'added')
  assert.equal(outcomes[0].instancesAttempted, undefined, '没有发生切换 ⇒ 不出现尝试实例列表')
  assert.equal(store.feed(feedUrl).rsshub.instance, 'https://old.test',
    '没有实际切换到的实例可记：来源字段是历史事实，原样保留')
})

test('预算：单实例 12s；第一个用满 12s 后第二个只剩 8s（注入时钟，不真 sleep）', async () => {
  const store = strictMemoryStore()
  const feedUrl = 'https://hub-a.test/budget/baoyu'
  const pool = ['https://hub-a.test', 'https://hub-b.test']
  await store.saveFeed(feedUrl, {
    url: feedUrl,
    title: '博客',
    rsshub: { namespace: 'budget', path: '/budget/baoyu', instance: 'https://hub-a.test' },
  })
  let elapsed = 0
  const { impl, calls } = fetchStub({
    [feedUrl]: () => {
      elapsed = 12_000
      return { kind: 'failed', reason: '超时（12000ms）' }
    },
    ['https://hub-b.test/budget/baoyu']: () => {
      elapsed = 20_000
      return { kind: 'failed', reason: '超时（8000ms）' }
    },
  })

  await refreshFeeds([feedUrl], store, {
    ...BASE_OPTIONS,
    limits: { ...LIMITS, timeoutMs: 30_000 },
    instances: pool,
    fetchFeedImpl: impl,
    clock: () => elapsed,
    now: () => new Date('2026-11-28T00:00:00.000Z'),
  })

  assert.equal(calls.length, 2)
  assert.equal(calls[0].limits.timeoutMs, RSSHUB_ATTEMPT_TIMEOUT_MS,
    '第一个实例的预算就是 12s，与用户配置的 30s 无关')
  assert.equal(calls[1].limits.timeoutMs, 8_000,
    '第一个用满 12s ⇒ 第二个只剩 20-12=8s（两次合计不超过 20s）')
})

test('预算：performance.now() 的小数毫秒不许流进 AbortSignal.timeout（真机 2026-11-28 的 internal 崩溃）', async () => {
  const store = strictMemoryStore()
  const feedUrl = 'https://hub-a.test/fraction/baoyu'
  const pool = ['https://hub-a.test', 'https://hub-b.test']
  await store.saveFeed(feedUrl, {
    url: feedUrl,
    title: '博客',
    rsshub: { namespace: 'fraction', path: '/fraction/baoyu', instance: 'https://hub-a.test' },
  })
  // 小数时钟才是 performance.now() 的真实形态；上面几条预算用例用整数时钟推进，
  // 恰好把「第二次尝试拿到 7998.823…」这个崩溃绕过去了（缺陷能在全绿套件里存活的原因）。
  let elapsed = 0
  const timeouts = []
  const { impl } = fetchStub({
    [feedUrl]: () => {
      elapsed = 12_000.7
      return { kind: 'failed', reason: '超时（12000ms）' }
    },
    ['https://hub-b.test/fraction/baoyu']: () => ({ kind: 'failed', reason: '超时（8000ms）' }),
  })
  // 真 fetch.ts 的第一件事就是 AbortSignal.timeout(limits.timeoutMs)。这里调同一个平台 API：
  // 小数会当场抛 ERR_OUT_OF_RANGE —— 这是复现，不是断言，失败信息就是用户看到的那一条。
  const guarded = async (url, validators, limits) => {
    timeouts.push(limits.timeoutMs)
    AbortSignal.timeout(limits.timeoutMs)
    return impl(url, validators, limits)
  }

  const outcomes = await refreshFeeds([feedUrl], store, {
    ...BASE_OPTIONS,
    limits: { ...LIMITS, timeoutMs: 30_000 },
    instances: pool,
    fetchFeedImpl: guarded,
    clock: () => elapsed,
    now: () => new Date('2026-11-28T00:00:00.000Z'),
  })

  assert.equal(outcomes[0].status, 'failed', '两个实例都失败 ⇒ 该源单源降级，不掀翻整轮')
  assert.equal(timeouts.length, 2, '两个实例都试过')
  for (const value of timeouts) {
    assert.ok(Number.isInteger(value), 'AbortSignal.timeout 只收整数毫秒，收到 ' + value)
  }
  assert.ok(timeouts[1] <= 8_000 && timeouts[1] > 0,
    '预算语义不变：第一个用满 12s 后第二个只剩 ≤8s，收到 ' + timeouts[1])
})

test('预算：第一个拖到 20s 预算耗尽 ⇒ 不再发起第二个请求', async () => {
  const store = strictMemoryStore()
  const feedUrl = 'https://hub-a.test/expired/baoyu'
  const pool = ['https://hub-a.test', 'https://hub-b.test']
  await store.saveFeed(feedUrl, {
    url: feedUrl,
    title: '博客',
    rsshub: { namespace: 'expired', path: '/expired/baoyu', instance: 'https://hub-a.test' },
  })
  let elapsed = 0
  const { impl, calls } = fetchStub({
    [feedUrl]: () => {
      elapsed = 20_000
      return { kind: 'failed', reason: '超时（20000ms）' }
    },
    ['https://hub-b.test/expired/baoyu']: { kind: 'ok', body: rss('不该到这里'), finalUrl: 'https://hub-b.test/expired/baoyu' },
  })

  const outcomes = await refreshFeeds([feedUrl], store, {
    ...BASE_OPTIONS, instances: pool, fetchFeedImpl: impl, clock: () => elapsed,
    now: () => new Date('2026-11-28T00:00:00.000Z'),
  })

  assert.equal(calls.length, 1, '总预算用光后不许再发第二个请求')
  assert.equal(outcomes[0].status, 'failed')
})

test('切换条件：200 但不是 feed（解析不出）也切下一个实例', async () => {
  const store = strictMemoryStore()
  const feedUrl = 'https://hub-a.test/html/baoyu'
  const pool = ['https://hub-a.test', 'https://hub-b.test']
  await store.saveFeed(feedUrl, {
    url: feedUrl,
    title: '博客',
    rsshub: { namespace: 'html', path: '/html/baoyu', instance: 'https://hub-a.test' },
  })
  const { impl, calls } = fetchStub({
    [feedUrl]: { kind: 'ok', body: '<html><body>502 Bad Gateway</body></html>', finalUrl: feedUrl },
    ['https://hub-b.test/html/baoyu']: { kind: 'ok', body: rss('真 feed'), finalUrl: 'https://hub-b.test/html/baoyu' },
  })

  const outcomes = await refreshFeeds([feedUrl], store, { ...BASE_OPTIONS, instances: pool, fetchFeedImpl: impl })

  assert.equal(calls.length, 2, '200 的 HTML 错误页不是内容 ⇒ 必须切下一个')
  assert.deepEqual(outcomes[0].instancesAttempted, pool)
  assert.equal(outcomes[0].status, 'added')
})

test('冷却（装配）：连续失败 2 次的实例被排到最后；10 分钟后回到原顺序', async () => {
  const store = strictMemoryStore()
  const feedUrl = 'https://hub-a.test/cool/baoyu'
  const pool = ['https://hub-a.test', 'https://hub-b.test', 'https://hub-c.test']
  await store.saveFeed(feedUrl, {
    url: feedUrl,
    title: '博客',
    rsshub: { namespace: 'cool', path: '/cool/baoyu', instance: 'https://hub-a.test' },
  })
  let nowMs = Date.parse('2026-11-28T00:00:00.000Z')
  const now = () => new Date(nowMs)
  const status = { a: 'ok', b: 'ok', c: 'ok' }
  const routes = {
    [feedUrl]: () => status.a === 'ok'
      ? { kind: 'ok', body: rss('A'), finalUrl: feedUrl }
      : { kind: 'failed', reason: 'HTTP 503' },
    ['https://hub-b.test/cool/baoyu']: () => status.b === 'ok'
      ? { kind: 'ok', body: rss('B'), finalUrl: 'https://hub-b.test/cool/baoyu' }
      : { kind: 'failed', reason: 'HTTP 502' },
    ['https://hub-c.test/cool/baoyu']: () => status.c === 'ok'
      ? { kind: 'ok', body: rss('C'), finalUrl: 'https://hub-c.test/cool/baoyu' }
      : { kind: 'failed', reason: 'HTTP 500' },
  }
  const run = async () => {
    const stub = fetchStub(routes)
    const outcomes = await refreshFeeds([feedUrl], store, {
      ...BASE_OPTIONS, instances: pool, fetchFeedImpl: stub.impl, now,
    })
    return { calls: stub.calls, outcome: outcomes[0] }
  }

  // ① A 成功 ⇒ 记住 A 为首选。
  let result = await run()
  assert.deepEqual(result.outcome.instancesAttempted, ['https://hub-a.test'])

  // ② A、B 各失败一次（B 从「没失败过」变成连败 1 次）。
  status.a = 'failed'
  status.b = 'failed'
  result = await run()
  assert.deepEqual(result.outcome.instancesAttempted, ['https://hub-a.test', 'https://hub-b.test'])

  // ③ A 第 2 次失败 ⇒ 进入冷却；B 成功 ⇒ 首选变成 B、B 的连败清零。
  status.b = 'ok'
  result = await run()
  assert.deepEqual(result.outcome.instancesAttempted, ['https://hub-a.test', 'https://hub-b.test'])

  // ④ 首选 B 失败。A 在冷却期 ⇒ 顺序是 B → C（A 被排到最后），不是 B → A。
  status.b = 'failed'
  result = await run()
  assert.deepEqual(result.outcome.instancesAttempted, ['https://hub-b.test', 'https://hub-c.test'],
    '冷却中的 A 必须排在未冷却的 C 后面')

  // ⑤ 10 分钟后冷却到期 ⇒ A 回到候选顺序里（此时首选是上轮成功的 C），C 失败后应轮到 A。
  nowMs += 10 * 60 * 1000 + 1
  status.a = 'ok'
  status.c = 'failed'
  result = await run()
  assert.deepEqual(result.outcome.instancesAttempted, ['https://hub-c.test', 'https://hub-a.test'],
    '冷却到期必须恢复原顺序（永不恢复的变异会在这里露馅）')
})

// ── 条件请求只对准「上次成功的那台」（R15 评审 #7）──────────────────────────

test('条件请求：记录实例仍在池中且排第一 ⇒ 照常带 ETag / Last-Modified（增量抓取不退化）', async () => {
  const store = strictMemoryStore()
  const feedUrl = 'https://hub-a.test/cond-ok/baoyu'
  const pool = ['https://hub-a.test', 'https://hub-b.test']
  await store.saveFeed(feedUrl, {
    url: feedUrl,
    title: '博客',
    etag: '"old"',
    lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    // 内容版本已是最新：本轮不是「正文升级轮」，条件头该照常发。
    contentRevision: 2,
    rsshub: { namespace: 'cond-ok', path: '/cond-ok/baoyu', instance: 'https://hub-a.test' },
  })
  const { impl, calls } = fetchStub({
    [feedUrl]: { kind: 'not-modified', etag: '"old"', lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
  })

  const outcomes = await refreshFeeds([feedUrl], store, { ...BASE_OPTIONS, instances: pool, fetchFeedImpl: impl })

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].validators, { etag: '"old"', lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
    '候选第一个就是上次成功的那台 ⇒ 条件头必须照带，否则每轮都全量重抓')
  assert.equal(outcomes[0].status, 'not-modified')
})

test('条件请求：记录实例不在池中 ⇒ 第一个候选不得带它的条件头（防止 304 被记成新实例成功）', async () => {
  // 病象：旧判据是「本次第一个候选 ⇒ 带 validators」。当记录里的实例被移出池子 / 正在冷却时，
  // 第一个候选并不是上次成功的那台，却仍带上它的 ETag —— 别的实例回 304 会被当成成功，
  // 并把 rsshub.instance 记成一台根本没取过内容的实例。
  const store = strictMemoryStore()
  const feedUrl = 'https://gone.test/cond-gone/baoyu'
  const pool = ['https://hub-a.test', 'https://hub-b.test']
  await store.saveFeed(feedUrl, {
    url: feedUrl,
    title: '博客',
    etag: '"old"',
    lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    contentRevision: 2,
    rsshub: { namespace: 'cond-gone', path: '/cond-gone/baoyu', instance: 'https://gone.test' },
  })
  const { impl, calls } = fetchStub({
    ['https://hub-a.test/cond-gone/baoyu']: {
      kind: 'ok', body: rss('来自池首'), finalUrl: 'https://hub-a.test/cond-gone/baoyu',
    },
  })

  const outcomes = await refreshFeeds([feedUrl], store, { ...BASE_OPTIONS, instances: pool, fetchFeedImpl: impl })

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].validators, {},
    '记录实例已不在池中 ⇒ 第一个候选不是它，绝不能带它的 ETag / Last-Modified')
  assert.equal(outcomes[0].status, 'added')
  assert.equal(store.feed(feedUrl).rsshub.instance, 'https://hub-a.test', '只记实际取到内容的实例')
})

test('条件请求：老记录没有 rsshub.instance ⇒ 任何候选都不带条件头（宁可多一次 200）', async () => {
  const store = strictMemoryStore()
  const feedUrl = 'https://hub-a.test/cond-legacy/baoyu'
  const pool = ['https://hub-a.test', 'https://hub-b.test']
  await store.saveFeed(feedUrl, {
    url: feedUrl,
    title: '博客',
    etag: '"old"',
    lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    contentRevision: 2,
    // 有 rsshub 来源（namespace/path）但没记过 instance：老记录升级后的形状。
    rsshub: { namespace: 'cond-legacy', path: '/cond-legacy/baoyu' },
  })
  const { impl, calls } = fetchStub({
    [feedUrl]: { kind: 'ok', body: rss('老记录'), finalUrl: feedUrl },
  })

  await refreshFeeds([feedUrl], store, { ...BASE_OPTIONS, instances: pool, fetchFeedImpl: impl })

  assert.deepEqual(calls[0].validators, {}, '没有 instance 事实就没有「上次成功的那台」，条件头一律不带')
})

// ── F1（2026-11-28 评审）：相对链接必须按**实际提供内容的实例**绝对化 ─────────────

test('F1：切到次选实例后，条目里的相对 link 按次选实例绝对化（不是订阅 URL 的实例）', async () => {
  // 病象：内容来自 hub-b，而条目 link 被拼到 hub-a 上 —— 落库的 rsshub.instance 与 link 互相矛盾，
  // 且缺 guid 的源会把 link 当身份依据（feed/item-id.ts），下一轮再切回来可能记成新条目。
  const store = strictMemoryStore()
  const feedUrl = 'https://hub-a.test/rel/baoyu'
  const pool = ['https://hub-a.test', 'https://hub-b.test']
  await store.saveFeed(feedUrl, {
    url: feedUrl,
    title: '博客',
    rsshub: { namespace: 'rel', path: '/rel/baoyu', instance: 'https://hub-a.test' },
  })
  // 相对链接（RSS 规范允许）：/post/1 必须相对**取到它的那台实例**解析。
  const relative = '<?xml version="1.0"?><rss version="2.0"><channel><title>相对</title>'
    + '<item><title>a</title><link>/post/1</link><guid>g1</guid></item></channel></rss>'
  const { impl, calls } = fetchStub({
    [feedUrl]: { kind: 'failed', reason: 'HTTP 503' },
    ['https://hub-b.test/rel/baoyu']: { kind: 'ok', body: relative, finalUrl: 'https://hub-b.test/rel/baoyu' },
  })

  const outcomes = await refreshFeeds([feedUrl], store, { ...BASE_OPTIONS, instances: pool, fetchFeedImpl: impl })

  assert.equal(calls.length, 2, '前置：首选 503 后切到次选')
  assert.equal(store.feed(feedUrl).rsshub.instance, 'https://hub-b.test', '来源记的是实际成功的实例')
  assert.equal(store.items.size, 1)
  const [itemId] = [...store.items.keys()]
  assert.equal(store.item(itemId).link, 'https://hub-b.test/post/1',
    '相对 link 必须按实际提供内容的实例绝对化（F1）')
  assert.equal(outcomes[0].status, 'added')
})

test('F1：同一实例（首选就成功）时相对 link 仍按该实例绝对化，与改动前逐字一致', async () => {
  const store = strictMemoryStore()
  const feedUrl = 'https://hub-a.test/rel-same/baoyu'
  const pool = ['https://hub-a.test', 'https://hub-b.test']
  await store.saveFeed(feedUrl, {
    url: feedUrl,
    title: '博客',
    rsshub: { namespace: 'rel-same', path: '/rel-same/baoyu', instance: 'https://hub-a.test' },
  })
  const relative = '<?xml version="1.0"?><rss version="2.0"><channel><title>相对</title>'
    + '<item><title>a</title><link>/post/1</link><guid>g1</guid></item></channel></rss>'
  const { impl, calls } = fetchStub({
    [feedUrl]: { kind: 'ok', body: relative, finalUrl: feedUrl },
  })

  await refreshFeeds([feedUrl], store, { ...BASE_OPTIONS, instances: pool, fetchFeedImpl: impl })

  assert.equal(calls.length, 1, '首选成功 ⇒ 只请求一次')
  const [itemId] = [...store.items.keys()]
  assert.equal(store.item(itemId).link, 'https://hub-a.test/post/1', '首选路径的行为不许漂')
})

test('F1：非 RSSHub 源（单请求路径）的相对 link 同样按 finalUrl 绝对化', async () => {
  // 这一支不走切换，但 baseUrl 现在统一来自 FetchResult.finalUrl —— 顺手钉住它没被改坏。
  const store = strictMemoryStore()
  const feedUrl = 'https://site.test/feed.xml'
  await store.saveFeed(feedUrl, { url: feedUrl, title: '原生源' })
  const relative = '<?xml version="1.0"?><rss version="2.0"><channel><title>原生</title>'
    + '<item><title>a</title><link>/post/2</link><guid>g1</guid></item></channel></rss>'
  const { impl } = fetchStub({
    [feedUrl]: { kind: 'ok', body: relative, finalUrl: feedUrl },
  })

  await refreshFeeds([feedUrl], store, { ...BASE_OPTIONS, fetchFeedImpl: impl })

  const [itemId] = [...store.items.keys()]
  assert.equal(store.item(itemId).link, 'https://site.test/post/2')
  assert.equal(store.feed(feedUrl).rsshub, undefined, '非 RSSHub 源不许被标成 RSSHub')
})

test('F1：重定向后的相对 link 按**落点**绝对化（finalUrl 而不是订阅 URL）', async () => {
  const store = strictMemoryStore()
  const feedUrl = 'https://hub-a.test/rel-redirect/baoyu'
  const pool = ['https://hub-a.test']
  await store.saveFeed(feedUrl, {
    url: feedUrl,
    title: '博客',
    rsshub: { namespace: 'rel-redirect', path: '/rel-redirect/baoyu', instance: 'https://hub-a.test' },
  })
  const relative = '<?xml version="1.0"?><rss version="2.0"><channel><title>相对</title>'
    + '<item><title>a</title><link>post/1</link><guid>g1</guid></item></channel></rss>'
  const { impl } = fetchStub({
    // 实例把这条路由 301 到带尾斜杠的规范地址：相对链接必须相对**落点**解析。
    [feedUrl]: { kind: 'ok', body: relative, finalUrl: 'https://hub-a.test/rel-redirect/baoyu/' },
  })

  await refreshFeeds([feedUrl], store, { ...BASE_OPTIONS, instances: pool, fetchFeedImpl: impl })

  const [itemId] = [...store.items.keys()]
  assert.equal(store.item(itemId).link, 'https://hub-a.test/rel-redirect/baoyu/post/1',
    '相对链接按落点目录解析，不是按订阅 URL 的目录')
})
