/**
 * 浏览器半的读写通道：25 个端点的**注册表**（2026-10-07 从 index.ts 拆出；2026-10-15 深化）。
 *
 * 原先这里是一个 switch：每臂各自手写 payload 解析、各自记得把未读账并进回包 ——
 * interface 的复杂度 ≈ implementation 的复杂度。现在「一个端点」是一个 module：
 * 名字的单点在 shared.ts（ENDPOINT_NAMES），回包形状与「是否必带未读账」在 ENDPOINTS 表里声明，
 * 分发核只做四件事：守卫 not-ready → 查表 → 交给 handler → 按声明合并账目；
 * 异常统一兜成 internal 信封。
 *
 * 名字表与 dispatch 的 case 必须是同一份（曾经是两处手写、靠人记得同步）；现在缺失即编译错误。
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { createSearch } from './search.js'
import type { Config } from './config.js'
import { EXTRACTOR_REVISION, fetchArticle, blocksToText } from './article.js'
import { rebuildItem, type ItemRecord } from './domain.js'
import { selectCleanup } from './retention.js'
import { buildOpml, parseOpml } from './opml.js'
import { FolderError } from './folders.js'
import { TagError } from './tags.js'
import { discoverCandidates, validateSubscriptions } from './subscribe.js'
import type { ReaderStore } from './store.js'
// 未读判据（isUnread / countUnreadPerFeed）不再由本文件在 JS 侧实现：Task 5 把它交给了存储侧，
// 自持实现里的 SQL `read_at IS NULL` 与 shared.ts 的 isUnread 是同一件事，两者的等价由
// tests/store-sqlite.test.mjs 的「同一夹具上逐键对账」钉住。shared.ts 仍是那条规则的定义处。
import { decodeCursor, encodeCursor, fail, ok, recencyOf, sanitizeViewPreferences, type Cursor, type Endpoint, type ItemView, type Overview, type RefreshRun, type RpcResult, type UnreadAccount } from './shared.js'

/** 端点需要的运行时依赖（显式传入，不靠闭包）。 */
export interface EndpointDeps {
  readonly config: Config
  readonly log: (message: string) => void
  readonly ready: () => ReaderStore | undefined
  readonly refreshNow: (options?: { force?: boolean; signal?: AbortSignal }) => Promise<RefreshRun>
  /** 上次刷新完成时间（刷新状态留在 index.ts 那侧，这里只读） */
  readonly lastRefreshCompletedAt: () => number | undefined
  readonly searchItems?: ReturnType<typeof createSearch>['run']
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
  readonly articleAttempts: Map<string, number>
}

/**
 * 一个端点的声明。
 *
 * `carriesAccount`：该端点的回包是否**必须**并入未读账（总数 + 每源）。
 * 收进声明而不是让每个 handler 自己拼：这条横切不变量原先在 5 个 case 里各写一遍
 * （`...accountOf(target)`），任一处漏掉就是「幽灵未读」——客户端拿本地增量当真相，
 * 左栏各源之和 ≠ 顶栏总数（spec §4 不变量 1）。
 */
