/**
 * HTML 片段 → 纯文本（2026-10-07 从 article.ts 拆出）。
 *
 * 为什么单独成模块：这套函数是**纯字符串处理，不依赖任何 node 能力**，而 article.ts 为了抓取
 * import 了 feed/fetch（node 专用）。浏览器半需要同一套规则（列表里渲染摘要是同一件事），
 * 但它不能 import article.ts —— 于是原先自己抄了一份 toParagraphs，两份的标签规则逐字相同、
 * 而实体解码那一步被漏掉了。搬到这里之后两侧共用同一份实现。
 */
/** 常见命名实体；HTML 里比 XML 多，但真正高频的就这些。 */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—',
  ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', middot: '·', times: '×',
  copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', deg: '°', euro: '€', pound: '£',
  yen: '¥', sect: '§', para: '¶', bull: '•', dagger: '†', prime: '′', permil: '‰',
}

/**
 * Unicode 码点上限。越界的字符引用（如 &#x110000;）会让 String.fromCodePoint 抛
 * RangeError —— 那是任意网页可控的输入，一次抛错就毁掉整页抽取（2026-10-07 安全评审 R4）。
 */
const MAX_CODE_POINT = 0x10ffff

function inCodePointRange(code: number): boolean {
  return Number.isFinite(code) && code >= 0 && code <= MAX_CODE_POINT
}

/** 解码实体（命名 + 十进制 + 十六进制）。 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return inCodePointRange(code) ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return inCodePointRange(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body] ?? whole
  })
}

/** HTML 片段 → 纯文本（块级标签转换行，其余标签当空白，收敛空白）。 */
export function htmlToText(fragment: string): string {
  return decodeEntities(
    stripTagsTo(
      fragment
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\s*\/(p|div|li|h[1-6]|blockquote|tr|section|article|figure|pre)\s*>/gi, '\n'),
      ' ',
    ),
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
  return decodeEntities(stripTagsTo(fragment, ''))
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

/** 把每个尖括号标签换成 replacement；没有闭合尖括号的按普通文本留下。O(n)。 */
function stripTagsTo(text: string, replacement: string): string {
  let out = ''
  let cursor = 0
  for (;;) {
    const lt = text.indexOf('<', cursor)
    if (lt === -1) return out + text.slice(cursor)
    const gt = text.indexOf('>', lt + 1)
    if (gt === -1) return out + text.slice(cursor)
    out += text.slice(cursor, lt) + replacement
    cursor = gt + 1
  }
}
