/**
 * 存储适配器：把 refresh 编排与真实的 ctx.storageDomain 隔开。
 *
 * 编排只依赖 ReaderStore 这个窄接口，测试里用内存实现即可覆盖
 * 去重、保留量裁剪与已读态保持，不必先起宿主。
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { readerDomain, type CursorRecord, type FeedRecord, type ItemRecord } from './domain.js'
import { sanitizeViewPreferences, type ViewPreferences } from './shared.js'

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
  /** 全部条目（显式清理要跨源统计已读旧条目） */
  allItems(): Array<[string, ItemRecord]>
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
