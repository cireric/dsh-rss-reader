/**
 * 刷新编排：逐源抓取 → 解析 → 去重 → 入库 → 更新游标与源状态。
 *
 * 三条不变式：
 *   ① 单源失败就地降级，其余源照常出；
 *   ② 去重键是条目稳定 id（feed/item-id.ts），与已读态绑在同一个键上；
 *   ③ 去重窗口（maxSeenPerFeed）与条目保留量（maxItemsPerFeed）是两件事，
 *      前者必须远大于后者，否则老条目会借「滚出去重窗口」重新变成未读。
 */
import { performance } from 'node:perf_hooks'
import { normalizeAuthor } from './author.js'
import { mapConcurrent } from './concurrency.js'
import { recencyOf } from './cursor.js'
import { rebuildItem, type FeedRecord } from './domain.js'
import { resolveItemIds, type KnownIdentities } from './feed/item-id.js'
import { fetchFeed, type FetchLimits, type FetchResult, type FeedValidators } from './feed/fetch.js'
import { selectPrunable, selectArticleEvictions, type RetentionRow } from './retention.js'
import { NOT_A_FEED_REASON, parseFeed, type ParsedFeed } from './feed/parse.js'
import {
  RSSHUB_ATTEMPT_TIMEOUT_MS,
  RSSHUB_MAX_ATTEMPTS,
  RSSHUB_REFRESH_BUDGET_MS,
  rsshubCooldown,
  rsshubFailureSummary,
  rsshubInstanceOrder,
  rsshubInstanceUrl,
  type RsshubAttemptFailure,
} from './rsshub-failover.js'
import { rsshubSourceOf } from './rsshub-source.js'
import { effectiveLimitOf } from './shared.js'
import type { ReaderStore } from './store.js'

/**
 * 已存正文的解析版本。1 = 旧实现（摘要优先，等于丢掉 content 里的全文）；
 * 2 = 正文优先 + 全文回填。版本落后时该源的第一轮抓取**绕开条件请求**去拿一次 200，
 * 之后立刻恢复正常的 ETag/Last-Modified 增量（§3.5 不被破坏：只多一次全量）。
 */
export const CONTENT_REVISION = 2

export interface RefreshOptions {
  limits: FetchLimits
  /** 每源保留的条目数（入 items 表） */
  maxItemsPerFeed: number
  /** 每源去重窗口大小（只存 id） */
  maxSeenPerFeed: number
  /**
   * 单条正文的存储上限（字符）。正文优先取 content 后，个别源会给出几十万字符的整页 dump，
   * 而存储域是「打开时全量载入内存」的 KV——不设上限会把 JSON 与内存一起撑爆。
   */
  maxContentChars: number
  /**
   * **全局**按需正文缓存总量上限（字符，全部源共摊）；超限从最旧的缓存开始清，见 capArticleCache。
   *
   * ⚠️ 2026-10-11：**语义由「每源」改为「全局」**，默认值仍是 8 000 000，但它的含义变了。
   * 受影响的是**所有源数 > 1 的用户（含默认配置的用户）**：旧代码逐源调用闸门，50 源实际
   * 拿到的额度是 50 × 8M；现在塌成合计 8M，即缩小约 50 倍。嫌紧就按源数调大（50 源 ⇒ 400 000 000）。
   */
  maxArticleCacheChars: number
  /**
   * 同时在飞的抓取数上限。逐源串行是 N x RTT 的线性等待（实测每源 100ms 时 10 源 1056ms、
   * 20 源 2089ms），而验收标准要求导入 ≥20 个源；最坏情况一个卡住的源会按 timeoutMs 拖住
   * 它后面的所有源（20 x 15s = 300s）。与 subscribe.ts 的并发校验同一套模式。
   */
  refreshConcurrency: number
  /**
   * RSSHub 实例池（R15 02，spec §4.1.3）：成功刷新时用 `feedId` 的 origin 识别来源并补写
   * `FeedRecord.rsshub`。缺省 = 空池（行为与加字段前逐字相同；测试桩不必逐处传）。
   *
   * 每次刷新**现读**（生命周期的闭包），所以设置页改了池子下一轮就生效，不缓存。
   */
  instances?: readonly string[]
  now?: () => Date
  /**
   * 单调时钟（毫秒），只给 RSSHub 切换的 20 s 总预算计时。
   *
   * 不用 `now`（墙钟）：系统校时或夏令时跳变能让「已用时间」凭空多出/少掉几分钟，预算就不是
   * 预算了。默认 `performance.now()`；测试注入假时钟即可验证「第一个用满 12 s ⇒ 第二个只剩 8 s」，
   * 不必真等 12 秒。
   */
  clock?: () => number
  fetchFeedImpl?: typeof fetchFeed
}

