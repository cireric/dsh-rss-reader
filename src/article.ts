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

/**
 * 抽取器的**内容版本**：抽取行为一变就要 +1。
 *
 * 为什么必须放在这个文件里（2026-10-09 补）：这个常量原先写死在 endpoints.ts，与抽取逻辑分居两地。
 * 上一轮修复改了抽取规则却没抬版本号，于是**已经缓存过的文章永远显示修复前的块**——用户反馈
 * 「修了还是老样子」，根因就在这里（实测：库里那篇文章的缓存时间早于修复 1 小时）。
 * 放在抽取逻辑旁边，改抽取的人改的就是同一个文件，漏抬版本变成「看得见的不一致」而不是静默事故。
 *
 * 版本 1 = 纯文本段落（已废弃）；2 = 结构化块；3 = 正文容器识别（去掉站点杂图）。
 */
export const EXTRACTOR_REVISION = 3

/** 整块丢弃的标签（连同内容）：这些几乎从不属于正文。 */
const DROP_BLOCKS = ['script', 'style', 'noscript', 'svg', 'iframe', 'form', 'nav', 'header', 'footer', 'aside', 'template'] as const

/** 标题剥离的最小长度：短于它的标题一律不剥（避免把「A | B」这种本身就是标题的写法切坏）。 */
const MIN_TITLE_CHARS = 10

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

/**
 * —— 正文容器识别（2026-10-09 补）——
 *
 * 为什么必须做：抽取层原先**在整页范围内**找段落/图片，于是页面上的站点头像、二维码、
 * 相关阅读卡片与正文一样满足「是个 p」「是个 img」的条件，只能靠长度门槛与尺寸描述符这类
 * 逐条规则去猜，猜不到的就留在正文里（实测：sspai 头像 6 张、爱范儿尾部 6 张二维码）。
 *
 * 换成「先认正文容器、再在容器里抽块」之后，站点杂图不再需要任何规则——它们根本不在容器里。
 * 判据只用容器自身的可测量形状（文本量 / 链接密度 / 段落占比），不看 class 名或路径关键词：
 * 那是脆弱的，而且每个站点的 class 名都不一样。
 *
 * 代价与兜底：容器可能选错。选错的后果被三层兜住 —— ①向下只收窄到「仍保有父容器至少 50%
 * 文本与 90% 分数」的更内层容器；②收窄总量不得低于最高分候选的 40%；③收窄结果若一个块都
 * 抽不出，就退回整页（改动前的行为）。所以最坏情况是「回到今天的样子」，不会把能读的文章变成读不了。
 */

/** 容器识别的最小文本量：低于它的元素不可能承载正文。 */
const CONTAINER_MIN_CHARS = 300

/** 向下收窄的边界：仍须保有此比例的文本与分数，才算「更精确的正文容器」。 */
const NARROW_MIN_TEXT_RATIO = 0.5
const NARROW_MIN_SCORE_RATIO = 0.9

/** 整体收窄的下限：收窄后不得低于**最高分候选**的这个比例（防止层层收窄把正文削光）。 */
const CONTAINER_MIN_RETAINED = 0.4

/** 这些标签天生不是正文容器（即使它们的文本量很大）。 */
const NOT_CONTENT_ROOT: ReadonlySet<string> = new Set(['html', 'head', 'body', 'header', 'footer', 'nav', 'aside', 'form', 'select', 'table', 'ul', 'ol', 'dl', 'figure', 'blockquote', 'pre', 'a', 'button', 'template', 'svg'])

/** 自己的标签不是正文边界：度量与抽取都要跳过（内容另行处理）。 */
const MEASURE_SKIP: ReadonlySet<string> = new Set([...DROP_BLOCKS, 'head', 'title'])

