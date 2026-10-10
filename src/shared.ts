/**
 * 浏览器半 ↔ 主进程半的 wire 约定（见 dsh-plugin-dev: references/connection-rpc.md）。
 *
 * 只放字符串、类型，以及与两侧都无关的纯常量与纯函数——没有实现细节，也保证两侧各自 import
 * 时谁都不需要运行时依赖对方。
 */

/**
 * 浏览器半读写的 HTTP 路由前缀（同源相对路径）。
 *
 * 为什么不用 `ctx.connection.rpc.handle`（技能文档推荐的那条）：它把 owner 绑定到
 * connection 插件自己的 ctx，而那个 ctx 解析不到 webServer，实测抛
 * `cannot get property "webServer" without inject`（2026-10-06，本部署；全部产品插件
 * 也都没用它）。改用宿主自有能力：`ctx.webServer.register` 挂路由 +
 * `ctx.connection.requestRejection(req)` 套用同一套 Host/Origin 与浏览器鉴权。
 */
export const ROUTE_PATH = '/rss-reader-api'

export type Endpoint = 'overview' | 'refresh' | 'markRead' | 'unmarkRead' | 'toggleStar' | 'toggleKeepUnread' | 'article' | 'cleanup'
  | 'opmlExport' | 'opmlImport' | 'addFeed' | 'removeFeed'
  | 'viewPreferences' | 'saveViewPreferences'

export type RpcResult<T> =
  | { ok: true; value: T }
  // details 是宿主信封的必填字段（ConnectionRpcFailure，2026-10-06 源码核对；
  // 技能文档里的样板落后于源码，少了它 tsc 直接拒绝）
  | { ok: false; error: { code: string; message: string; details: object } }

export interface FeedView {
  id: string
  title: string
  /** ISO8601 UTC；从未成功抓取过则为 undefined */
  lastFetchedAt?: string
  /** 最近一次失败原因；成功后清空 */
  lastFailure?: string
}

export interface ItemView {
  id: string
  feedId: string
  feedTitle: string
  title: string
  link: string
  publishedAt?: string
  fetchedAt: string
  /** 已读 = 有值（用户 2026-10-05 定的粒度） */
  readAt?: string
  starred: boolean
  /** 「保持未读」（规格 §3.3）：为真时批量「全部标为已读」会跳过它 */
  keptUnread?: boolean
  summary?: string
}

/**
 * 未读的**唯一判据**：已读 = readAt 有值（粒度见上面的 ItemView.readAt，用户 2026-10-05 定）。
 *
 * 抽成函数不是为了复用代码，是为了让「未读怎么算」**只有一处**：本计划已经两次栽在
 * 「同一条不变式在两个地方各算一遍」上（任务 1 的键域、任务 5 的 unread 口径），每次都表现为
 * 两个数各自自洽、合起来对不上，且只在特定截断/漂移截面才显形。
 * 宿主侧任何算未读的地方（buildOverview 的全表遍历、markRead/unmarkRead 的回包）都必须走它。
 */
export const isUnread = (item: Pick<ItemView, 'readAt'>): boolean => item.readAt === undefined

/**
 * 每源未读账目的**唯一算法**：键域 = feeds 表（0 未读的源也铺 0 值键），未读判据 = isUnread。
 *
 * 两个独立的陷阱都由这里一处挡掉：
 *  ① **不得从 items 派生**——items 是按 maxItemsShown 截断的，而账目按全量表算（endpoints.ts 的
 *     buildOverview 注释）：从截断后的 items 派生，各源之和必然小于顶栏总未读。
 *  ② **已退订源的残留条目不进账**——键域严格 = feeds 表，多一个键就等于左栏多一行幽灵。
 *
 * @param feedIds 订阅表当前的全部源 id（只用于定键域，顺序不影响结果）
 * @param items   条目表（宿主传全量；已退订源的残留条目会被 ① 的键域判定挡掉）
 */
