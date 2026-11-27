/**
 * 浏览器半 ↔ 主进程半的 wire 约定 + 少量纯工具（见 dsh-plugin-dev: references/connection-rpc.md）。
 *
 * 只放字符串、类型，以及与两侧都无关的纯常量与纯函数——没有实现细节，也保证两侧各自 import
 * 时谁都不需要运行时依赖对方。
 *
 * 2026-11-18 起，「带规则的概念」各自成家：排序键与游标在 `cursor.ts`，视图/阅读偏好的归一化在
 * `preferences.ts`，未读判据与账目在 `unread.ts`。本文件只剩：传输契约、wire 形状、文本/健康工具。
 * 判据：tests/shared-boundary.test.mjs —— 别把规则搬回来。
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
import type { UnreadAccount } from './unread.js'
import type { TunableSettings } from './settings-schema.js'
// 表格块没有 text / items，只有它能摊出可读文字。article-text.ts 零 node 依赖（本文件要进 client
// bundle），行列摊平也只有那一份实现 —— 不在这里再写一遍遍历（spec 决策 9 / 10）。
import { tableToText } from './article-text.js'

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
  'listFolders', 'createFolder', 'renameFolder', 'deleteFolder', 'moveFeedToFolder', 'reorderFeeds',
  'listTags', 'createTag', 'renameTag', 'deleteTag', 'setItemTags',
  // R11 01 / 02：设置页的读端点与写端点（写路径先落盘再改内存，见 settings-control.ts）。
  'settings', 'saveSettings',
  // R8a 01：RSSHub 实例的「测试连接」探活（宿主出网，浏览器不直连实例）。
  'testRsshub',
  // R9 02：归档页回溯（宿主读归档页、逐篇抓正文与日期、写入条目库）。
  'backfillHistory',
  // R8b 03：探索的两个**只读**端点 —— 目录分页与地址拼装。整张路由表永不下发浏览器（D12）。
  'exploreCatalog', 'exploreBuildUrl',
  // R7 01：翻译一批正文块（纯函数式；模型路由与失败原因都从宿主注入的服务取）。
  'translateBatch',
  // R7 02：翻译可用性探测（四类原因 + 当前路由；设置页据此显示模型选择器）。
  'translateInfo',
] as const
export type Endpoint = (typeof ENDPOINT_NAMES)[number]

export type RpcResult<T> =
  | { ok: true; value: T }
  // details 是宿主信封的必填字段（ConnectionRpcFailure，2026-10-06 源码核对；
  // 技能文档里的样板落后于源码，少了它 tsc 直接拒绝）
  | { ok: false; error: { code: string; message: string; details: object } }

/**
 * 「关于」区里一行只读参数（R11 06，spec D14.1）。
 *
 * 名单与顺序由**宿主**决定（Config 减去 `feeds` 与可调键），客户端只按回包顺序画。
 * 值原样下发（数字 / 布尔 / 字符串），展示格式归客户端 —— 这样加字段或改展示不需要
 * 在客户端抄一份当前值。
 */
export interface ReadOnlySettingView {
  /** Config 字段名。 */
  key: string
  /** 当前生效值。 */
  value: string | number | boolean
}

/**
 * RSSHub「测试连接」的结果（R8a 01，spec §4.1）。
 *
 * 探活只是**启发式**：200 + body 是非空 JSON 说明这个实例会回 Radar 规则；`message` 直接
 * 展示给人，所以失败原因（超时 / HTTP 状态 / 非 JSON）由宿主拼成人话，客户端不再改写。
 */
export interface RsshubTestResult {
  readonly passed: boolean
  readonly message: string
}

/**
 * 设置页的 wire 形状（R11 01 / 06）。
 *
 * 只带界面真正用到的部分：生效值与默认值（来源层 overrides / inherited / explicit
 * 刻意不下发，spec D16：界面不显示来源）；`warning` 是启动时读 `settings.json` 的告警
 * （坏文件已隔离 / 坏值已忽略），正常态缺席，不阻断任何功能（D17）。
 *
 * 06 票追加的「关于」区数据同样只由宿主下发：版本在装载时读 package.json，路径来自
 * settings 控制器，12 个只读参数来自同一份 Config —— 客户端不硬编码任何一项。
 */
