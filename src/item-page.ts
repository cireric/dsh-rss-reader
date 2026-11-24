/**
 * 一页条目：`(范围, 游标, 页大小) → 行 + 下一游标`。
 *
 * 为什么单独成模块（ADR-0004）：分页协议是三件事的合成 —— **排序键**（recency 降序 + id 升序，
 * cursor.ts 的 recencyOf）、**续页关系**（严格排在边界之后）、**栅栏**（游标绑在范围上）。
 * 这三件事原先分居三处：窗口循环与投影在 endpoints 的 buildOverview 闭包里、编码在 handler 里、
 * 解码在 200 行之外、谓词在三个 SQL 变体和两份 JS 适配器里各写一遍。改任何一处，另一处的用例
 * 都不会红；要测「一页怎么产生」还得起真库 + 真 dispatch。
 *
 * 现在它们只有一个 owner：本模块。端点的义务缩成三件 —— 解析范围存不存在、调用这里、装配回包。
 *
 * **输出为什么是行而不是 ItemView**：ItemView 是 wire 形状（feedTitle、tagIds 都在里面），
 * 留在端点一处装配；本模块只依赖**一条**取数语义（listRecent），替身因此是个 20 行的假函数，
 * 既不需要标签，也不需要标题表。
 */
import { createHash } from 'node:crypto'
import type { ItemRecord } from './domain.js'
import { decodeCursor, encodeCursor, recencyOf } from './cursor.js'
import type { Cursor } from './cursor.js'
import type { DisplayWindowBounds } from './display-window.js'

/**
 * 浏览范围：单个订阅源（id 参与栅栏键）、文件夹（成员参与）或标签（id 参与）。
 *
 * 用判别联合而不是「两个可选字段 + 一条互斥约定」：互斥约定写在注释里就会被下一个人违反，
 * 而判别联合在 fenceKeyOf 的 switch 里能穷尽。无范围就是 `undefined`（跨源首页），
 * 它同样有栅栏（键 = 空串），所以四种范围走同一条编解码。
 *
 * **源范围必须由宿主筛**（R14）：客户端拿全局第一页再按 `feedId` 过滤，会让低产源只显示
 * 「恰好落在这一页里的那几条」——实测 648 条的库里，27 条的源只有 2 条在前 300。文件夹 /
 * 标签本来就是宿主先筛，源与它们没有理由不同。
 */
export type PageScope =
  | { readonly kind: 'feed'; readonly id: string }
  | { readonly kind: 'folder'; readonly name: string; readonly feedIds: readonly string[] }
  | { readonly kind: 'tag'; readonly id: string }

/**
 * 文件夹的栅栏键 = 文件夹名 + **当前成员**的哈希。
 *
 * 为什么成员也要进键：文件夹只是一个名字，成员可以在两页之间被移动。只绑名字时，旧游标会拿着
 * 「第一页的成员快照」去查「第二页的新成员」，结果既不连续也不可解释；绑上排序后的成员列表后，
 * 成员一变旧游标自然失配，客户端必须从第一页重来。标签 id 是稳定主键：改名不失效、删除才失效。
 */
function scopeFenceOf(scope: PageScope | undefined): string {
  if (scope === undefined) return ''
  switch (scope.kind) {
    case 'feed':
      // 源 id 是规范化 URL（含 `:` / `/`）。栅栏匹配是「前缀 + 冒号」的 startsWith，
      // 不用分隔符切开，所以 URL 里的冒号不会与段分隔撞车；前缀再带一个 `:` 也挡住了
      // 「feed A 的 id 是 feed B 的前缀」这类碰撞。
      return 'feed:' + scope.id
    case 'tag':
      return 'tag:' + scope.id
    case 'folder': {
      const members = [...scope.feedIds].sort()
      return 'folder:' + createHash('sha256').update(JSON.stringify([scope.name, members])).digest('base64url')
    }
  }
}

/** 带窗游标的第二个栅栏段前缀。单独成常量：decoder 要靠它把「别的窗口的游标」判成 mismatch。 */
const WINDOW_FENCE_PREFIX = 'window:'

/**
 * 窗口段的键 = `[from, to)` 的哈希。
 *
 * 为什么不把 ISO 串直接拼进前缀：它含 `:` 与 `-`，与「档位段之间用 `:` 分隔」的读法撞车，
 * 而 `|` 又是游标体的分隔符。哈希（与文件夹成员同一个手法）让前缀永远是 `[A-Za-z0-9_-]+`。
 */
function windowFenceOf(window: DisplayWindowBounds): string {
  return WINDOW_FENCE_PREFIX
    + createHash('sha256').update(JSON.stringify([window.from, window.to])).digest('base64url')
}

/**
 * 一页的栅栏键（不含尾部冒号）：范围段 + 窗口段。
 *
 * **无窗口时逐字维持旧键**（`''` / `folder:<hash>` / `tag:<id>`）：升级瞬间用户浏览器里可能还
 * 握着旧游标，前缀不变才能让它们继续有效。带窗时追加 `:window:<hash>`，于是切档后旧游标
 * 一定对不上前缀 —— 这是「窗口进栅栏」的可观察半边（ADR-0004 的 2026-11-19 修订）。
 */