export type FeedStatus = 'added' | 'not-modified' | 'failed'

export interface FeedOutcome {
  feedId: string
  url: string
  status: FeedStatus
  /** 本次新增条目数 */
  added: number
  /**
   * 本次响应里「身份不可信」的条目数（不变量 2：同响应内 id 撞车但 URL 不同，已按 URL 重算）。
   * 它不是一个错误，所以不走 reason；但源在撒谎这件事必须看得见。
   */
  untrusted?: number
  /**
   * 本次响应里「认出是已见过的那一条」的条数（源改了 guid 写法 / 链接换过 / 撞车退回后又回来）。
   * 同样不是错误，但它是**分叉过**的信号：这个数不为 0 就说明源的身份依据变过，值得留痕。
   */
  reclaimed?: number
  reason?: string
  /**
   * 本轮为这个源**实际请求过**的实例（按尝试顺序，`URL.origin`）。
   *
   * 只有 RSSHub 源会带：非 RSSHub 源保持键缺席，「零切换」在回包上就是可判的（A4），
   * A1–A3 的请求数判据也靠它与 fetchFeedImpl 的调用记录互证。没轮到的实例不许出现在这里。
   */
  instancesAttempted?: string[]
}

/** 源标识即归一化后的 URL：稳定、可读、便于在存储里直接排查。 */
export function normalizeFeedUrl(url: string): string {
  return new URL(url.trim()).toString()
}

/**
 * 陈旧度排序键 = 上次**尝试**时间（成功 / 304 / 失败都算），回落到上次成功，再回落到空串。
 *
 * 为什么不直接用 lastFetchedAt（= 上次成功）：**永久失败**的源永远拿不到那个时间戳，
 * 于是永远钉在「无限陈旧」那一端。这类源一旦 ≥ 每轮上限 K，每一轮选中的就是同一批失败源，
 * 所有健康源再也抓不到（实测：200 源 / 20 个永久失败 / K=20 ⇒ 60 轮覆盖 0/180）——
 * 而「按陈旧度旋转」这条安全性论证对它们完全不成立。取「上次尝试」之后，失败的尝试同样
 * 把该源排到后面，旋转对失败源一样生效。见 docs/pitfalls.md §5.8。
 *
 * 回落到空串仍保留了「从未尝试过 = 无限陈旧」这一层，它对已有库（还没有 lastAttemptedAt 的
 * 记录）也成立，所以这个字段不需要任何迁移。
 *
 * ⚠️ **这两个时间戳一律假定是本插件自己写的 UTC ISO**（`now().toISOString()`，形如
 * `2026-10-11T09:00:00.000Z`）—— 只有这个形状下「按码位比较」才等于「按时间比较」。
 * 手工编辑 config.json 塞进带时区偏移的写法（`+08:00`）会按字面排序，即偏序。
 * 之所以不做归一化（例如 Date.parse 成数字再比）：写侧永远是 toISOString，所以这种偏差
 * **一次尝试之后就自愈**（下一次写入把它换成 UTC 形状），影响仅限那一轮谁先谁后；
 * 而为此在比较器里加一次解析（排序里 O(n log n) 次）是为一个未实测的输入扩规则。
 * 这条假定与「不为未经实测的样本扩规则」同一条纪律（见 docs/pitfalls.md §八）。
 */
function stalenessKey(record: FeedRecord): string {
  return record.lastAttemptedAt ?? record.lastFetchedAt ?? ''
}