export function countUnreadPerFeed(
  feedIds: Iterable<string>,
  items: Iterable<Pick<ItemView, 'feedId' | 'readAt'>>,
): Record<string, number> {
  const unread: Record<string, number> = {}
  // 先按 feeds 表铺 0：左栏按 feeds 表逐行渲染时无条件命中，不必区分「缺键」与「0」
  for (const feedId of feedIds) unread[feedId] = 0
  for (const item of items) {
    if (unread[item.feedId] === undefined) continue
    if (isUnread(item)) unread[item.feedId] += 1
  }
  return unread
}

/**
 * 未读账的 wire 形状：overview 与 markRead / unmarkRead **共用同一份**。
 *
 * 标读端点必须回它（不能只回 unread）：客户端只拿得到 maxItemsShown 条 items，截断之外那部分
 * 账（含**另一个面板刚标掉的**）它看不见；只回总数会让客户端拿本地盲增量去补每源账目，
 * 于是左栏各源之和 ≠ 顶栏总未读（spec §4 不变量 1，任务 9 实测复现：本地 3 条/宿主 20，
 * 外部把某本地不可见的源标空 ⇒ 差 3）。
 */
export interface UnreadAccount {
  unread: number
  /** 键域 = feeds 表，见 countUnreadPerFeed */
  perFeedUnread: Record<string, number>
}

export interface Overview extends UnreadAccount {
  feeds: FeedView[]
  /** 跨源合并、按时间倒序（river of news） */
  items: ItemView[]
  /** 本次调用是否真的发起了抓取（被节流或并入在途刷新时为 false） */
  refreshed: boolean
  /** 上次抓取完成时间（ISO）；undefined = 本次进程内还没成功抓过 */
  refreshedAt?: string
}
/** 按需正文（`article` 端点）的返回：成功给段落，失败给可直接显示的原因。 */
export interface ArticlePayload {
  itemId: string
  /** 命中存储里的缓存时为 true（没有跑网络） */
  cached: boolean
  title?: string
  /**
   * 结构化正文块（段落/标题/代码/图片/列表/引用）。客户端按 kind 排版——
   * 纯文本无法表达「这是标题/这是图片」，图片更是会被丢弃（用户实测反馈）。
   */
  blocks?: Array<Record<string, unknown>>
  /** 旧版本回传的纯文本段落；仅为兼容尚未刷新的老缓存，不再写入 */
  paragraphs?: string[]
  /** 抓取/抽取失败的原因；与 blocks 互斥 */
  failure?: string
  /** 站点是否允许被 iframe 嵌入（决定能否切到「原站视图」） */
  frameable?: boolean
}
/** 显式清理（`cleanup` 端点）的结果：删除条数、释放字符数与阈值。 */
export interface CleanupResult {
  deleted: number
  freedChars: number
  cutoff: string
  unread: number
}
/** OPML 导出（`opmlExport`）的返回。 */
export interface OpmlExportResult {
  opml: string
  feedCount: number
}

/** OPML 导入（`opmlImport`）的返回：逐源结果 + 汇总，坏源单独列出（§3.1）。 */
export interface OpmlImportResult {
  /** 新增（此前不在订阅里）的源数 */
  added: number
  /** 已存在、本次跳过校验后仍保留的源数 */
  existed: number
  /** 校验失败的源，逐条带原因 */
  failed: Array<{ url: string; reason: string }>
  /** OPML 里被跳过的条目（缺 xmlUrl / URL 非法 / 重复） */
  skipped: Array<{ title?: string; reason: string }>
  /** 通过校验并落库的源（供界面回显） */
  accepted: Array<{ url: string; title?: string; folder?: string }>
}

/**
 * 视图记忆：面板重开后要恢复起来的那几项（两列布局任务 7）。
 *
 * 三份状态刻意**只列被记忆的**：navSelection（虚拟视图 / 某个源）、filter、navVisible。
 * 特别**不含 navCursor**（键盘光标）—— 理由见客户端 store 的恢复注释：光标是「焦点在哪」，
 * 是瞬时的指向，而这里记的是「上次看到哪儿」；恢复时按既有规则把它落到生效的那一行即可。
 */
export interface ViewPreferences {
  navSelection: { kind: 'virtual' } | { kind: 'feed'; feedId: string }
  filter: 'all' | 'unread' | 'starred'
  navVisible: boolean
}