const VOID_ELEMENTS: ReadonlySet<string> = new Set(['img', 'br', 'hr', 'meta', 'link', 'input', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr'])

/** 一个候选容器的度量结果。 */
interface ContainerMetric {
  readonly id: number
  readonly parent: number
  readonly name: string
  readonly innerStart: number
  readonly innerEnd: number
  readonly textLen: number
  readonly linkLen: number
  readonly paraLen: number
  readonly depth: number
}

/** 度量过程中未闭合的栈帧。 */
interface MeasureFrame {
  readonly id: number
  readonly parent: number
  readonly name: string
  readonly innerStart: number
  innerEnd: number
  depth: number
  text: number
  link: number
  para: number
}

/** 文本的「可见长度」：连续空白算一个字符（缩进/换行不该虚增文本量）。 */
function visibleLength(raw: string): number {
  let length = 0
  let run = 0
  let space = false
  for (const char of raw) {
    if (char === ' ' || char === '\n' || char === '\t' || char === '\r' || char === '\f' || char === '\u00a0') {
      space = true
      continue
    }
    if (space) { length += 1; space = false }
    run += 1
    length += 1
  }
  return length
}

/** 容器的正文分数：文本量 × 非链接占比 × 段落占比加成。 */
function containerScore(metric: { textLen: number; linkLen: number; paraLen: number }): number {
  if (metric.textLen <= 0) return 0
  const linkRatio = Math.min(1, metric.linkLen / metric.textLen)
  const paraRatio = Math.min(1, metric.paraLen / metric.textLen)
  return metric.textLen * (1 - linkRatio) * (0.35 + 0.65 * paraRatio)
}

/**
 * 一次线性扫描算出每个元素的内容区间与子树度量（可见文本量 / 链接文本量 / 段落文本量）。
 *
 * 为什么要自己走一遍而不是数正则：p 与 a 是**嵌套**结构，正则分不清「这段文本在不在链接里」，
 * 而链接密度正是区分正文与导航/卡片列表最有效的那一项。扫描是 O(n)：文本片段只累加到栈顶，
 * 元素闭合时并入父元素，不重复遍历子树。
 */
function measureContainers(html: string): ContainerMetric[] {
  const frames: MeasureFrame[] = []
  const measure: MeasureFrame[] = []
  const skipped: boolean[] = []
  const found: ContainerMetric[] = []
  let skipDepth = 0
  let nextId = 0
  let cursor = 0

  const addText = (raw: string): void => {
    if (skipDepth > 0 || raw === '') return
    const length = visibleLength(raw)
    if (length === 0) return
    for (let i = measure.length - 1; i >= 0; i -= 1) {
      const frame = measure[i]
      frame.text += length
      if (frame.name === 'a') frame.link += length
      if (frame.name === 'p') frame.para += length
      return
    }
  }

  const closeFrame = (frame: MeasureFrame): void => {
    // measure 与非跳过帧同序，闭合又是后进先出 ⇒ 正常情况下面这行第一次就命中（O(1)）。
    // 这个「就地弹出」是本函数的关键：早先写成从栈顶往下线性找自己，遇到两万多个未闭合标签
    // 的载荷就退化成 O(n²)（实测 285ms，逼近性能闸门），而抽取跑在 host 进程里、会卡住整个 DSH。
    let index = measure.length - 1
    while (index >= 0 && measure[index].id !== frame.id) index -= 1
    if (index >= 0) {
      const parent = index > 0 ? measure[index - 1] : undefined
      if (parent !== undefined) {
        // 父元素是 a/p 时，子元素的全部文本都算成父元素的链接/段落文本（这正是嵌套的意义）
        parent.text += frame.text
        parent.link += parent.name === 'a' ? frame.text : frame.link
        parent.para += parent.name === 'p' ? frame.text : frame.para
      }
      measure.length = index
    }
    found.push({
      id: frame.id,
      parent: frame.parent,
      name: frame.name,
      innerStart: frame.innerStart,
      innerEnd: frame.innerEnd,
      textLen: frame.text,
      linkLen: frame.link,
      paraLen: frame.para,
      depth: frame.depth,
    })
  }

  const popTo = (name: string, at: number, closingEnd: number): void => {
    let target = -1
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      if (frames[i].name === name) { target = i; break }
    }
    if (target === -1) return
    let popped = 0
    for (let i = frames.length - 1; i >= target; i -= 1) {
      const frame = frames[i]
      frame.innerEnd = i === target ? at : closingEnd
      if (skipped[i]) skipDepth -= 1
      else { closeFrame(frame); popped += 1 }
    }
    frames.length = target
    skipped.length = target
    // measure 栈由 closeFrame 就地收缩（它知道每个闭合帧在栈里的位置）。这里**不能**再减一次：
    // 重复收缩会把仍打开的外层帧一起丢掉，后续文本随之记到错误的容器上（实测踩到）。
    void popped
  }

  for (const hit of eachTag(html)) {
    addText(html.slice(cursor, hit.start))
    cursor = hit.end
    if (hit.closing) {
      popTo(hit.name, hit.start, hit.end)
      continue
    }
    if (VOID_ELEMENTS.has(hit.name)) continue
    const frame: MeasureFrame = {
      id: nextId,
      parent: frames.length > 0 ? frames[frames.length - 1].id : -1,
      name: hit.name,
      innerStart: hit.end,
      innerEnd: html.length,
      depth: frames.length,
      text: 0,
      link: 0,
      para: 0,
    }
    nextId += 1
    const skip = skipDepth > 0 || MEASURE_SKIP.has(hit.name)
    frames.push(frame)
    skipped.push(skip)
    if (skip) { skipDepth += 1 } else { measure.push(frame) }
  }

  // 收尾：真实页面常见省略闭合标签，未闭合的元素按「一直到文末」算
  addText(html.slice(cursor))
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i]
    frame.innerEnd = html.length
    if (skipped[i]) skipDepth -= 1
    else closeFrame(frame)
  }
  return found
}

/**
 * 选出正文容器。三步：挑分数最高的候选（排除 html/body/导航这类天生不是正文的标签）→
 * 向下收窄到「更小但同样完整」的最内层容器 → 收窄过头就退回最高分候选。
 *
 * 返回 undefined 表示没有可信容器，调用方应当整页抽取（改动前的行为）。
 */