export interface SettingsSnapshot {
  effective: TunableSettings
  defaults: TunableSettings
  warning?: string
  /** 插件版本（运行时读 package.json）。 */
  version: string
  /** 插件自持存储根：`$DSH_HOME/storages/rss-reader`。 */
  dataDir: string
  /** `settings.json` 的绝对路径。 */
  settingsPath: string
  /** 「其余 12 个参数（只读）」：名称 + 当前值，顺序由宿主白名单固定。 */
  readOnly: ReadonlyArray<ReadOnlySettingView>
}

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
 * 发现阶段的一条候选。订阅身份就是 url 本身，用户选中后原样交给 addFeed。
 *
 * 两种来源（R8a 03）：
 *  - `page`：页面自己声明的 feed，发现时**抓过一遍**确认能解析 ⇒ format / itemCount 有值；
 *  - `rsshub`：从实例的 Radar 规则拼出来的地址，**没有**抓取校验（ADR-0010）⇒ 两个字段缺省，
 *    界面标「未验证」，真正的校验推迟到「添加」时由 addFeed 执行。
 *
 * `source` 是必填的：候选只在本次发现的内存里流转，没有旧 wire 需要兼容；缺省值会让
 * 「忘了标来源」静默变成页面候选，界面上就分不清哪些地址没收过抓取校验。
 */
