/**
 * R8b 03：`exploreCatalog` / `exploreBuildUrl` 两个端点的接线（spec §4.3 / §4.5 / §7 B1–B20）。
 *
 * 为什么整张表用**静态夹具 + 桩 fetch**：实例回包有 3.3 MB、社区维护，拿真网跑一次要 9 秒且
 * 内容随时会漂。这里手写一份「形状照实测、条目数够翻页」的目录，把「整表不出宿主」这条核心
 * 判据钉在响应体大小与字段裁剪上；出网本身归 02 的 `loadCatalog`，本文件只注入桩件确认它被调了
 * 几次、按哪个实例调的。
 *
 * 夹具刻意让**站点级 categories 全空、路由级有值**（B5 / D7 的判据），并夹带
 * description / maintainers / location / radar 的长字符串 —— 它们一旦漏进回包，响应体大小断言
 * 与字段裁剪断言会同时翻红。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../lib/config.js'
import { createDispatch } from '../lib/endpoints.js'
import { createMemoryStore } from '../lib/memory-store.js'
import { clearCatalogCache } from '../lib/explore-catalog-fetch.js'
import { encodeCatalogCursor, parsePathTemplate, prefillValues, projectCatalog } from '../lib/explore-catalog.js'

const HUB = 'https://hub.test'
const OTHER = 'https://other.test'
const HUB_CATALOG = HUB + '/api/namespace'
const OTHER_CATALOG = OTHER + '/api/namespace'

/** 长文本占位：漏进回包时，20 万字符的响应体断言会当场翻红（D12 / B18）。 */
const LONG_TEXT = '长'.repeat(600)

/** 实测形状的 features：七个事实键，`requireConfig` 是 `false | ConfigItem[]`（spec §1.1 / §4.2.1）。 */
function featuresOf(overrides = {}) {
  return {
    requireConfig: false,
    requirePuppeteer: false,
    antiCrawler: false,
    supportRadar: false,
    supportBT: false,
    supportPodcast: false,
    supportScihub: false,
    ...overrides,
  }
}

/** 一条路由的原始回包形状；description / maintainers / location / radar 都是长值。 */
function routeOf({ path, name, categories = [], example, parameters = {}, features = {} }) {
  return {
    path,
    name,
    url: 'https://site.example' + path,
    maintainers: ['维护者-' + LONG_TEXT],
    example,
    parameters,
    description: LONG_TEXT,
    categories,
    features: featuresOf(features),
    radar: LONG_TEXT,
    location: LONG_TEXT,
  }
}

/**
 * 静态目录夹具：3 个合法站点 / 110 条合法路由（够 30 一页翻四页，也够观察 100 的上限），
 * 外加 2 个坏站点与 3 条坏路由（B20：跳过并继续）。
 *
 * 哔哩哔哩 105 条：前 10 条同时属于 multimedia 与 programming，用来构造「namespace × category」
 * 的交集（B6）；其余只有 multimedia。
 */