/**
 * 这一轮该抓哪些源：按陈旧度升序取最旧的 `limit` 个，返回源 id（纯函数，无 IO）。
 *
 * **为什么调度必须是有界的**：每轮抓全部源时，200 源 / 并发 5 / 单源超时 15s 的最坏一轮是
 * 200 × 15 ÷ 5 = **600s**（spec §3、§6），而这一轮的时长直接就是用户点「刷新」后的等待。
 *
 * **为什么有界是安全的 —— 全部安全性都来自这一条排序**：
 * 这一轮没被选中的源，其排序键（`lastAttemptedAt`，见 stalenessKey）一个都没变，**而本轮被
 * 选中的那些全部变新了 —— 无论成败**。所以下一轮它们一定排在最前面，一定会在有限轮次内被选中。
 * 换句话说：「少抓」不是「漏抓」，只是把这一轮的工作挪到下一轮 —— 没有任何源会被永久跳过。
 *
 * ⚠️ 「无论成败」这四个字是承重的，漏掉它这条论证就是假的：只盖成功时间的话，**永久失败**的源
 * 永远排最前，≥ K 个这类源就能永久霸占每一轮的窗口（评审实测复现，见 domain.ts 的 `lastAttemptedAt`
 * 与 docs/pitfalls.md §5.8）。判据是 tests/refresh.test.mjs 的「永久失败的源不得饿死健康源」
 * 两条（纯函数 200/20/K=20 与真装配 3 源 / 1 个 500 / K=1）。
 *
 * ⇒ 也因此这条排序必须是**确定**的：等值（同一时间戳 / 都没抓过）时按传入顺序
 * （= `listFeeds()` 的顺序 = config.json 的 `feedOrder` 派生，没排过时就是键序）稳定排列。
 * tie-break 一旦是随机的，
 * 同一批等值的源可能反复被挑中，排在后面的源就饿死了 —— 那是本条唯一的失效模式。
 * 判据是 tests/refresh.test.mjs 的「陈旧度调度的饥饿不变式」（5 源 / K=2 ⇒ 3 轮覆盖全部）。
 *
 * **从未尝试过**的源（两个时间戳都缺）排**最前**：没试过 = 无限陈旧，它比任何试过的都该先抓
 * （Task 2 的逐字段搬运必须保住 `lastFetchedAt`，否则整条调度退化成按 config 键序轮流）。
 *
 * `limit <= 0` / NaN 一律返回**全部**：这是「上限没配上」而不是「这一轮一个都不抓」——
 * 后者等于让所有源永久停更，是静默的**全量停摆**，比「上限没配」这句话严重得多。
 * 与 `maxArticleCacheChars <= 0` 同一条纪律：非法上限回落到不制造破坏的那一边。
 */
export function selectStalestFeeds(
  feeds: ReadonlyArray<[string, FeedRecord]>,
  limit: number,
): string[] {
  if (!(limit > 0) || limit >= feeds.length) return feeds.map(([feedId]) => feedId)
  // slice() 先复制再排：就地排序会改到调用方手里那一份的顺序。**这是防御，不是承重判定** ——
  // 两条 store 的 listFeeds() 每次都返回新数组，去掉它没有任何输入会改变结果（等价变异，
  // 所以 scripts/mutation-test.mjs 里没有对应条目，见「正文容器收窄」那条的判定先例）。
  return feeds
    .slice()
    .sort(([, left], [, right]) => compareStaleness(left, right))
    .slice(0, limit)
    .map(([feedId]) => feedId)
}

/**
 * 码位比较，不用 localeCompare：ISO-8601 UTC 字符串按码位比较**就是**时间顺序，
 * 且不受 locale 影响，而上面那条旋转论证依赖排序是确定的。
 */
function compareStaleness(left: FeedRecord, right: FeedRecord): number {
  const a = stalenessKey(left)
  const b = stalenessKey(right)
  if (a < b) return -1
  return a > b ? 1 : 0
}

/** 单条正文截断；给截断留一句可辨认的标记，避免被误当成正文结尾。 */
function truncateContent(text: string | undefined, limit: number): string | undefined {
  if (text === undefined) return undefined
  // 上限非法（非有限数 / ≤0）一律视为「不截断」——否则 slice(0, undefined) 会返回整串
  // 却仍拼上截断标记，等于在本该完整的正文后面撒谎（实测踩到）。
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text
  return text.slice(0, limit) + '…（正文过长，已截断）'
}

/**
 * 按源裁剪到 maxItems。
 *
 * 策略在 `retention.ts` 的 `selectPrunable` 里（纯函数、有单测）：**先删未读、再删已读，
 * 星标永不自动删**。改动前这里是「无差别删最旧」，实测会连星标条目一起删掉。
 */
async function prune(store: ReaderStore, feedId: string, maxItems: number): Promise<void> {
  // 非法上限（0 / 负数 / NaN / ±Infinity）一律视为「未配置」⇒ 不裁剪，判据在
  // shared.ts 的 effectiveLimitOf（与去重窗口、回溯的每源余量共用同一份）。
  // 不这么写的话 maxItems=0 会把未星标、未保持未读的条目全部删光（2026-11-15 实测）。
  const limit = effectiveLimitOf(maxItems)
  const rows: RetentionRow[] = store.listItems(feedId).map(([itemId, record]) => ({
    id: itemId,
    starred: record.starred,
    kept: record.keptUnread === true,
    read: record.readAt !== undefined,
    recency: recencyOf(record),
  }))
  for (const itemId of selectPrunable(rows, limit)) {
    await store.deleteItem(itemId)
  }
}

