/**
 * 刷新编排：逐源抓取 → 解析 → 去重 → 入库 → 更新游标与源状态。
 *
 * 三条不变式：
 *   ① 单源失败就地降级，其余源照常出（交接件 §4.2）；
 *   ② 去重键是条目稳定 id（feed/item-id.ts），与已读态绑在同一个键上；
 *   ③ 去重窗口（maxSeenPerFeed）与条目保留量（maxItemsPerFeed）是两件事，
 *      前者必须远大于后者，否则老条目会借「滚出去重窗口」重新变成未读。
 */
import { deriveItemId } from './feed/item-id.js'
import { fetchFeed, type FetchLimits } from './feed/fetch.js'
import { parseFeed } from './feed/parse.js'
import type { ReaderStore } from './store.js'

export interface RefreshOptions {
  limits: FetchLimits
  /** 每源保留的条目数（入 items 表） */
  maxItemsPerFeed: number
  /** 每源去重窗口大小（只存 id） */
  maxSeenPerFeed: number
  now?: () => Date
  fetchFeedImpl?: typeof fetchFeed
}

export type FeedStatus = 'added' | 'not-modified' | 'failed'

export interface FeedOutcome {
  feedId: string
  url: string
  status: FeedStatus
  /** 本次新增条目数 */
  added: number
  reason?: string
}

/** 源标识即归一化后的 URL：稳定、可读、便于在存储里直接排查。 */
export function normalizeFeedUrl(url: string): string {
  return new URL(url.trim()).toString()
}

/** 条目排序用的时间：优先发布时间，缺则退到抓取时间。 */
function recencyOf(record: { publishedAt?: string; fetchedAt: string }): string {
  return record.publishedAt ?? record.fetchedAt
}

async function prune(store: ReaderStore, feedId: string, maxItems: number): Promise<void> {
  const all = store.listItems(feedId)
  if (all.length <= maxItems) return
  const oldestFirst = [...all].sort((a, b) => {
    const byTime = recencyOf(a[1]).localeCompare(recencyOf(b[1]))
    return byTime !== 0 ? byTime : a[0].localeCompare(b[0])
  })
  const dropCount = all.length - maxItems
  for (const [itemId] of oldestFirst.slice(0, dropCount)) {
    await store.deleteItem(itemId)
  }
}

export async function refreshFeeds(
  urls: readonly string[],
  store: ReaderStore,
  options: RefreshOptions,
  signal?: AbortSignal,
): Promise<FeedOutcome[]> {
  const now = options.now ?? (() => new Date())
  const doFetch = options.fetchFeedImpl ?? fetchFeed
  const outcomes: FeedOutcome[] = []

  for (const rawUrl of urls) {
    let feedId: string
    try {
      feedId = normalizeFeedUrl(rawUrl)
    } catch {
      outcomes.push({ feedId: rawUrl, url: rawUrl, status: 'failed', added: 0, reason: '不是合法 URL' })
      continue
    }

    const previous = store.feed(feedId)
    const result = await doFetch(
      feedId,
      { etag: previous?.etag, lastModified: previous?.lastModified },
      options.limits,
      signal,
    )
    const stamp = now().toISOString()

    if (result.kind === 'failed') {
      await store.saveFeed(feedId, {
        ...(previous ?? {}),
        url: feedId,
        lastFailure: result.reason,
      })
      outcomes.push({ feedId, url: feedId, status: 'failed', added: 0, reason: result.reason })
      continue
    }

    if (result.kind === 'not-modified') {
      await store.saveFeed(feedId, {
        ...(previous ?? {}),
        url: feedId,
        lastFetchedAt: stamp,
      })
      outcomes.push({ feedId, url: feedId, status: 'not-modified', added: 0 })
      continue
    }

    const parsed = parseFeed(result.body, feedId)
    const cursor = store.cursor(feedId)
    const seen = cursor?.seen ?? []
    const seenSet = new Set(seen)
    const freshIds: string[] = []

    for (const item of parsed.items) {
      const itemId = deriveItemId(feedId, item)
      if (seenSet.has(itemId)) continue
      seenSet.add(itemId)
      freshIds.push(itemId)
      await store.saveItem(itemId, {
        feedId,
        title: item.title,
        link: item.link,
        publishedAt: item.publishedAt,
        summary: item.summary,
        fetchedAt: stamp,
        starred: false,
      })
    }

    await store.saveCursor(feedId, {
      seen: [...freshIds, ...seen].slice(0, options.maxSeenPerFeed),
      cursorAt: stamp,
    })
    await store.saveFeed(feedId, {
      url: feedId,
      title: parsed.title ?? previous?.title,
      folder: previous?.folder,
      etag: result.etag,
      lastModified: result.lastModified,
      lastFetchedAt: stamp,
    })
    await prune(store, feedId, options.maxItemsPerFeed)

    outcomes.push({ feedId, url: feedId, status: 'added', added: freshIds.length })
  }

  return outcomes
}
