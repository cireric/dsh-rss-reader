/**
 * 存储适配器：把 refresh 编排与真实的 ctx.storageDomain 隔开。
 *
 * 编排只依赖 ReaderStore 这个窄接口，测试里用内存实现即可覆盖
 * 去重、保留量裁剪与已读态保持，不必先起宿主。
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { randomUUID } from 'node:crypto'
import { readerDomain, feedRecordSchema, tagRecordSchema, type CursorRecord, type FeedRecord, type ItemRecord, type TagRecord } from './domain.js'
import type { ReaderConfigFile } from './storage/config-file.js'
import { addFolder, deleteFolder, folderViews, moveFeedToFolder, renameFolder } from './folders.js'
import { normalizeTagIds, normalizeTagName, requireTagId, TagError } from './tags.js'
import type { FolderView, TagView } from './shared.js'
import { articleCharsOf, type ArticleEntry, type CleanupRow } from './retention.js'
import { applyFeedIntent, type FeedIntent } from './feed-intent.js'
import { clampReadingRatio, countUnreadPerFeed, sanitizeViewPreferences, type ViewPreferences } from './shared.js'
import { recencyOf } from './cursor.js'
import type { Cursor } from './cursor.js'
import { afterCursor } from './item-page.js'
import { linkKeyOf, type DuplicateRow } from './duplicates.js'

/**
 * 清理候选行：**判据字段**（供 selectCleanup 复跑）与**释放量原料**一次带齐。
 *
 * 为什么把释放量的原料也放进候选：调用方拿 id 逐条 `item(id)` 回读，在几千条候选下就是几千次
 * 点读 —— 与「扫描族归零」（spec §3.1）是同一件事的另一种形状。
 */
export interface CleanupCandidate extends CleanupRow {
  /** 正文缓存的字符数（articleCharsOf 的口径 —— 与 client 看到的「释放约 X KB」同源）。 */
  readonly articleChars: number
  /**
   * 摘要字符数。原先 freedChars 只算正文、漏了摘要，而摘要同样是这条条目占的字节；
   * 释放量是**如实汇报**（客户端直接显示它），所以两头都要算。
   */
  readonly summaryChars: number
}

/**
 * 按域切片的**窄接口**（票据 03）。
 *
 * 为什么用 `Pick<ReaderStore, …>` 而不是另写四份方法清单：另写就是第二份真值 —— 给 ReaderStore
 * 加一个方法，四份清单都要跟着改，而「两处各写一遍」正是本仓库反复付学费的地方。Pick 从根上
 * 保证切片与主接口永远一致。
 *
 * 用途：调用方只声明自己真正用到的那片，替身也只需要满足自己那一片。逐步替换即可 ——
 * 端点上下文（EndpointCtx.store）目前仍是完整 ReaderStore，收窄它是 28 个端点的活，不在这一轮。
 */
export type PagingStore = Pick<ReaderStore, 'listRecent'>
/** 未读账：判据来自 unreadPerFeed，**键域**来自 listFeeds（0 未读的源也要留 0）。 */
export type UnreadStore = Pick<ReaderStore, 'unreadPerFeed' | 'listFeeds'>
/** 清理：候选由存储侧成本过滤，删除由调用方按判据执行。 */
export type CleanupStore = Pick<ReaderStore, 'listCleanupCandidates' | 'deleteItem'>
/** 标签批量读：列表/搜索页每行一次查询的替代品。 */
export type TagBatchStore = Pick<ReaderStore, 'tagIdsForItems'>

