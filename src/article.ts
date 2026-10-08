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
import { MIN_CONTENT_CHARS } from './shared.js'
import { decodeEntities, htmlToText, preToText } from './html-text.js'

/** 整块丢弃的标签（连同内容）：这些几乎从不属于正文。 */
const DROP_BLOCKS = ['script', 'style', 'noscript', 'svg', 'iframe', 'form', 'nav', 'header', 'footer', 'aside', 'template'] as const

/** CDN 尺寸描述符小于等于这个值就当作装饰性小图（头像/图标/徽标）。见 isDecorativeImage。 */
const DECORATIVE_IMAGE_MAX = 200

/** 同一个 src 在正文里出现到这个次数以上就只留第一张（卡片区会把同一张图重复塞进来）。 */
const MAX_SAME_IMAGE = 2


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
/**
 * 这张图是不是「装饰性小图」—— CDN 的尺寸描述符说明它被当成头像/图标在用。
 *
 * 实测依据（sspai.com/post/115416）：21 个 img 块里 6 个是**同一张作者头像**的两种规格
 * （thumbnail/!72x72r 与 !100x100r，各出现 3 次），而正文图都是无尺寸描述符的原图。
 * 判据只看 URL 里显式的宽x高描述符，**不猜路径关键词**（那是脆弱且容易误伤的做法）。
 *
 * 阈值取 200：头像/图标/徽标的缩略规格都在 100 以内，而正文里最小的插图也远大于它。
 */
export function isDecorativeImage(url: string): boolean {
  for (const match of url.matchAll(/[!/=_-]0*(\d{1,4})x0*(\d{1,4})(?![0-9])/g)) {
    const width = Number(match[1])
    const height = Number(match[2])
    if (width > 0 && height > 0 && width <= DECORATIVE_IMAGE_MAX && height <= DECORATIVE_IMAGE_MAX) return true
  }
  return false
}

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

/**
 * —— 线性标签扫描基本件（2026-10-07 补）——
 *
 * 动机：抽取层原先每一段都是「惰性匹配 + 全局替换」的形状，遇到**没有闭合标签**的载荷会在
 * 每个起点重扫到文末，退化成 O(标签数 x 全文)。实测 25,000 个标签时就已超预算：
 * 未闭合 script 654ms、title 599ms、figure 672ms、裸尖括号 219ms；外推到默认的 2MB 上限
 * （约 25 万个标签）是 60 秒级——而这段代码跑在 host 进程里，一次按键足以冻住整个 DSH
 * （所有会话、所有流）。
 *
 * 下面这套基本件把同一批载荷压到 1~10ms，且对正常页面的结果与原先一致
 * （既有 article 单测继续作为行为护栏）。
 */

/** 标签头：可选斜杠 + 名字。sticky——只在 lastIndex 处试一次，O(1)。 */
const TAG_HEAD = /<\/?([a-zA-Z][a-zA-Z0-9-]*)/y


/** 去掉 HTML 注释；没有闭合标记的当普通文本留下（与正则同义）。O(n)。 */
function stripComments(html: string): string {
  let out = ''
  let cursor = 0
  for (;;) {
    const at = html.indexOf('<!--', cursor)
    if (at === -1) return out + html.slice(cursor)
    const end = html.indexOf('-->', at + 4)
    if (end === -1) return out + html.slice(cursor)
    out += html.slice(cursor, at) + ' '
    cursor = end + 3
  }
}

interface TagHit {
  readonly name: string
  readonly closing: boolean
  readonly start: number
  readonly end: number
}

/** 线性遍历正文里的每个标签；不能构成标签的尖括号只前进一个字符。整体 O(n)。 */
function* eachTag(text: string): Generator<TagHit> {
  let i = 0
  for (;;) {
    const lt = text.indexOf('<', i)
    if (lt === -1) return
    TAG_HEAD.lastIndex = lt
    const head = TAG_HEAD.exec(text)
    if (head === null) {
      i = lt + 1
      continue
    }
    const gt = text.indexOf('>', TAG_HEAD.lastIndex)
    if (gt === -1) return
    yield { name: head[1].toLowerCase(), closing: text[lt + 1] === '/', start: lt, end: gt + 1 }
    i = gt + 1
  }
}