/**
 * 按需正文缓存的**全局**闸门：超限时**跨全部源**从最旧的开始清缓存（只清 `article`，条目本身保留）。
 *
 * 清掉后用户再打开该条会重新抓一次——是「降级」而非「丢失」，所以不需要逐条确认。
 *
 * ⚠️ **为什么是全局、且必须在一轮抓取之后才清算**（2026-10-11 修）：
 * 上限原是**每源**一份、在刷新循环里逐源调用，于是 200 源的上限是 200 × 8M ≈ 16 亿字符 ——
 * 名义上的「上限」根本不成立（spec §10.1）。改成全局后，逐源清算同样不成立：每个源只
 * 看自己那一份，合计照样是上限的「源数倍」（earlier feeds 还会先占满、后面的源一条清不掉）。
 * 唯一的正确形状是：**一轮抓取全部落库之后，按全库合计清算一次**。
 * 判据是 tests/refresh.test.mjs 的「全局预算：每源都没超上限，但合计超了 ⇒ 必须跨源清」。
 *
 * 字符数一律走 store 的 `listArticleCacheEntries`（内部与 retention.articleCharsOf 同口径）。
 * 2026-10-07 修：这一段原先只统计 paragraphs，而现行缓存只写 blocks ⇒ 字符数恒为 0，
 * 闸门永不触发、上限形同虚设。
 *
 * ⚠️ **为什么向 store 要「清算原料」而不是 allItems()**（Task 9 评审实测）：
 * 这条判定只需要 { id, chars, fetchedAt }，正文一个字节都用不上；而 `allItems()` 会把
 * 每份正文都解出来留在堆里 —— `实测` 10 万条 × 8.8 KB 时**堆峰值 1865 MB / RSS 3173 MB**，
 * 超 spec §9.3 的「常驻内存 ≤ 300 MB」验收线 6.2 倍。改走 `listArticleCacheEntries` 之后，
 * body 逐行 parse 完即弃，堆峰值降到 **60.4 MB**（`实测` 同夹具 ⇒ 回到验收线内）。
 */
async function capArticleCache(store: ReaderStore, maxChars: number): Promise<number> {
  // 全库合计：跨源清算是本条的**全部**意义所在，喂单个源的名单等于没改（见上）。
  const entries = store.listArticleCacheEntries()
  const evicted = selectArticleEvictions(entries, maxChars)
  for (const itemId of evicted) {
    // 条目可能在算完名单之后就不在了（退订/重建）—— 原子改写对缺失键会拒绝，所以先确认它在
    if (store.item(itemId) === undefined) continue
    // 清掉 article，其余字段（含 readAt/starred）原样保留——交给 rebuildItem 按 schema 搬运。
    // ⚠️ 必须**原子读改写**：上面读到的那份 record 只是快照，若用它整体写回，会覆盖窗口期内别人
    // 写进去的字段（用户在刷新途中标已读/加星）。2026-10-10 与 article 端点同一个丢失更新类别，
    // 判据在 tests/refresh.test.mjs 的「正文缓存淘汰期间并发标已读」。
    await store.updateItem(itemId, (current) => rebuildItem(current, { omit: ['article', 'articleFailure'] }))
    // 正文没了，进度也就没有对象可指（M5 02 的验收项「缓存淘汰可清理进度」）。
    // 顺序放在清正文之后：先清正文再清进度，最坏只留一条孤儿进度（下次打开时版本对不上，无害）；
    // 反过来则会出现「进度没了、正文还在」—— 用户重开同一篇会从顶部开始，那才是丢东西。
    await store.clearReadingProgress(itemId)
  }
  return evicted.length
}

