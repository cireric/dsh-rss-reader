/**
 * R8a 03：把 RSSHub Radar 接进「发现候选」（spec §4.2 / §4.5 / §4.6 / §6 / §7 A1–A5、A9–A10）。
 *
 * 这一层钉的是**编排**：页面路径不受影响、Radar 只做加法、失败只产一条警告、未配置时零请求、
 * 合并顺序与上限。规则推导本身在 tests/rsshub.test.mjs（02 票），这里用真实规则形状的样本喂它。
 *
 * 出网全部用桩（`fetchImpl`）——除了 A9：那一条刻意把 Radar 请求**转交给真实 fetchFeed**，
 * 因为「私网被拒」是 fetch 层的行为，桩掉它就等于把安全边界换成断言一句注释。
 *
 * 04 票加了进程内缓存后，本文件的用例共用同一个 `BASE`：每个用例前必须清缓存，否则同一
 * 「实例 + 域名」的规则（或失败）会跨用例串味。缓存语义本身在 tests/radar-cache.test.mjs。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../lib/config.js'
import { createDispatch } from '../lib/endpoints.js'
import { fetchFeed } from '../lib/feed/fetch.js'
import { createMemoryStore } from '../lib/memory-store.js'
import { clearRadarCache } from '../lib/radar.js'
import { discoverCandidates } from '../lib/subscribe.js'

const LIMITS = { timeoutMs: 1000, maxBytes: 1024 * 1024, trustedTarget: true }
const RSS = '<?xml version="1.0"?><rss version="2.0"><channel><title>合法源</title>'
  + '<item><title>a</title><link>https://ex.test/a</link><guid>g1</guid></item></channel></rss>'
const BASE = 'https://hub.test'

const htmlPage = (...links) => '<html><head>' + links.join('') + '</head><body>普通网页</body></html>'
const feedLink = (href, type = 'application/rss+xml') =>
  '<link rel="alternate" type="' + type + '" href="' + href + '">'

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

const radarUrl = (domain) => BASE + '/api/radar/rules/' + domain

beforeEach(() => clearRadarCache())

const GITHUB_RULES = JSON.stringify({
  _name: 'GitHub',
  '.': [
    { title: '仓库分支', source: ['/:user/:repo'], target: '/github/branches/:user/:repo' },
    { title: '贡献者', source: ['/:user/:repo'], target: '/github/contributors/:user/:repo' },
  ],
})

test('A1：页面没有 RSS 声明时出现 RSSHub 候选（来源/站点名/地址形状），页面警告仍在', async () => {
  const fetchImpl = stubFetch({
    'https://github.com/DIYgod/RSSHub': { kind: 'ok', body: htmlPage() },
    [radarUrl('github.com')]: { kind: 'ok', body: GITHUB_RULES },
  })
  const result = await discoverCandidates('https://github.com/DIYgod/RSSHub', {
    limits: LIMITS, concurrency: 1, fetchImpl, rsshubBase: BASE,
  })

  assert.deepEqual(result.candidates.map((candidate) => candidate.url), [
    BASE + '/github/branches/DIYgod/RSSHub',
    BASE + '/github/contributors/DIYgod/RSSHub',
  ], '候选必须按规则顺序拼出来')
  assert.deepEqual(result.candidates.map((candidate) => candidate.source), ['rsshub', 'rsshub'])
  assert.equal(result.candidates[0].title, '仓库分支')
  assert.equal(result.candidates[0].siteName, 'GitHub', '第二行要显示站点名')
  assert.equal(result.candidates[0].format, undefined, 'Radar 候选没有 format（未验证）')
  assert.equal(result.candidates[0].itemCount, undefined, 'Radar 候选没有 itemCount（未验证）')
  assert.match(result.warnings[0].reason, /未发现公开声明的订阅源/, '页面自己没声明这件事仍要如实说明')
})

test('A1 顺序：页面候选在前、Radar 在后，两类各带来源标记', async () => {
  const rules = JSON.stringify({
    _name: '示例站',
    '.': [{ title: '帖子', source: ['/post/:id'], target: '/example/post/:id' }],
  })
  const fetchImpl = stubFetch({
    'https://site.test/post/1': { kind: 'ok', body: htmlPage(feedLink('/a.xml')) },
    'https://site.test/a.xml': { kind: 'ok', body: RSS },
    [radarUrl('site.test')]: { kind: 'ok', body: rules },
  })
  const result = await discoverCandidates('https://site.test/post/1', {
    limits: LIMITS, concurrency: 1, fetchImpl, rsshubBase: BASE,
  })

  assert.deepEqual(result.candidates.map((candidate) => candidate.url),
    ['https://site.test/a.xml', BASE + '/example/post/1'], '页面在前、Radar 在后')
  assert.equal(result.candidates[0].source, 'page')
  assert.equal(result.candidates[1].source, 'rsshub')
})

test('A4：页面抓取失败仍查 Radar（用用户给的 URL 取域名），页面失败原因与 Radar 候选并存', async () => {
  const fetchImpl = stubFetch({
    [radarUrl('down.test')]: { kind: 'ok', body: GITHUB_RULES },
  })
  const result = await discoverCandidates('https://down.test/DIYgod/RSSHub', {
    limits: LIMITS, concurrency: 1, fetchImpl, rsshubBase: BASE,
  })

  assert.deepEqual(fetchImpl.calls.map((call) => call.url),
    ['https://down.test/DIYgod/RSSHub', radarUrl('down.test')],
    '页面失败后仍要发 Radar 请求（没有 finalUrl 就用用户给的 URL）')
  assert.deepEqual(result.candidates.map((candidate) => candidate.source), ['rsshub', 'rsshub'])
  assert.match(result.warnings[0].reason, /HTTP 500/, '页面失败原因不能因为 Radar 有结果就消失')
})

test('A5：未配置实例 → 零 Radar 请求、零 Radar 警告', async () => {
  const fetchImpl = stubFetch({
    'https://site.test/': { kind: 'ok', body: htmlPage(feedLink('/a.xml')) },
    'https://site.test/a.xml': { kind: 'ok', body: RSS },
  })
  const result = await discoverCandidates('https://site.test/', { limits: LIMITS, concurrency: 1, fetchImpl })

  assert.deepEqual(fetchImpl.calls.map((call) => call.url),
    ['https://site.test/', 'https://site.test/a.xml'], '未配置时只有页面路径的请求')
  assert.deepEqual(result.candidates.map((candidate) => candidate.source), ['page'])
  assert.deepEqual(result.warnings, [], '未配置不是错误，默认状态不该天天吵')
})

test('A9：私网实例被 fetch 层拒绝 → 一条警告（url = 实例地址），页面候选不受影响', async () => {
  // 只把 Radar 请求交给真实 fetchFeed：它会先过 blockedReason，私网地址在出网前就被拒。
  const pageStub = stubFetch({
    'https://site.test/': { kind: 'ok', body: htmlPage(feedLink('/a.xml')) },
    'https://site.test/a.xml': { kind: 'ok', body: RSS },
  })
  const fetchImpl = async (url, validators, limits) => {
    if (url.startsWith('http://127.0.0.1')) return fetchFeed(url, validators, limits)
    return pageStub(url, validators, limits)
  }
  const result = await discoverCandidates('https://site.test/', {
    limits: LIMITS, concurrency: 1, fetchImpl, rsshubBase: 'http://127.0.0.1:1200',
  })

  assert.deepEqual(result.candidates.map((candidate) => candidate.url), ['https://site.test/a.xml'])
  const radarWarnings = result.warnings.filter((warning) => warning.url === 'http://127.0.0.1:1200')
  assert.equal(radarWarnings.length, 1, '实例故障只产一条警告')
  assert.match(radarWarnings[0].reason, /内网|127\.0\.0\.1/, '警告必须说清是内网地址被拒')
})

test('A10：用户给的就是 feed → 提前返回，Radar 零请求', async () => {
  const fetchImpl = stubFetch({ 'https://feed.test/rss': { kind: 'ok', body: RSS } })
  const result = await discoverCandidates('https://feed.test/rss', {
    limits: LIMITS, concurrency: 1, fetchImpl, rsshubBase: BASE,
  })

  assert.deepEqual(fetchImpl.calls.map((call) => call.url), ['https://feed.test/rss'], '不查 Radar')
  assert.equal(result.candidates.length, 1)
  assert.deepEqual(result.warnings, [])
})

test('跳过计数汇总成一条警告：缺参 + 通配 + 正则 = 3', async () => {
  const rules = JSON.stringify({
    _name: '示例站',
    '.': [
      { title: '缺参', source: ['/'], target: '/x/:missing' },
      { title: '通配', source: ['/'], target: '/wild/*' },
      { title: '正则', source: ['/'], target: '/re/{.+}' },
    ],
  })
  const fetchImpl = stubFetch({
    'https://site.test/': { kind: 'ok', body: htmlPage(feedLink('/a.xml')) },
    'https://site.test/a.xml': { kind: 'ok', body: RSS },
    [radarUrl('site.test')]: { kind: 'ok', body: rules },
  })
  const result = await discoverCandidates('https://site.test/', {
    limits: LIMITS, concurrency: 1, fetchImpl, rsshubBase: BASE,
  })

  const skipWarnings = result.warnings.filter((warning) => /无法拼出完整地址/.test(warning.reason))
  assert.equal(skipWarnings.length, 1, '三类跳过只汇总成一条')
  assert.match(skipWarnings[0].reason, /^3 条规则无法拼出完整地址$/)
  assert.equal(result.candidates.length, 1, '拼不出的规则不产生候选')
})

test('域名逐级回退：首个空 body 继续下一个域，命中即停', async () => {
  const rules = JSON.stringify({
    _name: '知乎',
    '.': [{ title: '问题', source: ['/question/:id'], target: '/zhihu/question/:id' }],
  })
  const fetchImpl = stubFetch({
    'https://www.zhihu.com/question/1': { kind: 'ok', body: htmlPage() },
    'https://hub.test/api/radar/rules/zhihu.com': { kind: 'ok', body: '' },
    'https://hub.test/api/radar/rules/www.zhihu.com': { kind: 'ok', body: rules },
  })
  const result = await discoverCandidates('https://www.zhihu.com/question/1', {
    limits: LIMITS, concurrency: 1, fetchImpl, rsshubBase: BASE,
  })

  assert.deepEqual(fetchImpl.calls.slice(1).map((call) => call.url), [
    'https://hub.test/api/radar/rules/zhihu.com',
    'https://hub.test/api/radar/rules/www.zhihu.com',
  ], '空 body = 该域没规则，继续下一级')
  assert.deepEqual(result.candidates.map((candidate) => candidate.url), [BASE + '/zhihu/question/1'])
  assert.deepEqual(result.warnings.map((warning) => warning.url), ['https://www.zhihu.com/question/1'],
    '查空不是错误：唯一的警告来自「页面自己没声明」，没有 Radar 警告')
})

test('域名回退：最短域命中后不再请求更具体的域（最多一次请求）', async () => {
  const rules = JSON.stringify({
    _name: '知乎',
    '.': [{ title: '问题', source: ['/question/:id'], target: '/zhihu/question/:id' }],
  })
  const fetchImpl = stubFetch({
    'https://www.zhihu.com/question/1': { kind: 'ok', body: htmlPage() },
    'https://hub.test/api/radar/rules/zhihu.com': { kind: 'ok', body: rules },
  })
  await discoverCandidates('https://www.zhihu.com/question/1', {
    limits: LIMITS, concurrency: 1, fetchImpl, rsshubBase: BASE,
  })
  assert.deepEqual(fetchImpl.calls.map((call) => call.url), [
    'https://www.zhihu.com/question/1',
    'https://hub.test/api/radar/rules/zhihu.com',
  ])
})

test('实例返回非 JSON / 非 2xx：一条警告（url = 实例地址），发现整体仍是 ok', async () => {
  for (const outcome of [
    { kind: 'ok', body: '<html>not json</html>' },
    { kind: 'failed', reason: 'HTTP 503' },
  ]) {
    // 两种失败共用同一个 BASE + site.test，缓存会串味：每轮先清。
    clearRadarCache()
    const fetchImpl = stubFetch({
      'https://site.test/': { kind: 'ok', body: htmlPage(feedLink('/a.xml')) },
      'https://site.test/a.xml': { kind: 'ok', body: RSS },
      [radarUrl('site.test')]: outcome,
    })
    const result = await discoverCandidates('https://site.test/', {
      limits: LIMITS, concurrency: 1, fetchImpl, rsshubBase: BASE,
    })
    assert.deepEqual(result.candidates.map((candidate) => candidate.url), ['https://site.test/a.xml'],
      '实例故障不许影响页面候选')
    assert.equal(result.warnings.length, 1, '实例故障只产一条警告')
    assert.equal(result.warnings[0].url, BASE)
    assert.match(result.warnings[0].reason, /RSSHub 实例/)
  }
})

test('合并去重：同一个归一化 URL 只留页面那条（页面优先）', async () => {
  const rules = JSON.stringify({
    _name: '示例站',
    '.': [{ title: '根', source: ['/'], target: '/feed.xml' }],
  })
  const fetchImpl = stubFetch({
    'https://site.test/': { kind: 'ok', body: htmlPage(feedLink('/feed.xml')) },
    'https://site.test/feed.xml': { kind: 'ok', body: RSS },
    [radarUrl('site.test')]: { kind: 'ok', body: rules },
  })
  const result = await discoverCandidates('https://site.test/', {
    limits: LIMITS, concurrency: 1, fetchImpl, rsshubBase: BASE.replace('hub.test', 'site.test'),
  })

  assert.equal(result.candidates.length, 1, '同一个地址只留一条')
  assert.equal(result.candidates[0].source, 'page', '重复时页面候选优先')
  assert.equal(result.candidates[0].format, 'rss2', '留下的必须是页面那条（带 format）')
})

test('合并上限：页面 4 条 + Radar 3 条 ⇒ 总共 5 条，Radar 只补 1 条', async () => {
  const links = ['/f0.xml', '/f1.xml', '/f2.xml', '/f3.xml']
  const map = {
    'https://site.test/': { kind: 'ok', body: htmlPage(...links.map((href) => feedLink(href))) },
    [radarUrl('site.test')]: {
      kind: 'ok',
      body: JSON.stringify({
        _name: '示例站',
        '.': ['a', 'b', 'c'].map((slug) => ({ title: slug, source: ['/'], target: '/radar/' + slug })),
      }),
    },
  }
  for (const href of links) map['https://site.test' + href] = { kind: 'ok', body: RSS }
  const result = await discoverCandidates('https://site.test/', {
    limits: LIMITS, concurrency: 1, fetchImpl: stubFetch(map), rsshubBase: BASE,
  })

  assert.equal(result.candidates.length, 5)
  assert.deepEqual(result.candidates.map((candidate) => candidate.source),
    ['page', 'page', 'page', 'page', 'rsshub'])
})

test('Radar 请求不带 trustedTarget：即使页面路径是可信目标，实例请求也必须按不可信处理', async () => {
  const fetchImpl = stubFetch({
    'https://site.test/': { kind: 'ok', body: htmlPage() },
    [radarUrl('site.test')]: { kind: 'ok', body: GITHUB_RULES },
  })
  await discoverCandidates('https://site.test/DIYgod/RSSHub', {
    limits: LIMITS, concurrency: 1, fetchImpl, rsshubBase: BASE,
  })
  const radarCall = fetchImpl.calls.find((call) => call.url.startsWith(BASE))
  assert.ok(radarCall)
  assert.equal(radarCall.limits.trustedTarget, undefined, 'Radar 的 limits 只带超时与体积（trustedTarget 缺省 false）')
  assert.equal(fetchImpl.calls[0].limits.trustedTarget, true, '前置：页面请求本身继承了调用方的 trustedTarget')
})

/* ─────────────────── 端点接线：rsshubBase 来自 ctx.config，日志走 ctx.log ─────────────────── */

