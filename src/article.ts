/**
 * 原站正文抓取与抽取（D 方案的宿主侧）。
 *
 * 为什么抽在宿主而在渲染在客户端：抽完只剩纯文本段落，回传体积小、客户端不需要注入 HTML
 * （无 XSS 面），而且抽取逻辑可以用固定夹具做单测——这是本轮最需要的那道验证。
 *
 * 不引第三方 Readability：只用「去非正文块 + 取 <p> 段落 + 退化到全文行」这套启发式，
 * 够用且完全可测。已知它会漏掉少数与导航混排的版式，这种失败是**可见**的（段落明显不对），
 * 而不是静默出错。
 */
import { fetchFeed, type FetchLimits } from './feed/fetch.js'

/** 整块丢弃的标签（连同内容）：这些几乎从不属于正文。 */
const DROP_BLOCKS = ['script', 'style', 'noscript', 'svg', 'iframe', 'form', 'nav', 'header', 'footer', 'aside', 'template'] as const

/** 常见命名实体；HTML 里比 XML 多，但真正高频的就这些。 */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—',
  ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', middot: '·', times: '×',
  copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', deg: '°', euro: '€', pound: '£',
  yen: '¥', sect: '§', para: '¶', bull: '•', dagger: '†', prime: '′', permil: '‰',
}

/** 解码实体（命名 + 十进制 + 十六进制）。 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body] ?? whole
  })
}

/** HTML 片段 → 纯文本（块级标签转换行，其余标签当空白，收敛空白）。 */
export function htmlToText(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\s*\/(p|div|li|h[1-6]|blockquote|tr|section|article|figure|pre)\s*>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  )
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
}

/** 段落最小长度：低于此值的 <p> 多为「分类：xxx」「订阅」「相关阅读」这类栏目。 */
const MIN_PARAGRAPH_CHARS = 40

/** 抽取结果：标题与段落（纯文本）。 */
export interface ExtractedArticle {
  title?: string
  paragraphs: string[]
}

/** 从 HTML 里抽正文。纯函数——单测直接喂夹具。 */
export function extractArticle(html: string): ExtractedArticle {
  const title =
    firstGroup(html, /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
    ?? firstGroup(html, /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i)
    ?? firstGroup(html, /<title[^>]*>([\s\S]*?)<\/title>/i)
    ?? firstGroup(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i)

  let body = html.replace(/<!--[\s\S]*?-->/g, ' ')
  for (const tag of DROP_BLOCKS) {
    body = body.replace(new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '>', 'gi'), ' ')
  }

  const paragraphs: string[] = []
  for (const match of body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = htmlToText(match[1]).replace(/\n/g, ' ')
    if (text.length >= MIN_PARAGRAPH_CHARS) paragraphs.push(text)
  }

  // 退化路径：有些站点正文用 <div> 排版，取不到足够 <p> 时就按行取全文
  if (paragraphs.length < 2) {
    const lines = htmlToText(body).split('\n').filter((line) => line.length >= MIN_PARAGRAPH_CHARS)
    if (lines.length > paragraphs.length) return { title: normalizeTitle(title), paragraphs: lines }
  }
  return { title: normalizeTitle(title), paragraphs }
}

function firstGroup(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text)
  return match?.[1]
}

function normalizeTitle(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const title = htmlToText(raw).replace(/\n/g, ' ').trim()
  return title === '' ? undefined : title
}

/** 抓原站并抽正文；返回段落文本。 */
export async function fetchArticle(
  url: string,
  limits: FetchLimits,
  signal?: AbortSignal,
): Promise<{ kind: 'ok'; title?: string; paragraphs: string[] } | { kind: 'failed'; reason: string }> {
  const result = await fetchFeed(url, {}, limits, signal)
  if (result.kind === 'failed') return { kind: 'failed', reason: result.reason }
  if (result.kind === 'not-modified') return { kind: 'failed', reason: '原站返回 304（未传条件请求，异常）' }
  const extracted = extractArticle(result.body)
  if (extracted.paragraphs.length === 0) return { kind: 'failed', reason: '没能从该页面里抽出正文（版式不支持）' }
  return { kind: 'ok', title: extracted.title, paragraphs: extracted.paragraphs }
}
