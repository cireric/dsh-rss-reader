/**
 * R8b 01：路由目录的投影、检索、游标与地址拼装 —— **纯函数**，零网络 / 零配置 / 零 DOM。
 *
 * 为什么单独成模块：探索的全部正确性都压在三条推导上 —— 实例回包（3.3 MB、社区维护、形状会漂）
 * 怎么投影成可检索的索引、翻页游标怎么绑住筛选条件、路径模板怎么变成一条没有 `:param` 残留的
 * 地址。把它们留在端点里就会被网络、缓存、HTTP 分型淹没，只能靠真实例验证；提出来之后，03 票的
 * 接线只负责取数据、装配 wire 形状与 404 / 400 的映射。
 *
 * 本模块只依赖 `shared.ts` 的 wire 类型（投影结果直接就是下发形状），不 import 端点、设置或存储。
 */
import { createHash } from 'node:crypto'
import type { ExploreRouteView } from './shared.js'
// 模板解析与预填的唯一实现在 explore-template.ts（客户端也要用，见那边的文件头）。
import { parsePathTemplate } from './explore-template.js'
// 「可跑」判据只有一份（票 05 导出）：排序与筛选必须引用它，不许各写一套。
import { isRunnableRoute, weeklyTestGenerationOf, weeklyTestKey, type WeeklyTestMap } from './weekly-tests.js'
export { parsePathTemplate, prefillValues } from './explore-template.js'
export type { PathTemplate, PathTemplateSegment } from './explore-template.js'

/** 检索条件：各筛子 **AND** 叠加；空串 / 缺省 = 不生效（spec §4.3 / D9）。 */
export interface CatalogFilter {
  /** 子串、大小写不敏感；命中站点名 OR 路由名 OR 路径模板任一即可。 */
  q?: string
  /** 单选等值；**只看路由级 categories**（D7 / D10）。 */
  category?: string
  /** 等值，即「站点钻取」。 */
  namespace?: string
  /**
   * 是否隐藏 NSFW 路由（R15 06 / spec §4.2.3）。**缺省 = true**：默认看不到 nsfw。
   * 它不是「只在客户端隐藏」的展示开关 —— 计数与分页都按过滤后的行算（spec §4.2.4）。
   */
  hideNsfw?: boolean
  /**
   * 只看可跑（R15 06 / A12）。**缺省 = false**；true 时 = 周测通过 + 无反爬 +
   * 无必填配置 + 非 nsfw 四项交集，判据直接复用 `isRunnableRoute`。
   */
  onlyRunnable?: boolean
}

/** 一次检索的结果：`matched` 与 `items` 同源，避免调用方另数一遍（两处迟早漂）。 */
export interface CatalogQueryResult {
  matched: number
  items: ExploreRouteView[]
}

/** 游标位置：`(namespace, path)`，与索引的排序键同源（keyset 分页的边界行）。 */
export interface CatalogPosition {
  namespace: string
  path: string
}

/**
 * 归一化后的筛选条件：三处（检索、栅栏、计数）必须用同一份判据。
 *
 * `q` 去空白 + 转小写：检索本来就是大小写不敏感的，若栅栏按原始字符串算 hash，
 * `q='GitHub'` 与 `q='github'` 筛选结果完全相同却会互相作废游标 —— 用户只是换了个大小写，
 * 翻页却突然 400。分类 / 站点是等值匹配，只把空串归一成「不生效」。
 */
interface NormalizedFilter {
  q: string
  category: string
  namespace: string
  hideNsfw: boolean
  onlyRunnable: boolean
}

function normalizeFilter(filter: CatalogFilter): NormalizedFilter {
  return {
    q: typeof filter.q === 'string' ? filter.q.trim().toLowerCase() : '',
    category: typeof filter.category === 'string' ? filter.category : '',
    namespace: typeof filter.namespace === 'string' ? filter.namespace : '',
    // 只认显式 false 才关闭隐藏：缺省 / 认不出的值都回到「默认隐藏 nsfw」。
    hideNsfw: filter.hideNsfw !== false,
    // 只认显式 true：缺省 / 认不出的值都不启用硬过滤。
    onlyRunnable: filter.onlyRunnable === true,
  }
}

