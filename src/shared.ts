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

/**
 * 端点名字的**单一来源**。
 *
 * 为什么是运行时常量而不是纯类型：注册表表的完整性检查（tests/endpoint-registry.test.mjs）
 * 与「未知端点」排查都需要在运行时枚举名字，纯类型给不出这个能力；类型由它派生，
 * 于是「加端点要改几处」这个问题只剩一处答案。
 */
export const ENDPOINT_NAMES = [
  'overview', 'refresh', 'markRead', 'unmarkRead', 'toggleStar', 'toggleKeepUnread', 'article', 'cleanup',
  'opmlExport', 'opmlImport', 'addFeed', 'removeFeed', 'discoverFeeds',
  'viewPreferences', 'saveViewPreferences', 'saveReadingProgress', 'duplicateHints', 'searchItems',
  'listFolders', 'createFolder', 'renameFolder', 'deleteFolder', 'moveFeedToFolder',
  'listTags', 'createTag', 'renameTag', 'deleteTag', 'setItemTags',
] as const
export type Endpoint = (typeof ENDPOINT_NAMES)[number]

export type RpcResult<T> =
  | { ok: true; value: T }
  // details 是宿主信封的必填字段（ConnectionRpcFailure，2026-10-06 源码核对；
  // 技能文档里的样板落后于源码，少了它 tsc 直接拒绝）
  | { ok: false; error: { code: string; message: string; details: object } }

/** 文件夹目录的一条：名称 + 成员订阅 id（成员按 config.json 的订阅顺序）。 */
export interface FolderView {
  name: string
  feedIds: string[]
}

/**
 * 标签的 wire 形状。`itemCount` 只在目录列表里有值（左栏角标/空标签可见性用）；
 * 单篇文章的标签查询不需要它，保持缺省。
 */
export interface TagView {
  id: string
  name: string
  createdAt: string
  itemCount?: number
}

/**
 * 发现阶段的一条候选（**已验证**可订阅）。订阅身份就是 url 本身，用户选中后原样交给 addFeed。
 */
export interface FeedCandidate {
  url: string
  title?: string
  /** 'rss2' | 'rss1' | 'atom' —— 解析器认出的格式，界面据此标注 */
  format: string
  itemCount: number
}

/**
 * 发现阶段的一条警告：候选声明了但没通过校验（url = 那个候选），或整页没有任何声明（url 缺省）。
 * 与候选分开是为了让「为什么没发现」能直接显示，而不是只剩一个空列表。
 */
export interface DiscoveryWarning {
  url?: string
  reason: string
}

export interface DiscoveryResult {
  /** 用户输入归一化后的那个 URL（不是重定向落点） */
  url: string
  candidates: FeedCandidate[]
  warnings: DiscoveryWarning[]
}

export interface FeedView {
  id: string
  title: string
  folder?: string
  /** ISO8601 UTC；从未成功抓取过则为 undefined */
  lastFetchedAt?: string
  /** ISO8601 UTC；上次**尝试**（成功/304/失败都盖）；从未试过则为 undefined。调度排序键，也是「最近尝试」的展示源 */
  lastAttemptedAt?: string
  /** 最近一次失败原因；成功后清空 */
  lastFailure?: string
  /** 连续失败次数。undefined = **历史未知**（升级前的老记录），0 = 真实零连败，见 domain.ts 的三态注释 */
  failureCount?: number
}

/**
 * 源的健康状态（PRD §10.1 的三个值）**只在这里定义一次**：宿主把它派生成 FeedView 的原始字段，
 * 客户端与管理页用本函数判断，避免两处各写一套 if。
 *
 * 判定顺序是承重的：**从未成功**优先于**有告警** —— 一个从没成功过、每次都在失败的源，
 * 说它「有告警」会让人以为它曾经好过；有告警专指「上次是成功的、最近这次失败」。
 */
export type FeedHealth = 'ok' | 'warn' | 'never'

export function feedHealthOf(feed: Pick<FeedView, 'lastFetchedAt' | 'lastFailure'>): FeedHealth {
  if (feed.lastFetchedAt === undefined) return 'never'
  return feed.lastFailure === undefined ? 'ok' : 'warn'
}

