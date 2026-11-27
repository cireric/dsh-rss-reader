/**
 * 试读（R15 10，spec §4.3.3 / §6 A15）。
 *
 * 这里的判据全部落在**出网结果的语义**上：
 *  · `ok` 只看解析结果（HTML 200 也算失败；空 feed 0 条仍算可用）；
 *  · 单条固定 15 s（不吃全局 timeoutMs：实测有成功路由要 17.5–20 s）；
 *  · 私网 / 回环 / 非法协议统一「目标被安全策略拒绝」，且一个字都不回显；
 *  · 批量保序、缓存命中不出网、在飞复用、10 分钟过期、50 条上限。
 *
 * fetchImpl 是唯一被替换的出网层 —— 与 subscribe / testRsshub 同一手法。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../lib/config.js'
import { createDispatch } from '../lib/endpoints.js'
import { createMemoryStore } from '../lib/memory-store.js'
import { createProbeFeeds, probeFeeds } from '../lib/probe.js'

const RSS_TWO = '<?xml version="1.0"?><rss version="2.0"><channel><title>两条</title>'
  + '<item><title>a</title><link>https://ex.test/a</link><guid>g1</guid></item>'
  + '<item><title>b</title><link>https://ex.test/b</link><guid>g2</guid></item></channel></rss>'
const ATOM_EMPTY = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>空源</title></feed>'

/** 一份与生产同形的 dispatch；fetchImpl 是唯一被替换的出网层。 */
function harness(fetchImpl) {
  const store = createMemoryStore()
  return createDispatch({
    config: Config({ timeoutMs: 3000, maxBytes: 2048 }),
    log: () => {},
    ready: () => store,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
    fetchImpl,
  })
}

/** 桩抓取：按 URL 决定结果，并记录每次调用的入参。 */
function stubFetch(outcomeOf) {
  const calls = []
  const impl = async (url, validators, limits) => {
    calls.push({ url, validators, limits })
    return outcomeOf(url, calls.length)
  }
  return { calls, impl }
}

const okRss = (url) => ({ kind: 'ok', body: RSS_TWO, finalUrl: url })

test('试读端点：可用与空 feed 都按解析结果判 ok（空 feed 0 条也算可用）', async () => {
  const stub = stubFetch((url) => (
    url.includes('empty') ? { kind: 'ok', body: ATOM_EMPTY, finalUrl: url } : okRss(url)
  ))
  const dispatch = harness(stub.impl)
  const result = await dispatch('probeFeeds', { urls: ['https://ok.test/feed', 'https://empty.test/feed'] })

  assert.equal(result.ok, true, '试读本身是成功调用（每条结果在数组里）')
  assert.equal(Array.isArray(result.value), true, '出参必须是逐条结果数组')
  assert.equal(result.value.length, 2)
  assert.deepEqual(result.value.map((entry) => entry.ok), [true, true])
  assert.equal(result.value[0].url, 'https://ok.test/feed', '回显请求的地址，便于候选行对上号')
  assert.equal(result.value[0].format, 'rss2')
  assert.equal(result.value[0].itemCount, 2)
  assert.equal(result.value[1].format, 'atom')
  assert.equal(result.value[1].itemCount, 0, '解析成 0 条仍是可用 feed')
  for (const entry of result.value) {
    assert.equal(typeof entry.elapsedMs, 'number')
    assert.ok(entry.elapsedMs >= 0, '耗时必须是可展示的非负数')
    assert.equal(entry.reason, undefined, '成功不带失败原因')
  }
})

test('试读端点：HTML 页 / 304 / 超时都按失败处理并给出可读原因', async () => {
  const stub = stubFetch((url) => {
    if (url.includes('html')) return { kind: 'ok', body: '<html><body>普通网页</body></html>', finalUrl: url }
    if (url.includes('not-feed')) return { kind: 'ok', body: '<foo><bar>任意 XML</bar></foo>', finalUrl: url }
    if (url.includes('not-modified')) return { kind: 'not-modified' }
    return { kind: 'failed', reason: '超时（15000ms）' }
  })
  const dispatch = harness(stub.impl)
  const result = await dispatch('probeFeeds', {
    urls: ['https://html.test/page', 'https://not-feed.test/feed', 'https://not-modified.test/feed', 'https://timeout.test/feed'],
  })

  assert.equal(result.ok, true)
  const [html, notFeed, notModified, timeout] = result.value
  assert.equal(html.ok, false, 'HTTP 200 的 HTML 页不是 feed')
  assert.match(html.reason, /不是可识别的 feed/)
  assert.equal(notFeed.ok, false, '任意 XML 不是 feed')
  assert.match(notFeed.reason, /不是可识别的 feed/)
  assert.equal(notModified.ok, false, '304 不能当作可用')
  assert.match(notModified.reason, /304/, '304 的原因要能看懂')
  assert.equal(timeout.ok, false)
  assert.match(timeout.reason, /超时/)

  // 单条 15s 是常量，不能退回 min(timeoutMs, 10s)：config 里写的是 3000。
  assert.equal(stub.calls[0].limits.timeoutMs, 15000, '试读固定 15s，不吃全局 timeoutMs')
  assert.equal(stub.calls[0].limits.maxBytes, 2048, '体积上限仍用全局配置')
})

