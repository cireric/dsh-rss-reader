/**
 * 原站正文抓取与抽取（D 方案的宿主侧）。
 *
 * 为什么抽在宿主而在渲染在客户端：客户端不需要注入 HTML（无 XSS 面），抽取逻辑可用固定夹具
 * 单测——这是最需要验证的部分。
 *
 * **输出是「结构化块」而不是纯文本**（2026-10-06 用户反馈「图片不显示、样式变形」后升级）：
 * 原先只回传字符串数组，图片被整块剥掉、标题/列表/引用的语义全部丢失，客户端只能一律当段落渲染。
 * 现在保留 段落 / 标题 / 代码 / 图片 / 列表 / 引用 六种块，客户端按语义排版。
 *
 * 不引第三方 Readability：只用「按块级标签保护 + 按边界切分」这套启发式，够用且完全可测。
 * 已知它会漏掉少数与导航混排的版式，这种失败是**可见**的（内容明显不对），而不是静默出错。
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

/**
 * 结构化正文块。
 *
 * 为什么要分种类：用户要求「阅读视图尽量与原站一致」。纯文本段落无法表达「这是标题/这是图/
 * 这是列表」，样式必然变形——图片更是被直接丢弃。
 */
export type ArticleBlock =
  | { readonly kind: 'p'; readonly text: string }
  | { readonly kind: 'h'; readonly level: number; readonly text: string }
  | { readonly kind: 'pre'; readonly text: string }
  | { readonly kind: 'img'; readonly src: string; readonly alt?: string; readonly caption?: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly kind: 'quote'; readonly text: string }

/** 抽取结果：标题 + 结构化块。 */
export interface ExtractedArticle {
  title?: string
  blocks: ArticleBlock[]
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

/** 只放行 http/https（挡掉 javascript: / data: —— 后者还可能是 1x1 跟踪像素）。 */
function safeUrl(raw: string | undefined, base: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.startsWith('data:')) return undefined
  try {
    const resolved = base === undefined ? new URL(trimmed) : new URL(trimmed, base)
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.toString() : undefined
  } catch {
    return undefined
  }
}

/** 从标签串里取属性（大小写不敏感，支持单双引号与无引号）。 */
export function attrOf(tag: string, name: string): string | undefined {
  const pattern = new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i')
  const match = pattern.exec(tag)
  if (match === null) return undefined
  const value = match[1] ?? match[2] ?? match[3]
  return value === undefined ? undefined : decodeEntities(value).trim()
}

/**
 * 挑出图片地址。
 *
 * 真实站点大量使用懒加载：`src` 是占位图（甚至是 1x1 gif），真地址在 `data-src` / `srcset` 里。
 * 只读 `src` 会得到「图片不显示」或一屏灰块——用户反馈的正是这个现象。
 * 优先级：srcset 里最大的候选 > src > data-src/data-original/data-lazy-src。
 */
export function pickImageUrl(tag: string, base: string | undefined): string | undefined {
  const srcset = attrOf(tag, 'srcset') ?? attrOf(tag, 'data-srcset')
  if (srcset !== undefined) {
    // 取「描述符最大」的那个候选（1x/2x/640w/1280w 都按数字比较）
    let best: { url: string; weight: number } | undefined
    for (const part of srcset.split(',')) {
      const pieces = part.trim().split(/\s+/)
      const url = pieces[0]
      if (url === undefined || url === '') continue
      const weight = Number.parseFloat((pieces[1] ?? '1').replace(/[^0-9.]/g, '')) || 1
      if (best === undefined || weight > best.weight) best = { url, weight }
    }
    const fromSrcset = safeUrl(best?.url, base)
    if (fromSrcset !== undefined) return fromSrcset
  }
  // 顺序要紧：懒加载属性**必须排在 src 前面**——真实站点常把 src 写成占位图（甚至 1x1 gif），
  // 真地址在 data-src 里。先看 src 就会拿到占位图，表现为「图片不显示」（用户实测反馈）。
  for (const name of ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'src']) {
    const url = safeUrl(attrOf(tag, name), base)
    if (url !== undefined) return url
  }
  return undefined
}