export function fenceKeyOf(scope?: PageScope, window?: DisplayWindowBounds): string {
  return [scopeFenceOf(scope), window === undefined ? '' : windowFenceOf(window)]
    .filter((part) => part !== '')
    .join(':')
}

/**
 * 围栏解码的三种结果。
 *
 * 为什么不是 `Cursor | undefined`：两种失败必须能分开 —— 「范围变了」的处置是让客户端重载当前范围
 * （它的游标确实过期了），「格式认不出」的处置是报格式错误（调用方传了垃圾）。合并成一种就只能
 * 说一句含糊的话。这里只给**判定**，文案与信封留在端点（那是 wire 层的事）。
 */
export type CursorParse =
  | { readonly status: 'ok'; readonly cursor: Cursor }
  | { readonly status: 'mismatch' }
  | { readonly status: 'malformed' }

/**
 * 游标 → wire 字符串；栅栏前缀 = `(范围, 窗口)` 的键。
 *
 * 无范围无窗口时就是裸体 `"<recency>|<id>"` —— 与加窗之前逐字相同。
 */
export function encodePageCursor(scope: PageScope | undefined, cursor: Cursor, window?: DisplayWindowBounds): string {
  const fence = fenceKeyOf(scope, window)
  return (fence === '' ? '' : fence + ':') + encodeCursor(cursor)
}

/**
 * wire 字符串 → 游标，先验栅栏再验形状。
 *
 * ⚠️ 两种失败都**不许**被当成「没有游标 ⇒ 从第一页开始」：那会让翻页永远翻不完（每页都回同一批
 * 条目，界面无限追加，用户看到的是「永远滚不到底」而不是一句报错）。
 *
 * **反方向也要认出来**：请求不带窗口、游标却带着窗口段（切回「全部」后续页）时，期望前缀可能是
 * 空串（无范围），`startsWith('')` 恒真，游标体则被 decodeCursor 判成 malformed —— 于是「切档后
 * 旧游标」会被报成「你传了垃圾」。这里先看前缀之后是不是窗口段：是就说明它属于**另一个栅栏**，
 * 回 mismatch，端点才能说「分页游标与当前范围不匹配，请重新加载」。
 */
export function decodePageCursor(scope: PageScope | undefined, raw: string, window?: DisplayWindowBounds): CursorParse {
  const fence = fenceKeyOf(scope, window)
  const prefix = fence === '' ? '' : fence + ':'
  if (!raw.startsWith(prefix)) return { status: 'mismatch' }
  const rest = raw.slice(prefix.length)
  if (window === undefined && rest.startsWith(WINDOW_FENCE_PREFIX)) return { status: 'mismatch' }
  const cursor = decodeCursor(rest)
  return cursor === undefined ? { status: 'malformed' } : { status: 'ok', cursor }
}

/**
 * 「这一行严格排在游标之后吗」—— JS 侧的唯一一份续页谓词（ADR-0004 决定 4）。
 *
 * 行与游标是**同一个形状**（`Cursor`：排序键 + id 的一对值，定义在 src/cursor.ts），所以两边都收
 * `Cursor` 而不是把一对裸字符串拆成两个参数 —— 排序键的含义只在一处声明。
 *
 * 排序是 recency 降序、同 recency 内 id **升序**，所以同 recency 的续页方向是 `row.id > cursor.id`。
 * ⚠️ 顺序反过来（`row.id <`）会在打平点上**重复 + 漏**：实测 6 行每页 2 条时返回 `a d e f`，
 * 正确是 `c d e f`（spec §10.3）。而 recency 打平是常态：同一轮抓取的条目共享 fetchedAt。
 *
 * 适配器（store.ts / memory-store.ts）与 SQL 侧那个片段常量是本谓词的两种语言写法，
 * 「逐字同义」由 ReaderStore 契约与 tests/overview-paging.test.mjs 的旧实现用例钉住。
 */
export function afterCursor(row: Cursor, cursor: Cursor): boolean {
  return row.recency < cursor.recency || (row.recency === cursor.recency && row.id > cursor.id)
}

/**
 * 取数接缝：**一条**语义 —— 「这个范围里排在 X 之后的下一批行」。
 *
 * 结构化声明而不是 `Pick<ReaderStore, 'listRecent'>`：store.ts / memory-store.ts 要反向 import
 * 本模块的 afterCursor，如果这里再 import store.ts 的类型就会形成模块环（类型虽可擦除，
 * 但读起来是两个模块互相依赖）。形状与 ReaderStore.listRecent 逐字一致，由契约测试保证。
 */
export interface PageSource {
  listRecent(
    limit: number,
    cursor?: Cursor,
    feedIds?: readonly string[],
    tagId?: string,
    window?: DisplayWindowBounds,
  ): Array<[string, ItemRecord]>
}