export interface ReaderStore {
  feed(feedId: string): FeedRecord | undefined
  saveFeed(feedId: string, record: FeedRecord): Promise<void>
  /**
   * **按意图变更**订阅（H4）：字段合并规则收在 src/feed-intent.ts 一处，调用方只声明
   * 「这次是什么事」—— 五个镜像白名单（refresh×3 + opmlImport/addFeed×2）的收拢点。
   * 原子读改写（KvTable.update，与 updateItem 同形）：并发窗口内别的写者不会被旧快照盖掉。
   * 源不存在时按存储域语义拒绝（与 updateItem 同一条纪律：先确认在，别用「写一次即创建」蒙混）。
   */
  updateFeed(feedId: string, intent: FeedIntent): Promise<void>
  cursor(feedId: string): CursorRecord | undefined
  saveCursor(feedId: string, record: CursorRecord): Promise<void>
  /**
   * **退订：一次变更**——订阅项（config.json）+ 该源全部条目 + 游标，都由这个方法完成。
   *
   * 为什么不能只删源记录（2026-11-14 收口，见 docs/adr/0002-unsubscribe-is-one-change.md）：
   * 订阅的真相在 config.json，库内没有 feeds 表，所以「删订阅」在库层面没有任何级联可依赖。
   * 让调用方自己拼（listItems → 逐条 deleteItem → 删源）等于 N+1 个独立事务 + 一次跨介质写，
   * 中途失败会把「一半条目没了、源还在」留给用户。实测（隔离副本，2026-11-14）：
   * 20 条删掉 4 条、星标 2→1，下一轮刷新把这 4 条当新条目写回，已读态与星标永久丢失。
   *
   * 顺序固定为「**先写 config，再在一个事务里删 items 与 cursors**」：跨介质没有共同回滚，
   * 只能选失败形态——这个顺序下最坏是留下看不见的孤儿条目（访问期挡板挡住、装载时报告）；
   * 反过来则是用户可见的数据丢失。
   *
   * 子表（texts / item_tags / reading_progress）由 ON DELETE CASCADE 带走。
   * 返回真正删掉的条目数，供调用方如实汇报。
   */
  deleteSubscription(feedId: string): Promise<{ items: number }>
  /** 单条读取（标记已读要读改写，不能覆盖其它字段） */
  item(itemId: string): ItemRecord | undefined
  saveItem(itemId: string, record: ItemRecord): Promise<void>
  /**
   * **原子读改写**：`fn` 在写入槽位执行，看到的是**当时的**记录 —— 并发写不会互相覆盖。
   *
   * 为什么必须有它（2026-10-10 用户实测的已读丢失）：`saveItem(id, rebuildItem(抓取前的快照, …))`
   * 这种「先取快照 → await 网络 → 整体写回」的写法，会把窗口期内别人写进去的字段（如 readAt）抹掉。
   * 存储域本来就提供这个语义（KvTable.update：fn 看到队列槽位上的当前值，并发更新不会交错），
   * 这里只是把它透出来，让「合并进当前记录」成为唯一可行的写法。
   *
   * 记录不存在时按存储域的语义拒绝（missing-key）—— 调用方应先确认条目在，
   * 不要用「写一次就等于创建」蒙混过去。
   */
  updateItem(itemId: string, fn: (current: ItemRecord) => ItemRecord): Promise<void>
  deleteItem(itemId: string): Promise<void>
  listItems(feedId: string): Array<[string, ItemRecord]>
  /**
   * 全部条目。**只留给「确实需要整表」的调用方**：Task 5 之后 buildOverview / accountOf /
   * cleanup 三条热路径都不再走它（它们各有 SQL 侧的取数方法，见下三条）。
   *
   * ⚠️ 它会把**每份正文都解出来**留在内存里（实测 10 万条 × 8.8 KB ⇒ 堆峰值 1865 MB），
   * 所以常驻路径一律不许走它；见下面 listArticleCacheEntries 的同类替代。
   */
  allItems(): Array<[string, ItemRecord]>
  /**
   * 全库正文缓存的**清算原料**：每条带缓存的条目给 `{ id, chars, fetchedAt }`。
   *
   * 为什么单独一条而不是让调用方走 allItems()（2026-10-11 任务 9 的实测）：
   * `实测` 10 万条、每条 8.8 KB 正文时，`allItems()` 把每份正文都解出来留在内存里 ——
   * 堆峰值 **1865 MB**、RSS 峰值 **3173 MB**，而 spec §9.3 的验收线是常驻内存 ≤ 300 MB（超 6.2 倍）。
   * 而全局预算这条判定**只需要 id + 字符数 + 抓取时间**，正文一个字节都用不上：
   * 本方法只把这三样读出来，让「按需读行」在每轮闸门上继续成立。
   *
   * `chars` 与 `retention.articleCharsOf` **同口径**（blocks 里 text / items 的字符数之和；
   * 库里只存 blocks 形态），是该口径的第二处实现 —— 对账用例在 tests/store-sqlite.test.mjs
   * （与 listCleanupCandidates 的 articleChars 在同一夹具上逐条相等）。
   */
  listArticleCacheEntries(): ArticleEntry[]
  /**
   * 每源未读账目（键域 = 调用方传进来的 feeds 表）。
   *
   * **为什么要有它**（Task 5，spec §3.1 的扫描族归零）：未读账原先由调用方把整张 items 表物化到
   * JS 再数一遍 —— 10 万行下「点一次星标」就是一次全表遍历。存储侧聚合（自持实现是
   * `GROUP BY feed_id`）把它降到毫秒级。
   *
   * **未读判据的定义处是 shared.ts 的 isUnread**（记录侧 `readAt === undefined`）。自持实现为了
   * 不物化 10 万行，在 SQL 里写作 `read_at IS NULL` —— 那是**同一判据的第二实现，不是第二口径**；
   * 「两者确实等价」由 `tests/store-sqlite.test.mjs` 的对账用例钉住
   * （「unreadPerFeed：与 shared.ts 的唯一口径在同一夹具上逐键相等」，同一夹具上逐键比对
   * SQL 结果与 countUnreadPerFeed）。**改判据时两处都要改。**
   *
   * **只保证「传进来的键都有值」，不保证「只有传进来的键」**：自持实现的 SQL 按全表聚合，
   * 已退订源的残留条目也会被数进去（只有拿到 feeds 表的人才做得准键域判定）。调用方一律
   * 「先按 feeds 表铺 0、再用有值的覆盖」—— shared.ts 的 countUnreadPerFeed 同此约定。
   */
  unreadPerFeed(feedIds: readonly string[]): Record<string, number>
  /**
   * 跨源最近的 limit 条（`recency` 降序 + id 升序 —— 与 allItems 同一套排序键，见 cursor.ts 的
   * recencyOf；缺发布时间的条目按抓取时间归位）。
   *
   * **为什么不是「取回全表再 slice」**：10 万行下「取 300 条」的代价是物化 10 万条。
   * 自持实现把排序键与上限都交给 SQL（走 i2 索引），limit ≤ 0 一律空列表
   * （**不能下传 -1**：SQLite 把 LIMIT -1 当「无上限」，那等于把整表读回来）。
   *
   * **可选游标 = keyset 分页**（Ruling P-7：扩展本方法而不是另立一个并列方法）。给了 `cursor`
   * 就只返回**严格排在它之后**的那批（`recency < ? OR (recency = ? AND id > ?)`）。
   *
   * ⚠️ 谓词**不许**写成行值比较 `(recency, id) < (?, ?)`：它按字典序展开成
   * `recency < r0 OR (recency = r0 AND id < id0)`，而同 recency 内我们要的是 `id > id0`
   * —— 方向反了（spec §10.3 `实测`：6 行每页 2 条时返回 `a d e f`，正确是 `c d e f`）。
   *
   * `feedIds`：可选的来源范围（文件夹浏览用）。**筛选必须发生在取数/分页之前**，
   * 否则旧跨源首页之外的成员条目会被截断窗口挡掉（M2 03 的硬要求）。
   * 传空数组 = 空结果，绝不回落成「无范围」。
   */
  listRecent(limit: number, cursor?: Cursor, feedIds?: readonly string[], tagId?: string): Array<[string, ItemRecord]>
  /**
   * 显式清理的候选行（Task 5；原先由调用方 allItems() 全表物化后再筛）。
   *
   * **判据的唯一裁决者是 `retention.ts` 的 `selectCleanup`**；本方法只负责「把可能要删的行捞出来」。
   * 契约是一条**包含关系**：
   *   · 候选集 **⊇** `selectCleanup` 的判定集（少取 = 少清，可接受；不许漏掉真该删的）；
   *   · 候选行必须携带**真实**的 `read / starred / kept` 与 `recency`，**不许按谓词回填**
   *     （回填会让判据看不见真实状态，2026-11-14 的隔离实验实测过这条路径）。
   * 调用方的最终删除集 = `selectCleanup(候选)`（`endpoints.ts` 的 `cleanup` 就这么做）。
   * 自持实现因此只筛「已读 + 够旧」两项成本条件，星标与保持未读交给判据 —— 见
   * `store-sqlite.ts` 的 `SELECT_CLEANUP_ROWS` 注释。
   */
  listCleanupCandidates(cutoffIso: string): CleanupCandidate[]
  /** 全部订阅源（key 即归一化后的 URL）——订阅源以存储域为准，Config 只是种子 */
  listFeeds(): Array<[string, FeedRecord]>
  /**
   * 文件夹目录（显式空目录 + 当前非空成员分组），成员按 config.json 的订阅顺序。
   *
   * 目录的**唯一真相是 config.json 的 `folders` 字段**（与订阅同住一份文件）：
   * 只从 `feed.folder` 派生的话，空文件夹活不过一次重启。旧配置没有该字段时，
   * 读取路径会从现有订阅派生 —— 这条规则在 src/storage/config-file.ts 一处实现。
   */
  listFolders(): FolderView[]
  /** 创建文件夹（只改目录）。名称校验与冲突判断在 src/folders.ts。 */
  createFolder(name: string): Promise<FolderView[]>
  /** 改名：目录与所有成员归属同一次原子写盘；目标是已有名称时拒绝（同名除外）。 */
  renameFolder(from: string, to: string): Promise<FolderView[]>
  /** 删除文件夹：只解除分类，**不退订、不删条目**。返回解除分类的订阅数。 */
  deleteFolder(name: string): Promise<{ folders: FolderView[]; detached: number }>
  /** 移动订阅；`undefined` = 移到未分类（清除 feed.folder）。目标不存在明确失败。 */
  moveFeedToFolder(feedId: string, folder: string | undefined): Promise<FolderView[]>
  /** 标签目录（含 0 篇文章的空标签，按创建时间稳定排序）。 */
  listTags(): TagView[]
  /** 创建标签；名称 trim 后唯一，重复名称抛 TagError('conflict')。 */
  createTag(name: string): Promise<TagRecord>
  /** 改名只改 name；id 与所有文章关联保持不变。 */
  renameTag(id: string, name: string): Promise<TagRecord>
  /** 删除标签：只删标签与关联，文章、阅读状态不动。 */
  deleteTag(id: string): Promise<void>
  /** 某篇文章的标签（用于 06 的列表/正文编辑入口）。 */
  itemTags(itemId: string): TagView[]
  /** 批量读取文章标签 id（列表/搜索页每行一次查询，不能逐条 N+1）。 */
  tagIdsForItems(itemIds: readonly string[]): Record<string, string[]>
  /** 幂等覆盖某篇文章的标签集合；空数组 = 清空。任一 id 不存在则整次失败。 */
  setItemTags(itemId: string, tagIds: readonly string[]): Promise<TagView[]>
  /**
   * 身份合并用：把 keeper 的条目记录与 loser 的标签关联**在同一事务**里落盘，再删除 loser。
   * 分两次写会让「删 loser 的级联」吞掉它身上的标签（M2 05 的硬要求）。
   */
  mergeItems(keeperId: string, loserIds: readonly string[], record: ItemRecord): Promise<void>
  /**
   * 读上次记住的视图偏好（两列布局任务 7）。
   *
   * 返回的**保证是可信形状**（读侧一律过 sanitizeViewPreferences）：媒介里有坏值时诚实回落默认，
   * 而不是把垃圾透给调用方去兜 —— 兜底散在调用方迟早漏一处。
   * 源是否还在订由这里判断（它手上有 feeds 表）：已退订的源回落虚拟视图，不抛错。
   */
  viewPreferences(): ViewPreferences
  /** 写回视图偏好。传进来的值先过一遍形状校验才落库。 */
  saveViewPreferences(preferences: unknown): Promise<ViewPreferences>

