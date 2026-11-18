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

/** 两个阅读速率常量（见 estimateReadingMinutes 的注释：整数近似值，不是测量结果）。 */
const CJK_CHARS_PER_MINUTE = 300
const WORDS_PER_MINUTE = 200
/** CJK 统一表意文字（含扩展 A）。shortcut: 假名/谚文不计入 CJK 速率（会被当成「词」，估算偏小），真有日文源再补范围 */
const CJK_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF]/g
/** 「这一段算一个词」的判据：至少含一个字母或数字。纯标点/纯符号不算词。 */
const WORD_PATTERN = /[\p{L}\p{N}]/u

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
 * 只放行 http/https 的绝对 URL；其余（`javascript:` / `data:` / `file:` / `mailto:` …）一律空串。
 *
 * 为什么必须有它（M5 安全评审，2026-11-15）：feed 的条目 `<link>` 由**发布者控制**，而它会
 * 原样进入客户端的三处 `<a href>` 与 `v` 键的 `window.open`。一个 `javascript:` 链接就是一次
 * **同源**脚本执行 —— 宿主把浏览器请求视为 owner 身份（packages/client/connection 的
 * requestRejection/admit），等于把 API 交给 feed 作者。抓取层（feed/fetch.ts 的 blockedReason）
 * 与图片层（article.ts 的 safeUrl）早已做同一件事，唯独条目链接的展示/打开漏了。
 *
 * 为什么放在 shared.ts：写入口（feed 解析）与读/渲染口（客户端）必须共用**同一份**判据；
 * 抄两份就是下一次漂移。`''` 是本仓既有的「无链接」语义（article 端点直接拒、界面不渲染
 * 「打开原站」），所以归一成空串是最小侵入。
 *
 * 不做历史数据迁移：库里旧行可能已经是脏 link，渲染期兜底足以阻断执行面；改用户数据风险更高
 *（见 docs/ops/backup-restore.md 的备份约束）。
 */
export function httpUrlOrEmpty(raw: string): string {
  try {
    const url = new URL(raw)
    // 归一化后的字符串交回去（同时剥掉 URL 里的控制字符）；合法 http(s) 的常见写法逐字不变。
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

/** 成功信封（两侧共用的信封构造器：宿主端点与客户端解包都按这个形状）。 */
export function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}
export function fail<T = never>(code: string, message: string, details: object = {}): RpcResult<T> {
  // details 必填：宿主信封 ConnectionRpcFailure 要求它（源码为准，技能文档样板落后）
  return { ok: false, error: { code, message, details } }
}