/** 从 HTML 里抽正文。纯函数——单测直接喂夹具。 */
export function extractArticle(html: string, baseUrl?: string): ExtractedArticle {
  const title =
    firstGroup(html, /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
    ?? firstGroup(html, /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i)
    ?? firstGroup(html, /<title[^>]*>([\s\S]*?)<\/title>/i)
    ?? firstGroup(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i)

  let body = html.replace(/<!--[\s\S]*?-->/g, ' ')
  for (const tag of DROP_BLOCKS) {
    body = body.replace(new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '>', 'gi'), ' ')
  }

  /**
   * 块先存进 Map 并留下占位符，**最后按占位符在文档里的位置重建顺序**。
   *
   * ⚠️ 不能边处理边 push：各类型是按「阶段」批量处理的（先 figure、再 pre、再 list…），
   * 那样数组顺序会变成**处理顺序**而不是文档顺序（实测：段落全被挤到末尾、图片跑到最前）。
   */
  const stashed = new Map<number, ArticleBlock>()
  let nextBlockId = 0
  const stash = (block: ArticleBlock): string => {
    const id = nextBlockId
    nextBlockId += 1
    stashed.set(id, block)
    return '\u0000B' + id + '\u0000'
  }

  // ①②③ 按「越具体越先」的顺序保护：figure 含 img、list 含 li、pre 可能含大量符号
  body = body.replace(/<figure\b[^>]*>([\s\S]*?)<\/figure>/gi, (_whole, inner: string) => {
    const imgTag = /<img\b[^>]*>/i.exec(inner)?.[0]
    const src = imgTag === undefined ? undefined : pickImageUrl(imgTag, baseUrl)
    if (src === undefined) return ' '
    const caption = firstGroup(inner, /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i)
    const text = caption === undefined ? '' : htmlToText(caption).replace(/\n/g, ' ').trim()
    return stash({ kind: 'img', src, alt: imgTag === undefined ? undefined : attrOf(imgTag, 'alt'), caption: text === '' ? undefined : text })
  })
  body = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_whole, inner: string) => {
    const text = preToText(inner)
    return text === '' ? ' ' : stash({ kind: 'pre', text })
  })
  body = body.replace(/<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_whole, tag: string, inner: string) => {
    const items: string[] = []
    for (const match of inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
      const text = htmlToText(match[1]).replace(/\n/g, ' ').trim()
      if (text !== '') items.push(text)
    }
    // 只有一个短项的「列表」多半是导航残留，丢掉
    if (items.length === 0 || (items.length === 1 && items[0].length < MIN_PARAGRAPH_CHARS)) return ' '
    return stash({ kind: 'list', ordered: tag.toLowerCase() === 'ol', items })
  })
  body = body.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_whole, inner: string) => {
    const text = htmlToText(inner).replace(/\n+/g, ' ').trim()
    // 引用**不套散文长度门槛**：blockquote 标签本身就是语义信号，短引用（一句被引的话）也是引用
    return text === '' ? ' ' : stash({ kind: 'quote', text })
  })
  body = body.replace(/<img\b[^>]*>/gi, (tag: string) => {
    const src = pickImageUrl(tag, baseUrl)
    return src === undefined ? ' ' : stash({ kind: 'img', src, alt: attrOf(tag, 'alt') })
  })
  body = body.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_whole, level: string, inner: string) => {
    const text = htmlToText(inner).replace(/\n/g, ' ').trim()
    return text === '' ? ' ' : stash({ kind: 'h', level: Number(level), text })
  })

  // ④ 按边界切分剩余散文，并**在同一遍里按文档顺序重建块**
  //    （闭合与开始标签都算边界；实测有站点省略 </p>，只按闭合切会把多段粘成一段）
  const boundary = /<\/(?:p|div|li|h[1-6]|blockquote|section|article|figure|tr|td)>|<(?:p|div|li|h[1-6]|blockquote|section|article|figure|tr|td)\b[^>]*>|<br\s*\/?>/gi
  const blocks: ArticleBlock[] = []
  // ⚠️ 必须把边界**替换成换行**再切分：直接 split 会丢掉分隔信息，相邻的两段文字会首尾相接
  // （实测：div 版式的两段被粘成一块 121 字符）。join('\n') 之后按占位符与换行分别处理。
  for (const piece of body.replace(boundary, '\n').split(/(\u0000B\d+\u0000)/)) {
    const marker = /^\u0000B(\d+)\u0000$/.exec(piece)
    if (marker !== null) {
      const block = stashed.get(Number(marker[1]))
      if (block !== undefined) blocks.push(block)
      continue
    }
    // 一个 piece 里可能含多行（被换行切开的相邻块）：逐行判断，避免把两段并成一段
    for (const line of htmlToText(piece).split('\n')) {
      const text = line.replace(/\s+/g, ' ').trim()
      if (text.length >= MIN_PARAGRAPH_CHARS) blocks.push({ kind: 'p', text })
    }
  }

  // ⑤ 兜底：一个块都没有时按行取全文（会带导航噪声，故只作最后手段）
  if (blocks.length === 0) {
    for (const line of htmlToText(body).split('\n')) {
      if (line.length >= MIN_PARAGRAPH_CHARS) blocks.push({ kind: 'p', text: line })
    }
  }
  return { title: normalizeTitle(title), blocks }
}

/** 正文纯文本（用于长度统计与日志）。 */
export function blocksToText(blocks: readonly ArticleBlock[]): string {
  return blocks
    .map((block) => {
      if (block.kind === 'img') return block.alt ?? ''
      if (block.kind === 'list') return block.items.join(' ')
      return block.text
    })
    .join('\n')
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
): Promise<{ kind: 'ok'; title?: string; blocks: ArticleBlock[]; frameable: boolean } | { kind: 'failed'; reason: string }> {
  let frameable = true
  const result = await fetchFeed(url, {}, limits, signal, (response) => { frameable = isFrameable(response.headers) })
  if (result.kind === 'failed') return { kind: 'failed', reason: result.reason }
  if (result.kind === 'not-modified') return { kind: 'failed', reason: '原站返回 304（未传条件请求，异常）' }
  const extracted = extractArticle(result.body, url)
  if (extracted.blocks.length === 0) return { kind: 'failed', reason: '没能从该页面里抽出正文（版式不支持）' }
  return { kind: 'ok', title: extracted.title, blocks: extracted.blocks, frameable }
}