export async function refreshFeeds(
  urls: readonly string[],
  store: ReaderStore,
  options: RefreshOptions,
  signal?: AbortSignal,
): Promise<FeedOutcome[]> {
  const now = options.now ?? (() => new Date())
  const clock = options.clock ?? (() => performance.now())
  const doFetch = options.fetchFeedImpl ?? fetchFeed
  /**
   * 有界并发 + 保序（见 concurrency.ts；与 subscribe.ts 共用同一个实现）。
   *
   * 为什么可以并发落库：存储域的每次写入都排在它的**单条 write chain** 上
   * （storage-domain/src/domain.ts：「every write queues on the chain」），而每次调度的
   * feedId 都不同（调用方传的是 listFeeds() 的键，天然唯一），所以写之间没有共享状态。
   */
  const outcomes = await mapConcurrent(urls, options.refreshConcurrency, (rawUrl) =>
    refreshOne(rawUrl, store, options, now, clock, doFetch, signal))
  // 正文缓存闸门在这一轮**全部落库之后**才清算，且只清算一次（2026-10-11 任务 9）：
  //   · 放循环里逐源清算 = 每源一份上限，200 源即 200 份（病象，见 capArticleCache 的注释）；
  //   · 放循环里逐源清算即便改成全局也错：每个源只看得见自己那一份，合计仍是上限的「源数倍」。
  // 这一句在 mapConcurrent **之后**无条件执行，所以 304 / 抓取失败那些早退的源同样被这条闸门
  // 覆盖到（早退发生在 refreshOne 内部，并不会跳过它）。这是对的：闸门只管**清**缓存，
  // 304 只是这一轮没往库里加新正文，库里已有的那份照样该被算进预算。
  await capArticleCache(store, options.maxArticleCacheChars)
  return outcomes
}

/** `settleFetch` 的入参：两条抓取路径（非 RSSHub 单请求 / RSSHub 切换）最后都汇到这一段入库逻辑。 */
interface SettleInput {
  readonly feedId: string
  readonly store: ReaderStore
  readonly options: RefreshOptions
  readonly previous: FeedRecord | undefined
  readonly now: () => Date
  /** 写回来源（RSSHub 切换成功时 instance 是实际成功的那台；非 RSSHub 源为 undefined）。 */
  readonly rsshub: FeedRecord['rsshub']
  readonly result: FetchResult
  /** RSSHub 切换路径已经解析过一次，直接复用；非 RSSHub 路径为 undefined（保持原路径的解析位置）。 */
  readonly parsed: ParsedFeed | undefined
  /** 返回给界面的尝试实例（RSSHub 切换路径才有）。 */
  readonly instancesAttempted: string[] | undefined
  /**
   * 本轮是否处于「内容版本落后」升级轮（`refreshOne` 只算一次）。
   *
   * 304 分支要用它决定是否提示「源未响应无条件请求，正文升级跳过」；如果在这里再算一遍，
   * 两处表达式迟早漂（ADR-0001：一条判据只有一个裁决者）。
   */
  readonly contentUpgrade: boolean
}

/**
 * 抓取并落库单个源；结果由调用方按输入下标放回数组。
 *
 * 只有两条抓取路径：
 *  - **非 RSSHub 源**（以及池子为空的 RSSHub 源）：原路径，一个请求，超时 / 错误文案逐字不变（A4）。
 *    池子为空时也不切换：没有候选实例，但已有订阅仍按原地址刷新 —— 「空池 = RSSHub 功能关闭」
 *    关闭的是 Radar / 探索 / 新订阅这些能力，不替用户静默停掉已经订好的源。
 *  - **RSSHub 源**：按候选顺序逐实例尝试，最多 2 个、总额 ≤ 20 s（spec §4.1.4）。
 *    任何「这次没拿到内容」（超时 / 网络 / 4xx / 5xx / 429 / 200 但不是 feed）都切下一个。
 */