export interface FeedCandidate {
  url: string
  title?: string
  /** 'rss2' | 'rss1' | 'atom' —— 解析器认出的格式，界面据此标注；Radar 候选没有 */
  format?: string
  itemCount?: number
  /** 候选来源（R8a 03）：页面声明 / RSSHub Radar */
  source: 'page' | 'rsshub'
  /** Radar 规则表的 `_name`（站点名）：界面第二行要显示「站点名 · 未验证」；页面候选不填 */
  siteName?: string
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
  /** feed 供给的原始署名；缺省 = 无作者。界面不显示占位，也不做任何推断（R12）。 */
  author?: string
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
/**
 * 显式清理（`cleanup` 端点）的结果：删除条数、释放字符数与阈值。
 *
 * `dryRun` 是回包的自我标识（R11 04 / D27.1）：预演与执行走同一个端点，调用方必须能分辨
 * 这次回包的 `deleted` 是「将要删」还是「已经删」—— 两者混为一谈会把预演当成已执行。
 * 预演时 `deleted` = 如果现在执行会删多少，且一条都不删。
 */
export interface CleanupResult {
  deleted: number
  freedChars: number
  cutoff: string
  dryRun: boolean
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

/**
 * 回溯篇数的硬边界（R9，spec §4.1）：默认 20，范围 1–50。
 *
 * 宿主 payload 声明（zod）、客户端行内预检、客户端默认值三处共用这一份。抄三份数字就会
 * 出现「界面允许、宿主拒绝」这类两边都自称按 spec 的漂移；边界改一次，三处一起变。
 */
export const BACKFILL_LIMIT = { min: 1, max: 50, default: 20 } as const

/**
 * 回溯报告里的单条失败（R9 03，spec §4.8）。
 *
 * 放在 shared.ts 而不是 `backfill.ts`：后者 import `node:crypto` 一族的宿主模块，客户端
 * 只能安全 import 纯 wire 类型；类型若留宿主编排文件，客户端要么 import 宿主实现（bundle 里
 * 出现 node 内建，见 docs/pitfalls.md §1.7b），要么抄第二份形状（下一次漂移）。
 */
export interface BackfillFailure {
  readonly url: string
  readonly reason: string
}

/**
 * 一次归档页回溯的报告（R9 02 的宿主回包，spec §4.8 的 wire 形状）。
 *
 * `remaining = max(0, matched − existing − attempted)`：**全部可用候选**（形态命中 − 已存在）
 * 里这次没发起抓取的条数——被请求篇数、每源余量或 deadline 挡下的都算。它回答「还剩多少」；
 * 被每源余量挡下时 `stoppedBy: 'limit'`，被 deadline 挡下时 `'deadline'`，仅被请求篇数
 * 截断时 `stoppedBy` 缺省。客户端只展示这份报告，不从中派生条目——条目以 reload 后的宿主快照为准。
 */
export interface BackfillReport {
  readonly feedId: string
  readonly archiveUrl: string
  /** 该源现有条目提供的**有效**形态样本数（能解析成 http(s) 的链接）。 */
  readonly sampleCount: number
  /** 归档页抽到的 http(s) 链接数。 */
  readonly archiveLinks: number
  /** 形态命中数（含已被同文键排除的）。 */
  readonly matched: number
  /** 同文键判定已存在而跳过的条数（含本次运行内新入库后撞上的）。 */
  readonly existing: number
  /** 真正发起抓取的篇数（失败也计入）。 */
  readonly attempted: number
  /** 成功入库的篇数。 */
  readonly added: number
  readonly failures: BackfillFailure[]
  readonly stoppedBy?: 'deadline' | 'limit'
  readonly remaining: number
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
 * **表格必须单独认**（2026-11-21，R5 05）：`table` 块既没有 `text` 也没有 `items`，只读那两个字段
 * 会把整张表算成 0 —— 含表格的正文时长系统性偏小，而界面上看不出来（时长本来就标着「估算」）。
 * 行列摊平复用 `article-text.ts` 的 `tableToText`，不在这里另写一份遍历。
 *
 * @returns 分钟数；没有可读文本时返回 0（调用方据此不显示任何数字，而不是显示「约 0 分钟」）
 */
export function estimateReadingMinutes(blocks: ReadonlyArray<Record<string, unknown>>): number {
  let cjk = 0
  let words = 0
  for (const block of blocks) {
    if (block['kind'] === 'img') continue
    const texts: string[] = []
    if (block['kind'] === 'table') texts.push(tableToText(block))
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
 * 「上限」类参数的共用判据：有限且 > 0 ⇒ 向下取整；其余 ⇒ `Infinity`（= 不限）。
 *
 * **非法值必须回落到不制造破坏的一边**。这些值同时充当每源保留量（`maxItemsPerFeed`）与
 * 去重窗口（`maxSeenPerFeed`）的上限：回落到 0 会一次删光条目 / 清空 `seen`，而两者都是
 * 不可逆的数据损失；回落到 `Infinity` 最坏只是这一轮没按上限裁剪，改好配置即恢复。
 *
 * 同一个判据原先在 refresh 的 prune / seen 窗口与 backfill 的余量 / seen 窗口各写一份
 * （ADR-0001：同一判据只留一处实现）。四处必须共用这**一个**函数——改一处漏三处，
 * 漏掉的那处就是下一次数据事故。
 */
export function effectiveLimitOf(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : Number.POSITIVE_INFINITY
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
 * 「这段摘要算不算正文」：段落拼成一行后达到 `MIN_CONTENT_CHARS`。
 *
 * 与门槛值同住是刻意的 —— 值改而判据没改（或反过来）是最难发现的一类漂移。判据本身与
 * 列表行历史实现逐字等价：`paragraphs.join(' ').trim().length >= MIN_CONTENT_CHARS`，
 * **只拼接一次**。分隔的那个空格也数进长度，调用方不要再自己 join 一遍来判。
 * 两处使用面（列表行摘录、正文面的回退内容）必须都走这里，不许各留一份。
 */
export function hasBodyText(paragraphs: readonly string[]): boolean {
  return paragraphs.join(' ').trim().length >= MIN_CONTENT_CHARS
}

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
  const url = httpUrlOf(raw)
  // 归一化后的字符串交回去（同时剥掉 URL 里的控制字符）；合法 http(s) 的常见写法逐字不变。
  return url === undefined ? '' : url.toString()
}

/** 解析成 http(s) URL；解析不出 / 其它协议 ⇒ undefined（`isHttpUrl` 与 `httpUrlOrEmpty` 共用）。 */
function httpUrlOf(raw: string): URL | undefined {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/**
 * 是否是绝对 http(s) 地址。
 *
 * 协议判断只留这一份：宿主入参声明（`endpoint-payloads.ts` 的归档页地址）与客户端行内预检
 * 各写一遍 `protocol === 'http:' || protocol === 'https:'`，下次加/减协议就会两边分家。
 */
export function isHttpUrl(value: string): boolean {
  return httpUrlOf(value) !== undefined
}

/**
 * 翻译的 wire 形状（R7，contract「shared.ts 共享 wire 类型」）。
 *
 * `TranslateRoute` 的 `effort` 是**已确认可用**的推理强度；01 只回会话默认，02 的可用性
 * 探测会复用同一份形状。`TranslateInfo` 的 reason 四枚举就是设置页 / 文章面不渲染按钮的
 * 依据 —— 客户端不自己拼「为什么不可用」。
 */
export interface TranslateRoute {
  readonly provider: string
  readonly model: string
  readonly effort?: string
}

/** 一条待译 / 已译文本：id 是 `'b' + 正文块下标`（标题走独立字段，不做成 item）。 */
export interface TranslateItem {
  readonly id: string
  readonly text: string
}

/** `translateBatch` 的成功回包：model 取响应回包里的值（不信客户端）。 */
export interface TranslateBatchResult {
  readonly model: string
  readonly title?: string
  readonly items: TranslateItem[]
}

/**
 * `translateInfo` 的 wire 形状（02 用；01 先建立，避免两票各造一份）。
 *
 * 必填项与 contract 一致：四类原因之一 + 解析出的路由。`sessionDefault` / `providers`
 * 是本票为**设置页模型选择器**补的可选扩展：客户端在浏览器沙箱里没有 ctx，无法直接读
 * `sessionController.modelCatalog()` / `llm.listModels()`；没有这两个字段，设置页就只能
 * 显示原因、无法列出可选模型（spec §4.2 要求「可用时显示模型选择器」）。
 * 老客户端忽略未知字段，因此这是向后兼容的加法。
 */
export interface TranslateInfo {
  readonly available: boolean
  readonly reason?: 'llm-unmounted' | 'no-provider' | 'no-model' | 'no-default-route'
  readonly route?: TranslateRoute
  /** 会话默认路由：设置页首项「跟随会话默认（{模型名}）」的文案来源。 */
  readonly sessionDefault?: TranslateRoute
  /** 可选模型目录：设置页按 provider 分组列模型；llm 不可用时缺席。 */
  readonly providers?: ReadonlyArray<TranslateProviderView>
}

/** 一个可选模型的展示信息；efforts 是适配器声明的思考强度 id（空 = 该模型不支持）。 */
export interface TranslateModelView {
  readonly id: string
  readonly efforts: ReadonlyArray<string>
}

/** 设置页模型下拉的一组：provider + 它列得出的模型。 */
export interface TranslateProviderView {
  readonly provider: string
  readonly models: ReadonlyArray<TranslateModelView>
}

/** 成功信封（两侧共用的信封构造器：宿主端点与客户端解包都按这个形状）。 */
export function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}
export function fail<T = never>(code: string, message: string, details: object = {}): RpcResult<T> {
  // details 必填：宿主信封 ConnectionRpcFailure 要求它（源码为准，技能文档样板落后）
  return { ok: false, error: { code, message, details } }
}

/**
 * R8b 01：探索视图的一条路由（spec §6）。
 *
 * 只放「列表展示 + 拼地址」需要的字段：`description` / `location` / `maintainers` / `radar` /
 * `apiRoutes` 一律不下发（D12）。`description` 是带 markdown 与外链的长文本，v1 不展示；
 * 其余与「列出来 + 拼地址」无关。形状放这里，是因为宿主投影与浏览器渲染必须共用同一份。
 */
export interface ExploreRouteView {
  /** 站点 key，也是路由地址的第一段（`/api/namespace` 的顶层键）。 */
  namespace: string
  siteName: string
  /** 路径模板原文，如 `/user/dynamic/:uid`。 */
  path: string
  name: string
  /** **路由级**分类；站点级分类不参与筛选（D7，站点级只覆盖 206 站）。 */
  categories: string[]
  example?: string
  /** 参数名 → 中文说明（可能为空对象）。 */
  parameters: Record<string, string>
  /**
   * 只带会被展示的事实键；其余 features 丢弃，非布尔按 false。
   *
   * `requireConfig` 是**三态**而不是布尔：实例回包里它的真实类型是 `false | ConfigItem[]`
   *（spec §1.3 实测 180 条非空）。按布尔读会让「需配置」徽标永远不出现，所以投影时就把
   * 「有没有必填项」压成 `required` / `optional` / `none`，界面不再重复推导。
   */
  features: {
    requireConfig: 'none' | 'optional' | 'required'
    requirePuppeteer: boolean
    antiCrawler: boolean
    supportPodcast: boolean
    /** 只认实例的 `nsfw === true`；拼写漂移 `nfsw` 不猜、不映射（spec §4.2.1）。 */
    nsfw: boolean
  }
  /**
   * 官方周测结论（R15 05）：`passed` / `failed`；**缺省 = 未参加周测**。
   *
   * 刻意不设 `ungraded` 第三值：未参加与「拉了数据但没有这条」在界面上是同一种表现（不显示徽标），
   * 多一个值只会让每个消费者多写一遍分支。它也不在目录索引里 —— 周测 7 天刷新、索引缓存 12h，
   * 烤进冻结行会让周测被索引缓存绑架（见 `weekly-tests.ts` 的出页附加）。
   */
  weeklyTest?: 'passed' | 'failed'
}

/**
 * R8b 01：探索目录的一页（spec §6）。
 *
 * `siteTotal` / `routeTotal`（目录口径，与筛选无关）与 `matched`（筛选后）**刻意分开**：
 * 合成一个 `total` 会让界面在筛选态显示一个既不是命中数、也不是目录大小的数（D13）。
 */
export interface ExploreCatalogPage {
  siteTotal: number
  routeTotal: number
  matched: number
  /** 整张目录的分类（升序，供筛选项）。 */
  categories: string[]
  items: ExploreRouteView[]
  /** 缺省 = 已到底。 */
  nextCursor?: string
}
