/**
 * 订阅导入的编排：逐源抓取校验，**坏源单独标注、不阻断其余**（交接件 §3.1）。
 *
 * 抽成独立模块是为了可测：并发上限、失败隔离、"校验通过才算订阅"这三条都是编排语义，
 * 用桩抓取函数就能完整覆盖，不必起宿主也不必真的出网。
 */
import { mapConcurrent } from './concurrency.js'
import { fetchFeed, type FetchLimits } from './feed/fetch.js'
import { parseFeed } from './feed/parse.js'
import { normalizeFeedUrl } from './refresh.js'

/** 一条导入结果。`ok` 为假时 reason 必须给出可直接展示的原因。 */
export interface SubscribeOutcome {
  url: string
  ok: boolean
  /** 通过校验时从 feed 里读到的标题（比 OPML 里的更可信） */
  title?: string
  format?: string
  itemCount?: number
  reason?: string
}

export interface SubscribeOptions {
  limits: FetchLimits
  /** 并发上限：≥20 个源逐个抓太慢，但也不能全放出去（对站点与本地都不友好） */
  concurrency: number
  /** 单源校验用的抓取实现（测试注入桩） */
  fetchImpl?: typeof fetchFeed
}

/**
 * 逐源校验。
 *
 * 判定「是不是可订阅的 feed」用**解析结果**而不是 HTTP 状态：有些站点对任意路径都回 200
 * HTML，只看状态码会把一堆网页当订阅源存下来（这正是"保存前抓取校验"要挡的）。
 */
export async function validateSubscriptions(
  urls: readonly string[],
  options: SubscribeOptions,
): Promise<SubscribeOutcome[]> {
  const fetchImpl = options.fetchImpl ?? fetchFeed
  // 有界并发 + 保序：与 refresh.ts 共用同一个实现（见 concurrency.ts）
  return mapConcurrent(urls, options.concurrency, (raw) => validateOne(raw, options, fetchImpl))
}

async function validateOne(
  raw: string,
  options: SubscribeOptions,
  fetchImpl: typeof fetchFeed,
): Promise<SubscribeOutcome> {
  let feedUrl: string
  try {
    feedUrl = normalizeFeedUrl(raw)
  } catch {
    return { url: raw, ok: false, reason: '不是合法 URL' }
  }

  const fetched = await fetchImpl(feedUrl, {}, options.limits)
  if (fetched.kind === 'failed') return { url: feedUrl, ok: false, reason: fetched.reason }
  if (fetched.kind === 'not-modified') {
    // 校验时不带条件请求，正常不该出现 304；出现了就当失败上报，别静默当成成功
    return { url: feedUrl, ok: false, reason: '校验请求收到了 304（不应发生）' }
  }

  const parsed = parseFeed(fetched.body, feedUrl)
  if (parsed.format === 'unknown') {
    return { url: feedUrl, ok: false, reason: '不是可识别的 feed（RSS 2.0 / RSS 1.0 / Atom 皆不匹配）' }
  }
  return {
    url: feedUrl,
    ok: true,
    title: parsed.title,
    format: parsed.format,
    itemCount: parsed.items.length,
  }
}