async function refreshOne(
  rawUrl: string,
  store: ReaderStore,
  options: RefreshOptions,
  now: () => Date,
  clock: () => number,
  doFetch: typeof fetchFeed,
  signal: AbortSignal | undefined,
): Promise<FeedOutcome> {
  let feedId: string
  try {
    feedId = normalizeFeedUrl(rawUrl)
  } catch {
    return { feedId: rawUrl, url: rawUrl, status: 'failed', added: 0, reason: '不是合法 URL' }
  }

  const previous = store.feed(feedId)
  // R15 02：来源识别（字段优先，否则 origin 命中实例池）。成功与 304 共用这一份 ——
  // 两个意图都是逐字段重建，漏传就等于「每刷新一次来源字段消失一次」。
  const rsshub = rsshubSourceOf({ url: feedId, rsshub: previous?.rsshub }, options.instances ?? [])
  // 内容版本落后 ⇒ 这一轮不带条件请求，强制拿 200 以便回填正文
  const needsContentUpgrade = (previous?.contentRevision ?? 1) < CONTENT_REVISION
  const validators: FeedValidators = needsContentUpgrade
    ? {}
    : { etag: previous?.etag, lastModified: previous?.lastModified }
  const instances = options.instances ?? []
  // 这一条是 A4 的承重判定：非 RSSHub 源**一个字节都不许**走下面的实例逻辑。
  const failover = rsshub !== undefined && instances.length > 0

  if (!failover) {
    const result = await doFetch(feedId, validators, options.limits, signal)
    // 池子为空时没有候选实例，也就没有「实际切换到的实例」可记：来源字段是历史事实（R15 02 的
    // 契约），这里原样保留，不因为用户关掉池子就把它改写成别的值。
    return settleFetch({
      feedId, store, options, previous, now, rsshub, result,
      parsed: undefined, instancesAttempted: undefined,
      contentUpgrade: needsContentUpgrade,
    })
  }

  const coolingNow = now().getTime()
  const order = rsshubInstanceOrder(
    rsshub?.instance,
    instances,
    (instance) => rsshubCooldown.isCooling(feedId, instance, coolingNow),
  )
  const startedAt = clock()
  const instancesAttempted: string[] = []
  const failures: RsshubAttemptFailure[] = []
  let success: { readonly instance: string; readonly result: FetchResult; readonly parsed: ParsedFeed | undefined } | undefined

  for (const instance of order) {
    if (instancesAttempted.length >= RSSHUB_MAX_ATTEMPTS) break
    // 预算必须是**整数毫秒**：clock 默认是 performance.now()（小数），而 AbortSignal.timeout
    // 只收整数（Node 抛 ERR_OUT_OF_RANGE）。向下取整只少等 ≤1 ms，不会突破 20 s 总预算。
    const remaining = Math.floor(RSSHUB_REFRESH_BUDGET_MS - (clock() - startedAt))
    // 第一个实例最多吃 12 s；它用满之后第二个只剩 8 s，两次合计不超过 20 s。
    if (remaining <= 0) break
    instancesAttempted.push(instance)
    const result = await doFetch(
      rsshubInstanceUrl(feedId, instance),
      // 条件请求只对**上次成功的那台**有意义：记录里的实例已移出池子、或正在冷却被排到后面时，
      // 候选顺序的第一个不是它，带上它的 ETag / Last-Modified 只会让别的实例回 304 ——
      // 那会被当成成功，并把 rsshub.instance 记成一台根本没取过内容的实例（真 bug）。
      // 老记录没有 instance 时一律不带：多一次 200 是可接受的，记错来源不是。
      instance === rsshub?.instance ? validators : {},
      { ...options.limits, timeoutMs: Math.min(RSSHUB_ATTEMPT_TIMEOUT_MS, remaining) },
      signal,
    )
    if (result.kind === 'failed') {
      failures.push({ instance, reason: result.reason })
      continue
    }
    if (result.kind === 'not-modified') {
      success = { instance, result, parsed: undefined }
      break
    }
    // 「200 但不是 feed」也算这次没拿到内容：有些实例/网关会用 200 回一张 HTML 错误页。
    // base 用 finalUrl：相对链接必须按**实际提供内容的那个地址**绝对化（评审 F1）。
    const parsed = parseFeed(result.body, result.finalUrl)
    if (parsed.format === 'unknown') {
      failures.push({ instance, reason: NOT_A_FEED_REASON })
      continue
    }
    success = { instance, result, parsed }
    break
  }

  const recordedAt = now().getTime()
  for (const failure of failures) rsshubCooldown.recordFailure(feedId, failure.instance, recordedAt)
  if (success === undefined) {
    return settleFetch({
      feedId, store, options, previous, now, rsshub,
      result: {
        kind: 'failed',
        reason: failures.length === 0 ? '没有可用的 RSSHub 实例' : rsshubFailureSummary(failures),
      },
      parsed: undefined,
      instancesAttempted,
      contentUpgrade: needsContentUpgrade,
    })
  }
  rsshubCooldown.recordSuccess(feedId, success.instance)
  return settleFetch({
    feedId, store, options, previous, now,
    rsshub: rsshub === undefined ? undefined : { ...rsshub, instance: success.instance },
    result: success.result,
    parsed: success.parsed,
    instancesAttempted,
    contentUpgrade: needsContentUpgrade,
  })
}

/**
 * 把一次抓取结果落库：200 解析入库 / 304 记成功 / failed 记失败。
 *
 * 抽出来是为了让两条抓取路径共用**同一段**入库逻辑（去重、身份、游标、来源字段、裁剪）。
 * 抄一份「RSSHub 版入库」是最容易让来源字段或失败计数在某一支上漂掉的做法。
 */
