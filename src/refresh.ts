/**
 * 刷新编排：逐源抓取 → 解析 → 去重 → 入库 → 更新游标与源状态。
 *
 * 三条不变式：
 *   ① 单源失败就地降级，其余源照常出（交接件 §4.2）；
 *   ② 去重键是条目稳定 id（feed/item-id.ts），与已读态绑在同一个键上；
 *   ③ 去重窗口（maxSeenPerFeed）与条目保留量（maxItemsPerFeed）是两件事，
 *      前者必须远大于后者，否则老条目会借「滚出去重窗口」重新变成未读。
 */
import { mapConcurrent } from './concurrency.js'
import { rebuildItem } from './domain.js'
import { deriveItemId } from './feed/item-id.js'
import { fetchFeed, type FetchLimits } from './feed/fetch.js'
import { articleCharsOf, selectPrunable, selectArticleEvictions, type RetentionRow } from './retention.js'
import { parseFeed } from './feed/parse.js'
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
  /** 每个源的按需正文缓存总量上限（字符）；超限从最旧的缓存开始清，见 capArticleCache */
  maxArticleCacheChars: number
  /**
   * 同时在飞的抓取数上限。逐源串行是 N x RTT 的线性等待（实测每源 100ms 时 10 源 1056ms、
   * 20 源 2089ms），而验收标准要求导入 ≥20 个源；最坏情况一个卡住的源会按 timeoutMs 拖住
   * 它后面的所有源（20 x 15s = 300s）。与 subscribe.ts 的并发校验同一套模式。
   */
  refreshConcurrency: number
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
  const rows: RetentionRow[] = store.listItems(feedId).map(([itemId, record]) => ({
    id: itemId,
    starred: record.starred,
    read: record.readAt !== undefined,
    recency: recencyOf(record),
  }))
  for (const itemId of selectPrunable(rows, maxItems)) {
    await store.deleteItem(itemId)
  }
}

/**
 * 按需正文缓存的总量闸门：超限时**从最旧的开始清缓存**（只清 `article`，条目本身保留）。
 *
 * 清掉后用户再打开该条会重新抓一次——是「降级」而非「丢失」，所以不需要逐条确认。
 * 上限按**源**统计：缓存是挂在条目上的，而条目按源裁剪，故同源的缓存自然同源清算。
 *
 * 字符数一律走 retention.articleCharsOf。2026-10-07 修：这里原先只统计 paragraphs，
 * 而现行缓存只写 blocks ⇒ 每源字符数恒为 0，闸门永不触发、上限形同虚设。
 */
async function capArticleCache(store: ReaderStore, feedId: string, maxChars: number): Promise<number> {
  const entries = store.listItems(feedId)
    .filter(([, record]) => record.article !== undefined)
    .map(([itemId, record]) => ({
      id: itemId,
      chars: articleCharsOf(record.article),
      fetchedAt: record.article?.fetchedAt ?? '',
    }))
  const evicted = selectArticleEvictions(entries, maxChars)
  for (const itemId of evicted) {
    const record = store.item(itemId)
    if (record === undefined) continue
    // 清掉 article，其余字段（含 readAt/starred）原样保留——交给 rebuildItem 按 schema 搬运
    await store.saveItem(itemId, rebuildItem(record, { omit: ['article', 'articleFailure'] }))
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
  const doFetch = options.fetchFeedImpl ?? fetchFeed
  /**
   * 有界并发 + 保序（见 concurrency.ts；与 subscribe.ts 共用同一个实现）。
   *
   * 为什么可以并发落库：存储域的每次写入都排在它的**单条 write chain** 上
   * （storage-domain/src/domain.ts：「every write queues on the chain」），而每次调度的
   * feedId 都不同（调用方传的是 listFeeds() 的键，天然唯一），所以写之间没有共享状态。
   */
  return mapConcurrent(urls, options.refreshConcurrency, (rawUrl) =>
    refreshOne(rawUrl, store, options, now, doFetch, signal))
}

/** 抓取并落库单个源；结果由调用方按输入下标放回数组。 */
async function refreshOne(
  rawUrl: string,
  store: ReaderStore,
  options: RefreshOptions,
  now: () => Date,
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
  // 内容版本落后 ⇒ 这一轮不带条件请求，强制拿 200 以便回填正文
  const needsContentUpgrade = (previous?.contentRevision ?? 1) < CONTENT_REVISION
  const result = await doFetch(
    feedId,
    needsContentUpgrade ? {} : { etag: previous?.etag, lastModified: previous?.lastModified },
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
    return { feedId, url: feedId, status: 'failed', added: 0, reason: result.reason }
  }

  if (result.kind === 'not-modified') {
    // 升级轮里还被判 304（源忽略了无条件请求）：写回版本号避免每轮都重试，并留下痕迹
    const upgradeSkipped = needsContentUpgrade
    await store.saveFeed(feedId, {
      ...(previous ?? {}),
      url: feedId,
      lastFetchedAt: stamp,
      contentRevision: CONTENT_REVISION,
    })
    return upgradeSkipped
      ? { feedId, url: feedId, status: 'not-modified', added: 0, reason: '源未响应无条件请求，正文升级跳过' }
      : { feedId, url: feedId, status: 'not-modified', added: 0 }
  }

  const parsed = parseFeed(result.body, feedId)
  const cursor = store.cursor(feedId)
  const seen = cursor?.seen ?? []
  const seenSet = new Set(seen)
  const freshIds: string[] = []

  for (const item of parsed.items) {
    const itemId = deriveItemId(feedId, item)
    const summary = truncateContent(item.summary, options.maxContentChars)
    const existing = store.item(itemId)

    if (existing !== undefined || seenSet.has(itemId)) {
      // 已见过：只补「更完整的正文」，绝不碰 readAt / starred（已读与星标是用户数据）。
      // 这条同时承担回填：解析优先级修好后，老条目在下一次抓取里就能拿到全文。
      if (existing !== undefined && (summary?.length ?? 0) > (existing.summary?.length ?? 0)) {
        await store.saveItem(itemId, { ...existing, summary })
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
    contentRevision: CONTENT_REVISION,
  })
  await prune(store, feedId, options.maxItemsPerFeed)
  await capArticleCache(store, feedId, options.maxArticleCacheChars)

  return { feedId, url: feedId, status: 'added', added: freshIds.length }
}