function catalogOf() {
  const bilibiliRoutes = {}
  for (let index = 0; index < 105; index += 1) {
    const key = 'r' + String(index).padStart(3, '0')
    bilibiliRoutes[key] = routeOf({
      path: '/video/' + key + '/:id',
      name: '视频 ' + key,
      categories: index < 10 ? ['multimedia', 'programming'] : ['multimedia'],
      parameters: { id: '视频 id' },
    })
  }
  return {
    // 键序刻意打乱：投影必须按 (namespace, path) 重排，不能靠对象键序。
    zhihu: {
      name: '知乎',
      url: 'https://www.zhihu.com',
      categories: [],
      routes: {
        activities: routeOf({
          path: '/people/activities/:id',
          name: '用户动态',
          categories: ['social'],
          example: '/zhihu/people/activities/abc',
          parameters: { id: '用户 id' },
        }),
        // 通配模板：拼地址必须明确失败，不许猜（spec §4.5）。
        wildcard: routeOf({ path: '/wildcard/*', name: '通配路由', categories: ['social'] }),
      },
    },
    github: {
      name: 'GitHub',
      url: 'https://github.com',
      categories: [],
      routes: {
        // 插入顺序打乱：排序应按 path。
        issues: routeOf({
          path: '/issues/:user/:repo/:state?',
          name: '仓库 Issues',
          categories: ['programming'],
          example: '/github/issues/DIYgod/RSSHub/open',
          parameters: { user: '用户名', repo: '仓库名', state: '状态' },
        }),
        branches: routeOf({
          path: '/branches/:user/:repo',
          name: '仓库分支',
          categories: ['programming'],
          example: '/github/branches/DIYgod/RSSHub',
          parameters: { user: '用户名', repo: '仓库名' },
        }),
        releases: routeOf({
          path: '/releases/:user/:repo',
          name: '仓库发布',
          categories: ['programming'],
          parameters: { user: '用户名', repo: '仓库名' },
          features: { requireConfig: [{ name: 'GITHUB_TOKEN', optional: false }], antiCrawler: true },
        }),
        // 坏路由：值不是对象 / path 不是字符串 / name 缺失 ⇒ 逐条跳过（B20）。
        nullRoute: null,
        numericPath: { path: 42, name: '坏路径' },
        missingName: { path: '/github/no-name/:id' },
      },
    },
    bilibili: {
      name: '哔哩哔哩',
      url: 'https://www.bilibili.com',
      categories: [],
      routes: bilibiliRoutes,
    },
    // 坏站点：值不是对象 / 没有 routes ⇒ 站点级跳过（B20）。
    notAnObject: 'oops',
    noRoutes: { name: '没有路由表', categories: ['x'] },
  }
}

/** 一份极小的目录：换实例用例用它证明「拿到的是新实例的表」（B12）。 */
function otherCatalogOf() {
  return {
    other: {
      name: '另一个实例',
      categories: [],
      routes: {
        only: routeOf({ path: '/only/:id', name: '只有一条', parameters: { id: '编号' } }),
      },
    },
  }
}

/** 桩 fetch：记录 url / validators / limits，按 url 回预设结果（与 rsshub-test-endpoint 同一手法）。 */
function stubFetch(map) {
  const calls = []
  const impl = async (url, validators, limits) => {
    calls.push({ url, validators, limits })
    const outcome = map[url]
    if (outcome === undefined) return { kind: 'failed', reason: 'HTTP 500' }
    return { kind: 'ok', body: JSON.stringify(outcome), finalUrl: url }
  }
  return { calls, impl }
}

/** 一份与生产同形的 dispatch：store 与 fetchImpl 是仅有的替换点。 */
function harness({ fetchImpl, config = {}, store } = {}) {
  const target = store ?? createMemoryStore()
  return createDispatch({
    config: Config(config),
    log: () => {},
    ready: () => target,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  })
}

beforeEach(() => clearCatalogCache())

// ── B9 / D11：未配置实例 ────────────────────────────────────────────────

test('未配置实例：两个端点都回可读错误，且一个网络请求都不发（B9）', async () => {
  const stub = stubFetch({ [HUB_CATALOG]: catalogOf() })
  const dispatch = harness({ fetchImpl: stub.impl })

  for (const [endpoint, payload] of [
    ['exploreCatalog', {}],
    ['exploreBuildUrl', { namespace: 'github', path: '/branches/:user/:repo', values: {} }],
  ]) {
    const result = await dispatch(endpoint, payload)
    assert.equal(result.ok, false, endpoint + ' 在未配置时必须失败，不能回空目录')
    assert.equal(result.error.code, 'not-configured', endpoint + ' 的错误码要能让界面指回设置页')
    assert.match(result.error.message, /未配置/, endpoint + ' 的文案要说明是没配实例')
  }
  assert.equal(stub.calls.length, 0, '未配置时一次网络请求都不许发')
})

// ── B1–B6 / D13：目录口径、筛选与分页 ────────────────────────────────────

