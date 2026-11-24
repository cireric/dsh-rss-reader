/**
 * 浏览器半的读写通道：33 个端点的**注册表**（2026-10-07 从 index.ts 拆出；2026-10-15 深化）。
 *
 * 原先这里是一个 switch：每臂各自手写 payload 解析、各自记得把未读账并进回包 ——
 * interface 的复杂度 ≈ implementation 的复杂度。现在「一个端点」是一个 module：
 * 名字的单点在 shared.ts（ENDPOINT_NAMES），回包形状与「是否必带未读账」在 ENDPOINTS 表里声明，
 * 分发核只做四件事：守卫 not-ready → 查表 → 交给 handler → 按声明合并账目；
 * 异常统一兜成 internal 信封。
 *
 * 名字表与 dispatch 的 case 必须是同一份（曾经是两处手写、靠人记得同步）；现在缺失即编译错误。
 */
import type { ZodType } from 'zod'
import {
  addFeedPayload,
  backfillHistoryPayload,
  cleanupPayload,
  discoverFeedsPayload,
  duplicateHintsPayload,
  exploreBuildUrlPayload,
  exploreCatalogPayload,
  idPayload,
  itemIdPayload,
  itemIdWindowPayload,
  markReadPayload,
  moveFeedToFolderPayload,
  namePayload,
  noPayload,
  opmlImportPayload,
  overviewPayload,
  removeFeedPayload,
  renameFolderPayload,
  renameTagPayload,
  reorderFeedsPayload,
  saveReadingProgressPayload,
  saveSettingsPayload,
  saveViewPreferencesPayload,
  scopePayload,
  searchQueryPayload,
  setItemTagsPayload,
  testRsshubPayload,
  unmarkReadPayload,
} from './endpoint-payloads.js'
import type { createSearch } from './search.js'
import type { Config } from './config.js'
import type { SettingsControl } from './settings-control.js'
import { EXTRACTOR_REVISION, contentVersionOf, fetchArticle, blocksToText } from './article.js'
import { BackfillError, backfillHistory } from './backfill.js'
import { rebuildItem } from './domain.js'
import { selectCleanup } from './retention.js'
import { buildOpml, parseOpml } from './opml.js'
import { FolderError } from './folders.js'
import { duplicateHintsOf, linkKeyOf, type DuplicateRow } from './duplicates.js'
import { TagError } from './tags.js'
import { discoverCandidates, validateSubscriptions } from './subscribe.js'
import { decodeRadarResponse, radarRulesUrl } from './radar.js'
import { fetchFeed } from './feed/fetch.js'
import { parseRsshubBase, parseTunableValue } from './settings-schema.js'
import type { ReaderStore, UnreadStore } from './store.js'
// R8b 03：探索的接线只**调用** 01 / 02 两层，不改它们的签名与行为。01 负责投影 / 检索 /
// 游标 / 拼装（唯一一份判据），02 负责出网与 12h 实例键缓存（唯一一份取表路径）。
import {
  buildExploreUrl,
  decodeCatalogCursor,
  encodeCatalogCursor,
  projectCatalog,
  type CatalogFilter,
  type CatalogIndex,
  type CatalogPosition,
} from './explore-catalog.js'
import { loadCatalog, type CatalogProjectResult } from './explore-catalog-fetch.js'
// 未读判据（isUnread / countUnreadPerFeed）不再由本文件在 JS 侧实现：Task 5 把它交给了存储侧，
// 自持实现里的 SQL `read_at IS NULL` 与 unread.ts 的 isUnread 是同一件事，两者的等价由
// tests/store-sqlite.test.mjs 的「同一夹具上逐键对账」钉住。shared.ts 仍是那条规则的定义处。
import { clampReadingRatio, fail, ok, type DuplicateHintView, type Endpoint, type ExploreCatalogPage, type ExploreRouteView, type ItemView, type Overview, type RefreshRun, type RpcResult } from './shared.js'
import type { UnreadAccount } from './unread.js'
import { sanitizeViewPreferences } from './preferences.js'
import { recencyOf } from './cursor.js'
import { decodeFencedCursor, encodeFencedCursor, queryFenceKey } from './cursor-fence.js'
import type { Cursor } from './cursor.js'
import type { DisplayWindowBounds } from './display-window.js'
import { buildItemPage, decodePageCursor, type PageScope } from './item-page.js'

/** 端点需要的运行时依赖（显式传入，不靠闭包）。 */
export interface EndpointDeps {
  readonly config: Config
  readonly log: (message: string) => void
  readonly ready: () => ReaderStore | undefined
  readonly refreshNow: (options?: { force?: boolean; signal?: AbortSignal }) => Promise<RefreshRun>
  /** 上次刷新完成时间（刷新状态留在 index.ts 那侧，这里只读） */
  readonly lastRefreshCompletedAt: () => number | undefined
  readonly searchItems?: ReturnType<typeof createSearch>['run']
  /**
   * 本机设置覆盖层（R11 01）。**显式注入**而不是塞进 ReaderStore：settings 是插件配置，
   * 不是条目数据（spec D30）。缺省只发生在测试桩没装配它时，端点会回 not-ready。
   */
  readonly settings?: SettingsControl
  /**
   * RSSHub 探活用的抓取实现（R8a 01）：默认 `fetchFeed`，测试注入桩件。
   * 与 subscribe 的 `options.fetchImpl` 同一手法 —— 否则「超时 / 非 2xx / 非 JSON」只能真出网才能测。
   */
  readonly fetchImpl?: typeof fetchFeed
  /**
   * 文章页抓取实现（R9 02）：默认 `fetchArticle`，只有回溯端点用它；测试注入桩件以断言
   * 「抓了哪几篇、间隔多少」而不真出网。index.ts 不传（生产走默认值）。
   */
  readonly fetchArticleImpl?: typeof fetchArticle
  readonly articleAttempts: Map<string, number>
}

/**
 * handler 拿到的请求上下文：一次请求解析一次。
 *
 * 为什么 store 是**值**而不是字段级的 ready()：每代装载会换掉 store（index.ts 的闭包变量），
 * 跨请求缓存句柄会在换代后悬垂。
 *
 * 为什么同时又带上 ready()：有两条路径在 await 之后还要**重新确认**句柄在不在 ——
 * refresh 端点 await 完一轮刷新、buildOverview 再去取数时，teardown 可能已经把这一代收摊了
 * （index.ts:460 的注释：「ready() 只挡得住下一次取 store」）。丢掉这一次重确认会让
 * 「关库后仍被读到」从「返回空列表」变成「抛错 → internal 信封」，那是行为变更。
 */
export interface EndpointCtx {
  readonly signal?: AbortSignal
  readonly store: ReaderStore
  readonly ready: () => ReaderStore | undefined
  readonly config: Config
  readonly log: (message: string) => void
  readonly refreshNow: (options?: { force?: boolean; signal?: AbortSignal }) => Promise<RefreshRun>
  readonly lastRefreshCompletedAt: () => number | undefined
  readonly searchItems?: ReturnType<typeof createSearch>['run']
  readonly settings?: SettingsControl
  readonly fetchImpl?: typeof fetchFeed
  readonly fetchArticleImpl?: typeof fetchArticle
  readonly articleAttempts: Map<string, number>
}

/**
 * 账目的**视野**：显示窗（收窄 unread / perFeedUnread）+ 读者本地「今天」的起点
 * （只在给了它时算 `unreadSplit`，见 R1 04 的 spec 决策 16 / 17）。
 *
 * 两者都是**可选**且互相独立：不带窗口 = 全量账；不带 todayFrom = 回包没有拆分。
 * 它们必须一起取自 `defineEndpoint` 的**那一次**解析（R1 02 决策 21 / ADR-0003）——
 * dispatch 若能为了拿字段再 `safeParse` 一遍，就有了第二个裁决者。
 */
export interface AccountFrame {
  readonly window?: DisplayWindowBounds
  readonly todayFrom?: string
}

/**
 * 一次端点调用的**解析回执**：回包 + 合并账目要用的视野。
 *
 * 视野必须取自 `defineEndpoint` 的**那一次**解析（R1 02 决策 21 / ADR-0003）。
 * 如果 dispatch 为了拿窗口再 `safeParse` 一遍，就有了第二个裁决者；如果 handler 自己算账，
 * overview 与写端点就会各有一份口径 —— 本票要收敛掉的正是后者。所以把「同一份解析结果里的
 * 窗口与今天起点」显式交回分发核，而不是让它去翻原始 payload。
 */
export interface EndpointOutcome {
  readonly result: RpcResult<unknown>
  /** 解析后的账目视野；缺省 = 全量账、无拆分（不带窗口的旧请求）。 */
  readonly accountFrame?: AccountFrame
}

/**
 * 一个端点的声明。
 *
 * `carriesAccount`：该端点的回包是否**必须**并入未读账（总数 + 每源）。
 * 收进声明而不是让每个 handler 自己拼：这条横切不变量原先在 5 个 case 里各写一遍
 * （`...accountOf(target)`），任一处漏掉就是「幽灵未读」——客户端拿本地增量当真相，
 * 左栏各源之和 ≠ 顶栏总数（spec §4 不变量 1）。
 *
 * `accountFrameOf`：带账端点的视野提取器（显示窗 + todayFrom），入参是**已解析**的那份值。
 * 声明成必填的约定（代码层面可选是因为非带账端点不需要）：带账却漏了它，窗口会被静默忽略、
 * 账目回全量，端点用例会立刻翻红 —— 那是这条约定唯一的守卫。
 *
 * `payload`：入参形状的**唯一**声明（`src/endpoint-payloads.ts`）。`to` 收到的已经是解析后的值，
 * 所以 handler 体内不再有 `payload as`。零入参端点写 `noPayload`（= `z.unknown()`）。
 */
export interface EndpointSpec {
  readonly carriesAccount?: true
  readonly payload: ZodType<unknown>
  /** 解析失败时给调用方看的那一句话；零入参端点没有这条路径，可以省。 */
  readonly invalidMessage?: string
  readonly to: (payload: unknown, ctx: EndpointCtx) => Promise<EndpointOutcome>
}

/**
 * 端点声明的构造器：把「解析一次」收在这里，`ENDPOINTS` 的每一项都经它声明。
 *
 * 为什么不在 `createDispatch` 里解析：dispatch 拿到的 `spec.to` 是**擦除过类型**的
 * `(payload: unknown) => …`。要在那里解析，handler 就得重新接回 `unknown` 再 cast 一遍 ——
 * 正是阶段 5 要消灭的东西。工厂闭包保留 `P`，handler 拿到的是已解析的类型。
 *
 * 失败信封只有一种：`bad-request` + 端点自己的中文文案 + `details.issues`（字段路径与
 * issue code，不含原始值 —— 日志与测试要能定位「哪个字段」，不该把用户输入抄进回包）。
 */
