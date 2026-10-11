/**
 * 存储适配器：把 refresh 编排与真实的 ctx.storageDomain 隔开。
 *
 * 编排只依赖 ReaderStore 这个窄接口，测试里用内存实现即可覆盖
 * 去重、保留量裁剪与已读态保持，不必先起宿主。
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { readerDomain, type CursorRecord, type FeedRecord, type ItemRecord } from './domain.js'
import { articleCharsOf, selectCleanup, type CleanupRow } from './retention.js'
import { countUnreadPerFeed, recencyOf, sanitizeViewPreferences, type Cursor, type ViewPreferences } from './shared.js'

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

export interface ReaderStore {
  feed(feedId: string): FeedRecord | undefined
  saveFeed(feedId: string, record: FeedRecord): Promise<void>
  cursor(feedId: string): CursorRecord | undefined
  saveCursor(feedId: string, record: CursorRecord): Promise<void>
  /** 退订：删源记录与它的游标（条目由调用方一并删，避免留下孤儿） */
  deleteFeed(feedId: string): Promise<void>
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
   */
  allItems(): Array<[string, ItemRecord]>
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
   * 跨源最近的 limit 条（`recency` 降序 + id 升序 —— 与 allItems 同一套排序键，见 shared.ts 的
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
   */
  listRecent(limit: number, cursor?: Cursor): Array<[string, ItemRecord]>
  /**
   * 显式清理的候选行（Task 5；原先由调用方 allItems() 全表物化后再筛）。
   *
   * 判据的定义处是 `retention.ts` 的 `selectCleanup`（已读 + 未星标 + 早于阈值）。本方法的契约是
   * **它的第二实现**（自持实现里是一条 SQL，见 `store-sqlite.ts` 的 `SELECT_CLEANUP_IDS`），
   * 四项都要在存储侧重述 —— 前三项照抄判据，**第四项比判据更窄**：
   *   · `readAt !== undefined`（已读）
   *   · `starred === false`（未星标）
   *   · `recencyOf(record) < cutoffIso`（早于阈值）
   *   · `keptUnread !== true`（**不被**「保持未读」保护）—— 用户对 kept-unread 说的是「别动它」，
   *     与星标同级；`selectCleanup` 是纯判据、不含这条，所以它只写在候选的契约里。
   * 于是调用方的最终删除集 = **候选集 ∩ `selectCleanup`(候选)**（`endpoints.ts` 的 `cleanup` 就是
   * 这么做的）。两份实现必须同步改，一致性由 `tests/store-sqlite.test.mjs` 的对账用例钉住
   * （「候选集必须与 selectCleanup 的集合逐字相等（除 kept 之外）」）。
   */
  listCleanupCandidates(cutoffIso: string): CleanupCandidate[]
  /** 全部订阅源（key 即归一化后的 URL）——订阅源以存储域为准，Config 只是种子 */
  listFeeds(): Array<[string, FeedRecord]>
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
}

export function createStore(domain: Domain<typeof readerDomain>): ReaderStore {
  const feeds = domain.table('feeds')
  const items = domain.table('items')
  const cursors = domain.table('cursors')
  // global 是单例槽（不是表）：UI 偏好放在这里，域的表集合与 version 都不受影响
  const global = domain.global

  return {
    feed: (feedId) => feeds.get(feedId),
    saveFeed: (feedId, record) => feeds.put(feedId, record),
    cursor: (feedId) => cursors.get(feedId),
    saveCursor: (feedId, record) => cursors.put(feedId, record),
    deleteFeed: async (feedId) => {
      await cursors.delete(feedId)
      await feeds.delete(feedId)
    },
    item: (itemId) => items.get(itemId),
    saveItem: (itemId, record) => items.put(itemId, record),
    updateItem: async (itemId, fn) => { await items.update(itemId, fn) },
    deleteItem: async (itemId) => {
      await items.delete(itemId)
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
    listRecent: (limit, cursor) => {
      if (limit <= 0) return []
      const rows = [...items.entries()].filter(([itemId, record]) => {
        if (cursor === undefined) return true
        const recency = recencyOf(record)
        // 与自持实现的谓词逐字同义（recency 降序、同 recency 内 id 升序的「之后」）
        return recency < cursor.recency || (recency === cursor.recency && itemId > cursor.id)
      })
      rows.sort(([idA, a], [idB, b]) => {
        const byTime = recencyOf(b).localeCompare(recencyOf(a))
        return byTime !== 0 ? byTime : idA.localeCompare(idB)
      })
      return rows.slice(0, limit)
    },
    /** 旧路径：全表筛一遍（判据通过 retention.ts 的 selectCleanup 复跑，与端点侧同口径）。 */
    listCleanupCandidates: (cutoffIso) => {
      const rows: CleanupCandidate[] = []
      for (const [itemId, record] of items.entries()) {
        const row: CleanupCandidate = {
          id: itemId,
          starred: record.starred,
          kept: record.keptUnread === true,
          read: record.readAt !== undefined,
          recency: recencyOf(record),
          articleChars: articleCharsOf(record.article),
          summaryChars: record.summary?.length ?? 0,
        }
        rows.push(row)
      }
      const doomed = new Set(selectCleanup(
        rows.filter((row) => !row.kept),
        cutoffIso,
      ))
      return rows.filter((row) => doomed.has(row.id))
    },
    listFeeds: () => [...feeds.entries()],
    viewPreferences: () => sanitizeViewPreferences(global.get(), (feedId) => feeds.get(feedId) !== undefined),
    saveViewPreferences: async (preferences) => {
      // 写侧也过一遍校验：先把认不出的形状归一，再落库。否则坏值会被原样写进媒介，
      // 之后每次打开都要靠读侧再兜一次 —— 存储里攒着垃圾，只是被读侧遮住了。
      const safe = sanitizeViewPreferences(preferences, (feedId) => feeds.get(feedId) !== undefined)
      await global.set(safe)
      return safe
    },
  }
}