export interface EndpointSpec {
  readonly carriesAccount?: true
  readonly to: (payload: unknown, ctx: EndpointCtx) => Promise<RpcResult<unknown>>
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

/** 读一次完整的未读账（总数 + 每源）。只读，不改任何条目。 */
const accountOf = (target: ReaderStore): UnreadAccount => {
  // 键域与判据都走**存储侧那一份**实现：未读判据就是 shared.ts 的 isUnread（自持实现里写作
  // `read_at IS NULL`，两者是同一件事的两种写法，有测试在同一夹具上逐键对账），键域 =
  // listFeeds() 的全量键（0 未读的源也留 0）。
  //
  // 为什么不再在这里对 allItems() 跑 countUnreadPerFeed：① 口径会分家 —— 这里算一遍、SQL 里
  // 再算一遍，正是任务 1 的键域与任务 5 的 unread 漂过两次的那条路；② 10 万行下每次标读/撤销/
  // 星标/保持未读/清理都拖着一次全表物化（spec §3.1 列的五处调用点）。
  const perFeedUnread = target.unreadPerFeed(target.listFeeds().map(([feedId]) => feedId))
  return { unread: sumOf(perFeedUnread), perFeedUnread }
}

/**
 * 文件夹浏览的**范围键**：游标必须绑在「文件夹名 + 当前成员」上。
 *
 * 为什么成员也要进键：文件夹只是一个名字，成员可以在两页之间被移动。只绑名字时，
 * 旧游标会拿着「第一页的成员快照」去查「第二页的新成员」，结果既不连续也不可解释；
 * 绑上排序后的成员列表后，成员一变旧游标自然失配，客户端必须从第一页重来。
 */
interface OverviewScope {
  readonly folder?: string
  readonly feedIds?: readonly string[]
  readonly tagId?: string
  readonly key: string
}

const folderScopeKey = (folder: string, feedIds: readonly string[]): string =>
  'folder:' + createHash('sha256').update(JSON.stringify([folder, [...feedIds].sort()])).digest('base64url')

/** 从 overview/refresh 的 payload 里解析文件夹或标签范围；失败时返回带 code 的信封。 */
function overviewScopeOf(ctx: EndpointCtx, payload: unknown): { scope?: OverviewScope; failure?: RpcResult<never> } {
  const body = payload as { folder?: unknown; tagId?: unknown } | null
  const folder = body?.folder
  const tagId = body?.tagId
  if (folder !== undefined && folder !== null && tagId !== undefined && tagId !== null) {
    return { failure: fail('bad-request', 'overview 不能同时按文件夹与标签筛选') }
  }
  if (tagId !== undefined && tagId !== null) {
    if (typeof tagId !== 'string' || tagId === '') {
      return { failure: fail('bad-request', 'overview 的 tagId 必须是非空字符串') }
    }
    const found = ctx.store.listTags().find((tag) => tag.id === tagId)
    if (found === undefined) return { failure: fail('not-found', '标签不存在：' + tagId) }
    // 标签 id 是稳定主键：改名不会让当前浏览范围失效；删除才会（listTags 找不到）。
    return { scope: { tagId: found.id, key: 'tag:' + found.id } }
  }
  if (folder === undefined || folder === null) return {}
  if (typeof folder !== 'string' || folder === '') {
    return { failure: fail('bad-request', 'overview 的 folder 必须是非空字符串') }
  }
  const found = ctx.store.listFolders().find((entry) => entry.name === folder)
  if (found === undefined) return { failure: fail('not-found', '文件夹不存在：' + folder) }
  return { scope: { folder, feedIds: found.feedIds, key: folderScopeKey(folder, found.feedIds) } }
}

/**
 * 一页列表 + 续页游标。
 *
 * @param run       本轮刷新的明细（refresh 端点用；overview 缺省 ⇒ 回包不带 refresh 字段、
 *                  refreshed 恒 false）。X/Y、节流与并入在途的区别全在这一个值里（M4 02）。
 * @param cursor    续页边界（keyset）；缺省 = 第一页。游标由 overview 端点解码后传入，
 *                  这里**不再判形状** —— 认不出的游标在那一层就被响亮拒了（见 ENDPOINTS.overview）
 * @param scope     文件夹范围；缺省 = 普通跨源契约（逐字不变）。有它时列表在 SQL 侧先按成员过滤再限页。
 */
const buildOverview = (ctx: EndpointCtx, run?: RefreshRun, cursor?: Cursor, scope?: OverviewScope): Overview => {
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

  // 每源账目走**与标读回包同一份**实现（store 的 unreadPerFeed，见 accountOf）：
  // 键域 = feeds 表、判据 = isUnread（自持实现里就是 `read_at IS NULL`）。
  // **重点在「不再物化全表」**（Task 5，spec §3.1）：原先这里对 allItems() 遍历 10 万行来
  // 同时建列表与记账 —— 每次打开面板/刷新一次全表遍历，而 SQL 侧聚合只需 3–12 ms（§3 的账）。
  // 先按 listFeeds() 铺 0、再用结果覆盖：GROUP BY 只返回有未读的源，反过来会让 0 未读的源
  // 从回包里消失（左栏那一行角标变空白，界面上无从分辨）。
  const perFeedUnread = target.unreadPerFeed(feeds.map((feed) => feed.id))

  // 列表取数同样交给存储侧：**只取一页**（SQL 里是 i2 索引上的 LIMIT + keyset 谓词），
  // 而不是「把 10 万行建成 ItemView、排序、再 slice 掉 99700 条」。取数顺序与原先逐字相同
  // （recency 降序 + id 升序），所以截断点上的结果没有区别 —— 只有成本不同。
  //
  // ⚠️ 窗口要**放大重取**：上面那句「只收所属源还在的条目」会把残留行（退订后没清干净 /
  // 手工改库）挡掉，而挡掉的那些**已经占掉了窗口**。不重取的话列表会少几条，而用户看不出原因
  // —— 原先的写法是先按 feeds 表滤完全部、再截断，所以这里必须保住同一条语义。
  //
  // ⚠️ 多取一行（window + 1）**只用于判断「后面还有没有」**：nextCursor 必须来自「存储侧确实
  // 还有行」这个事实，不能拿「items 短于 maxItemsShown」反推 —— 孤儿行占窗口时取不满的那一页
  // 未必是最后一页（上面那条放大的理由同此）。少给一页 = 用户翻不到底（本任务要修的缺陷又回来了）；
  // 多给一页 = 白白多一次往返，且末页空页会让界面上的「加载更多」闪一下。
  const pageSize = ctx.config.maxItemsShown
  let window = pageSize
  let rows: Array<[string, ItemRecord]> = []
  let items: ItemView[] = []
  // 最后一条**真正下发**的条目在 rows 里的下标（-1 = 这一页一条都没下）
  let lastDelivered = -1
  // 存储侧是否已给不出更多行（请求 window + 1 行却只拿到 ≤ window 行）
  let exhausted = false
  while (true) {
    rows = target.listRecent(window + 1, cursor, scope?.feedIds, scope?.tagId)
    items = []
    lastDelivered = -1
    for (let index = 0; index < rows.length; index += 1) {
      const [itemId, item] = rows[index]
      const feedTitle = titles.get(item.feedId)
      if (feedTitle === undefined) continue
      // 这一页取满就停：后面的行只用来判断「还有没有下一行」，不再建 ItemView
      if (items.length >= pageSize) break
      items.push({
        id: itemId,
        feedId: item.feedId,
        feedTitle,
        title: item.title,
        link: item.link,
        publishedAt: item.publishedAt,
        fetchedAt: item.fetchedAt,
        readAt: item.readAt,
        starred: item.starred,
        keptUnread: item.keptUnread,
        summary: item.summary,
      })
      lastDelivered = index
    }
    exhausted = rows.length <= window
    if (items.length >= pageSize || exhausted) break
    window *= 2
  }

  // 续页游标 = 下发批次的**最后一行**（recency + id 一对值）。判据是「它后面还有行」：
  // 要么同一批里还有（lastDelivered 不是最后一个下标），要么存储侧还没给完（!exhausted）。
  // 两者都不成立 ⇒ 到底，nextCursor 缺省 —— 客户端据此停止翻页（Overview 契约）。
  // 每页一次批量取标签 id（不能逐行 N+1）；ItemView 的 tagIds 是列表行标签与编辑器的数据源。
  const tagIdsByItem = target.tagIdsForItems(items.map((item) => item.id))
  items = items.map((item) => ({ ...item, tagIds: tagIdsByItem[item.id] ?? [] }))

  const nextCursor = lastDelivered >= 0 && (lastDelivered + 1 < rows.length || !exhausted)
    ? (scope === undefined ? '' : scope.key + ':')
      + encodeCursor({ recency: recencyOf(items[items.length - 1]), id: items[items.length - 1].id })
    : undefined

  return {
    feeds,
    folders,
    tags,
    items,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    // 总数由每源账目**求和派生**，不再单独数一遍：两处各算一次时，截断/漂移截面下迟早对不上，
    // 而「左栏各源之和 === 顶栏总未读」正是 spec §4 不变量 1。
    unread: sumOf(perFeedUnread),
    perFeedUnread,
    refreshed,
    ...(run === undefined ? {} : { refresh: run }),
    // 让界面能说明「上次到底什么时候抓过」——否则「按住刷新没反应」无从判断
    refreshedAt: refreshedAtMs === undefined ? undefined : new Date(refreshedAtMs).toISOString(),
  }
}
/**
 * 端点表：25 个端点一处声明。
 *
 * 穷尽性由 `Record<Endpoint, EndpointSpec>` 保证 —— 名字表（shared.ts 的 ENDPOINT_NAMES）
 * 加了新端点而这里没跟上，编译就不过。这是本文件里唯一需要「加端点时改的地方」。
 */
const searchDay = z.iso.date().optional()
const searchQuerySchema = z.object({
  text: z.string().trim().min(1).refine((text) => [...text].length <= 120),
  feedId: z.string().optional(),
  feedIds: z.array(z.string()).optional(),
  tagId: z.string().min(1).optional(),
  read: z.enum(['read', 'unread']).optional(),
  starred: z.boolean().optional(),
  from: searchDay,
  to: searchDay,
  cursor: z.string().max(2048).optional(),
}).refine(({ from, to }) => !from || !to || from <= to)

export const ENDPOINTS: Record<Endpoint, EndpointSpec> = {
  searchItems: {
    to: async (payload, ctx) => {
      const parsed = searchQuerySchema.safeParse(payload)
      if (!parsed.success) return fail('bad-request', '搜索词、日期范围或分页游标无效')
      if (!ctx.searchItems) return fail('not-ready', '搜索服务尚未就绪')
      const query = parsed.data
      const selected = query.feedIds === undefined ? undefined : new Set(query.feedIds)
      const feeds: Array<[string, string]> = ctx.store.listFeeds()
        .filter(([id]) => (query.feedId === undefined || query.feedId === id) && (selected?.has(id) ?? true))
        .map(([id, feed]) => [id, feed.title ?? id])
      const key = createHash('sha256').update(JSON.stringify([
        query.text, query.read, query.starred === true, query.from, query.to, query.tagId, feeds.map(([id]) => id).sort(),
      ])).digest('base64url') + ':'
      const cursor = query.cursor?.slice(key.length)
      if (query.cursor !== undefined && (!query.cursor.startsWith(key) || cursor === undefined || !decodeCursor(cursor))) {
        return fail('bad-request', '分页游标与当前搜索不匹配，请重新搜索')
      }
      const page = await ctx.searchItems({ ...query, cursor, feedId: feeds.length === 1 ? feeds[0][0] : undefined }, feeds, 30, ctx.signal)
      return ok({ ...page, nextCursor: page.nextCursor === undefined ? undefined : key + page.nextCursor })
    },
  },
  overview: {
    to: async (payload, ctx) => {
      // 续页游标**必须解码成功**才继续（Overview 的契约）。认不出时**响亮拒绝**：
      // 「解不出就从第一页开始」会让翻页永远翻不完 —— 每页都回同一批条目，界面无限追加重复行，
      // 而用户看到的是一份「永远滚不到底」的列表，不是一句报错。
      const resolved = overviewScopeOf(ctx, payload)
      if (resolved.failure !== undefined) return resolved.failure
      const scope = resolved.scope
      const raw = (payload as { cursor?: unknown } | null)?.cursor
      if (raw === undefined || raw === null) return ok(buildOverview(ctx, undefined, undefined, scope))
      if (typeof raw !== 'string') return fail('bad-request', 'overview 的 cursor 必须是字符串')
      let cursor: Cursor | undefined
      if (scope === undefined) {
        cursor = decodeCursor(raw)
      } else {
        // 有范围游标 = "<scopeKey>:<recency>|<id>"。前缀不符意味着文件夹成员变了、或调用方
        // 拿别的范围/无范围游标来续页 —— 两种都必须响亮失败，绝不能静默从头开始。
        const prefix = scope.key + ':'
        if (!raw.startsWith(prefix)) {
          return fail('bad-request', '分页游标与当前范围不匹配，请重新加载')
        }
        cursor = decodeCursor(raw.slice(prefix.length))
      }
      if (cursor === undefined) {
        return fail('bad-request', '未知的续页游标（格式应为 "<recency>|<id>"）：' + raw)
      }
      return ok(buildOverview(ctx, undefined, cursor, scope))
    },
  },

  refresh: {
    to: async (payload, ctx) => {
      // 在文件夹里点刷新时必须留在同一范围：否则列表会突然跳回跨源首页（用户会以为选中的文件夹丢了）。
      const resolved = overviewScopeOf(ctx, payload)
      if (resolved.failure !== undefined) return resolved.failure
      const run = await ctx.refreshNow()
      return ok(buildOverview(ctx, run, undefined, resolved.scope))
    },
  },

  markRead: {
    carriesAccount: true,
    to: async (payload, ctx) => {
      const body = payload as { itemIds?: unknown; skipKept?: unknown; before?: unknown } | null
      const itemIds = Array.isArray(body?.itemIds) ? (body as { itemIds: unknown[] }).itemIds.map(String) : []
      if (itemIds.length === 0) return fail('bad-request', 'markRead 需要 itemIds 数组')
      // 「全部标为已读」（A 键）走这条时带 skipKept：**保持未读的条目要活下来**
      // —— 那正是规格 §3.3 里 kept-unread 的用处；而单条打开/显式标记不带它，
      // 那种情况下按规格「标为已读即移除 kept-unread」。
      const skipKept = body?.skipKept === true
      // 「只标**早于** X 的」（规格 §3.3 的 panic button，2009-08 加入）。客户端会先按范围过滤一遍，
      // 这里是**第二道闸**：客户端列表只是快照，宿主手上的 recency 才是权威。
      const before = typeof body?.before === 'string' && body.before !== '' ? body.before : undefined
      const stamp = new Date().toISOString()
      let changed = 0
      for (const itemId of itemIds) {
        const existing = ctx.store.item(itemId)
        if (existing === undefined || existing.readAt !== undefined) continue
        if (skipKept && existing.keptUnread === true) continue
        // 判据与排序同源（recency = 发布时间优先、缺则抓取时间），ISO 字符串可直接比大小
        if (before !== undefined && recencyOf(existing) >= before) continue
        // 幂等：已读的原时间戳不动。用 rebuildItem 是为了同时把 kept-unread 去掉
        await ctx.store.saveItem(itemId, rebuildItem(existing, { omit: ['keptUnread'], set: { readAt: stamp } }))
        changed += 1
      }
      // 回包**必须带 perFeedUnread**：客户端在截断场景下看不见全量条目，只能靠这份整体覆盖
      // （spec §4 不变量 1；任务 9 实测：本地 3 条/宿主 20，外部把本地不可见的源标空 ⇒ 差 3）。
      // 账目由分发核按 carriesAccount 统一合并 —— 这条不变量不再由本 handler 承担。
      return ok({ changed })
    },
  },

  unmarkRead: {
    carriesAccount: true,
    to: async (payload, ctx) => {
      // 只服务于「全部标记已读」的短时撤销
      const itemIds = Array.isArray((payload as { itemIds?: unknown } | null)?.itemIds)
        ? ((payload as { itemIds: unknown[] }).itemIds.map(String))
        : []
      if (itemIds.length === 0) return fail('bad-request', 'unmarkRead 需要 itemIds 数组')
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
  },

  article: {
    to: async (payload, ctx) => {
      // 按需正文（V 键）：先看缓存，再冷却，最后才抓原站。三步都留日志——这是唯一会
      // 出网的用户手势，出问题时必须能从日志里还原过程。
      const itemId = String((payload as { itemId?: unknown } | null)?.itemId ?? '')
      if (!itemId) return fail('bad-request', 'article 需要 itemId')
      const existing = ctx.store.item(itemId)
      if (existing === undefined) return fail('not-found', '条目不存在：' + itemId)
      // 命中缓存的前提：**缓存的内容版本等于当前版本**。
      // 老缓存（升级前抓的，只有纯文本 paragraphs）没有版本号 ⇒ 判为过期、自动重抓一次。
      // 否则模型升级后老缓存会永远挡住新逻辑——实测：9 条老缓存导致「图片怎么都不显示」。
      if (existing.article !== undefined && existing.article.revision === ARTICLE_REVISION) {
        return ok({
          itemId, cached: true, title: existing.article.title,
          blocks: existing.article.blocks, paragraphs: existing.article.paragraphs,
          frameable: existing.article.frameable,
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
      return ok({ itemId, cached: false, title: article.title, blocks: article.blocks, frameable: article.frameable })
    },
  },

  opmlExport: {
    to: async (_payload, ctx) => {
      const feeds = ctx.store.listFeeds().map(([feedUrl, record]) => ({
        url: feedUrl, title: record.title, folder: record.folder,
      }))
      return ok({ opml: buildOpml(feeds), feedCount: feeds.length })
    },
  },

  opmlImport: {
    to: async (payload, ctx) => {
      // §3.1：导入时**逐源抓取校验**，坏源单独标注、不阻断其余。
      const text = String((payload as { opml?: unknown } | null)?.opml ?? '')
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
  },

  /**
   * **只发现、不订阅**（PRD §9）：回候选清单与逐条原因，一个字节都不写。
   *
   * 为什么单独一个端点而不是让 addFeed 回候选：addFeed 的语义是「校验并落库」，把它改成
   * 「可能只回候选」会让客户端无法区分「加了」和「只是看了看」——而这两件事的后果完全不同
   * （写盘 vs 零写入）。分开之后，取消 = 什么都不做，不需要任何回滚。
   */
  discoverFeeds: {
    to: async (payload, ctx) => {
      const raw = String((payload as { url?: unknown } | null)?.url ?? '').trim()
      if (raw === '') return fail('bad-request', 'discoverFeeds 需要 url')
      // 出网手势照 article 端点的先例留痕：发现不出现在刷新日志里，否则「点了没反应」无从排查。
      ctx.log('发现订阅候选：' + raw)
      const result = await discoverCandidates(raw, {
        limits: { timeoutMs: ctx.config.timeoutMs, maxBytes: ctx.config.maxBytes, trustedTarget: true },
        concurrency: 1,
      })
      ctx.log('发现结果：' + raw + ' → 已验证 ' + result.candidates.length + ' 个候选，' + result.warnings.length + ' 条警告')
      return ok(result)
    },
  },

  addFeed: {
    to: async (payload, ctx) => {
      const raw = String((payload as { url?: unknown } | null)?.url ?? '')
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
  },

  removeFeed: {
    to: async (payload, ctx) => {
      const feedId = String((payload as { url?: unknown } | null)?.url ?? '')
      if (!feedId) return fail('bad-request', 'removeFeed 需要 url')
      const known = ctx.store.feed(feedId)
      if (known === undefined) return fail('not-found', '订阅不存在：' + feedId)
      // 连带删掉该源的全部条目与游标——留着孤儿条目只会让人困惑
      const items = ctx.store.listItems(feedId)
      for (const [itemId] of items) await ctx.store.deleteItem(itemId)
      await ctx.store.deleteFeed(feedId)
      ctx.log('退订 ' + feedId + '（连带删除 ' + items.length + ' 条条目）')
      return ok({ removed: 1, items: items.length })
    },
  },

  cleanup: {
    carriesAccount: true,
    to: async (_payload, ctx) => {
      // 显式清理（用户点按钮触发，**不设定时器**——验收项之一就是不残留定时器）。
      // 判据刻意保守：已读 + 未星标 + 早于阈值，三个条件缺一不可（见 retention.ts 注释）。
      //
      // **候选集由存储侧一条 SQL 选出**（Task 5）：原先这里 `allItems()` 把整张 items 表
      // （10 万行）物化到 JS 再筛 —— 「点一次清理 = 一次全表遍历」，而 spec §3.1 只把清理记在
      // accountOf 名下，漏了这一处（计划的定稿加固已记账）。
      // 判据的定义处仍是 retention.ts 的 selectCleanup；但**候选集**已由存储侧的 SQL 预筛过
      // （src/store-sqlite.ts 的 SELECT_CLEANUP_IDS），那一份是**第二实现**而不是第二口径：
      // 它把「已读 / 未星标 / 早于阈值」三项照抄，另**更窄**一条 —— kept_unread = 0
      // （用户对「保持未读」说的是「别动它」，与星标同级）。
      // 这里把候选喂回 selectCleanup 复跑，所以**最终删哪些 = SQL 谓词 ∩ selectCleanup**：
      // SQL 只负责「不用把整张 items 表搬进 JS」，判断仍由判据之家做出，两处必须同步改。
      // 「两份实现仍然是同一个判据」由 tests/store-sqlite.test.mjs 的两条钉住：对账用例
      // （「候选集必须与 selectCleanup 的集合逐字相等（除 kept 之外）」）与 SQL 文本断言。
      const cutoff = new Date(Date.now() - ctx.config.cleanupAfterDays * 24 * 3600 * 1000).toISOString()
      const candidates = ctx.store.listCleanupCandidates(cutoff)
      const doomed = new Set(selectCleanup(candidates, cutoff))
      // 释放量直接读候选行自带的原料（正文 + 摘要）：原先按 id 逐条 `target.item()` 点读，
      // 几千条候选就是几千次点读（还把正文一起搬进内存）。摘要同样占字节，一并计入。
      const freedChars = candidates
        .filter((row) => doomed.has(row.id))
        .reduce((sum, row) => sum + row.articleChars + row.summaryChars, 0)
      for (const itemId of doomed) await ctx.store.deleteItem(itemId)
      ctx.log('清理：删除 ' + doomed.size + ' 条已读旧条目（阈值 ' + ctx.config.cleanupAfterDays + ' 天，释放约 ' +
        freedChars + ' 字符）')
      return ok({ deleted: doomed.size, freedChars, cutoff })
    },
  },

  toggleKeepUnread: {
    carriesAccount: true,
    to: async (payload, ctx) => {
      // 「保持未读」在 GR 里**没有快捷键**（规格 §3.4 的键位列是「—」），是条目下方的链接。
      // 所以这个端点服务于客户端的那个链接，不接键位。
      const itemId = String((payload as { itemId?: unknown } | null)?.itemId ?? '')
      if (!itemId) return fail('bad-request', 'toggleKeepUnread 需要 itemId')
      const existing = ctx.store.item(itemId)
      if (existing === undefined) return fail('not-found', '条目不存在：' + itemId)
      const keptUnread = existing.keptUnread !== true
      // 取消时把键去掉而不是写 false —— 缺省即「未保持」，少一个键更干净
      await ctx.store.saveItem(itemId, keptUnread
        ? rebuildItem(existing, { set: { keptUnread: true } })
        : rebuildItem(existing, { omit: ['keptUnread'] }))
      return ok({ itemId, keptUnread })
    },
  },

  // 视图记忆（两列布局任务 7）：UI 偏好的读/写端点是两个，而不是挂在 overview 上。
  //
  // 为什么不并进 overview（省一次往返）：
  //  · overview 的语义是「条目数据」，它已经被 unread / perFeedUnread / 截断三件事占满；
  //    往里塞 UI 偏好会让「什么都不动时读一次面板也会写盘」—— 恢复与写盘会互相触发。
  //  · 写侧必须独立：客户端只在**关键动作**后写一次，不能顺路搭在每次数据刷新上。
  //  · 读取必须**早于** feeds 数据可用：客户端一挂载就恢复，不能等 overview 回来再改视图
  //    （那会让用户先看到默认态再跳一下）。
  //
  // 复用既有 HTTP 通道（ROUTE_PATH + requestRejection 准入），与其余 13 个端点同一条路
  // —— 不新开机制、不加注入口。
  viewPreferences: {
    to: async (_payload, ctx) => ok({ preferences: ctx.store.viewPreferences() }),
  },

  saveViewPreferences: {
    to: async (payload, ctx) => {
      // 传进来的值一律不可信（可能是别的版本写的、也可能根本不是一个对象）：
      // 交给 store 归一后再落库。认不出就回落默认，绝不抛错、绝不把垃圾写进域。
      const saved = await ctx.store.saveViewPreferences((payload as { preferences?: unknown } | null)?.preferences)
      return ok({ preferences: saved })
    },
  },

  // ── 文件夹目录与变更接口（M2 02）────────────────────────────────────────
  // 与订阅同住 config.json；每个变更都在**一次**读改写里完成（改名连带成员归属）。
  // 名称规则与错误码归 src/folders.ts；这里只做 payload 形状校验与错误信封转换。
  listFolders: {
    to: async (_payload, ctx) => ok({ folders: ctx.store.listFolders() }),
  },

  createFolder: {
    to: async (payload, ctx) => {
      const name = (payload as { name?: unknown } | null)?.name
      if (typeof name !== 'string') return fail('bad-request', 'createFolder 需要 name（字符串）')
      try {
        return ok({ folders: await ctx.store.createFolder(name) })
      } catch (error) {
        const failure = folderFailure(error)
        if (failure !== undefined) return failure
        throw error
      }
    },
  },

  renameFolder: {
    to: async (payload, ctx) => {
      const body = payload as { from?: unknown; to?: unknown } | null
      if (typeof body?.from !== 'string' || typeof body?.to !== 'string') {
        return fail('bad-request', 'renameFolder 需要 from 与 to（字符串）')
      }
      try {
        return ok({ folders: await ctx.store.renameFolder(body.from, body.to) })
      } catch (error) {
        const failure = folderFailure(error)
        if (failure !== undefined) return failure
        throw error
      }
    },
  },

  deleteFolder: {
    to: async (payload, ctx) => {
      const name = (payload as { name?: unknown } | null)?.name
      if (typeof name !== 'string') return fail('bad-request', 'deleteFolder 需要 name（字符串）')
      try {
        // 独立入口：只解除分类，绝不走 removeFeed（那会连带删条目）。判据在 tests/folder-storage。
        return ok(await ctx.store.deleteFolder(name))
      } catch (error) {
        const failure = folderFailure(error)
        if (failure !== undefined) return failure
        throw error
      }
    },
  },

  moveFeedToFolder: {
    to: async (payload, ctx) => {
      const body = payload as { feedId?: unknown; folder?: unknown } | null
      if (typeof body?.feedId !== 'string' || body.feedId === '') {
        return fail('bad-request', 'moveFeedToFolder 需要 feedId（非空字符串）')
      }
      // folder 键**必须显式给出**：缺键 ≠ 移到未分类。少了这道判断，一个坏 payload 会把用户
      // 刚归好的源静默移出分组。
      if (body === null || !Object.hasOwn(body, 'folder')) {
        return fail('bad-request', 'moveFeedToFolder 需要 folder（字符串或 null，null = 未分类）')
      }
      if (body.folder !== null && typeof body.folder !== 'string') {
        return fail('bad-request', 'moveFeedToFolder 的 folder 必须是字符串或 null')
      }
      try {
        return ok({ folders: await ctx.store.moveFeedToFolder(body.feedId, body.folder === null ? undefined : body.folder) })
      } catch (error) {
        const failure = folderFailure(error)
        if (failure !== undefined) return failure
        throw error
      }
    },
  },

  // ── 标签持久化与变更接口（M2 05）────────────────────────────────────
  // 标签只分类：这里没有「标读」语义，也不触碰 items.read_at。关联写入使用稳定 tag id，
  // 名称可改而 id 不变；空标签由 listTags 的 LEFT JOIN 保留。
  listTags: {
    to: async (_payload, ctx) => ok({ tags: ctx.store.listTags() }),
  },

  createTag: {
    to: async (payload, ctx) => {
      const name = (payload as { name?: unknown } | null)?.name
      if (typeof name !== 'string') return fail('bad-request', 'createTag 需要 name（字符串）')
      try {
        return ok({ tag: await ctx.store.createTag(name) })
      } catch (error) {
        const failure = tagFailure(error)
        if (failure !== undefined) return failure
        throw error
      }
    },
  },

  renameTag: {
    to: async (payload, ctx) => {
      const body = payload as { id?: unknown; name?: unknown } | null
      if (typeof body?.id !== 'string' || typeof body?.name !== 'string') {
        return fail('bad-request', 'renameTag 需要 id 与 name（字符串）')
      }
      try {
        return ok({ tag: await ctx.store.renameTag(body.id, body.name) })
      } catch (error) {
        const failure = tagFailure(error)
        if (failure !== undefined) return failure
        throw error
      }
    },
  },

  deleteTag: {
    to: async (payload, ctx) => {
      const id = (payload as { id?: unknown } | null)?.id
      if (typeof id !== 'string') return fail('bad-request', 'deleteTag 需要 id（字符串）')
      try {
        await ctx.store.deleteTag(id)
        return ok({ deleted: true })
      } catch (error) {
        const failure = tagFailure(error)
        if (failure !== undefined) return failure
        throw error
      }
    },
  },

  setItemTags: {
    to: async (payload, ctx) => {
      const body = payload as { itemId?: unknown; tagIds?: unknown } | null
      if (typeof body?.itemId !== 'string' || body.itemId === '') {
        return fail('bad-request', 'setItemTags 需要 itemId（非空字符串）')
      }
      try {
        // tagIds 的形状由 normalizeTagIds 统一判（非数组 / 非字符串都回 bad-request）；
        // 这里不把 unknown 强转成 any，也不让一个坏 payload 走到 SQL。
        const tags = await ctx.store.setItemTags(body.itemId, body.tagIds as readonly string[])
        return ok({ itemId: body.itemId, tags })
      } catch (error) {
        const failure = tagFailure(error)
        if (failure !== undefined) return failure
        throw error
      }
    },
  },

  toggleStar: {
    carriesAccount: true,
    to: async (payload, ctx) => {
      const itemId = String((payload as { itemId?: unknown } | null)?.itemId ?? '')
      if (!itemId) return fail('bad-request', 'toggleStar 需要 itemId')
      const existing = ctx.store.item(itemId)
      if (existing === undefined) return fail('not-found', '条目不存在：' + itemId)
      const starred = !existing.starred
      await ctx.store.saveItem(itemId, { ...existing, starred })
      return ok({ itemId, starred })
    },
  },
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
  const { config, log, ready, refreshNow, lastRefreshCompletedAt, articleAttempts, searchItems } = deps

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
        store: target, ready, config, log, refreshNow, lastRefreshCompletedAt, articleAttempts, searchItems, signal,
      }
      const result = await spec.to(payload, ctx)
      if (spec.carriesAccount === true && result.ok) {
        const account = accountOf(target)
        return ok({ ...(result.value as object), unread: account.unread, perFeedUnread: account.perFeedUnread })
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
