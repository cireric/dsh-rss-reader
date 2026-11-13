/**
 * 导入校验的编排语义：**坏源不阻断其余**（§3.1 的硬要求）、并发受控、200 的网页不算 feed。
 * 用桩抓取函数覆盖，不出网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverCandidates, validateSubscriptions } from '../lib/subscribe.js'

const LIMITS = { timeoutMs: 1000, maxBytes: 1024 * 1024, trustedTarget: true }
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

test('首页 URL 自动发现：用页面声明的 feed，并标出 discoveredFrom', async () => {
  const html = '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>'
  const map = { 'https://site.test/': { kind: 'ok', body: html }, 'https://site.test/feed.xml': { kind: 'ok', body: RSS } }
  const results = await validateSubscriptions(['https://site.test/'], { limits: LIMITS, concurrency: 1, fetchImpl: stubFetch(map) })
  assert.equal(results[0].ok, true, '首页应当被发现成可订阅')
  assert.equal(results[0].url, 'https://site.test/feed.xml', '订阅的必须是 feed 本身，不是首页')
  assert.equal(results[0].discoveredFrom, 'https://site.test/')
  assert.equal(results[0].format, 'rss2')
})

test('信任不跨源传播：同源候选继承可信目标、跨源候选一律不可信（安全边界）', async () => {
  const seen = []
  const fetchImpl = async (url, _headers, limits) => {
    seen.push({ url, trusted: limits.trustedTarget === true })
    if (url === 'https://site.test/') {
      const body = '<link rel="alternate" type="application/rss+xml" href="/feed.xml">'
        + '<link rel="alternate" type="application/rss+xml" href="https://evil.test/feed.xml">'
      return { kind: "ok", body }
    }
    return { kind: "failed", reason: "未通过" }
  }
  await validateSubscriptions(['https://site.test/'], { limits: LIMITS, concurrency: 1, fetchImpl })
  assert.deepEqual(seen[0], { url: 'https://site.test/', trusted: true }, '用户给的那个 URL 才是可信目标')
  const same = seen.find((entry) => entry.url === 'https://site.test/feed.xml')
  const cross = seen.find((entry) => entry.url === 'https://evil.test/feed.xml')
  assert.equal(same.trusted, true, '同源候选继承信任（否则内网自建站的 feed 会被自己拒掉）')
  assert.equal(cross.trusted, false, '跨源候选由页面内容决定，必须按不可信处理')
})

test('首页没有任何 feed 声明：原因要说清是「页面里没声明」，好指导下一步', async () => {
  const map = { 'https://plain.test/': { kind: 'ok', body: '<html><body>普通网页</body></html>' } }
  const results = await validateSubscriptions(['https://plain.test/'], { limits: LIMITS, concurrency: 1, fetchImpl: stubFetch(map) })
  assert.equal(results[0].ok, false)
  assert.match(results[0].reason, /也没声明 feed/)
})


/* ──────────────────────── M4 01：只发现、不订阅 ──────────────────────── */
/**
 * 这一组钉的是「发现」这条新路径的**契约**（不钉实现）：
 *  ① 直达 feed ⇒ 唯一候选，订阅身份仍是用户给的 URL；
 *  ② 页面声明的候选逐个校验，失败的逐条列出（而不是静默丢掉，让「为什么没发现」无从回答）；
 *  ③ 相对链接按**重定向后的最终页面 URL** 解析；
 *  ④ 信任不跨源，也不因一次重定向而升级；
 *  ⑤ 候选数有上限（一个页面挂几十个链接不能顺着全抓）。
 */
const ATOM = '<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom">'
  + '<title>原子源</title><updated>2024-05-01T12:00:00Z</updated>'
  + '<entry><title>e</title><link href="https://ex.test/e"/><id>tag:ex,1</id><updated>2024-05-02T00:00:00Z</updated></entry></feed>'
const htmlPage = (...links) => '<html><head>' + links.join('') + '</head><body>普通网页</body></html>'
const feedLink = (href, type = 'application/rss+xml') =>
  '<link rel="alternate" type="' + type + '" href="' + href + '">'

