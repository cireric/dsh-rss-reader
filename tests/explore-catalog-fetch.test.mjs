/**
 * R8b 02：路由目录取表 + 12 小时实例键缓存（spec §4.2 / §4.7 / §4.8、§7 B10–B12 / B19）。
 *
 * 钉 `loadCatalog` 这一层的**对外行为**：出网预算、失败分型、实例键缓存与日志。投影本身
 * （坏条目跳过 / 字段裁剪 / 排序）是 01 的纯函数，这里只给最小桩投影 —— 在 02 重复测一遍
 * 会让两票的判据分家。全程桩 fetch + 可注入时钟：不真出网、不 sleep。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { catalogUrl, clearCatalogCache, loadCatalog } from '../lib/explore-catalog-fetch.js'

const BASE = 'https://hub.test'
const OTHER = 'https://other.test'
const TTL = 12 * 60 * 60 * 1000
const CATALOG_PATH = BASE + '/api/namespace'

/** 桩 fetch：按 URL 给回包，记录每次调用的 url / validators / limits。 */
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

/** 最小投影：认一个对象，把它的键当站点名带出去。 */
function projectSites(raw) {
  return { ok: true, value: { sites: Object.keys(raw) } }
}

beforeEach(() => clearCatalogCache())

test('catalogUrl：{base}/api/namespace 只有这一处拼法', () => {
  assert.equal(catalogUrl(BASE), 'https://hub.test/api/namespace')
})

test('首次拉表成功并建缓存：12h 内第二次零请求（桩件计数 1）', async () => {
  const fetchImpl = stubFetch({ [CATALOG_PATH]: { kind: 'ok', body: '{"github":{}}' } })
  const time = clock()
  const first = await loadCatalog(BASE, projectSites, { fetchImpl, now: time.now })

  assert.deepEqual(first, { kind: 'ok', catalog: { sites: ['github'] } })
  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(fetchImpl.calls[0].url, 'https://hub.test/api/namespace')

  const second = await loadCatalog(BASE, projectSites, { fetchImpl, now: time.now })
  assert.deepEqual(second, first, '命中缓存返回同一份投影')
  assert.equal(fetchImpl.calls.length, 1, '12h 内第二次必须零请求')
})

test('缓存 12h 过期：12h-1 仍命中，12h+1 后重新出网', async () => {
  const fetchImpl = stubFetch({ [CATALOG_PATH]: { kind: 'ok', body: '{"github":{}}' } })
  const time = clock()
  await loadCatalog(BASE, projectSites, { fetchImpl, now: time.now })

  time.advance(TTL - 1)
  await loadCatalog(BASE, projectSites, { fetchImpl, now: time.now })
  assert.equal(fetchImpl.calls.length, 1, '12h 内必须命中缓存')

  time.advance(2)
  await loadCatalog(BASE, projectSites, { fetchImpl, now: time.now })
  assert.equal(fetchImpl.calls.length, 2, '过期后必须重新出网')
})

test('失败不缓存：拉表失败后下一次立刻重试（桩件计数 2）', async () => {
  const fetchImpl = stubFetch({ [CATALOG_PATH]: { kind: 'failed', reason: 'HTTP 503' } })
  const time = clock()
  const first = await loadCatalog(BASE, projectSites, { fetchImpl, now: time.now })
  assert.deepEqual(first, { kind: 'failure', reason: 'HTTP 503' })

  const second = await loadCatalog(BASE, projectSites, { fetchImpl, now: time.now })
  assert.equal(second.kind, 'failure')
  assert.equal(fetchImpl.calls.length, 2, '失败不进缓存：第二次必须再出网')
})

test('换实例按新实例拉表：旧实例投影不会被拿去拼新实例地址', async () => {
  const fetchImpl = stubFetch({
    [CATALOG_PATH]: { kind: 'ok', body: '{"a":{}}' },
    [OTHER + '/api/namespace']: { kind: 'ok', body: '{"b":{}}' },
  })
  const time = clock()
  const first = await loadCatalog(BASE, projectSites, { fetchImpl, now: time.now })
  const second = await loadCatalog(OTHER, projectSites, { fetchImpl, now: time.now })

  assert.deepEqual(first.catalog, { sites: ['a'] })
  assert.deepEqual(second.catalog, { sites: ['b'] }, '第二个实例必须拿到自己的表')
  assert.deepEqual(
    fetchImpl.calls.map((call) => call.url),
    [CATALOG_PATH, OTHER + '/api/namespace'],
  )

  const back = await loadCatalog(BASE, projectSites, { fetchImpl, now: time.now })
  assert.deepEqual(back.catalog, { sites: ['a'] }, '切回旧实例命中它自己那份缓存')
  assert.equal(fetchImpl.calls.length, 2, '来回切换不重复拉表')
})

test('缓存键是归一后的源站：尾斜杠 / 大小写写法命中同一份', async () => {
  const fetchImpl = stubFetch({ [CATALOG_PATH]: { kind: 'ok', body: '{"github":{}}' } })
  const time = clock()
  await loadCatalog('https://HUB.test/', projectSites, { fetchImpl, now: time.now })
  const again = await loadCatalog(BASE, projectSites, { fetchImpl, now: time.now })

  assert.equal(again.kind, 'ok')
  assert.equal(fetchImpl.calls.length, 1, '同一源站的另一种写法必须命中同一份缓存')
  assert.equal(fetchImpl.calls[0].url, CATALOG_PATH, '请求地址也必须用归一后的源站')
})

