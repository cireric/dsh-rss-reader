/**
 * 内存版 ReaderStore（票据 02：从 tests/ 升格为 src/ 的第一等实现）。
 *
 * 为什么要升格：它此前是 tests/helpers 里的一份 .mjs —— 不经 tsc，接口加一个方法它也不会红；
 * 只实现 23/36，比生产更宽松（listRecent 忽略游标与范围、updateItem 不拒绝缺失键、
 * 清理候选把 starred/kept 按谓词回填）。于是「用替身测出来的绿」并不等于「生产也会绿」。
 * 现在它由 tsc 盯着（少一个方法就编译失败），并被 tests/helpers/reader-store-contract.mjs
 * 的同一套契约约束（与 sqlite / legacy 一起跑）。
 *
 * 它允许在**性能**上偷懒（全表遍历、数组过滤），但不许在**语义**上放宽 —— 这是替身与实现的
 * 唯一区别。文件的 Map（feeds / cursors / items）刻意保持裸露：既有用例大量直接断言或注入它们。
 */
import type { ReaderStore } from './store.js'
import type { CursorRecord, FeedRecord, ItemRecord, TagRecord } from './domain.js'
import type { ReaderConfigFile } from './storage/config-file.js'
import { applyFeedIntent } from './feed-intent.js'
import { addFolder, deleteFolder, folderViews, moveFeedToFolder, renameFolder } from './folders.js'
import { deriveFeedOrder, orderedFeedEntries, reorderFeedOrder } from './feed-order.js'
import { normalizeTagIds, normalizeTagName, requireTagId, TagError } from './tags.js'
import { type TagView } from './shared.js'
import { DEFAULT_VIEW_PREFERENCES, sanitizeViewPreferences } from './preferences.js'
import type { ViewPreferences } from './preferences.js'
import { recencyOf } from './cursor.js'
import { linkKeyOf } from './duplicates.js'
import { afterCursor } from './item-page.js'

export interface MemoryStore extends ReaderStore {
  /** 裸露的 Map：用例直接断言 / 注入并发写（见 tests/helpers/reader-store-memory.mjs）。 */
  readonly feeds: Map<string, FeedRecord>
  readonly cursors: Map<string, CursorRecord>
  readonly items: Map<string, ItemRecord>
  readonly tags: Map<string, TagRecord>
  /**
   * 测试用：**绕过归一**直接写视图偏好，造「存储里本来就有坏值」这一形态。
   * 正常路径写不进坏值（saveViewPreferences 会归一），所以坏值只能这样注入 —— 与 sqlite 侧
   * 直接在 config.json 里塞垃圾是同一件事。
   */
  putRawPreferences(value: unknown): void
  /** 测试用：读**未经归一**的媒介值 —— 用来断言「落进媒介的确实是归一后的那份」。 */
  getRawPreferences(): unknown
}

export interface MemoryStoreOptions {
  /**
   * 与两个生产实现同一守卫：refresh 三种意图在源不存在时抛错（创建只走 upsert 意图）。
   *
   * 默认关，是为了不重写 50 处既有 refresh 夹具（它们测的是刷新编排，不是 updateFeed 的存在性）；
   * **要判生产行为的新用例**必须开 —— 宽容桩会把生产上的抛错变成「悄悄创建」，那是假绿。
   */
  readonly strictFeedUpdates?: boolean
  /**
   * 正文写入的模拟延迟（毫秒）。只给并发用例用：正文那一次写慢一点，才来得及在窗口里插进别的写。
   * 0 = 不延迟（默认）。它模拟的是**传输耗时**，不是行为差异 —— 语义不许随它变。
   */
  readonly articleWriteDelayMs?: number
}

