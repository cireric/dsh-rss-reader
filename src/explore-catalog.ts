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

/** 检索条件：三个筛子 **AND** 叠加；空串 / 缺省 = 不生效（spec §4.3 / D9）。 */
export interface CatalogFilter {
  /** 子串、大小写不敏感；命中站点名 OR 路由名 OR 路径模板任一即可。 */
  q?: string
  /** 单选等值；**只看路由级 categories**（D7 / D10）。 */
  category?: string
  /** 等值，即「站点钻取」。 */
  namespace?: string
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
}

function normalizeFilter(filter: CatalogFilter): NormalizedFilter {
  return {
    q: typeof filter.q === 'string' ? filter.q.trim().toLowerCase() : '',
    category: typeof filter.category === 'string' ? filter.category : '',
    namespace: typeof filter.namespace === 'string' ? filter.namespace : '',
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
  query(filter: CatalogFilter): CatalogQueryResult
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
 * 事实标记：只保留四个会被展示的布尔（spec §4.4），非布尔一律 false。
 *
 * 不原样透传：实例的 `features` 有七个键，且未来可能改形状；把 `'yes'` / `1` 当成真值会让
 * 界面显示一个实例从未声明的能力（「不伪造事实」也适用于能力标记）。
 */
function featuresOf(raw: unknown): ExploreRouteView['features'] {
  const record = isRecord(raw) ? raw : {}
  return {
    requireConfig: record['requireConfig'] === true,
    requirePuppeteer: record['requirePuppeteer'] === true,
    antiCrawler: record['antiCrawler'] === true,
    supportPodcast: record['supportPodcast'] === true,
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
    const siteName = siteValue['name']
    const routes = siteValue['routes']
    // 站点名是 B3「搜站点名 ⇒ 该站全部路由命中」的判据；回落到 namespace 会让「搜 github」
    // 命中一个名字其实缺失的站点 —— 那条命中不是实例声明的，属于编造。宁可跳过这个站点。
    if (typeof siteName !== 'string' || siteName === '' || !isRecord(routes)) {
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
    query: (filter) => queryCatalog(frozenRows, filter),
  }
  Object.freeze(catalog)
  return { ok: true, catalog, invalid }
}

/**
 * 三筛 AND 检索（spec §4.3 / D8 / D9）。
 *
 * `q` 的匹配面是**站点名 OR 路由名 OR 路径模板**：站点名命中 ⇒ 该站全部路由命中，这是刻意的
 *（「搜站点 = 看该站能订什么」）；只看路由名 / 路径会把「搜 github 却只出来名字里带 github 的
 * 两三条」当成正确行为。
 *
 * 分类只看**路由级** `categories`：站点级分类只覆盖 206 站，用它筛会让 2734 条有路由分类、
 * 站点没分类的路由整片消失（D7）。一项路由可属多个分类，任一个相等即命中。
 */
function queryCatalog(rows: readonly ExploreRouteView[], filter: CatalogFilter): CatalogQueryResult {
  const { q, category: rawCategory, namespace: rawNamespace } = normalizeFilter(filter)
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
    return true
  })
  return { matched: items.length, items }
}

/**
 * 筛选条件 → 栅栏前缀（`<sha256 base64url>:`）。
 *
 * 为什么栅栏绑在**归一化后**的三元组上：栅栏回答的是「这页是不是同一个查询的下一页」，
 * 而查询只看归一化后的值（`q` 大小写不敏感）。绑原始字符串会把语义相同的查询判成不同，
 * 制造一次假 400（spec §4.3 要拒的是**变了**的条件，不是**写法变了**的条件）。
 */
function catalogFenceKey(filter: CatalogFilter): string {
  const { q, category, namespace } = normalizeFilter(filter)
  return createHash('sha256').update(JSON.stringify([q, category, namespace])).digest('base64url') + ':'
}

/**
 * 边界位置 → wire 游标：`<filter 栅栏><namespace>|<path>`。
 *
 * 与 `cursor.ts` 同一手感：分隔符取 `|`，**按第一个 `|` 切**（namespace 是站点 key，实测不含
 * `|` / `/`；path 是模板原文，万一含 `|` 也整段归 path）。
 */
export function encodeCatalogCursor(filter: CatalogFilter, position: CatalogPosition): string {
  return catalogFenceKey(filter) + position.namespace + '|' + position.path
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
export function decodeCatalogCursor(raw: string, filter: CatalogFilter): CatalogPosition | undefined {
  const fence = catalogFenceKey(filter)
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

/** 路径模板的一段：字面量，或一个参数（`:name` / `:name?` / `:name{constraint}`）。 */
export type PathTemplateSegment =
  | { readonly kind: 'literal'; readonly value: string }
  | {
    readonly kind: 'param'
    readonly name: string
    readonly optional: boolean
    /** `{.+}` / `{.*}`：吃剩余所有段（含 `/`）；其余 constraint 只吃一段（D5，不校验正则）。 */
    readonly greedy: boolean
  }

/** 解析后的路径模板。`unsupported` 为真时拼地址必须分型失败，不许猜。 */
export interface PathTemplate {
  readonly path: string
  readonly segments: readonly PathTemplateSegment[]
  readonly unsupported: boolean
}

/**
 * 参数段语法：`:name` / `:name?` / `:name{constraint}` / `:name{constraint}?`。
 *
 * constraint 用 `(.*)` 整段吃下、**不解释内容**：实测 126 条带 constraint 的路径里 118 条是
 * `.+` / `.*`，其余 6 条才是真正则。实现正则引擎既超出 D5 的范围，也会让「填错形状」在宿主
 * 这一层被误判成「这个路由不可用」。
 */
const PARAM_SEGMENT = /^:([A-Za-z0-9_]+)(?:\{(.*)\})?(\?)?$/

/**
 * 路径 → 段数组：只剥**首尾**斜杠，不合并中间的空段。
 *
 * 中段空段（`//`）不是合法路由，保留它会让拼接产生空段；这里不悄悄丢掉它，而是让后续的
 * 字面量比对失败 —— 形状怪异时宁可判「不可拼装 / 不预填」，也不产出一个看起来对的地址。
 */
function splitPathSegments(path: string): string[] {
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '')
  return trimmed === '' ? [] : trimmed.split('/')
}

/**
 * 解析路径模板。
 *
 * 两件事必须分开：**能认出参数**（`:name` 等）与**能不能安全拼装**。`*`、残留的 `{` / `}`
 * 以及畸形参数段（如 `:id{.+` 少了右括号）都归 `unsupported` —— 它们要么是 RSSHub 的通配 /
 * 正则语法，要么说明模板形状漂移；任何「试着填一下」都会拼出指向别的路由的地址（spec §4.5）。
 */
export function parsePathTemplate(path: string): PathTemplate {
  const segments: PathTemplateSegment[] = []
  let unsupported = false
  for (const segment of splitPathSegments(path)) {
    const match = PARAM_SEGMENT.exec(segment)
    if (match !== null) {
      const constraint = match[2]
      segments.push({
        kind: 'param',
        name: match[1],
        optional: match[3] === '?',
        // 只把恰好 `.+` / `.*` 当贪婪；`{newbook.*}` 之类真正则按单段处理（实测只有 6 条）
        greedy: constraint === '.+' || constraint === '.*',
      })
      continue
    }
    if (segment.startsWith(':') || segment.includes('*') || segment.includes('{') || segment.includes('}')) {
      unsupported = true
    }
    segments.push({ kind: 'literal', value: segment })
  }
  // 贪婪参数必须是最后一段（`{.+}` 的语义就是「吃剩余全部」）。实测 0 例例外；真出现时
  // 它后面的字面量无从对齐，拼出来的地址会悄悄少段 —— 归 unsupported，不猜。
  if (segments.some((segment, index) => segment.kind === 'param' && segment.greedy && index !== segments.length - 1)) {
    unsupported = true
  }
  return { path, segments: Object.freeze(segments), unsupported }
}

/** example 里的单段解码；坏百分号编码 ⇒ undefined（认证不了的样本不拿来预填）。 */
function decodeExampleSegment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}

/**
 * 单次对齐尝试：把 example 段数组当成「填好的路径」与模板逐段对齐。
 *
 * 贪婪参数必须**最后一段**且至少吃一段；非贪婪要求段数恰好相等。字面量必须逐字相等
 *（大小写敏感）—— 官方 example 与模板来自同一份声明，对不上说明这不是同一条路由的样本，
 * 猜一个值只会把用户送进错误的订阅地址。返回 undefined = 这次对齐不成立。
 */
function alignTemplate(
  template: PathTemplate,
  exampleSegments: readonly string[],
): Record<string, string> | undefined {
  const segments = template.segments
  const last = segments[segments.length - 1]
  const greedy = last !== undefined && last.kind === 'param' && last.greedy ? last : undefined
  const fixedCount = greedy === undefined ? segments.length : segments.length - 1
  if (greedy === undefined && exampleSegments.length !== fixedCount) return undefined
  if (greedy !== undefined && exampleSegments.length < fixedCount + 1) return undefined
  const values: Record<string, string> = {}
  for (let i = 0; i < fixedCount; i += 1) {
    const segment = segments[i]
    const actual = exampleSegments[i]
    if (segment === undefined || actual === undefined) return undefined
    if (segment.kind === 'literal') {
      if (segment.value !== actual) return undefined
      continue
    }
    const decoded = decodeExampleSegment(actual)
    if (decoded === undefined || decoded === '') return undefined
    values[segment.name] = decoded
  }
  if (greedy !== undefined) {
    const rest = exampleSegments.slice(fixedCount)
    const parts: string[] = []
    for (const actual of rest) {
      const decoded = decodeExampleSegment(actual)
      if (decoded === undefined || decoded === '') return undefined
      parts.push(decoded)
    }
    values[greedy.name] = parts.join('/')
  }
  return values
}

/**
 * 官方 `example` → 表单预填值；**缺省 / 段数对不上 / 对不齐 ⇒ 空对象，不猜**（spec §4.5）。
 *
 * 为什么 example 要多切一个候选：实例的 `path` 是**相对**的（实测 `/branches/:user/:repo`），
 * 而 `example` 带 namespace 前缀（实测 `/github/branches/DIYgod/RSSHub`，2922 条里 2902 条如此）。
 * 于是「example 去掉首段」与「example 原样」各是一次对齐尝试：只有一次成立才采用；**两次都成立
 * 就是歧义**（例如 `/:category{.+}?` 的 `/1lou/forum-2-1`），此时返回空对象 —— 猜错的值会
 * 悄悄换掉用户的订阅目标。调用方若知道 `namespace`（04 的列表行就有），传第三个参数即可消歧。
 */
export function prefillValues(
  template: PathTemplate,
  example: string | undefined,
  namespace?: string,
): Record<string, string> {
  if (example === undefined || example === '' || template.unsupported) return {}
  const exampleSegments = splitPathSegments(example)
  if (exampleSegments.length === 0) return {}
  if (namespace !== undefined && namespace !== '') {
    // 显式 namespace：example 确实以它为第一段才剥；不匹配就原样对齐（不猜别的剥离方式）
    const segments = exampleSegments[0] === namespace ? exampleSegments.slice(1) : exampleSegments
    return alignTemplate(template, segments) ?? {}
  }
  const direct = alignTemplate(template, exampleSegments)
  const withoutNamespace = alignTemplate(template, exampleSegments.slice(1))
  if (direct !== undefined && withoutNamespace !== undefined) return {}
  return direct ?? withoutNamespace ?? {}
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