/**
 * 一轮刷新**实际发生了什么**（M4 02）。四个分支互斥，界面据 outcome 决定措辞 ——
 * 这是「节流 / 并入在途」不许伪装成新一轮的承重点：只有 ran 才带 attempted/total。
 *
 * - ran：真发起了一轮。attempted = 本轮实际尝试的源数（= selectStalestFeeds 选中的数量），
 *   total = **本轮开始时**的已订阅源数（分母是这一轮的起点，不是抓完之后又变了的值）。
 * - throttled：距上次完成不足 minRefreshIntervalMs，一个请求都没发；waitMs 是还要等多久。
 * - in-flight：已有一轮在跑，本次只是等它结束，没有发起新的。
 * - not-ready：插件未就绪（关停中 / 装载未完成）。
 */
export interface RefreshRun {
  outcome: 'ran' | 'throttled' | 'in-flight' | 'not-ready'
  /** 本轮实际尝试的源数（只有 ran 有意义；其余恒 0 —— 没发起就是 0，不是「全抓了」） */
  attempted: number
  /** 本轮开始时的已订阅源数 */
  total: number
  /** 仅 throttled：还需等待的毫秒数 */
  waitMs?: number
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
  /** 该文章的标签 id 列表（M2 06；目录/名称由 `tags` 目录解析）。 */
  tagIds?: string[]
}

/**
 * 未读的**唯一判据**：已读 = readAt 有值（粒度见上面的 ItemView.readAt，用户 2026-10-05 定）。
 *
 * 抽成函数不是为了复用代码，是为了让「未读怎么算」**只有一处**：本计划已经两次栽在
 * 「同一条不变式在两个地方各算一遍」上（任务 1 的键域、任务 5 的 unread 口径），每次都表现为
 * 两个数各自自洽、合起来对不上，且只在特定截断/漂移截面才显形。
 *
 * **本函数是这条判据的定义处**；JS 侧任何算未读的地方都必须走它（唯一现役调用方是下面的
 * countUnreadPerFeed，createStore 的 unreadPerFeed 经它实现）。
 *
 * ⚠️ Task 5 之后**两条端点路径**（buildOverview / accountOf）不再有 JS 侧的全表记账：都改走存储侧的
 * unreadPerFeed，而自持实现为了不物化 10 万行，在 SQL 里写作 `read_at IS NULL` ——
 * 那是**同一判据的第二实现**，不是第二口径；「两者确实等价」由 tests/store-sqlite.test.mjs 的
 * 逐键对账用例钉住（「unreadPerFeed：与 shared.ts 的唯一口径在同一夹具上逐键相等」）。
 * ⚠️ **不是「宿主侧一处都不剩」**：旧适配器 `src/store.ts` 的 createStore 仍把整张 items 表
 * 摊进 JS 再数一遍（它只被测试当「旧实现 ↔ 自持实现」的同义性基线驱动，不在装载路径上）。
 * 改本条判据时，那处 SQL 与它的对账用例必须一起改。
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

export interface SearchQuery {
  text: string
  feedId?: string
  feedIds?: string[]
  /** 单个标签筛选（M2 06）；和 feedIds/read/starred/日期取交集。 */
  tagId?: string
  read?: 'read' | 'unread'
  starred?: boolean
  from?: string
  to?: string
  cursor?: string
}

export interface SearchPage {
  items: ItemView[]
  nextCursor?: string
}