/**
 * 投影后的目录索引。
 *
 * `sites` / `total` 是**目录口径**（与筛选无关）：站点数与路由数，投影时算一次（D13 的
 * `siteTotal` / `routeTotal`，03 直接映射）。`rows` 已按 `(namespace, path)` 升序冻结 ——
 * 分页是这组键的 keyset，顺序必须在整个缓存生命期内稳定。
 */
export interface CatalogIndex {
  readonly sites: number
  readonly total: number
  /** 整张目录的路由级分类，去重升序（供筛选项）。 */
  readonly categories: readonly string[]
  readonly rows: readonly ExploreRouteView[]
  /**
   * `weeklyTests` 是**内部参数**（不是用户 filter 的 wire 形状）：`onlyRunnable` 需要周测事实。
   * 不传 = 本次没有周测标注 ⇒「只看可跑」结果为空（未知不许当通过）。
   */
  query(filter: CatalogFilter, weeklyTests?: WeeklyTestMap): CatalogQueryResult
}

/** 投影结果：顶层形状非法 ⇒ 失败原因（不抛）；坏条目逐条跳过并计入 `invalid`（B20）。 */
export type CatalogProjection =
  | { ok: true; catalog: CatalogIndex; invalid: number }
  | { ok: false; reason: string }

/** 对象判据：数组也是 object，但实例回包里数组出现在这些位置一定是漂移，按坏条目处理。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 分类：非数组 ⇒ 空；逐项只收非空字符串（坏值只影响筛选项，不该让整条路由消失）。 */
function categoriesOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((category): category is string => typeof category === 'string' && category !== '')
}

/**
 * 参数说明：只收字符串值。非对象 ⇒ 空对象 —— 参数说明是展示辅助，缺了不影响拼地址
 *（拼地址只看模板里的参数名），不该因此丢掉整条路由。
 */
function parametersOf(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {}
  const parameters: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string') parameters[name] = value
  }
  return parameters
}

/**
 * `requireConfig` 是三态，不是布尔（spec §4.2.1）。
 *
 * 实例回包里的真实类型是 `false | ConfigItem[]`（spec §1.3 实测 180 条非空）；旧代码按
 * `=== true` 读，数组永远不等于 true ⇒「需配置」徽标从未显示过。数组里只要有一项的
 * `optional !== true`（显式 `optional: false` 或整个键缺失）就是必填，全为可选项才是可选；
 * `false` / 空数组 / 非数组都表示实例没有声明配置项 ⇒ `none`。历史布尔 `true` 也归 `none`：
 * 它不是数组，认下来就是替实例编造一个配置事实。
 */
function requireConfigStateOf(raw: unknown): ExploreRouteView['features']['requireConfig'] {
  if (!Array.isArray(raw) || raw.length === 0) return 'none'
  return raw.some((item) => !(isRecord(item) && item['optional'] === true)) ? 'required' : 'optional'
}

/**
 * 事实标记：`requireConfig` 压成三态，其余保留会被展示的布尔（spec §4.4），非布尔一律 false。
 *
 * 不原样透传：实例的 `features` 键数与形状都会漂（`nsfw` 还实测到一条拼成 `nfsw`）；把
 * `'yes'` / `1` 当成真值会让界面显示一个实例从未声明的能力，「不伪造事实」也适用于能力标记。
 */
function featuresOf(raw: unknown): ExploreRouteView['features'] {
  const record = isRecord(raw) ? raw : {}
  return {
    requireConfig: requireConfigStateOf(record['requireConfig']),
    requirePuppeteer: record['requirePuppeteer'] === true,
    antiCrawler: record['antiCrawler'] === true,
    supportPodcast: record['supportPodcast'] === true,
    // 只认 `nsfw`：拼写漂移 `nfsw` 不猜、不映射 —— 认它就是在替实例改数据。
    nsfw: record['nsfw'] === true,
  }
}

/**
 * 单条路由的运行时形状校验 + 投影。
 *
 * 判据：值必须是对象、`path` / `name` 必须是非空字符串。实例回包是**不可信输入**：一条漂移
 * 不许把整张表判失败（B20 / spec §4.2）；但也不能把 `path: 42` 收进索引 —— 拼地址时它只会在
 * `split('/')` 处抛异常，把「一条坏路由」放大成「整个端点 500」。
 */
