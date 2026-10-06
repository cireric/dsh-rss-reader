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

/**
 * `<pre>` 内容专用转换：**保留每行原样缩进**。
 *
 * 不能复用 htmlToText —— 它会逐行 trim，把代码的缩进吃掉（实测：单测当场抓到
 * 4 空格缩进被抹平，而那正是用户说的「代码全都变样」）。这里只解实体、去标签，
 * 并且标签替换成空串而不是空格（否则 <code> 之类会在词中间插空格）。
 */
export function preToText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ''))
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

/** 段落最小长度：低于此值的 <p> 多为「分类：xxx」「订阅」「相关阅读」这类栏目。 */
const MIN_PARAGRAPH_CHARS = 40

/** 抽取结果：标题与段落（纯文本；代码块保留内部换行）。 */
export interface ExtractedArticle {
  title?: string
  paragraphs: string[]
}

/**
 * 站点是否允许被 iframe 嵌入（浏览器强制执行的服务器策略）。
 *
 * 判断依据：`X-Frame-Options` 只认历史写法 ALLOWALL 才算放行；`Content-Security-Policy`
 * 的 `frame-ancestors` 只有通配 `*` 才放行。实测 6 个真实站点里 github.blog(SAMEORIGIN)
 * 与 MDN(DENY) 会拒绝，其余放行——所以这一项必须按站判断，不能假定。
 */
export function isFrameable(headers: Headers): boolean {
  const xfo = headers.get('x-frame-options')
  if (xfo !== null && xfo.trim().toLowerCase() !== 'allowall') return false
  const csp = headers.get('content-security-policy')
  if (csp !== null) {
    const match = /frame-ancestors([^;]*)/i.exec(csp)
    if (match !== null) {
      const value = match[1].trim()
      if (value !== '*' && !value.split(/\s+/).includes('*')) return false
    }
  }
  return true
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

  // ① 先保护代码块：它们确实配对，且必须保留换行与缩进
  const codes: string[] = []
  body = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_whole, inner: string) => {
    const text = preToText(inner)
    if (text === '') return ' '
    codes.push(text)
    return '\u0000C' + (codes.length - 1) + '\u0000'
  })

  // ② 按块级**边界**切分，而不是要求 <p>…</p> 配对。
  //    实测教训：mihai.dinculescu.dev 的页面里 <p 出现 34 次而 </p> 出现 0 次（省略闭合标签），
  //    配对正则命中 0，散文全军覆没——当时只是被「退化路径按行取全文」兜住了才看不出问题。
  //    闭合与**开始**标签都算边界：实测该站省略 </p>，只按闭合切分会把多个段落粘成一段
  //    （最长段曾达 2,383 字符）。开标签本身不含文字，切开无害；过短的碎片由长度门槛滤掉。
  const boundary = /<\/(?:p|div|li|h[1-6]|blockquote|section|article|figure|tr|td)>|<(?:p|div|li|h[1-6]|blockquote|section|article|figure|tr|td)\b[^>]*>|<br\s*\/?>/gi
  const chunks = body.split(boundary)
  const paragraphs: string[] = []
  for (const chunk of chunks) {
    // 一个 chunk 里可能夹着代码占位符（前后还有散文）：按占位符切开分别处理
    for (const piece of chunk.split(/(\u0000C\d+\u0000)/)) {
      const marker = /^\u0000C(\d+)\u0000$/.exec(piece)
      if (marker !== null) {
        paragraphs.push(codes[Number(marker[1])])
        continue
      }
      const text = htmlToText(piece).replace(/\n/g, ' ')
      if (text.length >= MIN_PARAGRAPH_CHARS) paragraphs.push(text)
    }
  }

  // ③ 兜底：完全没抽到时才按行取全文（这条路径会带上导航等噪声，所以只做最后手段）
  if (paragraphs.length === 0) {
    const lines = htmlToText(body).split('\n').filter((line) => line.length >= MIN_PARAGRAPH_CHARS)
    if (lines.length > 0) return { title: normalizeTitle(title), paragraphs: lines }
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
): Promise<{ kind: 'ok'; title?: string; paragraphs: string[]; frameable: boolean } | { kind: 'failed'; reason: string }> {
  let frameable = true
  const result = await fetchFeed(url, {}, limits, signal, (response) => { frameable = isFrameable(response.headers) })
  if (result.kind === 'failed') return { kind: 'failed', reason: result.reason }
  if (result.kind === 'not-modified') return { kind: 'failed', reason: '原站返回 304（未传条件请求，异常）' }
  const extracted = extractArticle(result.body)
  if (extracted.paragraphs.length === 0) return { kind: 'failed', reason: '没能从该页面里抽出正文（版式不支持）' }
  return { kind: 'ok', title: extracted.title, paragraphs: extracted.paragraphs, frameable }
}