export interface Overview extends UnreadAccount {
  feeds: FeedView[]
  /** 文件夹目录（含空目录）。左栏渲染空文件夹与「进入文件夹」都以它为准，不能只从 feeds 派生。 */
  folders: FolderView[]
  /** 标签目录（含 0 篇文章的空标签；左栏筛选与管理面板共用）。 */
  tags: TagView[]
  /** 跨源合并、按时间倒序（river of news） */
  items: ItemView[]
  /**
   * 续页游标（keyset）：把本页**最后一条**当边界原样回带给下一次 overview 调用。
   *
   * **缺省 = 已经到底**（本页之后没有更多条目）——客户端据此停止翻页。
   * 不要拿「items 短于 maxItemsShown」去反推到底没有：孤儿行（退订后没清干净的残留条目）会
   * 占掉取数窗口，取不满的那一页未必是最后一页（见 endpoints.ts 里「放大重取」的注释）。
   */
  nextCursor?: string
  /** 本次调用是否真的发起了抓取（被节流或并入在途刷新时为 false） */
  refreshed: boolean
  /** 本轮刷新的明细（只有 refresh 端点会给；overview 恒缺省）。与 refreshed 同时给出：
   *  refreshed 是布尔概况，refresh 说明「为什么是 false」以及 X/Y 各是多少 */
  refresh?: RefreshRun
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
  /**
   * 正文内容标识（M5 02）：抽取器修订号 + 块列表摘要，见 article.ts 的 contentVersionOf。
   * 阅读进度按 (itemId, contentVersion) 恢复 —— 内容变了就不沿用旧位置。
   */
  contentVersion?: string
  /** 上次读到哪儿（0..1）。缺省 = 没有进度（或内容版本对不上），从顶部开始。 */
  progress?: number
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

/**
 * 跨源重复提示（M5 03）：某条可见条目在**别的源**里还有哪些同链接的条目。
 *
 * 只做提示，不做合并：每个来源仍保留独立的 id、已读与星标（PRD F08 的硬要求）。
 */
export interface DuplicateHintView {
  itemId: string
  others: Array<{ itemId: string; feedId: string; feedTitle: string; title: string; link: string; readAt?: string }>
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
 * 四份状态刻意**只列被记忆的**：navSelection（虚拟视图 / 某个源）、filter、navVisible，
 * 以及 M5 01 的正文排版 reading。
 * 特别**不含 navCursor**（键盘光标）—— 理由见客户端 store 的恢复注释：光标是「焦点在哪」，
 * 是瞬时的指向，而这里记的是「上次看到哪儿」；恢复时按既有规则把它落到生效的那一行即可。
 */
export interface ViewPreferences {
  navSelection: { kind: 'virtual' } | { kind: 'feed'; feedId: string } | { kind: 'folder'; folder: string }
  filter: 'all' | 'unread' | 'starred'
  navVisible: boolean
  /** 正文排版（M5 01）。旧配置没有这个键 ⇒ 归一化时补默认值，不许因为缺字段就回落整份记忆。 */
  reading: ReadingPreferences
}

/**
 * 正文排版偏好（M5 01）：**只决定正文面怎么排**，不碰任何数据、排序或阅读状态。
 *
 * 为什么并进 viewPreferences 而不是另开一个存储槽：它是同一族界面记忆（「上次看到哪儿」），
 * 已经有读侧唯一判定点（sanitizeViewPreferences）与独立的读写端点。再开一套只会让「恢复」
 * 多一条路径，而本仓库为「同一条不变式两处各算一遍」付过的学费已经够多。
 *
 * 取值域刻意是**离散档位**而不是区间：界面就是几个 <option>，「归一化」只需要判「在不在档位里」，
 * 不必再写一套夹边界的逻辑，界面能选的值与能存下的值也不会各说各话。
 */
export interface ReadingPreferences {
  /** 正文字号（px），取值域见 READING_FONT_SIZES */
  fontSize: number
  /** 正文栏宽（px），打到 .dsh-rss-article-column 的 max-width */
  lineWidth: number
  /** auto = 完全继承宿主主题；light/dark 只覆盖正文面那一块 */
  theme: 'auto' | 'light' | 'dark'
}

/** 字号档位（px）。界面与归一化读同一份常量。 */
export const READING_FONT_SIZES: ReadonlyArray<number> = [14, 16, 18, 20]
/** 栏宽档位（px）。760 是 M5 之前的写死值，留作默认 ⇒ 老用户升上来观感不变。
 *  1080 / 1280 是给宽窗口的：max-width 只封顶，不会把小窗口撑宽，所以宽档在小屏上无害。 */
export const READING_LINE_WIDTHS: ReadonlyArray<number> = [640, 760, 900, 1080, 1280]
const READING_THEMES: ReadonlyArray<ReadingPreferences['theme']> = ['auto', 'light', 'dark']

/** 首版默认：沿用改动前的固定排版（16px / 760px），主题跟随宿主。 */
export const DEFAULT_READING_PREFERENCES: ReadingPreferences = { fontSize: 16, lineWidth: 760, theme: 'auto' }

/** 没有任何记忆时的值。同时是存储域 global 槽的 initial（首次 set 才落盘）。 */
export const DEFAULT_VIEW_PREFERENCES: ViewPreferences = {
  navSelection: { kind: 'virtual' },
  filter: 'all',
  navVisible: true,
  reading: DEFAULT_READING_PREFERENCES,
}

const FILTERS: ReadonlyArray<ViewPreferences['filter']> = ['all', 'unread', 'starred']

/** 两个阅读速率常量（见 estimateReadingMinutes 的注释：整数近似值，不是测量结果）。 */
const CJK_CHARS_PER_MINUTE = 300
const WORDS_PER_MINUTE = 200
/** CJK 统一表意文字（含扩展 A）。shortcut: 假名/谚文不计入 CJK 速率（会被当成「词」，估算偏小），真有日文源再补范围 */
const CJK_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF]/g
/** 「这一段算一个词」的判据：至少含一个字母或数字。纯标点/纯符号不算词。 */
const WORD_PATTERN = /[\p{L}\p{N}]/u

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
 * @param isKnownFolder - 可选的「这个文件夹还在目录里吗」判据；语义与 isKnownFeed 相同。
 * @returns 一定是新对象：校验没过的原值绝不能被引到 state 或写回存储里。
 */
export function sanitizeViewPreferences(
  raw: unknown,
  isKnownFeed?: (feedId: string) => boolean,
  isKnownFolder?: (folder: string) => boolean,
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
    } else if (selection['kind'] === 'folder'
      && typeof selection['folder'] === 'string' && selection['folder'] !== ''
      && (isKnownFolder === undefined || isKnownFolder(selection['folder']))) {
      navSelection = { kind: 'folder', folder: selection['folder'] }
    }
  }

  const filterRaw = source['filter']
  const filter = FILTERS.includes(filterRaw as ViewPreferences['filter'])
    ? (filterRaw as ViewPreferences['filter'])
    : DEFAULT_VIEW_PREFERENCES.filter

  const navVisible = typeof source['navVisible'] === 'boolean'
    ? source['navVisible']
    : DEFAULT_VIEW_PREFERENCES.navVisible

  const readingRaw = source['reading']
  const readingSource = typeof readingRaw === 'object' && readingRaw !== null && !Array.isArray(readingRaw)
    ? (readingRaw as Record<string, unknown>)
    : {}
  // 三个字段各自回落 —— 与上面三项同一条规则：一次坏值只该抹掉它自己。
  // 档位之外的值（含 18.5、'18'、null）一律回落默认，不做四舍五入也不做夹取：编造一个用户没选过的字号，
  // 比回到默认更让人困惑。
  const reading: ReadingPreferences = {
    fontSize: READING_FONT_SIZES.includes(readingSource['fontSize'] as number)
      ? readingSource['fontSize'] as number
      : DEFAULT_READING_PREFERENCES.fontSize,
    lineWidth: READING_LINE_WIDTHS.includes(readingSource['lineWidth'] as number)
      ? readingSource['lineWidth'] as number
      : DEFAULT_READING_PREFERENCES.lineWidth,
    theme: READING_THEMES.includes(readingSource['theme'] as ReadingPreferences['theme'])
      ? readingSource['theme'] as ReadingPreferences['theme']
      : DEFAULT_READING_PREFERENCES.theme,
  }

  // 只搬运点名的四个字段：认不出的键（历史版本留下的、或被别的写入者塞进来的）一律丢掉，
  // 否则它们会被原样写回存储，攒够几版就成了没人敢删的历史包袱。
  return { navSelection, filter, navVisible, reading }
}

