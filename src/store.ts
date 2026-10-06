/**
 * 存储适配器：把 refresh 编排与真实的 ctx.storageDomain 隔开。
 *
 * 编排只依赖 ReaderStore 这个窄接口，测试里用内存实现即可覆盖
 * 去重、保留量裁剪与已读态保持，不必先起宿主。
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { readerDomain, type CursorRecord, type FeedRecord, type ItemRecord } from './domain.js'

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
  deleteItem(itemId: string): Promise<void>
  listItems(feedId: string): Array<[string, ItemRecord]>
  /** 全部条目（显式清理要跨源统计已读旧条目） */
  allItems(): Array<[string, ItemRecord]>
  /** 全部订阅源（key 即归一化后的 URL）——订阅源以存储域为准，Config 只是种子 */
  listFeeds(): Array<[string, FeedRecord]>
}

export function createStore(domain: Domain<typeof readerDomain>): ReaderStore {
  const feeds = domain.table('feeds')
  const items = domain.table('items')
  const cursors = domain.table('cursors')

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
  }
}