function projectRoute(namespace: string, siteName: string, raw: unknown): ExploreRouteView | undefined {
  if (!isRecord(raw)) return undefined
  const path = raw['path']
  const name = raw['name']
  if (typeof path !== 'string' || path === '' || typeof name !== 'string') return undefined
  const example = raw['example']
  return {
    namespace,
    siteName,
    path,
    name,
    categories: categoriesOf(raw['categories']),
    // 缺 example 时**不要**留一个 `example: undefined` 的键：wire 上「缺省」与「空串」是
    // 两种语义（后者会让客户端显示一个空白的官方示例），省略键才是「没有」。
    ...(typeof example === 'string' && example !== '' ? { example } : {}),
    parameters: parametersOf(raw['parameters']),
    features: featuresOf(raw['features']),
  }
}

/** 码点序比较：不用 localeCompare —— 它的排序结果依赖运行环境的 ICU 语言，缓存顺序会漂。 */
function compareText(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** 分页键序：`(namespace, path)` 升序。 */
function compareRows(a: ExploreRouteView, b: ExploreRouteView): number {
  return compareText(a.namespace, b.namespace) || compareText(a.path, b.path)
}

/**
 * 冻结一条路由（含它内部的三层容器）。
 *
 * 索引是跨请求共享的缓存值：任何一处原地 `push` / 改字段都会污染后续所有请求，而且这种缺陷
 * 只在「先打开一次带筛选的视图」之后才显形。冻结让它在第一次写入时就响亮失败。
 */
function freezeRow(row: ExploreRouteView): ExploreRouteView {
  Object.freeze(row.categories)
  Object.freeze(row.parameters)
  Object.freeze(row.features)
  return Object.freeze(row)
}

/**
 * 把实例 `/api/namespace` 的原始 JSON 投影成可检索索引。
 *
 * 顶层不是对象（null / 数组 / 标量）⇒ `{ ok: false, reason }`，**不抛**：调用方（02 票的取表）
 * 要把「非 JSON / 形状非法」拼成一句可读错误，而不是让异常穿透到 HTTP 层变成 500。
 * 站点 / 路由的坏条目逐条跳过并计数，整表仍可用（B20）—— 3.3 MB 的回包里出现一条脏数据是常态。
 * 站点名缺失**不**算坏条目：它只影响展示，回落成 namespace 后路由照常展开（spec §4.2 的跳过
 * 清单不含它）；只有 `routes` 不是对象才丢掉整站。
 */
export function projectCatalog(raw: unknown): CatalogProjection {
  if (!isRecord(raw)) return { ok: false, reason: '路由目录不是对象（实例回包形状非法）' }
  const rows: ExploreRouteView[] = []
  const categorySet = new Set<string>()
  let sites = 0
  let invalid = 0
  for (const [namespace, siteValue] of Object.entries(raw)) {
    if (!isRecord(siteValue)) {
      invalid += 1
      continue
    }
    const siteName = typeof siteValue['name'] === 'string' && siteValue['name'] !== ''
      ? siteValue['name']
      // 站点名缺失 / 非字符串 / 空串 ⇒ 回落成 namespace。namespace 是实例自己声明的键，
      // 也是路由地址的第一段 —— 它是真实标识，不是编造的值；而 spec §4.2 的跳过清单只列了
      // 形状非法（站点值不是对象 / routes 不是对象 / 路由值不是对象 / path 不是字符串），
      // 「名字缺失」不在其中：为了一个展示名丢掉整站的全部路由超出了 spec 的授权。
      : namespace
    const routes = siteValue['routes']
    // 只有 routes 不是对象才是站点级形状非法 —— 没有路由表就无从展开，跳过并计数。
    if (!isRecord(routes)) {
      invalid += 1
      continue
    }
    // 站点本身有效即计数：即使它下面所有路由都是坏条目，这个站点在目录里存在。
    sites += 1
    for (const routeValue of Object.values(routes)) {
      const view = projectRoute(namespace, siteName, routeValue)
      if (view === undefined) {
        invalid += 1
        continue
      }
      rows.push(view)
      for (const category of view.categories) categorySet.add(category)
    }
  }
  rows.sort(compareRows)
  const frozenRows = Object.freeze(rows.map(freezeRow))
  const catalog: CatalogIndex = {
    sites,
    total: frozenRows.length,
    categories: Object.freeze([...categorySet].sort(compareText)),
    rows: frozenRows,
    query: (filter, weeklyTests) => queryCatalog(frozenRows, filter, weeklyTests),
  }
  Object.freeze(catalog)
  return { ok: true, catalog, invalid }
}

/**
 * 检索（spec §4.3 / D8 / D9）：q / category / namespace 三筛 AND，再叠加 R15 06 的
 * hideNsfw（默认隐藏）与 onlyRunnable（硬过滤）。
 *
 * `q` 的匹配面是**站点名 OR 路由名 OR 路径模板**：站点名命中 ⇒ 该站全部路由命中，这是刻意的
 *（「搜站点 = 看该站能订什么」）；只看路由名 / 路径会把「搜 github 却只出来名字里带 github 的
 * 两三条」当成正确行为。
 *
 * 分类只看**路由级** `categories`：站点级分类只覆盖 206 站，用它筛会让 2734 条有路由分类、
 * 站点没分类的路由整片消失（D7）。一项路由可属多个分类，任一个相等即命中。
 */
function queryCatalog(
  rows: readonly ExploreRouteView[],
  filter: CatalogFilter,
  weeklyTests: WeeklyTestMap | undefined,
): CatalogQueryResult {
  const { q, category: rawCategory, namespace: rawNamespace, hideNsfw, onlyRunnable } = normalizeFilter(filter)
  const category = rawCategory !== '' ? rawCategory : undefined
  const namespace = rawNamespace !== '' ? rawNamespace : undefined
  const items = rows.filter((row) => {
    if (namespace !== undefined && row.namespace !== namespace) return false
    if (category !== undefined && !row.categories.includes(category)) return false
    if (q !== '') {
      const hit = row.siteName.toLowerCase().includes(q)
        || row.name.toLowerCase().includes(q)
        || row.path.toLowerCase().includes(q)
      if (!hit) return false
    }
    // NSFW 默认隐藏（A8）：在宿主侧过滤，matched / 页大小 / nextCursor 才与过滤结果一致。
    if (hideNsfw && row.features.nsfw) return false
    // 只看可跑（A12）：判据只有 weekly-tests.ts 的 isRunnableRoute 一份，不许在这里重写四项条件。
    if (onlyRunnable && !isRunnableRoute(row, weeklyTests?.get(weeklyTestKey(row.namespace, row.path)))) {
      return false
    }
    return true
  })
  return { matched: items.length, items }
}

/**
 * 筛选条件 → 栅栏前缀（`<sha256 base64url>:`）。
 *
 * 为什么栅栏绑在**归一化后**的条件上：栅栏回答的是「这页是不是同一个查询的下一页」，
 * 而查询只看归一化后的值（`q` 大小写不敏感）。绑原始字符串会把语义相同的查询判成不同，
 * 制造一次假 400（spec §4.3 要拒的是**变了**的条件，不是**写法变了**的条件）。
 * R15 06 的两个开关与周测代次也一起进哈希：它们同样改变列表内容与边界行。
 */
function catalogFenceKey(filter: CatalogFilter, weeklyTests?: WeeklyTestMap): string {
  const { q, category, namespace, hideNsfw, onlyRunnable } = normalizeFilter(filter)
  // 周测代次也进栅栏（R15 06）：排序（可跑优先）与 onlyRunnable 都依赖这份外部事实，
  // 翻页中途刷新会让边界行附近重复或漏行 —— 旧游标必须诚实地 400，而不是静默给一页错数据。
  const weeklyGeneration = weeklyTestGenerationOf(weeklyTests)
  return createHash('sha256')
    .update(JSON.stringify([q, category, namespace, hideNsfw, onlyRunnable, weeklyGeneration]))
    .digest('base64url') + ':'
}

/**
 * 边界位置 → wire 游标：`<filter 栅栏><namespace>|<path>`。
 *
 * 与 `cursor.ts` 同一手感：分隔符取 `|`，**按第一个 `|` 切**（namespace 是站点 key，实测不含
 * `|` / `/`；path 是模板原文，万一含 `|` 也整段归 path）。
 */
export function encodeCatalogCursor(
  filter: CatalogFilter,
  position: CatalogPosition,
  weeklyTests?: WeeklyTestMap,
): string {
  return catalogFenceKey(filter, weeklyTests) + position.namespace + '|' + position.path
}

/**
 * wire 游标 → 边界位置；**认不出或栅栏不符一律 undefined**，调用方必须当 bad-request。
 *
 * ⚠️ 签名比票面多一个 `filter`：栅栏校验必须知道**当前**筛选条件，只拿 raw 无从比较。
 * 这与 `item-page.ts` 的 `decodePageCursor(scope, raw)` 是同一个手法（票面写的是
 * `decodeCatalogCursor(raw)`，接线时请传 `(raw, filter)`）。
 *
 * 为什么不把「栅栏不符」退化成「没有游标 ⇒ 从第一页开始」：那样客户端会无限追加重复行，
 * 用户看到的是重复而不是报错（spec §4.3 / B7）。
 */
export function decodeCatalogCursor(
  raw: string,
  filter: CatalogFilter,
  weeklyTests?: WeeklyTestMap,
): CatalogPosition | undefined {
  const fence = catalogFenceKey(filter, weeklyTests)
  if (!raw.startsWith(fence)) return undefined
  const body = raw.slice(fence.length)
  const separator = body.indexOf('|')
  if (separator <= 0) return undefined
  const namespace = body.slice(0, separator)
  const path = body.slice(separator + 1)
  // 两端不许带空白：游标是机器生成的；多出空白说明它被人手改过或来自别的格式。
  if (path === '' || namespace !== namespace.trim() || path !== path.trim()) return undefined
  // namespace 是站点 key，实测 1589 个全部单段；带 `/` 的位置不可能是目录里的行。
  if (namespace.includes('/')) return undefined
  return { namespace, path }
}

/** 拼地址的三种结局：成功 / 缺必填（带参数名）/ 模板不可拼装（`*` / `{}` 残留）。 */
export type ExploreUrlBuild =
  | { kind: 'ok'; url: string }
  | { kind: 'missing'; parameter: string }
  | { kind: 'unsupported' }

/** 参数值编码：贪婪参数保留 `/` 作为段分隔，其余整段编码（`/` 变成 `%2F`，不越段）。 */
function encodeParamValue(value: string, greedy: boolean): string {
  if (!greedy) return encodeURIComponent(value)
  return value.split('/').map((part) => encodeURIComponent(part)).join('/')
}

/**
 * 拼订阅地址：`{base}/{namespace}/{填值后的 path}`。
 *
 * 为什么 namespace 必须由这里拼：实例 `/api/namespace` 的键就是路由第一段，而路由 `path` 是
 * 相对模板（实测 `/branches/:user/:repo`）—— 不拼 namespace 会得到一个缺站点段的地址。
 *
 * 失败必须**分型**（复用 `rsshub.ts` 的 `buildRoute` 手感，不另造一套语义）：
 * 缺必填要能点名参数（400 文案），`*` / `{}` 残留要整条拒绝（unsupported）—— 绝不返回带
 * `:param` / `{}` / `*` 的地址，那种地址看起来对、实际指向别的路由，失败要等订阅后才暴露。
 * `values` 里模板之外的键忽略：客户端草稿可能带着上一次路由的残留（spec §4.5）。
 */
export function buildExploreUrl(
  base: string,
  namespace: string,
  path: string,
  values: Readonly<Record<string, string>>,
): ExploreUrlBuild {
  const template = parsePathTemplate(path)
  if (template.unsupported) return { kind: 'unsupported' }
  const filled: string[] = []
  for (const segment of template.segments) {
    if (segment.kind === 'literal') {
      filled.push(segment.value)
      continue
    }
    const value = values[segment.name]
    if (typeof value !== 'string' || value === '') {
      // 可选段缺值 ⇒ 整段消失（不留空段 / `undefined`）；必填缺值 ⇒ 点名失败
      if (segment.optional) continue
      return { kind: 'missing', parameter: segment.name }
    }
    filled.push(encodeParamValue(value, segment.greedy))
  }
  // base 末尾常带 `/`：先削掉，避免拼出 `//github/...`（与 rsshub.ts 的 candidatesFromRules 同一手法）
  const origin = base.replace(/\/+$/, '')
  const prefix = origin + '/' + encodeURIComponent(namespace)
  return { kind: 'ok', url: filled.length === 0 ? prefix : prefix + '/' + filled.join('/') }
}