function endpointHarness(fetchImpl, config = {}) {
  const store = createMemoryStore()
  const lines = []
  const dispatch = createDispatch({
    config: Config({ timeoutMs: 4321, maxBytes: 2048, ...config }),
    log: (line) => { lines.push(line) },
    ready: () => store,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
    fetchImpl,
  })
  return { dispatch, lines }
}

test('端点：discoverFeeds 读 ctx.config.rsshubBase，并记一行「Radar：域名 → 命中 N 条，跳过 M 条」', async () => {
  const fetchImpl = stubFetch({
    'https://site.test/': { kind: 'ok', body: htmlPage(feedLink('/a.xml')) },
    'https://site.test/a.xml': { kind: 'ok', body: RSS },
    [radarUrl('site.test')]: {
      kind: 'ok',
      body: JSON.stringify({
        _name: '示例站',
        '.': [
          { title: '甲', source: ['/'], target: '/a' },
          { title: '乙', source: ['/'], target: '/b' },
        ],
      }),
    },
  })
  const h = endpointHarness(fetchImpl, { rsshubBase: BASE })
  const result = await h.dispatch('discoverFeeds', { url: 'https://site.test/' })

  assert.equal(result.ok, true)
  assert.equal(result.value.candidates.filter((candidate) => candidate.source === 'rsshub').length, 2,
    '端点必须把配置里的实例地址传下去（否则这里只有页面候选）')
  assert.ok(h.lines.some((line) => line === 'Radar：site.test → 命中 2 条，跳过 0 条'),
    '必须有一行可排查的 Radar 日志；实际：' + JSON.stringify(h.lines))
})