/**
 * 桩必须守住 fetchFeed 的真实回包形状（ok 带 body **与 finalUrl**）——
 * 少给 finalUrl 就等同于让被测代码拿 undefined 去解析相对链接，那是夹具漂移，不是代码该容忍的形状。
 */
function discoveryStub(map) {
  return async (url) => {
    const outcome = map[url]
    if (outcome === undefined) return { kind: 'failed', reason: 'HTTP 404' }
    return outcome.kind === 'ok' ? { ...outcome, finalUrl: outcome.finalUrl ?? url } : outcome
  }
}

test('发现：直达 RSS/Atom URL 就是唯一候选，订阅身份保留用户给的 URL（不换成重定向落点）', async () => {
  const result = await discoverCandidates('https://feed.test/rss', {
    limits: LIMITS, concurrency: 1,
    fetchImpl: discoveryStub({ 'https://feed.test/rss': { kind: 'ok', body: RSS, finalUrl: 'https://cdn.feed.test/rss' } }),
  })
  assert.deepEqual(result.warnings, [])
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].url, 'https://feed.test/rss', '订阅身份 = 用户给的那个 URL（addFeed 存的也是它）')
  assert.equal(result.candidates[0].format, 'rss2')
  assert.equal(result.candidates[0].title, '合法源')
  assert.equal(result.candidates[0].itemCount, 1)
})

test('发现：多个有效候选全部列出（保序），校验失败的进 warnings 而不是静默丢掉', async () => {
  const result = await discoverCandidates('https://site.test/', {
    limits: LIMITS, concurrency: 1,
    fetchImpl: discoveryStub({
      'https://site.test/': { kind: 'ok', body: htmlPage(feedLink('/a.xml'), feedLink('https://other.test/b.atom', 'application/atom+xml'), feedLink('/broken.xml')) },
      'https://site.test/a.xml': { kind: 'ok', body: RSS },
      'https://other.test/b.atom': { kind: 'ok', body: ATOM },
      'https://site.test/broken.xml': { kind: 'ok', body: '<html><body>任意路径都回 200 的网页</body></html>' },
    }),
  })
  assert.deepEqual(result.candidates.map((candidate) => candidate.url),
    ['https://site.test/a.xml', 'https://other.test/b.atom'], '候选保序')
  assert.deepEqual(result.candidates.map((candidate) => candidate.format), ['rss2', 'atom'])
  assert.deepEqual(result.warnings.map((warning) => warning.url), ['https://site.test/broken.xml'])
  assert.match(result.warnings[0].reason, /不是可识别的 feed/,
    '200 的普通网页必须被判为不可订阅，并说清原因')
})

test('发现：重定向后相对候选按**最终页面 URL** 解析', async () => {
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    if (url === 'https://site.test/') {
      return { kind: 'ok', body: htmlPage(feedLink('feed.xml')), finalUrl: 'https://www.site.test/blog/' }
    }
    if (url === 'https://www.site.test/blog/feed.xml') return { kind: 'ok', body: RSS, finalUrl: url }
    return { kind: 'failed', reason: 'HTTP 404' }
  }
  const result = await discoverCandidates('https://site.test/', { limits: LIMITS, concurrency: 1, fetchImpl })
  assert.deepEqual(seen, ['https://site.test/', 'https://www.site.test/blog/feed.xml'],
    '相对候选必须拼在落点上（按输入 URL 会拼到错的 host）')
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].url, 'https://www.site.test/blog/feed.xml')
})