/**
 * 找同名闭合标签的位置。
 *
 * 同一个名字一旦在某个位置之后就再也没有闭合标签，就记下来不再尝试——否则「很多开标签 +
 * 一个闭合标签」的载荷仍会让每个开标签各扫一遍文末，又退回二次行为。
 */
function makeClosingFinder(text: string, lower: string): (name: string, from: number) => number {
  const exhausted = new Set<string>()
  return (name, from) => {
    if (exhausted.has(name)) return -1
    let searchFrom = from
    for (;;) {
      const at = lower.indexOf('</' + name, searchFrom)
      if (at === -1) {
        exhausted.add(name)
        return -1
      }
      if (text[at + 2 + name.length] === '>') return at
      searchFrom = at + 2
    }
  }
}

/**
 * 把开闭标签之间的整段交给 render 重写（只看第一个同名闭合标签，与惰性正则同义）。
 * 一次前进，整体 O(n)。
 */
function rewriteTagRegions(
  body: string,
  isTarget: (name: string) => boolean,
  render: (name: string, inner: string) => string,
): string {
  const lower = body.toLowerCase()
  const findClosing = makeClosingFinder(body, lower)
  let out = ''
  let cursor = 0
  for (const hit of eachTag(body)) {
    if (hit.closing || hit.start < cursor || !isTarget(hit.name)) continue
    const closeAt = findClosing(hit.name, hit.end)
    if (closeAt === -1) continue
    const closeEnd = body.indexOf('>', closeAt) + 1
    out += body.slice(cursor, hit.start) + render(hit.name, body.slice(hit.end, closeAt))
    cursor = closeEnd
  }
  return out + body.slice(cursor)
}

/** 把整段丢弃标签换成空格（等价于逐标签惰性替换，但只走一遍）。 */
function dropRegions(html: string): string {
  return rewriteTagRegions(html, (name) => DROP_SET.has(name), () => ' ')
}

/** 空元素：把标签本身交给 render。O(n)。 */
function rewriteVoidTags(body: string, name: string, render: (tag: string) => string): string {
  let out = ''
  let cursor = 0
  for (const hit of eachTag(body)) {
    if (hit.closing || hit.name !== name || hit.start < cursor) continue
    out += body.slice(cursor, hit.start) + render(body.slice(hit.start, hit.end))
    cursor = hit.end
  }
  return out + body.slice(cursor)
}

/** 第一个同名开闭标签之间的内容（与惰性正则的首个匹配同义）。O(n)。 */
function firstRegion(text: string, lower: string, name: string): string | undefined {
  const findClosing = makeClosingFinder(text, lower)
  for (const hit of eachTag(text)) {
    if (hit.closing || hit.name !== name) continue
    const closeAt = findClosing(name, hit.end)
    return closeAt === -1 ? undefined : text.slice(hit.end, closeAt)
  }
  return undefined
}

/** 第一个同名空元素的标签本身。O(n)。 */
function firstVoidTag(text: string, name: string): string | undefined {
  for (const hit of eachTag(text)) {
    if (!hit.closing && hit.name === name) return text.slice(hit.start, hit.end)
  }
  return undefined
}

/** 按顺序收集所有同名开闭标签之间的内容（等价于全局惰性匹配）。O(n)。 */
function allRegions(text: string, name: string): string[] {
  const lower = text.toLowerCase()
  const findClosing = makeClosingFinder(text, lower)
  const found: string[] = []
  let cursor = 0
  for (const hit of eachTag(text)) {
    if (hit.closing || hit.name !== name || hit.start < cursor) continue
    const closeAt = findClosing(name, hit.end)
    if (closeAt === -1) continue
    found.push(text.slice(hit.end, closeAt))
    cursor = text.indexOf('>', closeAt) + 1
  }
  return found
}

/** 丢弃标签的集合形态（线性扫描用成员判断，不再逐标签编译正则）。 */
const DROP_SET: ReadonlySet<string> = new Set<string>(DROP_BLOCKS)

/** 从 meta 标签里取指定 property 的 content。O(n)。 */
function metaContent(html: string, property: string): string | undefined {
  const want = property.toLowerCase()
  for (const hit of eachTag(html)) {
    if (hit.closing || hit.name !== 'meta') continue
    const tag = html.slice(hit.start, hit.end)
    const declared = attrOf(tag, 'property')
    if (declared === undefined || declared.toLowerCase() !== want) continue
    const content = attrOf(tag, 'content')
    if (content !== undefined) return content
  }
  return undefined
}