test('第一页：目录口径计数、默认 30 条与 nextCursor 同时到位（B1 / D13）', async () => {
  const stub = stubFetch({ [HUB_CATALOG]: catalogOf() })
  const dispatch = harness({ fetchImpl: stub.impl, config: { rsshubBase: HUB } })

  const result = await dispatch('exploreCatalog', {})
  assert.equal(result.ok, true, '配好实例后探索必须能用')
  const page = result.value
  assert.equal(page.siteTotal, 3, '目录口径：3 个合法站点（坏站点不计，B20）')
  assert.equal(page.routeTotal, 110, '目录口径：110 条合法路由（坏路由不计，B20）')
  assert.equal(page.matched, 110, '无筛选时命中 = 全部路由')
  assert.deepEqual(page.categories, ['multimedia', 'programming', 'social'], '分类目录按路由级去重升序')
  assert.equal(page.items.length, 30, '默认一页 30 条')
  assert.equal(typeof page.nextCursor, 'string', '还有 80 条 ⇒ 必须给续页游标')
  assert.equal(stub.calls.length, 1, '只拉一次表')
  assert.equal(stub.calls[0].url, HUB_CATALOG, '按实例源站拼 /api/namespace')

  // 「没有筛选」的常态请求：浏览器通道把缺省序列化成 null，不许因此回 bad-request。
  const bare = await dispatch('exploreCatalog', null)
  assert.equal(bare.ok, true)
  assert.equal(bare.value.matched, 110)
})

test('连翻到底：每页 30 / 末页 20，累计 = matched，无重复无遗漏（B2）', async () => {
  const stub = stubFetch({ [HUB_CATALOG]: catalogOf() })
  const dispatch = harness({ fetchImpl: stub.impl, config: { rsshubBase: HUB } })

  const seen = []
  const pages = []
  let cursor
  for (;;) {
    const result = await dispatch('exploreCatalog', cursor === undefined ? {} : { cursor })
    assert.equal(result.ok, true, '续页不许失败')
    pages.push(result.value.items.length)
    seen.push(...result.value.items)
    cursor = result.value.nextCursor
    if (cursor === undefined) break
  }
  assert.deepEqual(pages, [30, 30, 30, 20], '4 页：30/30/30/20')
  assert.equal(seen.length, 110, '累计条数 = matched')
  const keys = seen.map((row) => row.namespace + ' ' + row.path)
  assert.equal(new Set(keys).size, 110, '无重复：每一行只出现一次')
  assert.equal(new Set(keys).size, new Set(catalogKeysOf()).size, '无遗漏：与目录里的行集合一致')
})

/** 夹具里所有合法行的 `(namespace, path)` 集合：B2 的独立参照（不由被测代码派生）。 */
function catalogKeysOf() {
  const raw = catalogOf()
  const keys = []
  for (const [namespace, site] of Object.entries(raw)) {
    if (typeof site !== 'object' || site === null || typeof site.routes !== 'object' || site.routes === null) continue
    if (typeof site.name !== 'string') continue
    for (const route of Object.values(site.routes)) {
      if (typeof route !== 'object' || route === null) continue
      if (typeof route.path !== 'string' || route.path === '') continue
      if (typeof route.name !== 'string') continue
      keys.push(namespace + ' ' + route.path)
    }
  }
  return keys
}

test('q 搜站点名：该站全部路由命中；q 也认路由名与路径模板片段（B3 / B4 / D8）', async () => {
  const stub = stubFetch({ [HUB_CATALOG]: catalogOf() })
  const dispatch = harness({ fetchImpl: stub.impl, config: { rsshubBase: HUB } })

  const bySite = await dispatch('exploreCatalog', { q: 'GitHub' })
  assert.equal(bySite.ok, true)
  assert.equal(bySite.value.matched, 3, '搜站点名 = 看该站能订什么（D8）')
  assert.ok(bySite.value.items.every((row) => row.namespace === 'github'))

  // 中文站点名命中：'哔哩哔哩' 不出现在任何路由名 / 路径里，只能靠站点名匹配。
  const byChineseSite = await dispatch('exploreCatalog', { q: '哔哩哔哩', limit: 5 })
  assert.equal(byChineseSite.value.matched, 105)
  assert.ok(byChineseSite.value.items.every((row) => row.namespace === 'bilibili'))

  const byRouteName = await dispatch('exploreCatalog', { q: '用户动态' })
  assert.deepEqual(byRouteName.value.items.map((row) => row.path), ['/people/activities/:id'])

  const byPath = await dispatch('exploreCatalog', { q: 'ACTIVITIES' })
  assert.deepEqual(byPath.value.items.map((row) => row.name), ['用户动态'], '路径片段命中且大小写不敏感')
})