function defineEndpoint<P>(spec: {
  readonly carriesAccount?: true
  readonly payload: ZodType<P>
  readonly invalidMessage?: string
  /** 带账端点必须声明：从**已解析**的入参里取账目视野（见 EndpointOutcome 的注释）。 */
  readonly accountFrameOf?: (input: P) => AccountFrame
  readonly to: (input: P, ctx: EndpointCtx) => Promise<RpcResult<unknown>>
}): EndpointSpec {
  return {
    ...(spec.carriesAccount === true ? { carriesAccount: true as const } : {}),
    payload: spec.payload,
    ...(spec.invalidMessage === undefined ? {} : { invalidMessage: spec.invalidMessage }),
    to: async (raw, ctx) => {
      const parsed = spec.payload.safeParse(raw)
      if (!parsed.success) {
        return {
          result: fail('bad-request', spec.invalidMessage ?? '入参无效', {
            issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String), code: issue.code })),
          }),
        }
      }
      const result = await spec.to(parsed.data, ctx)
      // 账目视野与回包来自**同一次** safeParse 的 parsed.data：没有第二遍解析，也没有 handler 自算。
      return spec.accountFrameOf === undefined
        ? { result }
        : { result, accountFrame: spec.accountFrameOf(parsed.data) }
    },
  }
}

/**
 * 按需正文缓存的**内容版本** = 抽取器版本（定义在 article.ts，与抽取逻辑同文件）。
 *
 * 缓存命中要求版本相等——版本落后就被判为过期并**自动重抓一次**，否则抽取规则的改进对已有
 * 缓存永远不生效（实测两次：库里 9 条老缓存导致「图片怎么都不显示」；上一轮改了抽取但没抬版本，
 * 已缓存的文章继续显示站点头像与二维码）。**不要再在这里写死数字**——那正是它上次漂移的方式。
 */
const ARTICLE_REVISION = EXTRACTOR_REVISION

/** 账目的总数：与 buildOverview 一样由每源账目**求和派生**，绝不另数一遍（两处口径必然漂移）。 */
const sumOf = (perFeedUnread: Record<string, number>): number =>
  Object.values(perFeedUnread).reduce((sum, count) => sum + count, 0)

/**
 * 文件夹操作的可预期失败 → 带 code 的失败信封（bad-request / conflict / not-found）。
 * 其它异常**原样抛出**：读写文件失败是 internal，不能伪装成用户输入错误。
 */
const folderFailure = (error: unknown): RpcResult<never> | undefined =>
  error instanceof FolderError ? fail(error.code, error.message) : undefined

/** 标签操作的同一套失败信封转换；其它异常原样抛给 dispatch 的 internal 兜底。 */
const tagFailure = (error: unknown): RpcResult<never> | undefined =>
  error instanceof TagError ? fail(error.code, error.message) : undefined

/**
 * 同一订阅源的在途回溯（R9 02，spec §4.1）：第二次运行由**宿主**拒绝，而不是只靠界面禁用。
 *
 * 模块级而不是挂在 ctx / store 上：store 每代装载会换，闸门必须跨换代有效；而「一个源同时在跑
 * 两次回溯」是进程级事实。`finally` 清理（成功、失败、抛错三条路径都释放），否则一次失败会把
 * 该源永久锁死。
 */
const BACKFILL_IN_FLIGHT = new Set<string>()

/**
 * 读一次未读账（总数 + 每源）。只读，不改任何条目。
 *
 * **这是全仓库唯一的算账处**（R1 02 决策 20）：overview 与分发核（五个带账写端点）都调它。
 * 总账由每源账目**求和派生**，绝不另数一遍 —— 两处各算一次时，截断/漂移截面下迟早对不上。
 *
 * @param frame 账目视野（显示窗 + 今天的起点）；缺省 = 全量账、无拆分。取自调用方**已经解析过**
 *              的那份入参（overview 的 from/to/todayFrom 或 dispatch 的 EndpointOutcome.accountFrame），
 *              这里不再解析任何东西。
 */
const accountOf = (target: UnreadStore, frame?: AccountFrame): UnreadAccount => {
  // 键域与判据都走**存储侧那一份**实现：未读判据就是 unread.ts 的 isUnread（自持实现里写作
  // `read_at IS NULL`，两者是同一件事的两种写法，有测试在同一夹具上逐键对账），键域 =
  // listFeeds() 的全量键（0 未读的源也留 0）。
  //
  // 为什么不再在这里对 allItems() 跑 countUnreadPerFeed：① 口径会分家 —— 这里算一遍、SQL 里
  // 再算一遍，正是任务 1 的键域与任务 5 的 unread 漂过两次的那条路；② 10 万行下每次标读/撤销/
  // 星标/保持未读/清理都拖着一次全表物化（spec §3.1 列的五处调用点）。
  const feedIds = target.listFeeds().map(([feedId]) => feedId)
  const perFeedUnread = target.unreadPerFeed(feedIds, frame?.window)
  const account: UnreadAccount = { unread: sumOf(perFeedUnread), perFeedUnread }
  // 拆分只在请求给了 todayFrom 时出现：不带窗口的旧请求回包形状逐字不变（spec 验收 14）。
  // 它描述的是**全部未读**的构成，所以即使带了窗口也按同一键域算同一份（spec 决策 17）。
  if (frame?.todayFrom === undefined) return account
  return { ...account, unreadSplit: target.unreadSplit(feedIds, frame.todayFrom) }
}

/**
 * 从 overview/refresh 的**已解析**入参里取显示窗（形状与 `from < to` 已由 payload 声明判过，
 * 这里只做「缺席 ⇒ 不传窗口」的归一 —— 判据只有一处，别在这里重新校验）。
 *
 * `null` 与缺席同义：浏览器通道把缺省序列化成 `null`（与 folder / tagId 同一条 wire 形状）。
 */
function displayWindowOf(
  input: { readonly from?: string | null; readonly to?: string | null },
): DisplayWindowBounds | undefined {
  const { from, to } = input
  if (from === undefined || from === null || to === undefined || to === null) return undefined
  return { from, to }
}

/**
 * 从**已解析**入参里取账目的完整视野：显示窗 + 今天的起点（`todayFrom`）。
 *
 * 三个字段同属一段 `windowShape` 声明，所以这里也是同一次解析的产物；`null` 与缺席同义
 * （浏览器通道把缺省序列化成 null）。两个值互相独立：只有 from/to 时照旧按窗算账，
 * 只有 todayFrom 时照旧回全量账 + 拆分（「全部」档位就是这种组合）。
 */
function accountFrameOf(
  input: { readonly from?: string | null; readonly to?: string | null; readonly todayFrom?: string | null },
): AccountFrame {
  const window = displayWindowOf(input)
  const todayFrom = input.todayFrom ?? undefined
  return {
    ...(window === undefined ? {} : { window }),
    ...(todayFrom === undefined ? {} : { todayFrom }),
  }
}

/**
 * 范围标读的候选 id（ADR-0008）：在**库全量**上按与客户端同一组条件求值。
 *
 * 条件：范围（feedId / folder / tagId / 全库）× 显示窗（from/to，只判 publishedAt）
 * × 过滤（`starred` 时只看星标）× `before`（recency 阈值）× 未读且非「保持未读」。
 *
 * 实现走 `listRecent` 500/页遍历到游标用尽：单页上限与浏览端点共用同一条分页协议
 *（ADR-0004），不在这里另写一套 SQL。库规模到十万级再换成宿主直查 —— 那是性能决定，
 * 不是语义决定。
 */
const SCOPE_MARK_PAGE = 500

function scopeMarkCandidates(
  ctx: EndpointCtx,
  input: {
    readonly feedId?: string | null
    readonly folder?: string | null
    readonly tagId?: string | null
    readonly all?: boolean | null
  },
  filter: { readonly before?: string; readonly skipKept: boolean; readonly starred: boolean; readonly window?: DisplayWindowBounds },
): { ids?: string[]; failure?: RpcResult<never> } {
  let feedIds: readonly string[] | undefined
  let tagId: string | undefined
  if (input.feedId !== undefined && input.feedId !== null && input.feedId !== '') {
    if (ctx.store.feed(input.feedId) === undefined) return { failure: fail('not-found', '订阅源不存在：' + input.feedId) }
    feedIds = [input.feedId]
  } else if (input.folder !== undefined && input.folder !== null && input.folder !== '') {
    const found = ctx.store.listFolders().find((entry) => entry.name === input.folder)
    if (found === undefined) return { failure: fail('not-found', '文件夹不存在：' + input.folder) }
    feedIds = found.feedIds
  } else if (input.tagId !== undefined && input.tagId !== null && input.tagId !== '') {
    if (ctx.store.listTags().every((tag) => tag.id !== input.tagId)) {
      return { failure: fail('not-found', '标签不存在：' + input.tagId) }
    }
    tagId = input.tagId
  }
  const ids: string[] = []
  let cursor: Cursor | undefined
  for (;;) {
    const rows = ctx.store.listRecent(SCOPE_MARK_PAGE, cursor, feedIds, tagId, filter.window)
    for (const [itemId, record] of rows) {
      if (record.readAt !== undefined) continue
      if (filter.skipKept && record.keptUnread === true) continue
      if (filter.starred && record.starred !== true) continue
      if (filter.before !== undefined && recencyOf(record) >= filter.before) continue
      ids.push(itemId)
    }
    if (rows.length < SCOPE_MARK_PAGE) break
    const last = rows[rows.length - 1]
    cursor = { recency: recencyOf(last[1]), id: last[0] }
  }
  return { ids }
}

/** 从 overview/refresh 的**已解析**入参里把范围落到库上（形状由 payload 声明判，这里只判存在性）。 */
function overviewScopeOf(
  ctx: EndpointCtx,
  input: { readonly feedId?: string | null; readonly folder?: string | null; readonly tagId?: string | null },
): { scope?: PageScope; failure?: RpcResult<never> } {
  const { feedId, folder, tagId } = input
  if (feedId !== undefined && feedId !== null) {
    // 源范围必须由宿主先筛再分页（R14）：客户端拿全局第一页过滤会让低产源只露出
    // 恰好落在这一页里的几条。与 folder / tag 一样，存在性在这里判，不存在回 not-found。
    if (ctx.store.feed(feedId) === undefined) return { failure: fail('not-found', '订阅源不存在：' + feedId) }
    return { scope: { kind: 'feed', id: feedId } }
  }
  if (tagId !== undefined && tagId !== null) {
    const found = ctx.store.listTags().find((tag) => tag.id === tagId)
    if (found === undefined) return { failure: fail('not-found', '标签不存在：' + tagId) }
    // 标签 id 是稳定主键：改名不会让当前浏览范围失效；删除才会（listTags 找不到）。
    return { scope: { kind: 'tag', id: found.id } }
  }
  if (folder === undefined || folder === null) return {}
  const found = ctx.store.listFolders().find((entry) => entry.name === folder)
  if (found === undefined) return { failure: fail('not-found', '文件夹不存在：' + folder) }
  return { scope: { kind: 'folder', name: folder, feedIds: found.feedIds } }
}