function pickContentRoot(html: string): { start: number; end: number } | undefined {
  const metrics = measureContainers(html)
  const scored = metrics
    .filter((metric) => !NOT_CONTENT_ROOT.has(metric.name) && metric.textLen >= CONTAINER_MIN_CHARS)
    .map((metric) => ({ metric, score: containerScore(metric) }))
    .sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (best === undefined) return undefined

  const childrenOf = new Map<number, ContainerMetric[]>()
  for (const metric of metrics) {
    if (metric.parent === -1) continue
    const list = childrenOf.get(metric.parent)
    if (list === undefined) childrenOf.set(metric.parent, [metric])
    else list.push(metric)
  }

  let current = best
  for (let step = 0; step < 8; step += 1) {
    let next: { metric: ContainerMetric; score: number } | undefined
    for (const child of childrenOf.get(current.metric.id) ?? []) {
      if (NOT_CONTENT_ROOT.has(child.name)) continue
      if (child.textLen < current.metric.textLen * NARROW_MIN_TEXT_RATIO) continue
      const score = containerScore(child)
      if (score < current.score * NARROW_MIN_SCORE_RATIO) continue
      if (next === undefined || score > next.score) next = { metric: child, score }
    }
    if (next === undefined) break
    current = next
  }

  if (current.metric.textLen < best.metric.textLen * CONTAINER_MIN_RETAINED) current = best
  if (current.metric.innerEnd <= current.metric.innerStart) return undefined
  return { start: current.metric.innerStart, end: current.metric.innerEnd }
}

/** 从 HTML 里抽正文。纯函数——单测直接喂夹具。 */
export function extractArticle(html: string, baseUrl?: string): ExtractedArticle {
  const scoped = stripComments(html)
  const lower = scoped.toLowerCase()
  // 标题必须从**全页**取：og:title / <title> 在 head 里，正文容器限定之后就没有它们了
  const title =
    metaContent(scoped, 'og:title')
    ?? firstRegion(scoped, lower, 'title')
    ?? firstRegion(scoped, lower, 'h1')

  const root = pickContentRoot(scoped)
  // 容器取**内部**（不含容器自己的标签——容器标签自己不该被当成正文边界）
  const focused = root === undefined ? [] : collectBlocks(scoped.slice(root.start, root.end), baseUrl)
  // 容器里一个块都没抽到就退回整页。选错容器的代价必须是「回到改动前的行为」，而不是「正文没了」——
  // 这条回退让容器识别只可能变好，不可能让原本能读的文章变成读不了。
  const blocks = focused.length > 0 ? focused : collectBlocks(scoped, baseUrl)
  return { title: normalizeTitle(title), blocks: dedupeImages(blocks) }
}

/**
 * 块抽取本体：段落 / 标题 / 代码 / 图片 / 列表 / 引用。输入是 HTML 片段（整页或某个容器）。
 */
function collectBlocks(html: string, baseUrl: string | undefined): ArticleBlock[] {
  let body = dropRegions(html)

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
  return blocks
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

/**
 * 标题里的站点后缀分隔符，**只认实测到的两种**：`标题 - 少数派`（少数派）、`标题 | 爱范儿`（爱范儿）。
 *
 * 为什么要剥掉（2026-10-09）：og:title 常带站点名，而正文里另有一个 h1 是纯标题 —— 两者同时在
 * 阅读视图里出现时，读者看到的是同一个标题写了两遍（用户截图里的现象）。
 *
 * 为什么**不认**中文破折号 `——`：中文标题里它更常是副标题分隔符（`标题 —— 副标题`），而不是站点名，
 * 拿它当站点后缀会把标题拦腰砍断。同理不认 `·` —— 两者都没有实测样本，按「不为未经实测的样本扩规则」
 * 留在外面。没有分隔符的标题一律原样保留（不猜、不改写）。
 */
const TITLE_SUFFIX = /\s+[|\-]\s+\S/

function stripSiteSuffix(title: string): string {
  // 从右往左找到第一个分隔符；只接受「后缀明显短于标题」的情况，避免把含连字符的长标题切掉
  for (let at = title.length - 1; at > 0; at -= 1) {
    if (!/\s/.test(title[at])) continue
    const rest = title.slice(at)
    if (!TITLE_SUFFIX.test(rest)) continue
    const head = title.slice(0, at).trim()
    const tail = title.slice(at).replace(/^\s+[|\-–—·]\s+/, '').trim()
    if (head.length < MIN_TITLE_CHARS || tail.length === 0 || tail.length > head.length / 2) return title
    return head
  }
  return title
}

function normalizeTitle(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const title = htmlToText(raw).replace(/\n/g, ' ').trim()
  if (title === '') return undefined
  const stripped = stripSiteSuffix(title)
  return stripped === '' ? undefined : stripped
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