test('category 只按路由级分类筛（站点级分类全空也不影响），matched 与目录口径分开（B5 / D7）', async () => {
  const stub = stubFetch({ [HUB_CATALOG]: catalogOf() })
  const dispatch = harness({ fetchImpl: stub.impl, config: { rsshubBase: HUB } })

  const result = await dispatch('exploreCatalog', { category: 'programming', limit: 100 })
  assert.equal(result.ok, true)
  assert.equal(result.value.matched, 13, '3 条 GitHub + 10 条哔哩哔哩')
  assert.notEqual(result.value.matched, result.value.routeTotal, '命中数与目录大小是两个口径（D13）')
  assert.ok(result.value.items.every((row) => row.categories.includes('programming')))
  assert.equal(result.value.siteTotal, 3, '筛选不影响目录口径')
})

test('namespace 钻取与 category 取交集（B6）', async () => {
  const stub = stubFetch({ [HUB_CATALOG]: catalogOf() })
  const dispatch = harness({ fetchImpl: stub.impl, config: { rsshubBase: HUB } })

  const siteOnly = await dispatch('exploreCatalog', { namespace: 'bilibili', limit: 100 })
  assert.equal(siteOnly.value.matched, 105)
  assert.ok(siteOnly.value.items.every((row) => row.namespace === 'bilibili'))

  const both = await dispatch('exploreCatalog', { namespace: 'bilibili', category: 'programming' })
  assert.equal(both.value.matched, 10, '两个筛子是 AND 叠加')
  assert.ok(both.value.items.every((row) => row.namespace === 'bilibili' && row.categories.includes('programming')))
})

test('limit：默认 30、上限 100 夹取不拒绝，非正整数是形状错误（B18 的前半）', async () => {
  const stub = stubFetch({ [HUB_CATALOG]: catalogOf() })
  const dispatch = harness({ fetchImpl: stub.impl, config: { rsshubBase: HUB } })

  const clamped = await dispatch('exploreCatalog', { limit: 500 })
  assert.equal(clamped.ok, true, '越界不拒绝（展示偏好）')
  assert.equal(clamped.value.items.length, 100, '上限夹到 100')
  assert.equal(typeof clamped.value.nextCursor, 'string', '还有 10 条 ⇒ 仍要给游标')

  for (const limit of [0, -1, 1.5, '30']) {
    const bad = await dispatch('exploreCatalog', { limit })
    assert.equal(bad.ok, false, '非正整数是形状错误：' + JSON.stringify(limit))
    assert.equal(bad.error.code, 'bad-request')
  }
})

// ── B7 / B8：游标栅栏 ───────────────────────────────────────────────────