/**
 * 一页列表 + 续页游标。
 *
 * @param run       本轮刷新的明细（refresh 端点用；overview 缺省 ⇒ 回包不带 refresh 字段、
 *                  refreshed 恒 false）。X/Y、节流与并入在途的区别全在这一个值里（M4 02）。
 * @param cursor    续页边界（keyset）；缺省 = 第一页。游标由 overview 端点围栏解码后传入，
 *                  这里**不再判形状** —— 认不出的游标在那一层就被响亮拒了（见 ENDPOINTS.overview）
 * @param scope     浏览范围；缺省 = 普通跨源契约（逐字不变）。有它时取页在 SQL 侧先按成员/标签过滤再限页。
 * @param frame     账目视野（显示窗 + 今天的起点）；缺省 = 「全部」、无拆分 —— 取数与栅栏行为
 *                  与加窗之前逐字相同。窗口只作用于**列表取数与 unread / perFeedUnread**；
 *                  `unreadSplit` 描述全部未读的构成，与窗口无关（spec 决策 17）。
 */
const buildOverview = (
  ctx: EndpointCtx,
  run?: RefreshRun,
  cursor?: Cursor,
  scope?: PageScope,
  frame?: AccountFrame,
): Overview => {
  // 列表取数只看窗口这一半；拆分不参与取页（它描述全部未读的构成，与窗口无关）。
  const window = frame?.window
  const refreshedAtMs = ctx.lastRefreshCompletedAt()
  // refreshed 是布尔概况（客户端历史上就靠它），refresh 说明细节 —— 两者由同一个 run 派生，
  // 不允许各自算一遍：否则「refreshed=true 而 outcome=throttled」这种自相矛盾迟早出现。
  const refreshed = run?.outcome === 'ran'
  const target = ctx.ready()
  if (!target) {
    return { feeds: [], folders: [], tags: [], items: [], unread: 0, perFeedUnread: {}, refreshed, ...(run === undefined ? {} : { refresh: run }) }
  }

  const feeds = target.listFeeds().map(([feedId, record]) => ({
    id: feedId,
    title: record.title ?? feedId,
    ...(record.folder ? { folder: record.folder } : {}),
    lastFetchedAt: record.lastFetchedAt,
    lastAttemptedAt: record.lastAttemptedAt,
    lastFailure: record.lastFailure,
    // failureCount 原样透出：undefined（历史未知）与 0（真实零连败）在 wire 上必须能区分，
    // 补一个 0 就会把「不知道」谎报成「没失败过」（M4 02）。
    failureCount: record.failureCount,
  }))
  // 目录必须每次随 overview 下发：左栏要显示空文件夹/空标签，而 feeds 里没有它们的位置。
  const folders = target.listFolders()
  const tags = target.listTags()

  // 「源 id → 标题」以 feeds 表为键域：只收「所属源还在」的条目，与原先由 listFeeds 驱动的
  // 语义保持一致（退订时条目本该连删除掉，见 removeFeed；这里挡的是残留/手工改库的情形）。
  const titles = new Map<string, string>()
  for (const feed of feeds) titles.set(feed.id, feed.title)

  // 账目**不再由这里自己算**（R1 02 决策 20）：与分发核共用 accountOf，视野也传同一份。
  // 原先这里与 accountOf 各写一段 unreadPerFeed 调用 —— 两段代码自洽、合起来漂移时，
  // 单快照断言永远看不见；「overview 与写端点在同一个窗口下逐项相等」由端点用例钉住。
  const account = accountOf(target, frame)

  // 一页条目交给 src/item-page.ts（ADR-0004）：窗口放大、多取一行判尾、游标围栏都在那里。
  // 这里只做投影（行 → ItemView）与标签批量补 —— 两者是 wire 形状，不是分页协议。
  const page = buildItemPage(target, {
    ...(scope === undefined ? {} : { scope }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(window === undefined ? {} : { window }),
    pageSize: ctx.config.maxItemsShown,
    knownFeedIds: new Set(titles.keys()),
  })
  // 模块已按同一份 titles 键域滤掉孤儿；走到这里还缺标题，说明两个判定已经分家（不是用户输入问题），
  // 响亮抛错 —— 再回落一次 feedId 会把契约破坏伪装成「标题就是 id」的条目。
  const feedTitleOf = (feedId: string): string => {
    const title = titles.get(feedId)
    if (title === undefined) throw new Error('一页条目下发了 feeds 键域之外的条目：' + feedId)
    return title
  }
  // 每页一次批量取标签 id（不能逐行 N+1）；ItemView 的 tagIds 是列表行标签与编辑器的数据源。
  const tagIdsByItem = target.tagIdsForItems(page.rows.map(([itemId]) => itemId))
  const items: ItemView[] = page.rows.map(([itemId, item]) => ({
    id: itemId,
    feedId: item.feedId,
    feedTitle: feedTitleOf(item.feedId),
    title: item.title,
    author: item.author,
    link: item.link,
    publishedAt: item.publishedAt,
    fetchedAt: item.fetchedAt,
    readAt: item.readAt,
    starred: item.starred,
    keptUnread: item.keptUnread,
    summary: item.summary,
    tagIds: tagIdsByItem[itemId] ?? [],
  }))

  const nextCursor = page.nextCursor

  return {
    feeds,
    folders,
    tags,
    items,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    // 总数由每源账目**求和派生**（accountOf 内），不再单独数一遍 —— 见 accountOf 的注释。
    unread: account.unread,
    perFeedUnread: account.perFeedUnread,
    // 拆分是可选字段：不带 todayFrom 时**不出现**（旧形状逐字不变），不是 0/0/0。
    ...(account.unreadSplit === undefined ? {} : { unreadSplit: account.unreadSplit }),
    refreshed,
    ...(run === undefined ? {} : { refresh: run }),
    // 让界面能说明「上次到底什么时候抓过」——否则「按住刷新没反应」无从判断
    refreshedAt: refreshedAtMs === undefined ? undefined : new Date(refreshedAtMs).toISOString(),
  }
}
// ── R8b 03：探索的两个只读端点（spec §4.3 / §4.5）────────────────────────────

/** 一页的默认条数与上限（spec §4.3）：展示偏好，越界夹取不拒绝。 */
const CATALOG_PAGE_DEFAULT = 30
const CATALOG_PAGE_MAX = 100

/**
 * 实例源站 + 「这个实例当前是否可用」的唯一判据。
 *
 * 未配置是**功能关闭**（D11），不是实例故障：翻成 `not-configured` 让界面能指回设置页，
 * 同时保证这一刻零请求（B9）。非法地址也归同一个码 —— 对调用方是同一件事「没有可用的实例」，
 * 差别只在文案；地址判据仍只有 `parseRsshubBase` 这一份，不在这里重写协议 / 路径的规则。
 */
function exploreBaseOf(ctx: EndpointCtx): { ok: true; base: string } | { ok: false; result: RpcResult<never> } {
  const base = parseRsshubBase(ctx.config.rsshubBase)
  if (base === '') {
    return { ok: false, result: fail('not-configured', '未配置 RSSHub 实例地址，无法浏览路由表') }
  }
  if (base === undefined) {
    return {
      ok: false,
      result: fail('not-configured', 'RSSHub 实例地址不合法（只支持 http(s) 源站，不能带路径 / 查询 / 参数），无法浏览路由表'),
    }
  }
  return { ok: true, base }
}

/**
 * 01 的投影 → 02 的取表之间那层**薄适配**（票面明确不许改两侧签名）。
 *
 * 投影回 `{ ok, catalog, invalid }`，取表层要 `{ ok, value, totals? }`。把 `sites` / `total`
 * 顺带塞进 `totals`，02 的成功日志就能报「N 站 / M 路由」——不必为了凑一句日志去改投影形状。
 * `invalid` 在端点这一层没有下发位置（wire 里没有它），只作为 02 日志与 01 用例的事实。
 */
function projectForLoad(raw: unknown): CatalogProjectResult<CatalogIndex> {
  const projected = projectCatalog(raw)
  if (!projected.ok) return projected
  return {
    ok: true,
    value: projected.catalog,
    totals: { siteTotal: projected.catalog.sites, routeTotal: projected.catalog.total },
  }
}

/**
 * 取表：两个端点共用同一条路径（同一份缓存、同一份失败文案）。
 *
 * 失败统一翻成 `catalog-unavailable`：拉不到表既不是调用方的请求错误（400 会让人去查自己的
 * 入参），也不是插件内部异常（internal 会让人以为代码坏了）。真正的原因（超时 / 非 JSON /
 * 内网地址被拒）由 02 原样给出，这里只加一层「拉取路由表失败」的上下文。
 */
async function loadExploreCatalog(
  ctx: EndpointCtx,
  base: string,
): Promise<{ ok: true; catalog: CatalogIndex } | { ok: false; result: RpcResult<never> }> {
  const loaded = await loadCatalog(base, projectForLoad, { fetchImpl: ctx.fetchImpl, log: ctx.log })
  if (loaded.kind === 'failure') {
    return { ok: false, result: fail('catalog-unavailable', '拉取路由表失败：' + loaded.reason) }
  }
  return { ok: true, catalog: loaded.catalog }
}

/** 入参 → 01 的检索条件；null 与缺省都当「不生效」（与 01 的 normalizeFilter 同一语义）。 */
function catalogFilterOf(
  input: { readonly q?: string | null; readonly category?: string | null; readonly namespace?: string | null },
): CatalogFilter {
  return {
    ...(input.q === null || input.q === undefined ? {} : { q: input.q }),
    ...(input.category === null || input.category === undefined ? {} : { category: input.category }),
    ...(input.namespace === null || input.namespace === undefined ? {} : { namespace: input.namespace }),
  }
}

/**
 * 一页 = 游标边界之后的 `limit` 行。
 *
 * 边界行必须**还在**当前结果里：栅栏保证筛选相同、目录在同一次缓存里冻结，正常情况一定找得到；
 * 找不到只可能是 12h 过期后实例换了表。此时明确失败 —— 回第一页会让界面无限追加重复行
 *（与 spec §4.3 / B7 拒绝失配游标是同一条理由）。返回 undefined = 这一页无法定位。
 */
function catalogPageOf(
  items: readonly ExploreRouteView[],
  position: CatalogPosition | undefined,
  limit: number,
): { page: ExploreRouteView[]; hasMore: boolean } | undefined {
  let start = 0
  if (position !== undefined) {
    const boundary = items.findIndex((row) => row.namespace === position.namespace && row.path === position.path)
    if (boundary < 0) return undefined
    start = boundary + 1
  }
  const page = items.slice(start, start + limit)
  return { page, hasMore: start + page.length < items.length }
}

/**
 * 端点表：35 个端点一处声明（每项的 `payload` 是入参形状的唯一声明）。
 *
 * 穷尽性由 `Record<Endpoint, EndpointSpec>` 保证 —— 名字表（shared.ts 的 ENDPOINT_NAMES）
 * 加了新端点而这里没跟上，编译就不过。这是本文件里唯一需要「加端点时改的地方」。
 */
export const ENDPOINTS: Record<Endpoint, EndpointSpec> = {
  searchItems: defineEndpoint({
    payload: searchQueryPayload,
    invalidMessage: '搜索词、日期范围或分页游标无效',
    to: async (input, ctx) => {
      if (!ctx.searchItems) return fail('not-ready', '搜索服务尚未就绪')
      const query = input
      const selected = query.feedIds === undefined ? undefined : new Set(query.feedIds)
      const feeds: Array<[string, string]> = ctx.store.listFeeds()
        .filter(([id]) => (query.feedId === undefined || query.feedId === id) && (selected?.has(id) ?? true))
        .map(([id, feed]) => [id, feed.title ?? id])
      // 查询条件栅栏与搜索工具共用一份实现（src/cursor-fence.ts）：条件变、旧游标必须响亮失败。
      const key = queryFenceKey([
        query.text, query.read, query.starred === true, query.from, query.to, query.tagId, feeds.map(([id]) => id).sort(),
      ])
      const parsed = decodeFencedCursor(key, query.cursor)
      if (parsed.status === 'mismatch') return fail('bad-request', '分页游标与当前搜索不匹配，请重新搜索')
      const page = await ctx.searchItems({ ...query, cursor: parsed.inner, feedId: feeds.length === 1 ? feeds[0][0] : undefined }, feeds, 30, ctx.signal)
      return ok({ ...page, nextCursor: encodeFencedCursor(key, page.nextCursor) })
    },
  }),
  overview: defineEndpoint({
    payload: overviewPayload,
    invalidMessage: 'overview 的 folder / tagId / cursor / 时间窗口无效',
    to: async (input, ctx) => {
      // 续页游标**必须解码成功**才继续（Overview 的契约）。认不出时**响亮拒绝**：
      // 「解不出就从第一页开始」会让翻页永远翻不完 —— 每页都回同一批条目，界面无限追加重复行，
      // 而用户看到的是一份「永远滚不到底」的列表，不是一句报错。
      const resolved = overviewScopeOf(ctx, input)
      if (resolved.failure !== undefined) return resolved.failure
      const scope = resolved.scope
      // 窗口与 todayFrom 只解析这一次：下游（取页、栅栏、账目）都拿这同一份值，
      // 不许各自再从 payload 里抠一遍。
      const frame = accountFrameOf(input)
      const raw = input.cursor
      if (raw === undefined || raw === null) return ok(buildOverview(ctx, undefined, undefined, scope, frame))
      // 围栏（前缀 = 范围键 + 窗口键）与形状都由一页条目模块判（ADR-0004）；两种失败各留一句文案：
      // 「范围变了」要客户端重载当前范围，「格式认不出」是调用方传了垃圾 —— 处置不同，不能合并。
      // 窗口进栅栏：切档后旧游标在这里失配，绝不静默按旧边界续页。
      const parsed = decodePageCursor(scope, raw, frame.window)
      if (parsed.status === 'mismatch') return fail('bad-request', '分页游标与当前范围不匹配，请重新加载')
      if (parsed.status === 'malformed') return fail('bad-request', '未知的续页游标（格式应为 "<recency>|<id>"）：' + raw)
      return ok(buildOverview(ctx, undefined, parsed.cursor, scope, frame))
    },
  }),

  refresh: defineEndpoint({
    payload: scopePayload,
    invalidMessage: 'refresh 的 folder / tagId / 时间窗口无效',
    to: async (input, ctx) => {
      // 在文件夹里点刷新时必须留在同一范围：否则列表会突然跳回跨源首页（用户会以为选中的文件夹丢了）。
      const resolved = overviewScopeOf(ctx, input)
      if (resolved.failure !== undefined) return resolved.failure
      // 窗口同理：refresh 回的是同一页 + 同一份账，不带窗口就会把视图悄悄放回「全部」。
      // 拆分也要跟着同一份视野走，否则刷新一次顶栏的三分就消失了。
      const frame = accountFrameOf(input)
      const run = await ctx.refreshNow()
      return ok(buildOverview(ctx, run, undefined, resolved.scope, frame))
    },
  }),

  markRead: defineEndpoint({
    payload: markReadPayload,
    invalidMessage: 'markRead 需要 itemIds 数组，或恰好一个范围（feedId / folder / tagId / all）；时间窗口必须成对且合法',
    carriesAccount: true,
    accountFrameOf,
    to: async (input, ctx) => {
      const itemIds = input.itemIds
      // 「全部标为已读」（A 键）走这条时带 skipKept：**保持未读的条目要活下来**
      // —— 那正是规格 §3.3 里 kept-unread 的用处；而单条打开/显式标记不带它，
      // 那种情况下按规格「标为已读即移除 kept-unread」。
      const skipKept = input.skipKept === true
      // 「只标**早于** X 的」（规格 §3.3 的 panic button，2009-08 加入）。客户端会先按范围过滤一遍，
      // 这里是**第二道闸**：客户端列表只是快照，宿主手上的 recency 才是权威。
      // 空串仍是「没有范围」：形状声明只判类型，这条归一留在这里。
      const before = input.before === undefined || input.before === null || input.before === ''
        ? undefined
        : input.before
      // 范围路径（ADR-0008）：宿主在库全量上求值，客户端只给「范围 × 过滤 × 窗 × 阈值」。
      // itemIds 缺席 = 范围/all 标读；`dryRun` 只回条数（确认框的 N），一个字都不写。
      const bulk = itemIds === undefined || itemIds === null
      const starred = input.starred === true
      let targets: string[]
      if (bulk) {
        const resolved = scopeMarkCandidates(ctx, input, {
          ...(before === undefined ? {} : { before }),
          skipKept,
          starred,
          ...(displayWindowOf(input) === undefined ? {} : { window: displayWindowOf(input) }),
        })
        if (resolved.failure !== undefined) return resolved.failure
        targets = resolved.ids ?? []
        if (input.dryRun === true) return ok({ count: targets.length })
      } else {
        targets = itemIds
      }
      const stamp = new Date().toISOString()
      let changed = 0
      const changedIds: string[] = []
      for (const itemId of targets) {
        const existing = ctx.store.item(itemId)
        if (existing === undefined || existing.readAt !== undefined) continue
        // 范围路径的筛条件**只在 `scopeMarkCandidates` 里判一次**（ADR-0001：一条判据一个裁决者）。
        // 这里不再复判：两处都判会让「删掉其中一处」变成等价变异，变异门槛就看不见真正的缺口。
        // itemIds 路径没有那一段求值，所以它的筛条件必须在这里。
        if (!bulk) {
          if (skipKept && existing.keptUnread === true) continue
          // 判据与排序同源（recency = 发布时间优先、缺则抓取时间），ISO 字符串可直接比大小
          if (before !== undefined && recencyOf(existing) >= before) continue
        }
        // 幂等：已读的原时间戳不动。用 rebuildItem 是为了同时把 kept-unread 去掉
        await ctx.store.saveItem(itemId, rebuildItem(existing, { omit: ['keptUnread'], set: { readAt: stamp } }))
        changed += 1
        changedIds.push(itemId)
      }
      // 回包**必须带 perFeedUnread**：客户端在截断场景下看不见全量条目，只能靠这份整体覆盖
      // （spec §4 不变量 1；任务 9 实测：本地 3 条/宿主 20，外部把本地不可见的源标空 ⇒ 差 3）。
      // 账目由分发核按 carriesAccount 统一合并 —— 这条不变量不再由本 handler 承担。
      // 范围路径回被标 id：撤销条按 id 集合工作，客户端此前并不知道宿主选了哪些（ADR-0008）。
      return ok(bulk ? { changed, ids: changedIds } : { changed })
    },
  }),

  unmarkRead: defineEndpoint({
    payload: unmarkReadPayload,
    invalidMessage: 'unmarkRead 需要 itemIds 数组，时间窗口必须成对且合法',
    carriesAccount: true,
    accountFrameOf,
    to: async (input, ctx) => {
      // 只服务于「全部标记已读」的短时撤销
      const itemIds = input.itemIds
      let changed = 0
      for (const itemId of itemIds) {
        const existing = ctx.store.item(itemId)
        if (existing === undefined || existing.readAt === undefined) continue
        // 只去掉 readAt：原先这里调的那个 helper 按 7 个字段重建，会把 article 缓存
        // 一起丢掉——撤销「全部已读」不该动内容缓存（2026-10-07 随三处重建收敛时修掉）
        await ctx.store.saveItem(itemId, rebuildItem(existing, { omit: ['readAt'] }))
        changed += 1
      }
      // 同上：撤销也要把每源账目一并下发，客户端才不必拿本地增量去猜（同一个不变量）。
      return ok({ changed })
    },
  }),

  article: defineEndpoint({
    payload: itemIdPayload,
    invalidMessage: 'article 需要 itemId',
    to: async (input, ctx) => {
      // 按需正文（V 键）：先看缓存，再冷却，最后才抓原站。三步都留日志——这是唯一会
      // 出网的用户手势，出问题时必须能从日志里还原过程。
      const itemId = input.itemId
      const existing = ctx.store.item(itemId)
      if (existing === undefined) return fail('not-found', '条目不存在：' + itemId)
      // 命中缓存的前提：**缓存的内容版本等于当前版本**。
      // 老缓存（升级前抓的，只有纯文本 paragraphs）没有版本号 ⇒ 判为过期、自动重抓一次。
      // 否则模型升级后老缓存会永远挡住新逻辑——实测：9 条老缓存导致「图片怎么都不显示」。
      if (existing.article !== undefined && existing.article.revision === ARTICLE_REVISION) {
        // 内容标识与进度都从**这一份**缓存算（M5 02）：客户端拿到的版本号与它即将显示的
        // 块列表严格同源，才谈得上「同一份正文的进度」。进度读的是本地库，不出网。
        const contentVersion = contentVersionOf(ARTICLE_REVISION, existing.article.blocks)
        return ok({
          itemId, cached: true, title: existing.article.title,
          blocks: existing.article.blocks, paragraphs: existing.article.paragraphs,
          frameable: existing.article.frameable,
          contentVersion,
          progress: ctx.store.readingProgress(itemId, contentVersion)?.ratio,
        })
      }
      if (existing.link === '') return fail('bad-request', '该条目没有可抓取的链接')

      const lastAt = ctx.articleAttempts.get(itemId)
      if (lastAt !== undefined && Date.now() - lastAt < ctx.config.articleCooldownMs) {
        const wait = Math.ceil((ctx.config.articleCooldownMs - (Date.now() - lastAt)) / 1000)
        return fail('cooldown', '刚刚取过这篇正文，请 ' + wait + ' 秒后再试')
      }
      ctx.articleAttempts.set(itemId, Date.now())

      ctx.log('取正文：' + existing.link)
      const fetched = await fetchArticle(existing.link, {
        timeoutMs: ctx.config.timeoutMs,
        maxBytes: ctx.config.articleMaxBytes,
      })
      if (fetched.kind === 'failed') {
        // 失败原因存进条目：用户重开时能看到，且不必再等一次网络往返。
        // ⚠️ 必须**合并进当前记录**（updateItem），不能用抓取前那份 existing 快照整体写回 ——
        // 抓取窗口里客户端并发发出的 markRead 已经把 readAt 写进去了，用旧快照写回会把它抹掉。
        // 2026-10-10 用户实测：详情页逐篇读，已读状态丢失（缓存命中的条目因早退不写盘而幸免）。
        await ctx.store.updateItem(itemId, (current) => ({ ...current, articleFailure: fetched.reason }))
        ctx.log('取正文失败：' + existing.link + ' → ' + fetched.reason)
        return ok({ itemId, cached: false, failure: fetched.reason })
      }
      const article = {
        fetchedAt: new Date().toISOString(),
        revision: ARTICLE_REVISION,
        title: fetched.title,
        blocks: fetched.blocks,
        frameable: fetched.frameable,
      }
      // 成功要清掉旧的失败原因：交给 rebuildItem（它按 schema 字段表搬运，不会漏字段）。
      // 基准必须是**当前**记录、不是抓取前的 existing —— 否则会抹掉窗口期内的并发写
      // （readAt），与上面失败路径同一个丢失更新（用户实测的那个 bug）。
      await ctx.store.updateItem(itemId, (current) =>
        rebuildItem(current, { omit: ['articleFailure'], set: { article } }))
      ctx.log('取正文成功：' + existing.link + '（' + fetched.blocks.length + ' 块 ' +
        blocksToText(fetched.blocks).length + ' 字符）')
      // 同一份内容版本号在两条分支上必须一致（否则「缓存命中」与「刚抓」会各记一个进度）
      const contentVersion = contentVersionOf(article.revision, article.blocks)
      return ok({
        itemId, cached: false, title: article.title, blocks: article.blocks, frameable: article.frameable,
        contentVersion,
        // 内容与旧缓存逐字节相同时版本号相等 ⇒ 旧进度照常恢复；不同则读不到（版本不匹配）
        progress: ctx.store.readingProgress(itemId, contentVersion)?.ratio,
      })
    },
  }),

  backfillHistory: defineEndpoint({
    payload: backfillHistoryPayload,
    invalidMessage: 'backfillHistory 需要 feedId、http(s) 归档页地址，以及 1–50 的篇数',
    to: async (input, ctx) => {
      // 在途闸门放在解析之后、读归档页之前：拿坏入参的请求不该占住一个源。
      if (BACKFILL_IN_FLIGHT.has(input.feedId)) {
        return fail('conflict', '该源已有回溯在进行，请等它结束再试')
      }
      BACKFILL_IN_FLIGHT.add(input.feedId)
      try {
        const report = await backfillHistory(input, {
          store: ctx.store,
          config: ctx.config,
          // 归档页复用端点既有的 fetchImpl 注入缝（与 testRsshub / discoverFeeds 同一手法）；
          // 文章页单独一条缝，因为它的返回形状与 feed 抓取不同。
          ...(ctx.fetchImpl === undefined ? {} : { fetchFeedImpl: ctx.fetchImpl }),
          ...(ctx.fetchArticleImpl === undefined ? {} : { fetchArticleImpl: ctx.fetchArticleImpl }),
          log: ctx.log,
        })
        return ok(report)
      } catch (error) {
        // 预期失败（源不存在 / 样本不足 / 余量为零 / 归档页读不出来）回带 code 的失败信封；
        // 其它异常原样抛给 dispatch 的 internal 兜底 —— 存储故障不能伪装成用户输入错误。
        if (error instanceof BackfillError) return fail(error.code, error.message)
        throw error
      } finally {
        BACKFILL_IN_FLIGHT.delete(input.feedId)
      }
    },
  }),

  duplicateHints: defineEndpoint({
    payload: duplicateHintsPayload,
    invalidMessage: 'duplicateHints 的 itemIds 必须是字符串数组',
    to: async (input, ctx) => {
      // 跨源重复提示（M5 03）：**一次批量查**，只针对客户端这一屏的条目。
      // 不做「每次渲染扫全库」：客户端一次 load 调一次，宿主按 link_key 走索引查候选。
      const ids = input.itemIds ?? []
      if (ids.length === 0) return ok({ hints: [] })
      // 一屏最多几百条；超出的直接截断而不是报错 —— 提示是锦上添花，不该让面板红一次
      const visible: DuplicateRow[] = []
      for (const itemId of ids.slice(0, 200)) {
        const record = ctx.store.item(itemId)
        if (record === undefined) continue
        visible.push({
          id: itemId, feedId: record.feedId, title: record.title, link: record.link,
          ...(record.readAt === undefined ? {} : { readAt: record.readAt }),
        })
      }
      const keys = new Set<string>()
      for (const row of visible) {
        const key = linkKeyOf(row.link)
        if (key !== '') keys.add(key)
      }
      const candidates = keys.size === 0 ? [] : ctx.store.itemsByLinkKeys([...keys])
      const hints = duplicateHintsOf(visible, candidates)
      // 源标题由这里补（客户端不该为了提示再拉一次订阅表）
      const titles = new Map(ctx.store.listFeeds().map(([feedId, feed]) => [feedId, feed.title ?? feedId]))
      const view: DuplicateHintView[] = hints.map((hint) => ({
        itemId: hint.itemId,
        others: hint.others.map((other) => ({
          ...other, feedTitle: titles.get(other.feedId) ?? other.feedId,
        })),
      }))
      return ok({ hints: view })
    },
  }),

  saveReadingProgress: defineEndpoint({
    payload: saveReadingProgressPayload,
    invalidMessage: 'saveReadingProgress 需要 itemId、contentVersion 与 ratio',
    to: async (input, ctx) => {
      // 阅读进度（M5 02）。**只写本地库**：这条路径一次网络都不发（恢复进度也不该发）。
      const { itemId, contentVersion } = input
      if (ctx.store.item(itemId) === undefined) return fail('not-found', '条目不存在：' + itemId)
      // 夹取只在这里与存储侧发生（clampReadingRatio 是唯一实现）：快速滚动时会算出越界值，
      // 而库里躺着 1.5 这种比例只会让下一次恢复「越界」。
      const ratio = clampReadingRatio(input.ratio)
      await ctx.store.saveReadingProgress(itemId, contentVersion, ratio)
      return ok({ ratio })
    },
  }),

  opmlExport: defineEndpoint({
    payload: noPayload,
    to: async (_input, ctx) => {
      const feeds = ctx.store.listFeeds().map(([feedUrl, record]) => ({
        url: feedUrl, title: record.title, folder: record.folder,
      }))
      return ok({ opml: buildOpml(feeds), feedCount: feeds.length })
    },
  }),

  opmlImport: defineEndpoint({
    payload: opmlImportPayload,
    invalidMessage: 'opmlImport 需要 opml 文本',
    to: async (input, ctx) => {
      // §3.1：导入时**逐源抓取校验**，坏源单独标注、不阻断其余。
      const text = input.opml
      if (text.trim() === '') return fail('bad-request', 'opmlImport 需要 opml 文本')
      const parsed = parseOpml(text)
      if (parsed.subscriptions.length === 0) {
        return ok({
          added: 0, existed: 0, failed: [], skipped: parsed.skipped, accepted: [],
        })
      }

      const checked = await validateSubscriptions(
        parsed.subscriptions.map((subscription) => subscription.xmlUrl),
        { limits: { timeoutMs: ctx.config.timeoutMs, maxBytes: ctx.config.maxBytes, trustedTarget: true }, concurrency: ctx.config.importConcurrency },
      )

      const byUrl = new Map(parsed.subscriptions.map((subscription) => [subscription.xmlUrl, subscription]))
      const accepted: Array<{ url: string; title?: string; folder?: string }> = []
      const failed: Array<{ url: string; reason: string }> = []
      let added = 0
      let existed = 0

      for (const result of checked) {
        if (!result.ok) {
          failed.push({ url: result.url, reason: result.reason ?? '校验失败' })
          continue
        }
        const subscription = byUrl.get(result.url)
        const previous = ctx.store.feed(result.url)
        existed += previous === undefined ? 0 : 1
        added += previous === undefined ? 1 : 0
        // 已存在的源保留其 folder（用户可能在界面上改过），新源才写入 OPML 的分组。
        // 意图声明（H4）：调度痕迹（lastAttemptedAt）的保留规则在 feed-intent.ts 一处 ——
        // 不逐字段搬，「源刚试过一次」这个事实会被导入 OPML 抹掉，该源下一轮又被当「没试过」排到最前。
        // **归属的合并判据在原子写入时做**（feed-intent.ts）：已存在的源一律保留本地 folder
        //（包括本地未分类），只有新源才继承 OPML 分组。这里刻意不再读 `previous?.folder` 再回传 ——
        //网络校验期间用户可能刚把源移出分组，用校验前的快照会把它盖回去。
        await ctx.store.updateFeed(result.url, {
          kind: 'upsert-subscription',
          url: result.url,
          title: result.title ?? subscription?.title ?? previous?.title,
          folder: subscription?.folder,
        })
        // 回包报告**实际落盘**的归属（写后重读），而不是 OPML 声明的那个。
        const stored = ctx.store.feed(result.url)
        accepted.push({ url: result.url, title: result.title ?? subscription?.title, folder: stored?.folder })
      }

      ctx.log('导入 OPML：新增 ' + added + ' 源，已存在 ' + existed + ' 源，校验失败 ' + failed.length +
        ' 源，文件内跳过 ' + parsed.skipped.length + ' 项')
      return ok({ added, existed, failed, skipped: parsed.skipped, accepted })
    },
  }),

  /**
   * **只发现、不订阅**（PRD §9）：回候选清单与逐条原因，一个字节都不写。
   *
   * 为什么单独一个端点而不是让 addFeed 回候选：addFeed 的语义是「校验并落库」，把它改成
   * 「可能只回候选」会让客户端无法区分「加了」和「只是看了看」——而这两件事的后果完全不同
   * （写盘 vs 零写入）。分开之后，取消 = 什么都不做，不需要任何回滚。
   */
  discoverFeeds: defineEndpoint({
    payload: discoverFeedsPayload,
    invalidMessage: 'discoverFeeds 需要 url',
    to: async (input, ctx) => {
      const raw = input.url
      // 出网手势照 article 端点的先例留痕：发现不出现在刷新日志里，否则「点了没反应」无从排查。
      ctx.log('发现订阅候选：' + raw)
      const result = await discoverCandidates(raw, {
        limits: { timeoutMs: ctx.config.timeoutMs, maxBytes: ctx.config.maxBytes, trustedTarget: true },
        concurrency: 1,
        // R8a 03：实例地址每次现读 ctx.config（settings 保存后直接改内存，不需要重启）。
        rsshubBase: ctx.config.rsshubBase,
        // fetchImpl 与 testRsshub 同一手法：端点测要能桩住页面与实例两组出网。
        fetchImpl: ctx.fetchImpl,
        // Radar 的「命中/跳过」明细要能出现在宿主日志里；只走日志，不进回包（spec §6）。
        log: ctx.log,
      })
      // 口径按来源分计（R8a 评审 #7）：Radar 候选**没有**抓取校验（ADR-0010），把它们算进
      // 「已验证」会让人以为界面上每条都收过一遍。总数仍报，但拆成页面 / RSSHub 两段。
      const rsshubCount = result.candidates.filter((candidate) => candidate.source === 'rsshub').length
      const pageCount = result.candidates.length - rsshubCount
      ctx.log('发现结果：' + raw + ' → 候选 ' + result.candidates.length + ' 条（页面 ' + pageCount
        + ' / RSSHub ' + rsshubCount + '），' + result.warnings.length + ' 条警告')
      return ok(result)
    },
  }),

  addFeed: defineEndpoint({
    payload: addFeedPayload,
    invalidMessage: 'addFeed 需要 url',
    to: async (input, ctx) => {
      const raw = input.url
      const checked = await validateSubscriptions([raw], {
        limits: { timeoutMs: ctx.config.timeoutMs, maxBytes: ctx.config.maxBytes, trustedTarget: true },
        concurrency: 1,
      })
      const result = checked[0]
      if (result === undefined || !result.ok) {
        return ok({ added: 0, existed: 0, failed: [{ url: raw, reason: result?.reason ?? '校验失败' }], skipped: [], accepted: [] })
      }
      const previous = ctx.store.feed(result.url)
      // 同 OPML 导入：意图声明（H4），「刚试过」的痕迹保留规则在 feed-intent.ts
      await ctx.store.updateFeed(result.url, {
        kind: 'upsert-subscription',
        url: result.url,
        title: result.title ?? previous?.title,
        // 新源保持未分类；已存在的源由 feed-intent 保留本地 folder（含「本地是未分类」）。
        folder: undefined,
      })
      const stored = ctx.store.feed(result.url)
      return ok({
        added: previous === undefined ? 1 : 0,
        existed: previous === undefined ? 0 : 1,
        failed: [], skipped: [],
        accepted: [{ url: result.url, title: result.title, folder: stored?.folder }],
      })
    },
  }),

  removeFeed: defineEndpoint({
    payload: removeFeedPayload,
    invalidMessage: 'removeFeed 需要 url',
    to: async (input, ctx) => {
      const feedId = input.url
      const known = ctx.store.feed(feedId)
      if (known === undefined) return fail('not-found', '订阅不存在：' + feedId)
      // 回溯途中的退订必须由宿主拒绝（spec §4.1）：回溯还在往这个源写条目，退订会先删订阅
      // 与全部条目，后续写入就落在「已不在订阅集合里的源」上 —— 留下谁都看不见的孤儿条目。
      // 界面上这一行的退订已经置灰，但界面不是判据：同一秒的重放 / 另开的面板都会绕过它。
      if (BACKFILL_IN_FLIGHT.has(feedId)) return fail('conflict', '该源正在回溯，结束后再退订')
      // 退订是**一次变更**，由 store 拥有（订阅项 + 条目 + 游标，见 ADR-0002）：
      // 这里既不逐条删（N+1 个事务、还会把整源正文物化出来），也不碰 config.json。
      // 失败时事务回滚 ⇒ 什么都没发生，用户看到的是「退订失败」，不是「少了一半」。
      const { items } = await ctx.store.deleteSubscription(feedId)
      ctx.log('退订 ' + feedId + '（连带删除 ' + items + ' 条条目）')
      return ok({ removed: 1, items })
    },
  }),

  cleanup: defineEndpoint({
    payload: cleanupPayload,
    // cleanup 是零业务入参，但窗口字段有形状：坏窗口必须响亮拒绝而不是被当成「忽略 payload」。
    invalidMessage: 'cleanup 的时间窗口无效（from / to 必须成对且 from < to）',
    carriesAccount: true,
    accountFrameOf,
    to: async (input, ctx) => {
      // 显式清理（用户点按钮触发，**不设定时器**——验收项之一就是不残留定时器）。
      // 判据刻意保守：已读 + 未星标 + 未保持未读 + 早于阈值，四个条件缺一不可（见 retention.ts 注释）。
      //
      // R11 04 / D27.1：dryRun 只是**同一段判据的只读运行** —— 候选、cutoff、释放量全在这里
      // 算一遍，唯一区别是「不删、不写删除日志」。所以预演数出来的 N 就是执行会删的 N。
      //
      // **候选集由存储侧一条 SQL 选出**（Task 5）：原先这里 `allItems()` 把整张 items 表
      // （10 万行）物化到 JS 再筛 —— 「点一次清理 = 一次全表遍历」，而 spec §3.1 只把清理记在
      // accountOf 名下，漏了这一处（计划的定稿加固已记账）。
      // 判据的**唯一裁决者**是 retention.ts 的 selectCleanup。存储侧的 SQL（SELECT_CLEANUP_ROWS）
      // 只负责「不用把整张 items 表搬进 JS」—— 它只筛「已读 + 够旧」，连星标与保持未读也不筛。
      // 所以喂回来的候选**可能比判定集宽**（受保护的旧条目也在里面），这里必须复跑判据：
      // 删掉这一句 = 让 SQL 的宽容度决定「用户说别动」的条目命不命，2026-11-14 之前的形态。
      // 「候选 ⊇ 判定集」由 tests/store-sqlite.test.mjs 钉住；「受保护条目活下来」由
      // tests/overview-scale.test.mjs 与 tests/overview-paging.test.mjs 钉住。
      const cutoff = new Date(Date.now() - ctx.config.cleanupAfterDays * 24 * 3600 * 1000).toISOString()
      const candidates = ctx.store.listCleanupCandidates(cutoff)
      const doomed = new Set(selectCleanup(candidates, cutoff))
      // 释放量直接读候选行自带的原料（正文 + 摘要）：原先按 id 逐条 `target.item()` 点读，
      // 几千条候选就是几千次点读（还把正文一起搬进内存）。摘要同样占字节，一并计入。
      const freedChars = candidates
        .filter((row) => doomed.has(row.id))
        .reduce((sum, row) => sum + row.articleChars + row.summaryChars, 0)
      if (input.dryRun === true) {
        // 预演：一条都不删、不写「清理：删除」（那是已经发生的既成事实）。日志用「将清理」，
        // 与执行路径区分开 —— 排查「按钮点了没反应」时，日志说得出这次到底删没删。
        ctx.log('预演：将清理 ' + doomed.size + ' 条已读旧条目（阈值 ' + ctx.config.cleanupAfterDays + ' 天，释放约 ' +
          freedChars + ' 字符）')
        return ok({ deleted: doomed.size, freedChars, cutoff, dryRun: true })
      }
      for (const itemId of doomed) await ctx.store.deleteItem(itemId)
      ctx.log('清理：删除 ' + doomed.size + ' 条已读旧条目（阈值 ' + ctx.config.cleanupAfterDays + ' 天，释放约 ' +
        freedChars + ' 字符）')
      return ok({ deleted: doomed.size, freedChars, cutoff, dryRun: false })
    },
  }),

  toggleKeepUnread: defineEndpoint({
    payload: itemIdWindowPayload,
    invalidMessage: 'toggleKeepUnread 需要 itemId，时间窗口必须成对且合法',
    carriesAccount: true,
    accountFrameOf,
    to: async (input, ctx) => {
      // 「保持未读」在 GR 里**没有快捷键**（规格 §3.4 的键位列是「—」），是条目下方的链接。
      // 所以这个端点服务于客户端的那个链接，不接键位。
      const itemId = input.itemId
      const existing = ctx.store.item(itemId)
      if (existing === undefined) return fail('not-found', '条目不存在：' + itemId)
      const keptUnread = existing.keptUnread !== true
      // 取消时把键去掉而不是写 false —— 缺省即「未保持」，少一个键更干净
      await ctx.store.saveItem(itemId, keptUnread
        ? rebuildItem(existing, { set: { keptUnread: true } })
        : rebuildItem(existing, { omit: ['keptUnread'] }))
      return ok({ itemId, keptUnread })
    },
  }),

  // 视图记忆（两列布局任务 7）：UI 偏好的读/写端点是两个，而不是挂在 overview 上。
  //
  // 为什么不并进 overview（省一次往返）：
  //  · overview 的语义是「条目数据」，它已经被 unread / perFeedUnread / 截断三件事占满；
  //    往里塞 UI 偏好会让「什么都不动时读一次面板也会写盘」—— 恢复与写盘会互相触发。
  //  · 写侧必须独立：客户端只在**关键动作**后写一次，不能顺路搭在每次数据刷新上。
  //  · 读取必须**早于** feeds 数据可用：客户端一挂载就恢复，不能等 overview 回来再改视图
  //    （那会让用户先看到默认态再跳一下）。
  //
  // 复用既有 HTTP 通道（ROUTE_PATH + requestRejection 准入），与其余端点同一条路
  // —— 不新开机制、不加注入口。
  viewPreferences: defineEndpoint({
    payload: noPayload,
    to: async (_input, ctx) => ok({ preferences: ctx.store.viewPreferences() }),
  }),

  saveViewPreferences: defineEndpoint({
    payload: saveViewPreferencesPayload,
    invalidMessage: 'saveViewPreferences 需要 preferences',
    to: async (input, ctx) => {
      // 传进来的值一律不可信（可能是别的版本写的、也可能根本不是一个对象）：
      // 交给 store 归一后再落库。认不出就回落默认，绝不抛错、绝不把垃圾写进域。
      const saved = await ctx.store.saveViewPreferences(input.preferences)
      return ok({ preferences: saved })
    },
  }),

  /**
   * 设置页的**只读**快照（R11 01）：生效值 + 默认值（+ 启动时的读侧告警）。
   *
   * 为什么回包多一层 `settings`：界面要的是一个可扩展的对象 —— 06 票的只读区 / 版本 / 路径
   * 会往同一个对象里加字段，而不是再造一个端点（spec D4.1 的回包形状）。
   * 写路径是 02 票的 saveSettings，本票刻意不提供（先落盘再改内存的顺序需要单独一轮注意力）。
   */
  settings: defineEndpoint({
    payload: noPayload,
    to: async (_input, ctx) => {
      if (ctx.settings === undefined) return fail('not-ready', '设置服务尚未就绪')
      return ok({ settings: ctx.settings.snapshot() })
    },
  }),

  /**
   * 设置页的**写**端点（R11 02）：逐项保存一个可调参数。
   *
   * 回包与读端点同形（`{ settings: { effective, defaults } }`），客户端成功后用回包覆盖权威值 ——
   * 不做乐观更新，界面上的数字只有宿主确认落盘后才成为「生效值」（spec D12）。
   *
   * 错误码分两种：非法入参在 `defineEndpoint` 就回 `bad-request`（文件与内存都不会被碰）；
   * 写盘失败回 `write-failed` —— 它必须能和「你输错了」区分开，否则用户会去改一个本来合法的值。
   */
  saveSettings: defineEndpoint({
    payload: saveSettingsPayload,
    invalidMessage: 'saveSettings 需要 patch 或 resetToDefaults（二选一）：数字键要在范围内，'
      + 'RSSHub 地址只支持 http(s) 且不能带路径、查询或参数',
    to: async (input, ctx) => {
      if (ctx.settings === undefined) return fail('not-ready', '设置服务尚未就绪')
      // 恢复默认（07 票）：删 / 写规则在控制器里逐键判断，端点只负责把结果转成信封。
      // 与 patch 分支共用同一条「先落盘再改内存」的失败语义（D7）。
      const outcome = 'resetToDefaults' in input
        ? ctx.settings.resetToDefaults()
        : ctx.settings.save(input.patch)
      if (!outcome.ok) return fail('write-failed', outcome.message)
      return ok({ settings: outcome.snapshot })
    },
  }),

  /**
   * RSSHub 实例探活（R8a 01，spec §4.1 / §4.6）。
   *
   * 判据是启发式：`GET {base}/api/radar/rules/zhihu.com` 回 200 + 非空 JSON ⇒ 这个实例会发
   * Radar 规则。返回 `{ passed, message }` 而不是失败信封：探活失败是**观测结果**，不是请求
   * 形状错误，界面要在原地显示原因（超时 / HTTP 状态 / 非 JSON）。
   *
   * **刻意不传 `trustedTarget`**：RSSHub 实例是第三方出网目标，默认按不可信处理，内网地址
   * 会被 fetch 层拒绝（A9）。把这一条留给 fetch.ts 的唯一判据，不在这里另判。
   */
  testRsshub: defineEndpoint({
    payload: testRsshubPayload,
    invalidMessage: 'testRsshub 需要 base（字符串）',
    to: async (input, ctx) => {
      // 与保存 / 读取同一份地址判据（parseTunableValue）；空串是「未配置」而不是坏入参。
      const base = parseTunableValue('rsshubBase', input.base)
      if (base === undefined) {
        return ok({ passed: false, message: '地址不合法：只支持 http:// 或 https:// 的实例源站（不能带路径、查询或参数）' })
      }
      if (base === '') return ok({ passed: false, message: '未配置 RSSHub 实例地址' })

      const fetchImpl = ctx.fetchImpl ?? fetchFeed
      // limits 不带 trustedTarget（默认 false）：私网实例在这里就会被拒，与 A9 一致。
      // 地址只从 `radarRulesUrl` 来 —— 与发现流程同一份拼法，别在这里再写一次字符串。
      const fetched = await fetchImpl(radarRulesUrl(base, 'zhihu.com'), {}, {
        timeoutMs: ctx.config.timeoutMs,
        maxBytes: ctx.config.maxBytes,
      })
      if (fetched.kind === 'failed') return ok({ passed: false, message: '连接失败：' + fetched.reason })
      if (fetched.kind === 'not-modified') {
        return ok({ passed: false, message: '实例返回了 304（探活请求不应带条件头）' })
      }
      // 「取 body → 判空 → JSON.parse → 是不是规则表」只有一份实现（radar.ts 的
      // decodeRadarResponse）：与发现流程各写一遍，就会出现「测试通过但发现报实例故障」
      // 这类互斥结论（R8a 评审 #2）。这里只把解码结果翻译成探活话术。
      const decoded = decodeRadarResponse(fetched)
      if (decoded.kind === 'rules') {
        return ok({ passed: true, message: '测试通过：实例返回了 Radar 规则 JSON（探活是启发式，不代表每个站点都有规则）' })
      }
      if (decoded.kind === 'empty') {
        return ok({ passed: false, message: '响应里没有可用的 Radar 规则（空响应或只有站点名的空壳）' })
      }
      return ok({ passed: false, message: decoded.reason + '（这个地址可能不是 RSSHub 实例）' })
    },
  }),

  /**
   * 探索：分页取一页路由行（R8b 03，spec §4.3 / §6）。
   *
   * 浏览器永远拿不到整张表：宿主按需拉一次（02 的 12h 实例键缓存）→ 01 的索引里筛 → 只回这一页。
   * 三个筛子 AND 叠加、`matched` 与目录口径分开、游标栅栏全部由 01 的 `query` 与
   * `encode/decodeCatalogCursor` 判 —— 这里只做「取表、夹 limit、装配 wire 形状」。
   *
   * 只读：不写库、不改配置（探索是一次性浏览，D14 的视图状态也不落盘）。
   */
  exploreCatalog: defineEndpoint({
    payload: exploreCatalogPayload,
    invalidMessage: 'exploreCatalog 的 q / category / namespace 需为字符串，limit 需为正整数，cursor 需为字符串',
    to: async (input, ctx) => {
      const resolved = exploreBaseOf(ctx)
      if (!resolved.ok) return resolved.result
      const loaded = await loadExploreCatalog(ctx, resolved.base)
      if (!loaded.ok) return loaded.result

      const filter = catalogFilterOf(input)
      // 游标先过栅栏：筛选变了（B7）或游标认不出（B8）都回 bad-request。
      // **绝不**把 undefined 当成「没有游标 ⇒ 从第一页开始」—— 那会让界面无限追加重复行。
      let position: CatalogPosition | undefined
      if (input.cursor !== null && input.cursor !== undefined) {
        position = decodeCatalogCursor(input.cursor, filter)
        if (position === undefined) return fail('bad-request', '分页游标与当前筛选不匹配，请重新加载')
      }
      // 越界夹取不拒绝：limit 是展示偏好，不是正确性（spec §4.3）。默认 30 / 上限 100。
      const limit = Math.min(input.limit ?? CATALOG_PAGE_DEFAULT, CATALOG_PAGE_MAX)
      const { matched, items } = loaded.catalog.query(filter)
      const paged = catalogPageOf(items, position, limit)
      if (paged === undefined) return fail('bad-request', '分页游标已失效（目录已更新），请重新加载')
      const last = paged.page[paged.page.length - 1]
      const nextCursor = paged.hasMore && last !== undefined
        ? encodeCatalogCursor(filter, { namespace: last.namespace, path: last.path })
        : undefined
      return ok<ExploreCatalogPage>({
        siteTotal: loaded.catalog.sites,
        routeTotal: loaded.catalog.total,
        matched,
        categories: [...loaded.catalog.categories],
        items: paged.page,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      })
    },
  }),

  /**
   * 探索：把 `{ namespace, path, values }` 拼成一个**没有 `:param` 残留**的订阅地址
   *（R8b 03，spec §4.5）。地址拼装只在宿主做，客户端只提交参数值。
   *
   * 404 与 400 的分工是承重的：未知站点 / 未知路由是「你点的这一行不在目录里」（404），
   * 缺必填参数是「这一行在，但你没填全」（400 且点名参数）。未知站点要先查目录，所以两个端点
   * 都走同一条取表路径（02 的缓存让第二次点击不再出网）。
   *
   * 只读：拼地址不订阅、不写库（订阅仍走既有的 addFeed）。
   */
  exploreBuildUrl: defineEndpoint({
    payload: exploreBuildUrlPayload,
    invalidMessage: 'exploreBuildUrl 需要 namespace / path（非空字符串）与 values（参数名 → 值）',
    to: async (input, ctx) => {
      const resolved = exploreBaseOf(ctx)
      if (!resolved.ok) return resolved.result
      const loaded = await loadExploreCatalog(ctx, resolved.base)
      if (!loaded.ok) return loaded.result

      // 站点先判：打错站点与「站点对、路由不存在」是两条不同的排障线索，文案要能区分。
      if (!loaded.catalog.rows.some((row) => row.namespace === input.namespace)) {
        return fail('not-found', '未知的站点（namespace）：' + input.namespace)
      }
      if (!loaded.catalog.rows.some((row) => row.namespace === input.namespace && row.path === input.path)) {
        return fail('not-found', '未知的路由路径：' + input.path)
      }
      // 拼装只调 01 的 buildExploreUrl：端点内不出现第二套模板解析（`*` / `{}` 的拒绝、
      // 可选段的省略、必填的点名都在那一份实现里）。
      const built = buildExploreUrl(resolved.base, input.namespace, input.path, input.values)
      if (built.kind === 'unsupported') {
        return fail('bad-request', '这条路由的路径模板含通配 / 正则段，无法安全拼出地址（' + input.path + '）')
      }
      if (built.kind === 'missing') return fail('bad-request', '缺少必填参数：' + built.parameter)
      return ok({ url: built.url })
    },
  }),


  // ── 文件夹目录与变更接口（M2 02）────────────────────────────────────────
  // 与订阅同住 config.json；每个变更都在**一次**读改写里完成（改名连带成员归属）。
  // 名称规则与错误码归 src/folders.ts；这里只做 payload 形状校验与错误信封转换。
  listFolders: defineEndpoint({
    payload: noPayload,
    to: async (_input, ctx) => ok({ folders: ctx.store.listFolders() }),
  }),

  createFolder: defineEndpoint({
    payload: namePayload,
    invalidMessage: 'createFolder 需要 name（字符串）',
    to: async (input, ctx) => {
      const name = input.name
      try {
        return ok({ folders: await ctx.store.createFolder(name) })
      } catch (error) {
        const failure = folderFailure(error)
        if (failure !== undefined) return failure
        throw error
      }
    },
  }),

  renameFolder: defineEndpoint({
    payload: renameFolderPayload,
    invalidMessage: 'renameFolder 需要 from 与 to（字符串）',
    to: async (input, ctx) => {
      const { from, to } = input
      try {
        return ok({ folders: await ctx.store.renameFolder(from, to) })
      } catch (error) {
        const failure = folderFailure(error)
        if (failure !== undefined) return failure
        throw error
      }
    },
  }),

  deleteFolder: defineEndpoint({
    payload: namePayload,
    invalidMessage: 'deleteFolder 需要 name（字符串）',
    to: async (input, ctx) => {
      const name = input.name
      try {
        // 独立入口：只解除分类，绝不走 removeFeed（那会连带删条目）。判据在 tests/folder-storage。
        return ok(await ctx.store.deleteFolder(name))
      } catch (error) {
        const failure = folderFailure(error)
        if (failure !== undefined) return failure
        throw error
      }
    },
  }),

  moveFeedToFolder: defineEndpoint({
    payload: moveFeedToFolderPayload,
    invalidMessage: 'moveFeedToFolder 需要 feedId（非空字符串）与 folder（字符串或 null）',
    to: async (input, ctx) => {
      // folder 键**必须显式给出**：缺键 ≠ 移到未分类。这条由 payload 声明（键必需、可 null）钉住，
      // 少了它一个坏 payload 会把用户刚归好的源静默移出分组。
      const { feedId, folder } = input
      try {
        return ok({ folders: await ctx.store.moveFeedToFolder(feedId, folder === null ? undefined : folder) })
      } catch (error) {
        const failure = folderFailure(error)
        if (failure !== undefined) return failure
        throw error
      }
    },
  }),

  // ── 订阅源顺序（R3 02）──────────────────────────────────────────────
  // 顺序是 config.json 里的一份显式数组（缺省 = 没排过）。归一规则在 src/feed-order.ts，
  // 这里只做 payload 形状校验；回包是**落盘后重读派生**的有效顺序。
  // 不加 carriesAccount：排序不改任何条目的读态，未读账不随这次写变化（客户端之后会 reload 重取）。
  reorderFeeds: defineEndpoint({
    payload: reorderFeedsPayload,
    invalidMessage: 'reorderFeeds 需要 ids（字符串数组，可为空）',
    to: async (input, ctx) => ok({ feedOrder: await ctx.store.reorderFeeds(input.ids) }),
  }),

  // ── 标签持久化与变更接口（M2 05）────────────────────────────────────
  // 标签只分类：这里没有「标读」语义，也不触碰 items.read_at。关联写入使用稳定 tag id，
  // 名称可改而 id 不变；空标签由 listTags 的 LEFT JOIN 保留。
  listTags: defineEndpoint({
    payload: noPayload,
    to: async (_input, ctx) => ok({ tags: ctx.store.listTags() }),
  }),

  createTag: defineEndpoint({
    payload: namePayload,
    invalidMessage: 'createTag 需要 name（字符串）',
    to: async (input, ctx) => {
      const name = input.name
      try {
        return ok({ tag: await ctx.store.createTag(name) })
      } catch (error) {
        const failure = tagFailure(error)
        if (failure !== undefined) return failure
        throw error
      }
    },
  }),

  renameTag: defineEndpoint({
    payload: renameTagPayload,
    invalidMessage: 'renameTag 需要 id 与 name（字符串）',
    to: async (input, ctx) => {
      const { id, name } = input
      try {
        return ok({ tag: await ctx.store.renameTag(id, name) })
      } catch (error) {
        const failure = tagFailure(error)
        if (failure !== undefined) return failure
        throw error
      }
    },
  }),

  deleteTag: defineEndpoint({
    payload: idPayload,
    invalidMessage: 'deleteTag 需要 id（字符串）',
    to: async (input, ctx) => {
      const id = input.id
      try {
        await ctx.store.deleteTag(id)
        return ok({ deleted: true })
      } catch (error) {
        const failure = tagFailure(error)
        if (failure !== undefined) return failure
        throw error
      }
    },
  }),

  setItemTags: defineEndpoint({
    payload: setItemTagsPayload,
    invalidMessage: 'setItemTags 需要 itemId（非空字符串）与 tagIds（字符串数组）',
    to: async (input, ctx) => {
      try {
        // tagIds 的形状由 payload 声明判；去重仍由 store 的 normalizeTagIds 判，
        // 标签是否存在由存储侧的关联写入判（src/store-sqlite.ts 的 setItemTags）。
        const tags = await ctx.store.setItemTags(input.itemId, input.tagIds)
        return ok({ itemId: input.itemId, tags })
      } catch (error) {
        const failure = tagFailure(error)
        if (failure !== undefined) return failure
        throw error
      }
    },
  }),

  toggleStar: defineEndpoint({
    payload: itemIdWindowPayload,
    invalidMessage: 'toggleStar 需要 itemId，时间窗口必须成对且合法',
    carriesAccount: true,
    accountFrameOf,
    to: async (input, ctx) => {
      const itemId = input.itemId
      const existing = ctx.store.item(itemId)
      if (existing === undefined) return fail('not-found', '条目不存在：' + itemId)
      const starred = !existing.starred
      await ctx.store.saveItem(itemId, { ...existing, starred })
      return ok({ itemId, starred })
    },
  }),
}

/**
 * 分发核。四步固定顺序，一步都不许提前：
 *   ① not-ready 守卫（存储没起来时**任何**名字都回它，含不存在与原型链上的名字）
 *   ② 查表（`Object.hasOwn`：`constructor`/`toString` 这类名字不能命中 Object.prototype）
 *   ③ 交给 handler
 *   ④ 按 carriesAccount 声明合并未读账
 * 异常一律兜成 internal 信封 —— 不把 throw 泄进通道（调用方要的是带 code 的失败信封）。
 */
export function createDispatch(deps: EndpointDeps): (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<RpcResult<unknown>> {
  const { config, log, ready, refreshNow, lastRefreshCompletedAt, articleAttempts, searchItems, settings, fetchImpl, fetchArticleImpl } = deps

  const dispatch = async (endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<unknown>> => {
    try {
      const target = ready()
      if (!target) return fail('not-ready', '存储域尚未就绪，稍后重试')

      // Object.hasOwn 而不是 `ENDPOINTS[endpoint]`：后者对 'constructor' / 'toString' /
      // '__proto__' 会沿原型链取到 Object.prototype 上的函数，把「未知端点」变成一次真实调用。
      const spec = typeof endpoint === 'string' && Object.hasOwn(ENDPOINTS, endpoint)
        ? ENDPOINTS[endpoint as Endpoint]
        : undefined
      if (spec === undefined) return fail('unknown-endpoint', '未知端点：' + endpoint)

      const ctx: EndpointCtx = {
        store: target, ready, config, log, refreshNow, lastRefreshCompletedAt, articleAttempts, searchItems, settings, fetchImpl, fetchArticleImpl, signal,
      }
      const outcome = await spec.to(payload, ctx)
      const { result } = outcome
      if (spec.carriesAccount === true && result.ok) {
        // 视野来自 defineEndpoint 那一次解析的同一份入参（EndpointOutcome.accountFrame）——
        // 不在这里重新解析 payload，也不让 handler 自己算账（R1 02 决策 21）。
        const account = accountOf(target, outcome.accountFrame)
        return ok({
          ...(result.value as object),
          unread: account.unread,
          perFeedUnread: account.perFeedUnread,
          ...(account.unreadSplit === undefined ? {} : { unreadSplit: account.unreadSplit }),
        })
      }
      return result
    } catch (error) {
      if (signal?.aborted) return fail('cancelled', '请求已取消')
      log('请求失败（' + endpoint + '）：' + String(error))
      return fail('internal', error instanceof Error ? error.message : String(error))
    }
  }

  return dispatch
}
/**
 * 读一个请求体（上限 256 KiB）。
 *
 * 上限**响亮拒绝**而不是静默截断：一个被截断的 JSON 会让 endpoint 收到半个 payload，
 * 那比报错更难查。
 */
async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.from(chunk as Buffer)
    size += buf.length
    if (size > 256 * 1024) throw new Error('请求体过大')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? undefined : JSON.parse(text)
}

/**
 * HTTP 传输壳：从「一个 IncomingMessage」到「一条 RpcResult 信封」。
 *
 * 这一层只做传输：准入 → 方法 → 读 body → 交给 dispatch → 写信封。**端点语义全在
 * dispatch 里**（见 ENDPOINTS）——把它搬进来是因为它与 dispatch 是同一个职责的两半，
 * 而此前它们分别住在 endpoints.ts 与 index.ts 的 apply 闭包里，要测传输层只能走 apply
 * 并伪造整个宿主（2026-10-15 H2 Task 2）。
 *
 * **刻意不含路由注册**（ctx.webServer.register）与热重载撞 duplicate prefix 时的响亮失败：
 * 那两条依赖 ctx，留在 index.ts。
 */
export function createHttpHandler(
  dispatch: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<RpcResult<unknown>>,
  opts: {
    requestRejection: (req: import('node:http').IncomingMessage) => number | undefined
  },
): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> {
  const { requestRejection } = opts

  return async (req, res): Promise<void> => {
    // 与宿主其它路由同一套准入：Host/Origin 检查 + 浏览器鉴权
    const rejection = requestRejection(req)
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'text/plain' })
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain' })
      res.end('method not allowed')
      return
    }
    let result: RpcResult<unknown>
    try {
      const body = (await readJsonBody(req)) as { endpoint?: unknown; payload?: unknown } | undefined
      // 端点名一律过 String(...)：body 里的类型不可信，而 dispatch 的 interface 就是 string。
      // 缺省落成空串 ⇒ dispatch 回 unknown-endpoint（而不是把 undefined 传下去）。
      const endpoint = String(body?.endpoint ?? '')
      if (res.destroyed) return
      if (endpoint === 'searchItems') {
        const controller = new AbortController()
        res.once('close', () => { if (!res.writableEnded) controller.abort() })
        result = await dispatch(endpoint, body?.payload, controller.signal)
      } else {
        result = await dispatch(endpoint, body?.payload)
      }
    } catch (error) {
      result = fail('bad-request', error instanceof Error ? error.message : String(error))
    }
    if (res.destroyed) return
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(result))
  }
}