test('未配置实例：零请求 + 可读原因', async () => {
  const fetchImpl = stubFetch({})
  const time = clock()
  for (const base of ['', '   ']) {
    const result = await loadCatalog(base, projectSites, { fetchImpl, now: time.now })
    assert.deepEqual(result, { kind: 'failure', reason: '未配置 RSSHub 实例地址' })
  }
  assert.equal(fetchImpl.calls.length, 0, '未配置必须零请求')
})

test('实例地址非法：零请求 + 可读原因', async () => {
  const fetchImpl = stubFetch({})
  const result = await loadCatalog('https://hub.test/api', projectSites, { fetchImpl })

  assert.equal(result.kind, 'failure')
  assert.match(result.reason, /不合法/)
  assert.equal(fetchImpl.calls.length, 0, '非法地址必须零请求')
})

test('304 当失败：不静默当成空目录', async () => {
  const fetchImpl = stubFetch({ [CATALOG_PATH]: { kind: 'not-modified' } })
  const result = await loadCatalog(BASE, projectSites, { fetchImpl })

  assert.equal(result.kind, 'failure')
  assert.match(result.reason, /304/)
})

test('非 JSON 与顶层形状非法各有可读原因，且都不缓存', async () => {
  const notJson = stubFetch({ [CATALOG_PATH]: { kind: 'ok', body: '<html>502 Bad Gateway</html>' } })
  const first = await loadCatalog(BASE, projectSites, { fetchImpl: notJson })
  assert.deepEqual(first, { kind: 'failure', reason: '响应不是路由表 JSON' })

  const badShapeProject = (raw) => (
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? { ok: true, value: raw }
      : { ok: false, reason: '路由表顶层必须是对象' }
  )
  const shape = stubFetch({ [CATALOG_PATH]: { kind: 'ok', body: '[]' } })
  const second = await loadCatalog(BASE, badShapeProject, { fetchImpl: shape })
  assert.deepEqual(second, { kind: 'failure', reason: '路由表顶层必须是对象' })

  const again = await loadCatalog(BASE, badShapeProject, { fetchImpl: shape })
  assert.equal(again.kind, 'failure')
  assert.equal(shape.calls.length, 2, '形状非法也不缓存：下一次必须重新出网')
})

test('私网实例被拒：原因指向内网地址，不是实例故障', async () => {
  const time = clock()
  // 不注入桩 fetch：走真实 fetchFeed 的地址策略。私网在 DNS / 连接之前就被 blockedReason 拒掉，
  // 不会真的发出网络请求 —— 这正是「出网不带 trustedTarget」的端到端判据。
  const result = await loadCatalog('http://127.0.0.1:1200', projectSites, { now: time.now })

  assert.equal(result.kind, 'failure')
  assert.match(result.reason, /内网地址/, '必须说清是内网地址被拒')
  assert.doesNotMatch(result.reason, /实例故障/)
})

test('出网只带 60s / 16MiB 专用预算，不带 trustedTarget', async () => {
  const fetchImpl = stubFetch({ [CATALOG_PATH]: { kind: 'ok', body: '{}' } })
  await loadCatalog(BASE, projectSites, { fetchImpl })

  assert.deepEqual(fetchImpl.calls[0].limits, { timeoutMs: 60_000, maxBytes: 16 * 1024 * 1024 })
  assert.equal('trustedTarget' in fetchImpl.calls[0].limits, false, '目录拉取不是可信目标')
  assert.deepEqual(fetchImpl.calls[0].validators, {}, '拉表不带条件头（否则会拿到 304）')
})

test('日志：成功一行带站数 / 路由数，失败一行带原因', async () => {
  const messages = []
  const log = (message) => messages.push(message)
  const fetchImpl = stubFetch({ [CATALOG_PATH]: { kind: 'ok', body: '{"github":{},"bilibili":{}}' } })
  const withTotals = () => ({ ok: true, value: { tag: 'x' }, totals: { siteTotal: 2, routeTotal: 5 } })

  await loadCatalog(BASE, withTotals, { fetchImpl, log })
  assert.deepEqual(messages, ['探索：拉取 https://hub.test 路由表 → 2 站 / 5 路由'])

  const cached = await loadCatalog(BASE, withTotals, { fetchImpl, log })
  assert.equal(cached.kind, 'ok')
  assert.equal(messages.length, 1, '命中缓存不重复记「拉取」')

  // 上一段已把 BASE 的表写进缓存；失败分支要重新出网，先清掉（缓存是进程级，跨用例共享）。
  clearCatalogCache()
  const failing = stubFetch({ [CATALOG_PATH]: { kind: 'failed', reason: 'HTTP 503' } })
  await loadCatalog(BASE, withTotals, { fetchImpl: failing, log })
  assert.deepEqual(messages.slice(1), ['探索：拉取路由表失败（HTTP 503）'])
})

test('日志：投影拿不到计数就不编，退化为「成功」一行', async () => {
  const messages = []
  const fetchImpl = stubFetch({ [CATALOG_PATH]: { kind: 'ok', body: '{"github":{}}' } })
  await loadCatalog(BASE, projectSites, { fetchImpl, log: (message) => messages.push(message) })

  assert.deepEqual(messages, ['探索：拉取 https://hub.test 路由表成功'])
})