/** 没有任何记忆时的值。同时是存储域 global 槽的 initial（首次 set 才落盘）。 */
export const DEFAULT_VIEW_PREFERENCES: ViewPreferences = {
  navSelection: { kind: 'virtual' },
  filter: 'all',
  navVisible: true,
}

const FILTERS: ReadonlyArray<ViewPreferences['filter']> = ['all', 'unread', 'starred']

/**
 * 把「存储里读到的东西」归一成一份可信的视图记忆（**读侧唯一的判定点**）。
 *
 * 为什么必须逐字段独立回落而不是整份二选一：一次坏值不该把另外两项的记忆一起抹掉 ——
 * 那会让「filter 字段写坏」表现为「选中的源也丢了」，用户完全无从理解。
 *
 * @param raw - 任何来源的值（存储域 global、端点回包）。**一律当作不可信**。
 * @param isKnownFeed - 可选的「这个源还在订吗」判据。给了它，指向已退订源的选中态才回落成虚拟视图。
 *   宿主侧给（它手上有 feeds 表）；客户端恢复时也给（用刚下发的 feeds 表）。
 *   **不给则只验形状** —— 客户端在 feeds 表到手之前空手校验会把正常记忆全吃掉。
 * @returns 一定是新对象：校验没过的原值绝不能被引到 state 或写回存储里。
 */
export function sanitizeViewPreferences(
  raw: unknown,
  isKnownFeed?: (feedId: string) => boolean,
): ViewPreferences {
  const source = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}

  const selectionRaw = source['navSelection']
  let navSelection: ViewPreferences['navSelection'] = DEFAULT_VIEW_PREFERENCES.navSelection
  if (typeof selectionRaw === 'object' && selectionRaw !== null && !Array.isArray(selectionRaw)) {
    const selection = selectionRaw as Record<string, unknown>
    if (selection['kind'] === 'virtual') {
      navSelection = { kind: 'virtual' }
    } else if (selection['kind'] === 'feed'
      && typeof selection['feedId'] === 'string' && selection['feedId'] !== ''
      && (isKnownFeed === undefined || isKnownFeed(selection['feedId']))) {
      navSelection = { kind: 'feed', feedId: selection['feedId'] }
    }
  }

  const filterRaw = source['filter']
  const filter = FILTERS.includes(filterRaw as ViewPreferences['filter'])
    ? (filterRaw as ViewPreferences['filter'])
    : DEFAULT_VIEW_PREFERENCES.filter

  const navVisible = typeof source['navVisible'] === 'boolean'
    ? source['navVisible']
    : DEFAULT_VIEW_PREFERENCES.navVisible

  // 只搬运点名的三个字段：认不出的键（历史版本留下的、或被别的写入者塞进来的）一律丢掉，
  // 否则它们会被原样写回存储，攒够几版就成了没人敢删的历史包袱。
  return { navSelection, filter, navVisible }
}

/**
 * 「这算不算正文」的长度门槛（字符）。
 *
 * 一个值、两个使用面：抽取层用它滤掉导航残留（低于它的段落多是「分类：xxx」「相关阅读」），
 * 列表里用它判断摘要够不够读（实测 HN 的 feed 里 description 恒为 68 字符的 HTML，剥标签后
 * 只剩 Comments 一个词）。**必须是同一个值** —— 否则会出现「抽取时丢掉的，列表里却当正文显示」。
 */
export const MIN_CONTENT_CHARS = 40

/**
 * 条目的排序用时间：优先发布时间，缺则退到抓取时间。
 *
 * 宿主侧（列表排序、按源裁剪、显式清理）与浏览器半（列表显示）都用它——原先三处各写一份，
 * 任何一处改了规则都会让列表顺序与清理判据悄悄不一致。
 */
export function recencyOf(record: { publishedAt?: string; fetchedAt: string }): string {
  return record.publishedAt ?? record.fetchedAt
}

/** 成功信封（两侧共用的信封构造器：宿主端点与客户端解包都按这个形状）。 */
export function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}
export function fail<T = never>(code: string, message: string, details: object = {}): RpcResult<T> {
  // details 必填：宿主信封 ConnectionRpcFailure 要求它（源码为准，技能文档样板落后）
  return { ok: false, error: { code, message, details } }
}