test('游标栅栏：换 q / category / namespace 或乱码一律 bad-request，绝不回第一页（B7 / B8）', async () => {
  const stub = stubFetch({ [HUB_CATALOG]: catalogOf() })
  const dispatch = harness({ fetchImpl: stub.impl, config: { rsshubBase: HUB } })

  const first = await dispatch('exploreCatalog', { q: 'github', limit: 2 })
  assert.equal(first.ok, true)
  const cursor = first.value.nextCursor
  assert.equal(typeof cursor, 'string', '两页才装得下 3 条 ⇒ 必须有游标')

  // 同一查询：游标可以续页，且从边界行之后开始（不重复第一页的行）。
  const same = await dispatch('exploreCatalog', { q: 'github', limit: 2, cursor })
  assert.equal(same.ok, true)
  assert.deepEqual(same.value.items.map((row) => row.path), ['/releases/:user/:repo'])

  // 只有大小写变了：语义相同的查询，不许把游标判废（01 的栅栏绑在归一化后的条件上）。
  const sameDifferentCase = await dispatch('exploreCatalog', { q: 'GitHub', limit: 2, cursor })
  assert.equal(sameDifferentCase.ok, true, '大小写不同不是「筛选变了」')

  for (const payload of [
    { q: 'zhihu', limit: 2, cursor },
    { q: 'github', category: 'programming', limit: 2, cursor },
    { q: 'github', namespace: 'github', limit: 2, cursor },
  ]) {
    const changed = await dispatch('exploreCatalog', payload)
    assert.equal(changed.ok, false, '筛选变了必须响亮失败：' + JSON.stringify(payload))
    assert.equal(changed.error.code, 'bad-request')
    assert.match(changed.error.message, /游标/)
  }

  for (const garbage of ['乱码', '', 'x'.repeat(64), cursor + 'x']) {
    const bad = await dispatch('exploreCatalog', { q: 'github', limit: 2, cursor: garbage })
    assert.equal(bad.ok, false, '认不出的游标不许从第一页开始：' + JSON.stringify(garbage))
    assert.equal(bad.error.code, 'bad-request')
  }

  // 栅栏对得上、但边界行已不在目录里（缓存过期后实例换了表）：同样响亮失败，不回第一页。
  const stale = encodeCatalogCursor({ q: 'github' }, { namespace: 'github', path: '/github/removed/:id' })
  const staleResult = await dispatch('exploreCatalog', { q: 'github', limit: 2, cursor: stale })
  assert.equal(staleResult.ok, false)
  assert.equal(staleResult.error.code, 'bad-request')
  assert.match(staleResult.error.message, /失效/)
})

// ── B13–B16：地址拼装 ───────────────────────────────────────────────────

test('拼地址：example 预填 → 地址含 namespace、无 :param 残留（B13）', async () => {
  const stub = stubFetch({ [HUB_CATALOG]: catalogOf() })
  const dispatch = harness({ fetchImpl: stub.impl, config: { rsshubBase: HUB } })

  const listed = await dispatch('exploreCatalog', { q: '仓库分支' })
  const route = listed.value.items[0]
  assert.ok(route !== undefined, '夹具里必须有那条带 example 的路由')
  const values = prefillValues(parsePathTemplate(route.path), route.example, route.namespace)
  assert.deepEqual(values, { user: 'DIYgod', repo: 'RSSHub' }, '预填只从官方 example 反推')

  const built = await dispatch('exploreBuildUrl', { namespace: route.namespace, path: route.path, values })
  assert.equal(built.ok, true)
  assert.equal(built.value.url, HUB + '/github/branches/DIYgod/RSSHub')
  assert.equal(built.value.url.includes('/:'), false, '地址里不许有 :param 残留')
  assert.ok(built.value.url.includes('/github/'), 'namespace 必须拼进地址（它是路由第一段）')
})

test('拼地址：必填留空回 400 且点名参数（B14）', async () => {
  const stub = stubFetch({ [HUB_CATALOG]: catalogOf() })
  const dispatch = harness({ fetchImpl: stub.impl, config: { rsshubBase: HUB } })

  const none = await dispatch('exploreBuildUrl', { namespace: 'github', path: '/branches/:user/:repo', values: {} })
  assert.equal(none.ok, false)
  assert.equal(none.error.code, 'bad-request')
  assert.match(none.error.message, /user/, '文案必须点名缺的第一个参数')

  const missingRepo = await dispatch('exploreBuildUrl', { namespace: 'github', path: '/branches/:user/:repo', values: { user: 'DIYgod' } })
  assert.equal(missingRepo.ok, false)
  assert.match(missingRepo.error.message, /repo/)
})