export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const strictFeedUpdates = options.strictFeedUpdates === true
  const articleWriteDelayMs = options.articleWriteDelayMs ?? 0
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const isArticleWrite = (record: ItemRecord): boolean => record.article !== undefined || record.articleFailure !== undefined
  const feeds = new Map<string, FeedRecord>()
  const cursors = new Map<string, CursorRecord>()
  const items = new Map<string, ItemRecord>()
  const progress = new Map<string, { version: string; ratio: number }>()
  const tags = new Map<string, TagRecord>()
  /** itemId → tagId[]（关联的唯一存放处：改名只动 tags 里的 name，关联不动）。 */
  const itemTagIds = new Map<string, string[]>()
  /** 显式目录（含空目录）：**不能**只从 feed.folder 派生，否则空文件夹活不过一次「重启」。 */
  let folderNames: string[] = []
  /** 显式顺序：`undefined` = 从没排过（与生产 config.json 缺这个键同形）。 */
  let feedOrder: string[] | undefined
  let preferences: ViewPreferences = DEFAULT_VIEW_PREFERENCES
  let tagSeq = 0

  /** 把文件夹纯函数要的 config 形状现造出来（规则只在 src/folders.ts 一处，这里不重写）。 */
  const configFile = (): ReaderConfigFile => ({
    version: 1,
    feeds: Object.fromEntries(feeds),
    folders: [...folderNames],
    ...(feedOrder === undefined ? {} : { feedOrder: [...feedOrder] }),
  })

  /** 把纯函数返回的新 config 写回 Map —— 成员归属与目录同一次落盘（与生产同语义）。 */
  const writeConfigFile = (file: ReaderConfigFile): void => {
    folderNames = [...(file.folders ?? [])]
    feedOrder = file.feedOrder === undefined ? undefined : [...file.feedOrder]
    for (const [feedId, record] of Object.entries(file.feeds)) feeds.set(feedId, record)
  }

  const tagViewOf = (tag: TagRecord): TagView => ({
    id: tag.id,
    name: tag.name,
    createdAt: tag.createdAt,
    itemCount: [...itemTagIds.values()].filter((ids) => ids.includes(tag.id)).length,
  })

  const knownTagIds = (): Set<string> => new Set(tags.keys())

  const store: MemoryStore = {
    feeds,
    cursors,
    items,
    tags,

    feed: (feedId) => feeds.get(feedId),
    saveFeed: async (feedId, record) => { feeds.set(feedId, record) },
    updateFeed: async (feedId, intent) => {
      const current = feeds.get(feedId)
      if (strictFeedUpdates && current === undefined && intent.kind !== 'upsert-subscription') {
        throw new Error('updateFeed：源不存在（' + feedId + '）—— 变更的前提是它已在，创建走 saveFeed 或 upsert 意图')
      }
      feeds.set(feedId, applyFeedIntent(current, intent))
    },
    cursor: (feedId) => cursors.get(feedId),
    saveCursor: async (feedId, record) => { cursors.set(feedId, record) },
    deleteSubscription: async (feedId) => {
      let removed = 0
      for (const [itemId, record] of items.entries()) {
        if (record.feedId !== feedId) continue
        items.delete(itemId)
        progress.delete(itemId)
        itemTagIds.delete(itemId)
        removed += 1
      }
      cursors.delete(feedId)
      feeds.delete(feedId)
      return { items: removed }
    },

    item: (itemId) => items.get(itemId),
    saveItem: async (itemId, record) => {
      if (articleWriteDelayMs > 0 && isArticleWrite(record)) await sleep(articleWriteDelayMs)
      items.set(itemId, record)
    },
    updateItem: async (itemId, fn) => {
      if (articleWriteDelayMs > 0) await sleep(articleWriteDelayMs)
      const current = items.get(itemId)
      // 与生产同一条纪律：写一次不等于创建（缺失键按存储域语义拒绝）。
      if (current === undefined) throw new Error('updateItem：条目不存在（' + itemId + '）')
      items.set(itemId, fn(current))
    },
    deleteItem: async (itemId) => { items.delete(itemId); progress.delete(itemId); itemTagIds.delete(itemId) },
    listItems: (feedId) => [...items.entries()].filter(([, record]) => record.feedId === feedId),
    allItems: () => [...items.entries()],

    /**
     * 清算原料：**只交出 id / 字符数 / 抓取时间**，正文不跟着出来。
     * 桩也必须守这条 —— 否则测的其实是「桩自己把正文摊开了」，而生产单列这条正是为了不让正文进堆。
     */
    listArticleCacheEntries: () => {
      const entries = []
      for (const [itemId, record] of items.entries()) {
        if (record.article === undefined) continue
        const chars = (record.article.paragraphs ?? []).reduce((sum, paragraph) => sum + paragraph.length, 0)
          + (record.article.blocks ?? []).reduce((sum, block) => {
            const text = block['text']
            if (typeof text === 'string') return sum + text.length
            const listItems = block['items']
            if (Array.isArray(listItems)) return sum + listItems.reduce<number>((inner, entry) => inner + String(entry).length, 0)
            return sum
          }, 0)
        entries.push({ id: itemId, chars, fetchedAt: record.article.fetchedAt })
      }
      return entries
    },

    unreadPerFeed: (feedIds) => {
      const unread: Record<string, number> = {}
      for (const feedId of feedIds) unread[feedId] = 0
      for (const record of items.values()) {
        if (unread[record.feedId] === undefined || record.readAt !== undefined) continue
        unread[record.feedId] += 1
      }
      return unread
    },

    listRecent: (limit, cursor, feedIds, tagId) => {
      if (limit <= 0) return []
      // 传空数组 = 空结果（绝不回落成「无范围」）；undefined 才是「无范围」。
      if (feedIds !== undefined && feedIds.length === 0) return []
      const scope = feedIds === undefined ? undefined : new Set(feedIds)
      const rows = [...items.entries()].filter(([itemId, record]) => {
        if (scope !== undefined && !scope.has(record.feedId)) return false
        if (tagId !== undefined && !(itemTagIds.get(itemId) ?? []).includes(tagId)) return false
        return true
      })
      rows.sort(([idA, a], [idB, b]) => {
        const byTime = recencyOf(b).localeCompare(recencyOf(a))
        return byTime !== 0 ? byTime : idA.localeCompare(idB)
      })
      // 续页谓词与另两份实现同源：JS 侧共用 src/item-page.ts 的 afterCursor（ADR-0004）。
      const after = cursor === undefined
        ? rows
        : rows.filter(([id, record]) => afterCursor({ recency: recencyOf(record), id }, cursor))
      return after.slice(0, limit)
    },

    listCleanupCandidates: (cutoffIso) => {
      const rows = []
      for (const [id, record] of items.entries()) {
        const recency = record.publishedAt ?? record.fetchedAt
        // 与自持实现同一条成本条件：只捞「已读 + 够旧」。星标/保持未读一律**如实报真值**，
        // 交给 retention.ts 的 selectCleanup 裁决 —— 回填会让判据看不见真实状态。
        if (record.readAt === undefined || recency >= cutoffIso) continue
        rows.push({
          id,
          read: true,
          starred: record.starred === true,
          kept: record.keptUnread === true,
          recency,
          articleChars: 0,
          summaryChars: record.summary?.length ?? 0,
        })
      }
      return rows
    },

    /**
     * 顺序与生产同一条派生（src/feed-order.ts）：`configFile()` 现造的 config 形状里没有
     * `feedOrder`，派生结果就是 `feeds` 的键序；替身不许自写一遍排序规则。
     */
    listFeeds: () => {
      const file = configFile()
      return orderedFeedEntries(file.feedOrder, file.feeds)
    },
    /** 与生产同一条规则：归一在 src/feed-order.ts，这里只负责把结果写进自己的 config 形状。 */
    reorderFeeds: async (ids) => {
      const current = configFile()
      const next = reorderFeedOrder(current.feedOrder, current.feeds, ids)
      if (next !== undefined) writeConfigFile({ ...current, feedOrder: next })
      const file = configFile()
      return deriveFeedOrder(file.feedOrder, file.feeds)
    },
    listFolders: () => folderViews(configFile()),
    createFolder: async (name) => {
      writeConfigFile(addFolder(configFile(), name))
      return folderViews(configFile())
    },
    renameFolder: async (from, to) => {
      writeConfigFile(renameFolder(configFile(), from, to))
      return folderViews(configFile())
    },
    deleteFolder: async (name) => {
      const result = deleteFolder(configFile(), name)
      writeConfigFile(result.file)
      return { folders: folderViews(configFile()), detached: result.detached }
    },
    moveFeedToFolder: async (feedId, folder) => {
      writeConfigFile(moveFeedToFolder(configFile(), feedId, folder).file)
      return folderViews(configFile())
    },

    listTags: () => [...tags.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(tagViewOf),
    createTag: async (name) => {
      const normalized = normalizeTagName(name)
      for (const tag of tags.values()) {
        if (tag.name === normalized) throw new TagError('conflict', '标签已存在：' + normalized)
      }
      tagSeq += 1
      const tag: TagRecord = { id: 'tag-' + tagSeq, name: normalized, createdAt: new Date().toISOString() }
      tags.set(tag.id, tag)
      return tag
    },
    renameTag: async (id, name) => {
      const tagId = requireTagId(id)
      const tag = tags.get(tagId)
      if (tag === undefined) throw new TagError('not-found', '标签不存在：' + tagId)
      const normalized = normalizeTagName(name)
      for (const other of tags.values()) {
        if (other.id !== tagId && other.name === normalized) throw new TagError('conflict', '标签已存在：' + normalized)
      }
      const next: TagRecord = { ...tag, name: normalized }
      tags.set(tagId, next)
      return next
    },
    deleteTag: async (id) => {
      const tagId = requireTagId(id)
      tags.delete(tagId)
      for (const [itemId, ids] of itemTagIds.entries()) {
        itemTagIds.set(itemId, ids.filter((entry) => entry !== tagId))
      }
    },
    itemTags: (itemId) => (itemTagIds.get(itemId) ?? [])
      .map((id) => tags.get(id))
      .filter((tag): tag is TagRecord => tag !== undefined)
      .map(tagViewOf),
    tagIdsForItems: (itemIds) => Object.fromEntries(itemIds.map((id) => [id, [...(itemTagIds.get(id) ?? [])]])),
    setItemTags: async (itemId, tagIds) => {
      const ids = normalizeTagIds(tagIds)
      const known = knownTagIds()
      for (const id of ids) {
        if (!known.has(id)) throw new TagError('not-found', '标签不存在：' + id)
      }
      itemTagIds.set(itemId, ids)
      return ids.map((id) => tags.get(id)).filter((tag): tag is TagRecord => tag !== undefined).map(tagViewOf)
    },
    mergeItems: async (keeperId, loserIds, record) => {
      const merged = new Set<string>(itemTagIds.get(keeperId) ?? [])
      for (const loserId of loserIds) {
        for (const tagId of itemTagIds.get(loserId) ?? []) merged.add(tagId)
        items.delete(loserId)
        progress.delete(loserId)
        itemTagIds.delete(loserId)
      }
      items.set(keeperId, record)
      if (merged.size > 0) itemTagIds.set(keeperId, [...merged])
    },

    putRawPreferences: (value) => { preferences = value as ViewPreferences },
    getRawPreferences: () => preferences,
    viewPreferences: () => sanitizeViewPreferences(
      preferences,
      (feedId) => feeds.has(feedId),
      (folder) => folderViews(configFile()).some((view) => view.name === folder),
      (tagId) => tags.has(tagId),
    ),
    saveViewPreferences: async (next) => {
      preferences = sanitizeViewPreferences(
        next,
        (feedId) => feeds.has(feedId),
        (folder) => folderViews(configFile()).some((view) => view.name === folder),
        (tagId) => tags.has(tagId),
      )
      return preferences
    },

    readingProgress: (itemId, contentVersion) => {
      const row = progress.get(itemId)
      return row === undefined || row.version !== contentVersion ? undefined : { ratio: row.ratio }
    },
    saveReadingProgress: async (itemId, contentVersion, ratio) => {
      if (!items.has(itemId)) throw new Error('saveReadingProgress 拒绝：条目 ' + itemId + ' 不在库里（写一次不等于创建）')
      progress.set(itemId, { version: contentVersion, ratio: Math.max(0, Math.min(1, ratio)) })
    },
    clearReadingProgress: async (itemId) => { progress.delete(itemId) },

    itemsByLinkKeys: (keys) => {
      const wanted = new Set(keys.filter((key) => key !== ''))
      if (wanted.size === 0) return []
      const rows = []
      for (const [id, record] of items.entries()) {
        if (!wanted.has(linkKeyOf(record.link))) continue
        rows.push({ id, feedId: record.feedId, title: record.title, link: record.link, readAt: record.readAt })
      }
      return rows
    },
  }

  return store
}
