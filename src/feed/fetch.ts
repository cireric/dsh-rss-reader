/**
 * 条件请求抓取。
 *
 * 三条边界都在这里封死，失败只影响当前这一个源（交接件 §4.2「单源失败就地降级」）：
 *   ① 超时——AbortSignal.timeout，绝不挂死整个刷新；
 *   ② 体积上限——流式累计，越界立刻 cancel，不把 5 MB 全读进内存；
 *   ③ 非 2xx——就地判失败，不把错误页当 feed 解析。
 *
 * 304 命中即返回 not-modified：重复抓取不得发全量重抓（§3.5 增量抓取）。
 */

export interface FetchLimits {
  /** 单源超时（毫秒） */
  timeoutMs: number
  /** 单次响应体积上限（字节） */
  maxBytes: number
}

/** 上次抓取存下的协商缓存凭据，回带即可能命中 304。 */
export interface FeedValidators {
  etag?: string
  lastModified?: string
}

export type FetchResult =
  | { kind: 'ok'; body: string; etag?: string; lastModified?: string }
  | { kind: 'not-modified' }
  | { kind: 'failed'; reason: string }

const USER_AGENT = 'dsh-rss-reader/0.0.1'
const ACCEPT = 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5'

/**
 * 字节 → 文本。按 BOM 与 XML 声明里的 encoding 解码；声明不可用则退回 UTF-8。
 * 中文 feed 里 GBK/gb2312 仍有存量，一律按 UTF-8 读会得到乱码。
 */
export function decodeXmlBody(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 512))
  const declared = /encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/i.exec(head)?.[1]?.toLowerCase()
  if (declared === undefined || declared === 'utf-8' || declared === 'utf8') {
    return new TextDecoder('utf-8').decode(bytes)
  }
  try {
    return new TextDecoder(declared).decode(bytes)
  } catch {
    // 平台不认这个标签（如缺 full-icu）：退回 UTF-8，至少不抛给调用方
    return new TextDecoder('utf-8').decode(bytes)
  }
}

function describeFailure(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return `超时（${timeoutMs}ms）`
    if (error.name === 'AbortError') return '已中止'
    return error.message || error.name
  }
  return String(error)
}

export async function fetchFeed(
  url: string,
  validators: FeedValidators,
  limits: FetchLimits,
  externalSignal?: AbortSignal,
  /**
   * 可选：响应一到就回调，让调用方能读响应头（如判断站点是否允许被 iframe 嵌入）。
   * 放在这里而不是扩展返回值，是为了不把「嵌入策略」这类上层关心的事塞进 feed 层。
   */
  onResponse?: (response: Response) => void,
): Promise<FetchResult> {
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: ACCEPT }
  if (validators.etag) headers['if-none-match'] = validators.etag
  if (validators.lastModified) headers['if-modified-since'] = validators.lastModified

  const timeout = AbortSignal.timeout(limits.timeoutMs)
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout

  let response: Response
  try {
    response = await fetch(url, { headers, redirect: 'follow', signal })
  } catch (error) {
    return { kind: 'failed', reason: describeFailure(error, limits.timeoutMs) }
  }

  onResponse?.(response)
  if (response.status === 304) return { kind: 'not-modified' }
  if (!response.ok) {
    return { kind: 'failed', reason: `HTTP ${response.status}` }
  }

  const chunks: Uint8Array[] = []
  let received = 0
  try {
    const reader = response.body?.getReader()
    if (!reader) {
      return { kind: 'failed', reason: '响应没有可读的 body' }
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        received += value.byteLength
        if (received > limits.maxBytes) {
          await reader.cancel()
          return { kind: 'failed', reason: `响应超过体积上限 ${limits.maxBytes} 字节` }
        }
        chunks.push(value)
      }
    }
  } catch (error) {
    return { kind: 'failed', reason: describeFailure(error, limits.timeoutMs) }
  }

  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  const etag = response.headers.get('etag') ?? undefined
  const lastModified = response.headers.get('last-modified') ?? undefined
  return { kind: 'ok', body: decodeXmlBody(new Uint8Array(bytes)), etag, lastModified }
}