test('拼地址：可选参数留空 ⇒ 整段消失；模板外的键忽略（B15 / spec §4.5）', async () => {
  const stub = stubFetch({ [HUB_CATALOG]: catalogOf() })
  const dispatch = harness({ fetchImpl: stub.impl, config: { rsshubBase: HUB } })

  const omitted = await dispatch('exploreBuildUrl', {
    namespace: 'github',
    path: '/issues/:user/:repo/:state?',
    values: { user: 'DIYgod', repo: 'RSSHub' },
  })
  assert.equal(omitted.ok, true)
  assert.equal(omitted.value.url, HUB + '/github/issues/DIYgod/RSSHub', '可选段整段消失')
  assert.equal(omitted.value.url.endsWith('/'), false, '不许留尾部空段')
  assert.equal(omitted.value.url.slice(HUB.length).includes('//'), false, '不许出现空段')
  assert.equal(omitted.value.url.includes('undefined'), false)

  const filled = await dispatch('exploreBuildUrl', {
    namespace: 'github',
    path: '/issues/:user/:repo/:state?',
    values: { user: 'DIYgod', repo: 'RSSHub', state: 'open' },
  })
  assert.equal(filled.value.url, HUB + '/github/issues/DIYgod/RSSHub/open')

  // 客户端草稿可能带着上一条路由的残留：模板外的键忽略，不报错。
  const leftover = await dispatch('exploreBuildUrl', {
    namespace: 'github',
    path: '/issues/:user/:repo/:state?',
    values: { user: 'DIYgod', repo: 'RSSHub', state: '', stale: '上一次的路由' },
  })
  assert.equal(leftover.ok, true)
  assert.equal(leftover.value.url, HUB + '/github/issues/DIYgod/RSSHub')
})

test('拼地址：未知 namespace / 未知 path 回 404；通配模板明确失败（B16 / spec §4.5）', async () => {
  const stub = stubFetch({ [HUB_CATALOG]: catalogOf() })
  const dispatch = harness({ fetchImpl: stub.impl, config: { rsshubBase: HUB } })

  const unknownSite = await dispatch('exploreBuildUrl', { namespace: 'nope', path: '/branches/:user/:repo', values: { user: 'a', repo: 'b' } })
  assert.equal(unknownSite.ok, false)
  assert.equal(unknownSite.error.code, 'not-found', '未知站点是 404 语义')

  const unknownPath = await dispatch('exploreBuildUrl', { namespace: 'github', path: '/not-a-route', values: {} })
  assert.equal(unknownPath.ok, false)
  assert.equal(unknownPath.error.code, 'not-found', '未知路由是 404 语义')

  const wildcard = await dispatch('exploreBuildUrl', { namespace: 'zhihu', path: '/wildcard/*', values: {} })
  assert.equal(wildcard.ok, false)
  assert.equal(wildcard.error.code, 'bad-request', '拼不出就明确失败，绝不返回带 * / {} 的地址')
  assert.match(wildcard.error.message, /通配|正则/)
})

test('拼地址入参形状：namespace / path 非空、values 是字符串表（ADR-0003）', async () => {
  const stub = stubFetch({ [HUB_CATALOG]: catalogOf() })
  const dispatch = harness({ fetchImpl: stub.impl, config: { rsshubBase: HUB } })

  for (const bad of [
    {},
    { namespace: '', path: '/github/x', values: {} },
    { namespace: 'github', path: '', values: {} },
    { namespace: 'github', path: '/github/x' },
    { namespace: 'github', path: '/github/x', values: { user: 5 } },
  ]) {
    const result = await dispatch('exploreBuildUrl', bad)
    assert.equal(result.ok, false, '坏形状必须被拒：' + JSON.stringify(bad))
    assert.equal(result.error.code, 'bad-request')
  }
  assert.equal(stub.calls.length, 0, '坏形状在触达网络前就被拒')
})

// ── B10–B12 / B19：取表与缓存 ───────────────────────────────────────────