/**
 * 预计阅读时长（分钟，向上取整）。**估算是给人一个量级，不是承诺**，界面必须标「估算」。
 *
 * 中英混排按两套速率分别计：CJK 字 300/分、其余按空白分词 200 词/分，再各自相加后向上取整。
 * 两个速率取的是常见阅读速度的**整数近似值**（不是本仓库的测量结果）——本机没有真人阅读实验，
 * 所以这里不假装有精确值：真要调，只动这两个常量，判据在 tests/reading.test.mjs 的固定夹具上。
 *
 * 只吃块列表而不是拼好的字符串：正文块是客户端唯一拿到了缓存正文的地方（ArticlePayload.blocks），
 * 图片没有文本、不计入；标题/列表/引用都算正文（它们确实要读）。
 *
 * @returns 分钟数；没有可读文本时返回 0（调用方据此不显示任何数字，而不是显示「约 0 分钟」）
 */
export function estimateReadingMinutes(blocks: ReadonlyArray<Record<string, unknown>>): number {
  let cjk = 0
  let words = 0
  for (const block of blocks) {
    if (block['kind'] === 'img') continue
    const texts: string[] = []
    if (typeof block['text'] === 'string') texts.push(block['text'])
    if (Array.isArray(block['items'])) for (const entry of block['items']) texts.push(String(entry))
    for (const text of texts) {
      cjk += (text.match(CJK_PATTERN) ?? []).length
      // 先把 CJK 抹成空白再按空白分词：否则「中文English混排」会被当成一个超长单词。
      // 纯标点串必须丢掉 —— 「，」「。」不是词，算进去会让标点密集的中文文章系统性偏大
      // （实测夹具：300 个逗号被数成 300 个假词，4 分钟估成 6 分钟）。
      for (const token of text.replace(CJK_PATTERN, ' ').split(/\s+/)) {
        if (WORD_PATTERN.test(token)) words += 1
      }
    }
  }
  return Math.ceil(cjk / CJK_CHARS_PER_MINUTE + words / WORDS_PER_MINUTE)
}