/** 从 HTML 里抽正文。纯函数——单测直接喂夹具。 */
export function extractArticle(html: string, baseUrl?: string): ExtractedArticle {
  const lower = html.toLowerCase()
  const title =
    metaContent(html, 'og:title')
    ?? firstRegion(html, lower, 'title')
    ?? firstRegion(html, lower, 'h1')

  let body = dropRegions(stripComments(html))
  body = lower.length === 0 ? body : body

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
  body = rewriteTagRegions(body, (name) => name === 'figure', (_name, inner) => {
    const imgTag = firstVoidTag(inner, 'img')
    const src = imgTag === undefined ? undefined : pickImageUrl(imgTag, baseUrl)
    // 装饰性小图（头像/图标）即使包在 figure 里也不是正文，丢掉
    if (src === undefined || isDecorativeImage(src)) return ' '
    const caption = firstRegion(inner, inner.toLowerCase(), 'figcaption')
    const text = caption === undefined ? '' : htmlToText(caption).replace(/\n/g, ' ').trim()
    return stash({ kind: 'img', src, alt: imgTag === undefined ? undefined : attrOf(imgTag, 'alt'), caption: text === '' ? undefined : text })
  })
  body = rewriteTagRegions(body, (name) => name === 'pre', (_name, inner) => {
    const text = preToText(inner)
    return text === '' ? ' ' : stash({ kind: 'pre', text })
  })
  body = rewriteTagRegions(body, (name) => name === 'ul' || name === 'ol', (name, inner) => {
    const items: string[] = []
    for (const li of allRegions(inner, 'li')) {
      const text = htmlToText(li).replace(/\n/g, ' ').trim()
      if (text !== '') items.push(text)
    }
    // 只有一个短项的「列表」多半是导航残留，丢掉
    if (items.length === 0 || (items.length === 1 && items[0].length < MIN_CONTENT_CHARS)) return ' '
    return stash({ kind: 'list', ordered: name === 'ol', items })
  })
  body = rewriteTagRegions(body, (name) => name === 'blockquote', (_name, inner) => {
    const text = htmlToText(inner).replace(/\n+/g, ' ').trim()
    // 引用**不套散文长度门槛**：blockquote 标签本身就是语义信号，短引用（一句被引的话）也是引用
    return text === '' ? ' ' : stash({ kind: 'quote', text })
  })
  body = rewriteVoidTags(body, 'img', (tag) => {
    const src = pickImageUrl(tag, baseUrl)
    if (src === undefined || isDecorativeImage(src)) return ' '
    return stash({ kind: 'img', src, alt: attrOf(tag, 'alt') })
  })
  body = rewriteTagRegions(body, (name) => /^h[1-6]$/.test(name), (name, inner) => {
    const text = htmlToText(inner).replace(/\n/g, ' ').trim()
    return text === '' ? ' ' : stash({ kind: 'h', level: Number(name.slice(1)), text })
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
      if (text.length >= MIN_CONTENT_CHARS) blocks.push({ kind: 'p', text })
    }
  }

  // ⑤ 兜底：一个块都没有时按行取全文（会带导航噪声，故只作最后手段）
  if (blocks.length === 0) {
    for (const line of htmlToText(body).split('\n')) {
      if (line.length >= MIN_CONTENT_CHARS) blocks.push({ kind: 'p', text: line })
    }
  }
  return { title: normalizeTitle(title), blocks: dedupeImages(blocks) }
}

/**
 * 同一张图在正文里重复出现时只留第一次。
 *
 * 实测依据（sspai）：作者头像与「相关阅读」卡片会引用与正文相同的图；22 个 img 块里去重能砍掉
 * 4 个纯重复。只对 img 去重，**段落重复不碰**（那可能是站点故意的排版，也可能是抽取噪声，
 * 但两种情况下「合并」都比「保留」更危险）。
 */
function dedupeImages(blocks: readonly ArticleBlock[]): ArticleBlock[] {
  const seen = new Map<string, number>()
  const out: ArticleBlock[] = []
  for (const block of blocks) {
    if (block.kind !== 'img') { out.push(block); continue }
    const count = (seen.get(block.src) ?? 0) + 1
    seen.set(block.src, count)
    if (count > MAX_SAME_IMAGE) continue
    out.push(block)
  }
  return out
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