test('12h 内两次打开探索只拉一次表（B11）', async () => {
  const stub = stubFetch({ [HUB_CATALOG]: catalogOf() })
  const dispatch = harness({ fetchImpl: stub.impl, config: { rsshubBase: HUB } })

  const first = await dispatch('exploreCatalog', {})
  const second = await dispatch('exploreCatalog', { limit: 5 })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(stub.calls.length, 1, '缓存命中：第二次零请求')
  assert.equal(second.value.matched, first.value.matched, '拿到的仍是同一份投影')
})

test('换实例：按新实例拉表，绝不复用旧实例的投影（B12）', async () => {
  const stub = stubFetch({ [HUB_CATALOG]: catalogOf(), [OTHER_CATALOG]: otherCatalogOf() })

  const onHub = await harness({ fetchImpl: stub.impl, config: { rsshubBase: HUB } })('exploreCatalog', {})
  assert.equal(onHub.ok, true)
  assert.equal(onHub.value.siteTotal, 3)

  const onOther = await harness({ fetchImpl: stub.impl, config: { rsshubBase: OTHER } })('exploreCatalog', {})
  assert.equal(onOther.ok, true)
  assert.equal(onOther.value.siteTotal, 1, '换实例后拿到的是新实例的表')
  assert.equal(onOther.value.items[0].namespace, 'other')
  assert.deepEqual(stub.calls.map((call) => call.url), [HUB_CATALOG, OTHER_CATALOG], '各按自己的实例拉表')
})

test('实例失败：明确错误、不缓存失败 —— 下次立刻重试（B10）', async () => {
  let attempts = 0
  const impl = async (url) => {
    attempts += 1
    if (attempts === 1) return { kind: 'failed', reason: 'HTTP 503' }
    return { kind: 'ok', body: JSON.stringify(catalogOf()), finalUrl: url }
  }
  const dispatch = harness({ fetchImpl: impl, config: { rsshubBase: HUB } })

  const first = await dispatch('exploreCatalog', {})
  assert.equal(first.ok, false, '实例不可达不是空目录')
  assert.equal(first.error.code, 'catalog-unavailable')
  assert.match(first.error.message, /HTTP 503/, '原因要能直接显示给人看')

  const second = await dispatch('exploreCatalog', {})
  assert.equal(second.ok, true, '失败不缓存：第二次会重试')
  assert.equal(attempts, 2)
})

test('实例回包坏形状：非 JSON / 顶层不是对象 ⇒ 可读原因，不抛异常（B10）', async () => {
  for (const [body, pattern] of [
    ['<html>网关错误页</html>', /不是路由表 JSON/],
    ['[]', /不是对象/],
    ['null', /不是对象/],
  ]) {
    clearCatalogCache()
    const impl = async (url) => ({ kind: 'ok', body, finalUrl: url })
    const dispatch = harness({ fetchImpl: impl, config: { rsshubBase: HUB } })
    const result = await dispatch('exploreCatalog', {})
    assert.equal(result.ok, false, '坏回包必须失败：' + body)
    assert.equal(result.error.code, 'catalog-unavailable')
    assert.match(result.error.message, pattern)
  }
})