/**
 * 阅读进度的比例，夹到 [0, 1]（M5 02）。**这是唯一的夹取点**：写入侧（端点、两个 store）与
 * 读取侧都调它，避免「库里躺着 1.5」这种只有某一层才认的形状。
 *
 * 非有限数（NaN / Infinity / 字符串）一律按 0 处理：进度的语义是「读到哪儿」，认不出就是没读到。
 */
export function clampReadingRatio(value: unknown): number {
  const ratio = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(ratio) || ratio <= 0) return 0
  return ratio >= 1 ? 1 : ratio
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

/**
 * keyset 游标的**解出形态**：一页的边界行 = 排序键（recency）与 id 的**一对值**。
 *
 * 为什么必须是一对值而不是行引用/偏移量：分页期间会有条目被清理、退订连带删除，
 * 而 recency 会大量打平（同一轮抓取的条目共享 fetchedAt）。只带时间会在打平点上死循环或跳页
 * （spec §10.3）；行引用则会在那一行被删掉时静默丢页。
 */
export interface Cursor {
  /** 边界行的 recency = publishedAt ?? fetchedAt（与 recencyOf 同一口径） */
  recency: string
  /** 边界行的条目 id；同 recency 内按它升序续页 */
  id: string
}

/**
 * 游标 → wire 字符串，格式 `"<recency>|<id>"`（brief 定稿的接口）。
 *
 * 分隔符取 `|`：recency 的取值域是 ISO-8601 时刻（见 decodeCursor 的校验），**不含** `|`；
 * 于是「按第一个 `|` 切」是唯一确定的切法。id 是 opaque 摘要，理论上可能含 `|`，
 * 所以切分从左边切、右边整段归 id。
 */
export function encodeCursor(cursor: Cursor): string {
  return cursor.recency + '|' + cursor.id
}

/**
 * wire 字符串 → 游标；**认不出的一律 undefined**。
 *
 * ⚠️ 调用方必须把 undefined 当成**响亮失败**（bad-request），绝不能当成「没有游标 ⇒ 从第一页开始」：
 * 客户端把游标原样回带，一旦解不出却又回第一页，翻页就永远翻不完 —— 每页都回同一批条目，
 * 界面无限追加（用户看到的是重复，而不是报错）。
 *
 * recency 的取值域收得很紧（**实测**：本插件所有写入口都是 `new Date(...).toISOString()` ——
 * refresh.ts 的 stamp、feed/date.ts 的 toIsoUtc，都是毫秒精度 UTC），所以按 ISO-8601 时刻校验。
 * 形状不认 ⇒ 那是**别的版本/别的写入者**塞进来的游标，宁可响亮拒绝也不要静默给出一页错数据。
 */
export function decodeCursor(raw: string): Cursor | undefined {
  const separator = raw.indexOf('|')
  if (separator <= 0) return undefined
  const recency = raw.slice(0, separator)
  const id = raw.slice(separator + 1)
  // 两端都不许带空白：cursor 是机器生成的字符串，多出空白说明它被人手改过或来自别的格式
  if (recency !== recency.trim() || id !== id.trim() || id === '') return undefined
  if (!ISO_INSTANT.test(recency) || Number.isNaN(Date.parse(recency))) return undefined
  return { recency, id }
}

/** ISO-8601 时刻（毫秒可有可无，时区必须是 Z 或 ±HH:MM）。宽松于 toISOString 的产物，但足以挡住垃圾。 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

/** 成功信封（两侧共用的信封构造器：宿主端点与客户端解包都按这个形状）。 */
export function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}
export function fail<T = never>(code: string, message: string, details: object = {}): RpcResult<T> {
  // details 必填：宿主信封 ConnectionRpcFailure 要求它（源码为准，技能文档样板落后）
  return { ok: false, error: { code, message, details } }
}