  /**
   * 读某条的阅读进度（M5 02）。**内容标识对不上就当没有**：正文变了，旧位置指向的不是同一段文字。
   *
   * 判据放在存储侧而不是调用方：两个实现（SQL 版与内存版）都得给同一个答案，
   * 而「版本相等」这件事只该有**一处**写法。
   */
  readingProgress(itemId: string, contentVersion: string): { ratio: number } | undefined
  /**
   * 记一次阅读进度。ratio 由实现夹到 [0,1]（shared.ts 的 clampReadingRatio）。
   * 条目不存在则拒绝 —— 与 updateItem 同一条纪律：写一次不等于创建。
   */
  saveReadingProgress(itemId: string, contentVersion: string, ratio: number): Promise<void>
  /** 清掉某条的阅读进度（正文缓存淘汰时调；条目整体删除由 deleteItem 一并处理）。幂等。 */
  clearReadingProgress(itemId: string): Promise<void>

  /**
   * 按「归一化链接键」批量取候选行（M5 03 的跨源重复提示）。
   *
   * 键由调用方用 duplicates.ts 的 linkKeyOf 算好；实现只负责按 key 取行，
   * **不自己再归一化一遍**（否则同一个规则会有两份写法）。
   */
  itemsByLinkKeys(keys: readonly string[]): DuplicateRow[]
}