test('发现：重复候选只算一个，候选数封顶 5 个', async () => {
  const links = Array.from({ length: 8 }, (_, index) => feedLink('/f' + index + '.xml'))
  const attempted = []
  const fetchImpl = async (url) => {
    if (url === 'https://site.test/') return { kind: 'ok', body: htmlPage(...links, feedLink('/f0.xml')), finalUrl: url }
    attempted.push(url)
    return { kind: 'failed', reason: 'HTTP 404' }
  }
  const result = await discoverCandidates('https://site.test/', { limits: LIMITS, concurrency: 1, fetchImpl })
  assert.equal(attempted.length, 5, '只校验前 5 个候选（页面挂几十个链接不能顺着全抓）')
  assert.equal(new Set(attempted).size, 5, '重复的 href 只校验一次')
  assert.equal(result.candidates.length, 0)
  assert.equal(result.warnings.length, 5, '每个校验失败的候选都要有一条原因')
})

test('发现：页面没有任何声明 → 零候选 + 一条可指导下一步的说明', async () => {
  const result = await discoverCandidates('https://plain.test/', {
    limits: LIMITS, concurrency: 1,
    fetchImpl: discoveryStub({ 'https://plain.test/': { kind: 'ok', body: htmlPage() } }),
  })
  assert.deepEqual(result.candidates, [])
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0].reason, /未发现公开声明的订阅源/)
})

test('发现：页面抓取失败 → 失败原因进 warnings（不抛异常、不冒充零结果）', async () => {
  const result = await discoverCandidates('https://down.test/', {
    limits: LIMITS, concurrency: 1,
    fetchImpl: async () => ({ kind: 'failed', reason: 'HTTP 500' }),
  })
  assert.deepEqual(result.candidates, [])
  assert.match(result.warnings[0].reason, /HTTP 500/)
})

test('发现：非法 URL 一个请求都不发', async () => {
  let calls = 0
  const result = await discoverCandidates('not a url', {
    limits: LIMITS, concurrency: 1,
    fetchImpl: async () => { calls += 1; return { kind: 'failed', reason: 'x' } },
  })
  assert.equal(calls, 0)
  assert.deepEqual(result.candidates, [])
  assert.match(result.warnings[0].reason, /不是合法 URL/)
})

test('发现：同源候选继承可信目标；跨源候选一律不可信', async () => {
  const seen = []
  const fetchImpl = async (url, _headers, limits) => {
    seen.push({ url, trusted: limits.trustedTarget === true })
    if (url === 'https://site.test/') {
      return { kind: 'ok', body: htmlPage(feedLink('/feed.xml'), feedLink('https://evil.test/feed.xml')), finalUrl: url }
    }
    return { kind: 'failed', reason: '未通过' }
  }
  await discoverCandidates('https://site.test/', { limits: LIMITS, concurrency: 1, fetchImpl })
  assert.deepEqual(seen[0], { url: 'https://site.test/', trusted: true }, '用户给的那个 URL 才是可信目标')
  assert.equal(seen.find((entry) => entry.url === 'https://site.test/feed.xml')?.trusted, true,
    '同源候选继承信任（否则内网自建站的 feed 会被自己拒掉）')
  assert.equal(seen.find((entry) => entry.url === 'https://evil.test/feed.xml')?.trusted, false,
    '跨源候选由页面内容决定，必须按不可信处理')
})

test('发现：一次重定向不能把候选升级成可信目标（落点只用于解析，不用于继承信任）', async () => {
  const seen = []
  const fetchImpl = async (url, _headers, limits) => {
    seen.push({ url, trusted: limits.trustedTarget === true })
    if (url === 'https://site.test/') {
      // 站点把首页 302 到另一个域名，那边声明了相对候选 —— 解析要跟落点，信任不能跟
      return { kind: 'ok', body: htmlPage(feedLink('/feed.xml')), finalUrl: 'https://mirror.test/' }
    }
    return { kind: 'failed', reason: '未通过' }
  }
  await discoverCandidates('https://site.test/', { limits: LIMITS, concurrency: 1, fetchImpl })
  const candidate = seen.find((entry) => entry.url === 'https://mirror.test/feed.xml')
  assert.ok(candidate, '相对候选要按最终页面 URL 解析')
  assert.equal(candidate.trusted, false, '信任只从用户给的 URL 继承；重定向目标按不可信处理')
})