async function settleFetch(input: SettleInput): Promise<FeedOutcome> {
  const { feedId, store, options, previous, now, rsshub, result, instancesAttempted, contentUpgrade } = input
  const stamp = now().toISOString()
  const attempts = instancesAttempted === undefined ? {} : { instancesAttempted }

  // 抓取窗口内用户可能已经退订了这个源（removeFeed → store.deleteSubscription，一次变更）。
  // 判据必须带 previous !== undefined：**本轮开始时它得还在**。只判「现在不在」会把
  // 「首次抓取未预置源」也当成退订（既有夹具正是这种形状），那是行为漂移。
  // 这是一个**前置检查**，不是补偿：过了这一句到各次 saveItem 之间仍有 await 让出点，
  // 退订恰好落进这段窗口仍会写出孤儿条目 —— 那部分由装载时的孤儿报告兜底（ADR-0002）。
  // 一个源的这种失败也不该掀翻整轮（模块头的不变式①）。
  if (previous !== undefined && store.feed(feedId) === undefined) {
    return { feedId, url: feedId, status: 'failed', added: 0, reason: '订阅已在抓取期间移除，本轮结果丢弃', ...attempts }
  }

  let added = 0
  try {
    if (result.kind === 'failed') {
      // 字段合并规则在 src/feed-intent.ts（H4 收拢）；「失败的尝试也是一次尝试」的防饿死判据
      // 随意图走（refresh-failure），判据在 tests/refresh.test.mjs。
      await store.updateFeed(feedId, { kind: 'refresh-failure', url: feedId, stamp, reason: result.reason })
      return { feedId, url: feedId, status: 'failed', added: 0, reason: result.reason, ...attempts }
    }

    if (result.kind === 'not-modified') {
      // 升级轮里还被判 304（源忽略了无条件请求）：写回版本号避免每轮都重试，并留下痕迹。
      // 「是不是升级轮」由 refreshOne 只算一次后传进来（contentUpgrade），这里不重复推导。
      // 304 也是**成功**（源说「内容没变」）：lastFailure 必须清 —— 横幅只能反映最近一次真实结果
      //（用户实测：月光博客连续十几次 not-modified，横幅仍写 HTTP 502）。合并语义在 feed-intent.ts。
      await store.updateFeed(feedId, {
        kind: 'refresh-not-modified', url: feedId, stamp, contentRevision: CONTENT_REVISION, rsshub,
      })
      return contentUpgrade
        ? { feedId, url: feedId, status: 'not-modified', added: 0, reason: '源未响应无条件请求，正文升级跳过', ...attempts }
        : { feedId, url: feedId, status: 'not-modified', added: 0, ...attempts }
    }

    // 解析基准 = 本轮**真正取到内容**的地址（`finalUrl`），不是订阅 URL：实例切换后内容可能来自
    // 池里的另一台，用 `feedId` 会把 `/post/1` 拼到没提供过这份内容的实例上（评审 F1）。
    // 走到这里 `result.kind` 必是 `'ok'`（failed / not-modified 上面已各自返回），不必兜底。
    const parsed = input.parsed ?? parseFeed(result.body, result.finalUrl)
    const cursor = store.cursor(feedId)
    const seen = cursor?.seen ?? []

    /**
     * 身份索引：**这个源里我们见过什么**，供 resolveItemIds 判断「这条是不是老条目换了个身份」。
     *
     * 两个来源缺一不可：
     * - items 表里的条目 ⇒ 知道「老身份」是什么（源换 guid 写法后候选表里没有它了）；
     * - 游标里的 seen ⇒ 知道被保留量裁掉的条目（它不在表里，但身份仍被占用，见「去重不是归档」）。
     * 链接反查只走条目表：链接是**现在的**链接，只对还在表里的条目有意义。
     */
    const knownIds = new Set(seen)
    const idByLink = new Map<string, string>()
    /** 同链接分叉出多条时留下**最早**那条的记录：修复动作认的是它，与 identity-repair 同一判据 */
    const recordById = new Map<string, { link: string; title: string; publishedAt?: string; fetchedAt: string }>()
    for (const [itemId, record] of store.listItems(feedId)) {
      knownIds.add(itemId)
      recordById.set(itemId, { link: record.link, title: record.title, publishedAt: record.publishedAt, fetchedAt: record.fetchedAt })
      const link = record.link.trim()
      const previous = idByLink.get(link)
      if (previous === undefined) idByLink.set(link, itemId)
      else {
        const a = recordById.get(previous)
        if (record.fetchedAt < (a?.fetchedAt ?? record.fetchedAt)) idByLink.set(link, itemId)
      }
    }
    const known: KnownIdentities = {
      has: (id) => knownIds.has(id),
      idOf: (link) => idByLink.get(link),
      recordOf: (id) => recordById.get(id),
    }

    // 一次响应内先把身份解析干净：认回老身份，再处理撞车（规格 §5 不变量 2）
    const resolved = resolveItemIds(feedId, parsed.items, known)
    const seenSet = new Set(seen)
    const freshIds: string[] = []

    for (const [index, item] of parsed.items.entries()) {
      const itemId = resolved.ids[index]
      const summary = truncateContent(item.summary, options.maxContentChars)
      const parsedAuthor = normalizeAuthor(item.author)
      const existing = store.item(itemId)

      if (existing !== undefined || seenSet.has(itemId)) {
        // 已见过：只补「更完整的正文」与「从无到有的作者」，绝不碰 readAt / starred（已读与星标是用户数据）。
        // 这条同时承担回填：解析优先级修好后，老条目在下一次抓取里就能拿到全文。
        //
        // 要不要写的判据用循环开头那份 existing 快照（决策 9）：summary 变长、或作者从无到有。
        // 两个条件都不成立就**不调用** updateItem —— 空写会在每轮刷新里无谓地压写链。
        const summaryGrows = existing !== undefined && (summary?.length ?? 0) > (existing.summary?.length ?? 0)
        const authorMissing = existing !== undefined && existing.author === undefined && parsedAuthor !== undefined
        if (summaryGrows || authorMissing) {
          // ⚠️ 合并进**当前**记录，不要用循环开头那份 existing 快照整体写回：抓取是长任务，
          // 期间用户完全可能把它标已读/加星，用旧快照写回会把这些用户数据一起抹掉。
          // （2026-10-10 与 article 端点同一个丢失更新类别，判据在 tests/refresh.test.mjs）
          //
          // author 在回调里还要按 current 再判一次空：快照说「没有」不等于写入那一刻还没有。
          // 只补空、不覆盖 —— 源改作者名不该静默改写历史条目（决策 9）。
          await store.updateItem(itemId, (current) => {
            const next = summaryGrows ? { ...current, summary } : current
            return authorMissing && next.author === undefined ? { ...next, author: parsedAuthor } : next
          })
        }
        continue
      }

      seenSet.add(itemId)
      freshIds.push(itemId)
      await store.saveItem(itemId, {
        feedId,
        title: item.title,
        link: item.link,
        publishedAt: item.publishedAt,
        summary,
        // 作者的归一化只有 src/author.ts 一处口径（决策 3）：空白值不得落库成「有作者」。
        author: parsedAuthor,
        fetchedAt: stamp,
        starred: false,
      })
      added += 1
    }

    // 去重窗口的非法上限同理：0 / 负数 / NaN = 未配置 ⇒ 不截断（同一个判据：effectiveLimitOf）。
    // 清空 seen 会让下一轮把整份 feed 当成新内容重新导入成未读（条目暴增 + 已读态错位）。
    const seenLimit = effectiveLimitOf(options.maxSeenPerFeed)
    const nextSeen = [...freshIds, ...seen]
    await store.saveCursor(feedId, {
      seen: seenLimit === Number.POSITIVE_INFINITY ? nextSeen : nextSeen.slice(0, seenLimit),
      cursorAt: stamp,
    })
    await store.updateFeed(feedId, {
      kind: 'refresh-success',
      url: feedId,
      stamp,
      title: parsed.title ?? previous?.title,
      etag: result.etag,
      lastModified: result.lastModified,
      contentRevision: CONTENT_REVISION,
      rsshub,
    })
    await prune(store, feedId, options.maxItemsPerFeed)

    return {
      feedId,
      url: feedId,
      status: 'added',
      added,
      // 源在撒谎（同一次响应里 id 撞车）时留痕，由刷新摘要渲染出来 —— 它不该静默
      untrusted: resolved.untrusted > 0 ? resolved.untrusted : undefined,
      // 「认回了老条目」也留痕：它是「源的身份依据变过」这唯一一个可观测信号
      reclaimed: resolved.reclaimed > 0 ? resolved.reclaimed : undefined,
      ...attempts,
    }
  } catch (error) {
    // 单源持久化失败必须**就地降级**（模块头的不变式①）：磁盘满、config.json 被外部改坏、
    // SQLITE_BUSY 都只该影响这一个源。不接住的话，整轮 refreshFeeds 会 reject ——
    // 健康源的结果、日志摘要、正文缓存清算会一起丢掉（2026-11-15 实测）。
    return {
      feedId,
      url: feedId,
      status: 'failed',
      added,
      reason: '存储写入失败：' + (error instanceof Error ? error.message : String(error)),
      ...attempts,
    }
  }
}