test('试读端点：私网 / 回环 / 非法协议一律拒绝，且不回显地址、不发出网请求', async () => {
  const stub = stubFetch((url) => okRss(url))
  const dispatch = harness(stub.impl)
  const privateUrls = [
    'http://127.0.0.1:1200/feed',
    'http://localhost/feed',
    'http://192.168.1.10/feed',
    'http://[::1]/feed',
  ]
  const result = await dispatch('probeFeeds', { urls: privateUrls })

  assert.equal(result.ok, true)
  for (const entry of result.value) {
    assert.equal(entry.ok, false, '内网地址不许判可用：' + entry.url)
    assert.equal(entry.reason, '目标被安全策略拒绝')
  }
  assert.equal(stub.calls.length, 0, '地址策略必须在出网前拒掉，一个请求都不发')
  const reasons = result.value.map((entry) => entry.reason).join('\n')
  for (const host of ['127.0.0.1', 'localhost', '192.168.1.10', '::1']) {
    assert.equal(reasons.includes(host), false, '失败原因不许回显 host / IP：' + host)
  }

  // 非法协议在端点的入参声明层就是 bad-request（只接受绝对 http(s)）；
  // 模块层直接调用时也必须给同一句可展示原因，且不回显 host。
  const direct = await probeFeeds(['ftp://secret.example/feed'], { maxBytes: 1024 })
  assert.equal(direct[0].ok, false)
  assert.equal(direct[0].reason, '目标被安全策略拒绝')
  assert.equal(direct[0].reason.includes('secret.example'), false, '非法协议也不回显 host')
})

test('试读端点：批量结果按入参顺序返回（慢的排在前面也不许乱序）', async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const stub = stubFetch(async (url) => {
    if (url.includes('slow')) await wait(30)
    if (url.includes('mid')) await wait(10)
    return okRss(url)
  })
  const dispatch = harness(stub.impl)
  const urls = ['https://slow.test/feed', 'https://fast.test/feed', 'https://mid.test/feed']
  const result = await dispatch('probeFeeds', { urls })

  assert.deepEqual(result.value.map((entry) => entry.url), urls, '结果顺序必须与入参一致')
  assert.deepEqual(result.value.map((entry) => entry.ok), [true, true, true])
  assert.equal(stub.calls.length, 3)
})

test('试读端点：不触碰 store（只读探测，入口不需要订阅状态）', async () => {
  let touched = false
  const store = new Proxy({}, {
    get() {
      touched = true
      throw new Error('试读不该读取 store')
    },
  })
  const stub = stubFetch((url) => okRss(url))
  const dispatch = createDispatch({
    config: Config({}),
    log: () => {},
    ready: () => store,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
    fetchImpl: stub.impl,
  })
  const result = await dispatch('probeFeeds', { urls: ['https://store-free.test/feed'] })
  assert.equal(result.ok, true)
  assert.equal(result.value[0].ok, true)
  assert.equal(touched, false, '试读是只读探测：读取 / 写入 store 的任何字段都不该发生')
})

// ── 缓存：进程内 Map，键 = 归一化 URL，10 分钟；在飞复用；上限 50 条按插入序淘汰 ──

test('试读缓存：同 URL 二次调用不再出网（归一化后的地址算同一个键）', async () => {
  const stub = stubFetch((url) => okRss(url))
  const probe = createProbeFeeds()
  const deps = { fetchImpl: stub.impl, maxBytes: 1024 }

  const first = await probe(['https://cache.test/feed'], deps)
  const second = await probe(['https://CACHE.test:443/feed'], deps)
  assert.equal(stub.calls.length, 1, '小写主机 + 默认端口归一后必须命中同一份缓存')
  assert.deepEqual(second[0], { ...first[0], url: 'https://CACHE.test:443/feed' },
    '缓存命中回原结果，但 url 回显本次请求的写法')
})

test('试读缓存：同一 URL 在飞时复用同一个 Promise', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const impl = async (url) => {
    calls += 1
    await gate
    return okRss(url)
  }
  const probe = createProbeFeeds()
  const deps = { fetchImpl: impl, maxBytes: 1024 }
  const first = probe(['https://inflight.test/feed'], deps)
  const second = probe(['https://inflight.test/feed'], deps)
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(calls, 1, '在飞期间同一 URL 只允许一次出网')
  assert.equal(a[0].ok, true)
  assert.deepEqual(b[0], a[0], '两个调用方拿到同一份结果')
})

test('试读缓存：10 分钟过期重抓；上限 50 条按插入序淘汰', async () => {
  let clock = 1_000_000
  const counts = new Map()
  const impl = async (url) => {
    counts.set(url, (counts.get(url) ?? 0) + 1)
    return okRss(url)
  }
  const probe = createProbeFeeds({ now: () => clock })
  const deps = { fetchImpl: impl, maxBytes: 1024 }

  const ttlUrl = 'https://ttl.test/feed'
  await probe([ttlUrl], deps)
  clock += 9 * 60 * 1000
  await probe([ttlUrl], deps)
  assert.equal(counts.get(ttlUrl), 1, '9 分钟内命中缓存')
  clock += 2 * 60 * 1000
  await probe([ttlUrl], deps)
  assert.equal(counts.get(ttlUrl), 2, '超过 10 分钟必须重抓')

  // 50 条上限：从空缓存开始灌 50 条，再加第 51 条，最早的必须被淘汰。
  const probe2 = createProbeFeeds()
  const urls = Array.from({ length: 50 }, (_, index) => 'https://cap-' + index + '.test/feed')
  for (const url of urls) await probe2([url], deps)
  const extra = 'https://cap-50.test/feed'
  await probe2([extra], deps)

  await probe2([urls[1]], deps)
  assert.equal(counts.get(urls[1]), 1, '只淘汰最旧的一条，其余仍在缓存里')
  await probe2([urls[0]], deps)
  assert.equal(counts.get(urls[0]), 2, '第 51 条插入后，最早那条被淘汰，再试必须重新出网')
})