export interface PageRequest {
  /** 浏览范围；缺省 = 跨源（无栅栏前缀）。 */
  readonly scope?: PageScope
  /** 续页边界；缺省 = 第一页。 */
  readonly cursor?: Cursor
  /**
   * 显示窗（半开区间）；缺省 = 「全部」，取数与栅栏行为与加窗之前逐字相同。
   *
   * 窗口**不进** `PageScope`（ADR-0004 修订）：范围回答「哪些源」，窗口回答「哪段时间」，
   * 两者正交 —— 文件夹里也能问「今天剩什么」。
   */
  readonly window?: DisplayWindowBounds
  /** 一页要下发多少条（config.maxItemsShown）。 */
  readonly pageSize: number
  /**
   * 「哪些源还在」的键域。不在集合里的行是**孤儿**（退订后没清干净 / 手工改库），
   * 既不进列表，也**不许占掉窗口** —— 后者正是下面要放大重取的全部理由。
   */
  readonly knownFeedIds: ReadonlySet<string>
}

/**
 * 范围 → listRecent 的两个可选参数。判别联合保证二者最多一个非空。
 *
 * 写成 switch 而不是两条三元：给 PageScope 加第三种范围时，这里与 fenceKeyOf 都会因
 * 「函数可能不返回」当场编译失败 —— 否则新范围会静默落进「无范围」分支（查出全库）。
 */
function listRecentArgsOf(scope: PageScope | undefined): { feedIds?: readonly string[]; tagId?: string } {
  if (scope === undefined) return {}
  switch (scope.kind) {
    case 'feed':
      // 存储层的 listRecent 本就按 feedIds 数组筛：单源就是只含一个成员的范围，
      // 不新开「单源专用」参数（同一语义只留一种表达）。
      return { feedIds: [scope.id] }
    case 'folder':
      return { feedIds: scope.feedIds }
    case 'tag':
      return { tagId: scope.id }
  }
}

export interface ItemPage {
  /** 真正下发的行（已剔孤儿、已按 pageSize 截断）。 */
  readonly rows: Array<[string, ItemRecord]>
  /** 续页游标；缺省 = 到底。 */
  readonly nextCursor?: string
}

/**
 * 取一页。
 *
 * 窗口补偿：先按 pageSize 取，被孤儿挡掉的行**已经占掉了窗口**，所以要放大重取（×2），
 * 直到凑满一页或存储侧给不出更多行 —— 不放大就会静默少几条，而用户看不出原因
 * （原实现是先按 feeds 表滤完全部再截断；这条语义必须保住）。
 *
 * 多取一行（fetchSize + 1）**只用于判断「后面还有没有」**：`nextCursor` 必须来自「存储侧确实还有行」
 * 这个事实，不能拿「取回的条数短于 pageSize」反推 —— 孤儿占窗时取不满的那一页未必是最后一页。
 * 少给一页 = 用户翻不到底；多给一页 = 多一次往返，且末页空页会让「加载更多」闪一下。
 */
export function buildItemPage(source: PageSource, request: PageRequest): ItemPage {
  const { scope, cursor, window, pageSize, knownFeedIds } = request
  // 范围落到 listRecent 的两个可选参数上（映射本身是一个穷尽 switch，见 listRecentArgsOf）。
  const { feedIds, tagId } = listRecentArgsOf(scope)

  let fetchSize = pageSize
  let fetched: Array<[string, ItemRecord]> = []
  let rows: Array<[string, ItemRecord]> = []
  // 最后一条**真正下发**的行在本批 fetched 里的下标（-1 = 这一页一条都没下）
  let lastDelivered = -1
  // 存储侧是否已给不出更多行（请求 window + 1 行却只拿到 ≤ window 行）
  let exhausted = false
  while (true) {
    fetched = source.listRecent(fetchSize + 1, cursor, feedIds, tagId, window)
    rows = []
    lastDelivered = -1
    for (let index = 0; index < fetched.length; index += 1) {
      const row = fetched[index]
      if (!knownFeedIds.has(row[1].feedId)) continue
      // 这一页取满就停：后面的行只用来判断「还有没有下一行」，不再收进结果
      if (rows.length >= pageSize) break
      rows.push(row)
      lastDelivered = index
    }
    exhausted = fetched.length <= fetchSize
    if (rows.length >= pageSize || exhausted) break
    fetchSize *= 2
  }

  // 续页游标 = 下发批次的**最后一行**（recency + id 一对值）。判据是「它后面还有行」：
  // 要么同一批里还有（lastDelivered 不是最后一个下标），要么存储侧还没给完（!exhausted）。
  // 两者都不成立 ⇒ 到底，nextCursor 缺省 —— 客户端据此停止翻页（Overview 契约）。
  const boundary = rows[rows.length - 1]
  const nextCursor = lastDelivered >= 0 && (lastDelivered + 1 < fetched.length || !exhausted)
    ? encodePageCursor(scope, { recency: recencyOf(boundary[1]), id: boundary[0] }, window)
    : undefined
  return nextCursor === undefined ? { rows } : { rows, nextCursor }
}