test('私网实例：默认抓取层在出网前就拒绝并说明是内网（B19）', async () => {
  // 刻意不注入 fetchImpl：走真实 fetchFeed 的地址策略，与服务订阅路径同一条判据。
  const dispatch = harness({ config: { rsshubBase: 'http://127.0.0.1:1200' } })
  const result = await dispatch('exploreCatalog', {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'catalog-unavailable')
  assert.match(result.error.message, /内网/, '原因要指向内网地址，不能糊成「实例故障」')
})

// ── B18 / B20 / D12：整表不出宿主 ───────────────────────────────────────

test('字段裁剪与响应体大小：单页远小于整表，且不含 description / maintainers / location / radar（B18 / D12）', async () => {
  const raw = catalogOf()
  const rawSize = JSON.stringify(raw).length
  const stub = stubFetch({ [HUB_CATALOG]: raw })
  const dispatch = harness({ fetchImpl: stub.impl, config: { rsshubBase: HUB } })

  const page30 = await dispatch('exploreCatalog', { limit: 30 })
  const page100 = await dispatch('exploreCatalog', { limit: 100 })
  assert.equal(page30.ok, true)
  assert.equal(page100.ok, true)
  const size30 = JSON.stringify(page30.value).length
  const size100 = JSON.stringify(page100.value).length
  assert.ok(size30 < 200_000, 'limit=30 的回包必须远小于 200 KB（实际 ' + size30 + '）')
  assert.ok(size100 < 200_000, 'limit=100 的回包必须远小于 200 KB（实际 ' + size100 + '）')
  assert.ok(rawSize > size100 * 3, '整表比最大的一页大一个数量级（夹具 ' + rawSize + ' vs ' + size100 + '）')

  const wire = JSON.stringify(page100.value)
  assert.equal(wire.includes(LONG_TEXT), false, '长文本（description / maintainers / location / radar）不许下发')
  for (const field of ['description', 'maintainers', 'location', 'radar', 'apiRoutes']) {
    assert.equal(wire.includes('"' + field + '"'), false, 'D12：' + field + ' 不许出现在回包里')
  }
  // 保留的字段必须在：列表行要展示它们。
  for (const field of ['namespace', 'siteName', 'path', 'name', 'categories', 'parameters', 'features']) {
    assert.ok(wire.includes('"' + field + '"'), 'wire 字段 ' + field + ' 不许被裁掉')
  }
})

test('坏条目跳过并继续，整表仍可用（B20）', async () => {
  // 先证明夹具里真的有坏条目：否则「端点照常工作」只是因为根本没喂坏数据（空转的判据）。
  const projected = projectCatalog(catalogOf())
  assert.equal(projected.ok, true)
  assert.equal(projected.invalid, 5, '夹具带 5 条坏条目：3 条坏路由 + 2 个坏站点')
  const stub = stubFetch({ [HUB_CATALOG]: catalogOf() })
  const dispatch = harness({ fetchImpl: stub.impl, config: { rsshubBase: HUB } })

  const all = await dispatch('exploreCatalog', { limit: 100 })
  assert.equal(all.ok, true, '一条坏路由不许把整张表判失败')
  assert.equal(all.value.siteTotal, 3, '坏站点不计入目录')
  assert.equal(all.value.routeTotal, 110, '坏路由不计入目录')

  // 坏条目的 path / name 不许以任何形式出现在结果里。
  const paths = []
  let cursor = all.value.nextCursor
  paths.push(...all.value.items.map((row) => row.path))
  while (cursor !== undefined) {
    const next = await dispatch('exploreCatalog', { limit: 100, cursor })
    assert.equal(next.ok, true)
    paths.push(...next.value.items.map((row) => row.path))
    cursor = next.value.nextCursor
  }
  assert.equal(paths.includes('/github/no-name/:id'), false, '坏路由的原始值不许漏出')
  assert.ok(paths.includes('/branches/:user/:repo'), '好路由照常下发')
})

// ── 只读面 ─────────────────────────────────────────────────────────────

test('两个端点都不写库、不改配置：store 一次都不许碰（探索是只读面）', async () => {
  const explodingStore = new Proxy({}, {
    get() { throw new Error('探索端点不该碰 store') },
    set() { throw new Error('探索端点不该写 store') },
  })
  const config = Config({ rsshubBase: HUB })
  const before = JSON.stringify(config)
  const stub = stubFetch({ [HUB_CATALOG]: catalogOf() })
  const dispatch = harness({ fetchImpl: stub.impl, config, store: explodingStore })

  const list = await dispatch('exploreCatalog', { category: 'programming' })
  assert.equal(list.ok, true)
  const built = await dispatch('exploreBuildUrl', { namespace: 'github', path: '/branches/:user/:repo', values: { user: 'a', repo: 'b' } })
  assert.equal(built.ok, true)
  assert.equal(JSON.stringify(config), before, '配置对象一个字节都不许变')
})