export function createStore(domain: Domain<typeof readerDomain>): ReaderStore {
  const feeds = domain.table('feeds')
  const items = domain.table('items')
  const cursors = domain.table('cursors')
  // global 是单例槽（不是表）：UI 偏好放在这里，域的表集合与 version 都不受影响
  const global = domain.global

  /**
   * 旧适配器的文件夹目录是**内存态**：这个适配器只服务测试里的「旧实现 ↔ 自持实现」同义性基线，
   * 不在装载路径上，也没有 config.json 可写。显式空目录在这里随进程消失 —— 与生产实现的差别
   * 只影响这个测试基线（生产判定严格走 createSqliteStore 的路径，由 tests/folder-storage 钉住）。
   */
  const explicitFolders = new Set<string>()
  const folderFile = (): ReaderConfigFile => ({
    version: 1,
    feeds: Object.fromEntries(feeds.entries()),
    folders: [...explicitFolders],
  })
  const isKnownFolder = (folder: string): boolean => explicitFolders.has(folder)
    || [...feeds.entries()].some(([, record]) => record.folder === folder)
  /** 旧适配器的标签是内存态：只服务 ReaderStore 的结构比对与测试，不参与生产装载。 */
  const tags = new Map<string, TagRecord>()
  const itemTagIds = new Map<string, Set<string>>()
  /** 旧适配器的阅读进度是内存态：只服务 ReaderStore 的结构比对与测试，不参与生产装载。 */
  const progress = new Map<string, { version: string; ratio: number }>()
  const tagViews = (): TagView[] => [...tags.values()]
    .sort((a, b) => a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt))
    .map((tag) => ({
      id: tag.id,
      name: tag.name,
      createdAt: tag.createdAt,
      itemCount: [...itemTagIds.values()].filter((ids) => ids.has(tag.id)).length,
    }))
  const itemTagViews = (itemId: string): TagView[] => {
    const ids = itemTagIds.get(itemId) ?? new Set<string>()
    return tagViews().filter((tag) => ids.has(tag.id)).map(({ itemCount: _count, ...tag }) => tag)
  }

  const applyFolderChange = async (change: (file: ReaderConfigFile) => ReaderConfigFile): Promise<FolderView[]> => {
    const before = Object.fromEntries(feeds.entries())
    const next = change(folderFile())
    explicitFolders.clear()
    for (const name of next.folders ?? []) explicitFolders.add(name)
    for (const [feedId, record] of Object.entries(next.feeds)) {
      if (before[feedId] !== record) await feeds.put(feedId, record)
    }
    return folderViews(next)
  }

  return {
    feed: (feedId) => feeds.get(feedId),
    saveFeed: (feedId, record) => feeds.put(feedId, record),
    updateFeed: async (feedId, intent) => {
      await feeds.update(feedId, (current: FeedRecord | undefined) => {
        // refresh 三种 intent 的前提是源已在（种子先行），缺失即拒（与 updateItem 同一条纪律）；
        // upsert-subscription 例外——update-or-insert 名字即语义，addFeed / opmlImport 的新源创建走它。
        if (current === undefined && intent.kind !== 'upsert-subscription') {
          throw new Error('updateFeed：源不存在（' + feedId + '）—— 变更的前提是它已在，创建走 saveFeed 或 upsert 意图')
        }
        return feedRecordSchema.parse(applyFeedIntent(current, intent))
      })
    },
    cursor: (feedId) => cursors.get(feedId),
    saveCursor: (feedId, record) => cursors.put(feedId, record),
    deleteSubscription: async (feedId) => {
      // 旧适配器同样是一次调用完成：条目 + 游标 + 源记录（Map 上没有事务，但中间不碰其它介质）。
      let removed = 0
      for (const [itemId, record] of items.entries()) {
        if (record.feedId !== feedId) continue
        await items.delete(itemId)
        progress.delete(itemId)
        removed += 1
      }
      await cursors.delete(feedId)
      await feeds.delete(feedId)
      return { items: removed }
    },
    item: (itemId) => items.get(itemId),
    saveItem: (itemId, record) => items.put(itemId, record),
    updateItem: async (itemId, fn) => { await items.update(itemId, fn) },
    deleteItem: async (itemId) => {
      await items.delete(itemId)
      // 进度跟着条目走：条目没了，位置就没有意义（SQL 版靠外键 + 显式删除做同一件事）
      progress.delete(itemId)
    },
    listItems: (feedId) => {
      const found: Array<[string, ItemRecord]> = []
      for (const [key, value] of items.entries()) {
        if (value.feedId === feedId) found.push([key, value])
      }
      return found
    },
    allItems: () => [...items.entries()],
    /**
     * 旧路径：全表筛出带正文的条目，按 src/store.ts 的契约只交出 { id, chars, fetchedAt }。
     *
     * 为什么值得单独实现而不是复用 allItems() 再过滤：闸门每轮都要过一遍全库，
     * 而它只需要这三样 —— 让调用方先拿整表就会把每份正文都搬进 JS 堆（自持实现下
     * 实测堆峰值 1865 MB，spec §9.3 的验收线是 300 MB）。字符数仍走共享的
     * retention.articleCharsOf，所以两处 store 的口径不可能分家。
     */
    listArticleCacheEntries: () => {
      const entries: ArticleEntry[] = []
      for (const [itemId, record] of items.entries()) {
        if (record.article === undefined) continue
        entries.push({
          id: itemId,
          chars: articleCharsOf(record.article),
          fetchedAt: record.article.fetchedAt ?? '',
        })
      }
      return entries
    },
    /**
     * 旧路径**行为不变**（Task 5 的接口扩展）：先按传进来的键铺 0，再把全表里的未读累加上去。
     * 键域判据（`unread[feedId] === undefined` 就跳过）与 shared.ts 的 countUnreadPerFeed
     * 逐字一致 —— 已退订源的残留条目因此不进账。代价是全表遍历，但这条是历史路径
     * （生产早已是 createSqliteStore），不拿性能目标去重写它。
     */
    unreadPerFeed: (feedIds) => countUnreadPerFeed(
      feedIds,
      [...items.entries()].map(([, record]) => record),
    ),
    /**
     * 旧路径同样行为不变：全表按 recency 降序 + id 升序排完取前缀。
     * limit ≤ 0 短路成空列表（`slice(0, -1)` 会返回到倒数第二项，那是静默的错答案）。
     */
    listRecent: (limit, cursor, feedIds, tagId) => {
      if (limit <= 0) return []
      // 空数组 = 空结果：绝不能把「空范围」当成「没有范围」（那会让空文件夹查出全库）。
      const allowed = feedIds === undefined ? undefined : new Set(feedIds)
      if (allowed !== undefined && allowed.size === 0) return []
      const rows = [...items.entries()].filter(([itemId, record]) => {
        if (allowed !== undefined && !allowed.has(record.feedId)) return false
        if (tagId !== undefined && !(itemTagIds.get(itemId)?.has(tagId) ?? false)) return false
        if (cursor === undefined) return true
        // 与自持实现逐字同义：JS 侧只有一份续页谓词（src/item-page.ts 的 afterCursor），
        // SQL 侧是 store-sqlite 的 AFTER_CURSOR —— 两种语言各一处，别在这里再写第三份。
        return afterCursor({ recency: recencyOf(record), id: itemId }, cursor)
      })
      rows.sort(([idA, a], [idB, b]) => {
        const byTime = recencyOf(b).localeCompare(recencyOf(a))
        return byTime !== 0 ? byTime : idA.localeCompare(idB)
      })
      return rows.slice(0, limit)
    },
    /**
     * 旧路径：全表扫一遍，只做**成本过滤**（已读 + 够旧），与自持实现的 SQL 谓词同义。
     *
     * 判据（星标 / 保持未读 / 阈值）**只在端点那一处**执行 —— 此前这里先跑一遍 selectCleanup
     * 再把结果交出去，于是同一条判据被执行两次：端点改了、这里没改，或者反过来，都看不出异常
     * （2026-11-14 评审记的欠账）。候选比判定集宽是**契约要求**，不是缺陷。
     */
    listCleanupCandidates: (cutoffIso) => {
      const rows: CleanupCandidate[] = []
      for (const [itemId, record] of items.entries()) {
        const recency = recencyOf(record)
        if (record.readAt === undefined || recency >= cutoffIso) continue
        rows.push({
          id: itemId,
          starred: record.starred,
          kept: record.keptUnread === true,
          read: true,
          recency,
          articleChars: articleCharsOf(record.article),
          summaryChars: record.summary?.length ?? 0,
        })
      }
      return rows
    },
    listFeeds: () => [...feeds.entries()],
    listFolders: () => folderViews(folderFile()),
    createFolder: async (name) => applyFolderChange((file) => addFolder(file, name)),
    renameFolder: async (from, to) => applyFolderChange((file) => renameFolder(file, from, to)),
    deleteFolder: async (name) => {
      let detached = 0
      const folders = await applyFolderChange((file) => {
        const result = deleteFolder(file, name)
        detached = result.detached
        return result.file
      })
      return { folders, detached }
    },
    moveFeedToFolder: async (feedId, folder) => applyFolderChange((file) => moveFeedToFolder(file, feedId, folder).file),
    listTags: () => tagViews(),
    createTag: async (name) => {
      const safe = normalizeTagName(name)
      if ([...tags.values()].some((tag) => tag.name === safe)) throw new TagError('conflict', '标签已存在：' + safe)
      const tag = { id: randomUUID(), name: safe, createdAt: new Date().toISOString() }
      tags.set(tag.id, tag)
      return tagRecordSchema.parse(tag)
    },
    renameTag: async (id, name) => {
      const tagId = requireTagId(id)
      const current = tags.get(tagId)
      if (current === undefined) throw new TagError('not-found', '标签不存在：' + tagId)
      const safe = normalizeTagName(name)
      if ([...tags.values()].some((tag) => tag.id !== tagId && tag.name === safe)) {
        throw new TagError('conflict', '标签已存在：' + safe)
      }
      const next = { ...current, name: safe }
      tags.set(tagId, next)
      return tagRecordSchema.parse(next)
    },
    deleteTag: async (id) => {
      const tagId = requireTagId(id)
      if (!tags.delete(tagId)) throw new TagError('not-found', '标签不存在：' + tagId)
      for (const ids of itemTagIds.values()) ids.delete(tagId)
    },
    itemTags: (itemId) => {
      if (items.get(itemId) === undefined) throw new TagError('not-found', '文章不存在：' + itemId)
      return itemTagViews(itemId)
    },
    tagIdsForItems: (itemIds) => {
      const result: Record<string, string[]> = {}
      for (const itemId of itemIds) result[itemId] = [...(itemTagIds.get(itemId) ?? [])]
      return result
    },
    setItemTags: async (itemId, tagIds) => {
      if (items.get(itemId) === undefined) throw new TagError('not-found', '文章不存在：' + itemId)
      const ids = normalizeTagIds(tagIds)
      for (const id of ids) if (!tags.has(id)) throw new TagError('not-found', '标签不存在：' + id)
      itemTagIds.set(itemId, new Set(ids))
      return itemTagViews(itemId)
    },
    mergeItems: async (keeperId, loserIds, record) => {
      await items.put(keeperId, record)
      const keeperTags = new Set(itemTagIds.get(keeperId) ?? [])
      for (const loserId of loserIds) {
        for (const tagId of itemTagIds.get(loserId) ?? []) keeperTags.add(tagId)
        itemTagIds.delete(loserId)
        await items.delete(loserId)
      }
      itemTagIds.set(keeperId, keeperTags)
    },
    /**
     * 旧路径：全表扫一遍。它只服务测试里的同义性基线（生产是 createSqliteStore 的 IN 查询），
     * **不要**在装载路径上用它 —— 票据禁止的「每次渲染扫全库」正是这个形状。
     */
    itemsByLinkKeys: (keys) => {
      const wanted = new Set(keys.filter((key) => key !== ''))
      if (wanted.size === 0) return []
      const rows: DuplicateRow[] = []
      for (const [id, record] of items.entries()) {
        if (!wanted.has(linkKeyOf(record.link))) continue
        rows.push({
          id, feedId: record.feedId, title: record.title, link: record.link,
          ...(record.readAt === undefined ? {} : { readAt: record.readAt }),
        })
      }
      return rows
    },
    readingProgress: (itemId, contentVersion) => {
      const row = progress.get(itemId)
      if (row === undefined || row.version !== contentVersion) return undefined
      return { ratio: row.ratio }
    },
    saveReadingProgress: async (itemId, contentVersion, ratio) => {
      if (items.get(itemId) === undefined) {
        throw new Error('saveReadingProgress 拒绝：条目 ' + itemId + ' 不在库里（写一次不等于创建）')
      }
      progress.set(itemId, { version: contentVersion, ratio: clampReadingRatio(ratio) })
    },
    clearReadingProgress: async (itemId) => { progress.delete(itemId) },
    viewPreferences: () => sanitizeViewPreferences(
      global.get(),
      (feedId) => feeds.get(feedId) !== undefined,
      isKnownFolder,
      (tagId) => tags.get(tagId) !== undefined,
    ),
    saveViewPreferences: async (preferences) => {
      // 写侧也过一遍校验：先把认不出的形状归一，再落库。否则坏值会被原样写进媒介，
      // 之后每次打开都要靠读侧再兜一次 —— 存储里攒着垃圾，只是被读侧遮住了。
      const safe = sanitizeViewPreferences(
        preferences,
        (feedId) => feeds.get(feedId) !== undefined,
        isKnownFolder,
        (tagId) => tags.get(tagId) !== undefined,
      )
      await global.set(safe)
      return safe
    },
  }
}