test('端点：未配置 rsshubBase 时没有 Radar 日志，也没有 Radar 请求', async () => {
  const fetchImpl = stubFetch({
    'https://site.test/': { kind: 'ok', body: htmlPage(feedLink('/a.xml')) },
    'https://site.test/a.xml': { kind: 'ok', body: RSS },
  })
  const h = endpointHarness(fetchImpl, {})
  const result = await h.dispatch('discoverFeeds', { url: 'https://site.test/' })

  assert.deepEqual(result.value.candidates.map((candidate) => candidate.source), ['page'])
  assert.equal(h.lines.some((line) => line.startsWith('Radar：')), false, '未配置不该有 Radar 日志')
  assert.equal(fetchImpl.calls.some((call) => call.url.startsWith('/api/radar')), false)
})

test('端点：config 里塞了带 path 的非法实例地址 → 零 Radar 请求，一条可读警告（profile patch 绕过保存校验）', async () => {
  // profile patch / Config 直接注入可以绕过 saveSettings 的入参校验；发现流程必须用
  // 与设置面同一个纯函数再验一次，否则会真的请求 `…/api/api/radar/…`（spec §4.1 的原始病象）。
  const fetchImpl = stubFetch({
    'https://site.test/': { kind: 'ok', body: htmlPage(feedLink('/a.xml')) },
    'https://site.test/a.xml': { kind: 'ok', body: RSS },
  })
  const h = endpointHarness(fetchImpl, { rsshubBase: 'https://hub.test/api' })
  const result = await h.dispatch('discoverFeeds', { url: 'https://site.test/' })

  assert.equal(result.ok, true, '非法实例地址不能把「发现」整体打成失败')
  assert.deepEqual(result.value.candidates.map((candidate) => candidate.source), ['page'],
    '页面候选必须照常返回')
  assert.equal(fetchImpl.calls.some((call) => call.url.includes('/api/radar/')), false,
    '非法地址必须零 Radar 请求；实际请求：' + JSON.stringify(fetchImpl.calls.map((call) => call.url)))
  const radarWarnings = result.value.warnings.filter((warning) => /实例地址不合法/.test(warning.reason))
  assert.equal(radarWarnings.length, 1, '必须有一条说明「实例地址不合法」的警告')
  assert.equal(radarWarnings[0].url, 'https://hub.test/api', '警告要指回被拒的原始地址')
})
