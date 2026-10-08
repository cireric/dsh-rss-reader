/**
 * RSS 2.0 / RSS 1.0(RDF) / Atom 三格式归一。
 *
 * 只做归一，不碰网络、不碰存储——因此可以被 fixture 逐条钉死。
 * 解析器用 fast-xml-parser：真实世界的 feed 畸形是常态，手写 XML 扫描器
 * 是给自己挖坑。它不解析 DTD、不取外部实体，故无 XXE；深嵌套由
 * maxNestedTags 设限，体积另由抓取层封顶（5 MB）。
 */
import { XMLParser } from 'fast-xml-parser'
import { asArray } from '../xml-node.js'
import { toIsoUtc } from './date.js'

export type FeedFormat = 'rss2' | 'rss1' | 'atom' | 'unknown'

export interface ParsedItem {
  /** feed 自带的 id/guid；稳定派生优先用它（见 item-id.ts） */
  id?: string
  title: string
  link: string
  publishedAt?: string
  publishedRaw?: string
  summary?: string
  author?: string
}

export interface ParsedFeed {
  format: FeedFormat
  title?: string
  items: ParsedItem[]
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: '#cdata',
  trimValues: true,
  parseTagValue: false,   // 一律保留字符串：不对 feed 里的数字/日期做类型推断
  processEntities: true,  // 展开实体；不外取 DTD/外部实体（无 XXE）
  htmlEntities: true,     // 一并解码 HTML 命名实体与数字字符引用：&#8217; 这类在真实 feed 里极常见，
                          // 默认值 false 会把它们原样留在正文里（已实测）
  maxNestedTags: 256,
})

type XmlNode = Record<string, unknown>



/** 取元素文本：兼容 CDATA 容器与带属性元素（文本落在 #text）。 */
export function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return textOf(value[0])
  if (typeof value === 'object') {
    const node = value as XmlNode
    return textOf(node['#cdata'] ?? node['#text'])
  }
  return undefined
}

/**
 * 取「更完整」的那份文本。
 *
 * 同一个源里，正文常常在 content:encoded / content，而 description / summary 只是摘要
 * ——实测 GitHub Blog：content:encoded 3,826–548,104 字符，description 只有 231–286 字符。
 * 原实现固定「摘要优先」，等于把到手的全文扔掉（用户因此以为这插件只能看摘要）。
 * 比较用「去掉标签后的长度」：HTML 标记不该让某一份看起来更完整。
 */
export function fullest(...candidates: Array<string | undefined>): string | undefined {
  let best: string | undefined
  let bestLength = -1
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    const length = candidate.replace(/<[^>]*>/g, '').length
    if (length > bestLength) {
      best = candidate
      bestLength = length
    }
  }
  return best
}

/** 相对链接按源地址解析成绝对链接；解析不了就原样返回。 */
export function absolutize(href: string | undefined, baseUrl: string): string {
  const value = (href ?? '').trim()
  if (!value) return ''
  try {
    return new URL(value, baseUrl).toString()
  } catch {
    return value
  }
}

/** Atom 的 link 是带属性元素列表：取 rel!=self 的第一个，否则取第一个。 */
function atomLink(value: unknown): string | undefined {
  const links = asArray(value)
  if (links.length === 0) return undefined
  const preferred = links.find((entry) => {
    if (typeof entry !== 'object' || entry === null) return false
    const rel = (entry as XmlNode)['@_rel']
    return rel === undefined || rel === 'alternate'
  })
  const chosen = preferred ?? links[0]
  if (typeof chosen === 'string') return chosen.trim() || undefined
  if (chosen && typeof chosen === 'object') {
    const href = (chosen as XmlNode)['@_href']
    return typeof href === 'string' ? href.trim() || undefined : undefined
  }
  return undefined
}

function normalizeItem(fields: {
  id?: string
  title?: string
  link?: string
  published?: string
  summary?: string
  author?: string
}, baseUrl: string): ParsedItem {
  return {
    id: fields.id,
    title: fields.title ?? '',
    link: absolutize(fields.link, baseUrl),
    publishedAt: toIsoUtc(fields.published),
    publishedRaw: fields.published,
    summary: fields.summary,
    author: fields.author,
  }
}

function parseRss2(root: XmlNode, baseUrl: string): ParsedFeed {
  const channel = (asArray(root.rss)[0] as XmlNode | undefined)?.channel
  const node = asArray(channel)[0] as XmlNode | undefined
  if (!node) return { format: 'rss2', items: [] }
  const items = asArray(node.item).map((raw) => {
    const item = (raw ?? {}) as XmlNode
    const published = textOf(item.pubDate) ?? textOf(item['dc:date'])
    return normalizeItem({
      id: textOf(item.guid),
      title: textOf(item.title),
      link: textOf(item.link),
      published,
      // 正文优先，而不是摘要优先（见 fullest 的注释）
      summary: fullest(textOf(item['content:encoded']), textOf(item.description)),
      author: textOf(item['dc:creator']) ?? textOf(item.author),
    }, baseUrl)
  })
  return { format: 'rss2', title: textOf(node.title), items }
}

function parseRss1(root: XmlNode, baseUrl: string): ParsedFeed {
  const rdf = (asArray(root['rdf:RDF'])[0] ?? asArray(root.RDF)[0]) as XmlNode | undefined
  if (!rdf) return { format: 'rss1', items: [] }
  const channel = asArray(rdf.channel)[0] as XmlNode | undefined
  const items = asArray(rdf.item).map((raw) => {
    const item = (raw ?? {}) as XmlNode
    return normalizeItem({
      id: textOf(item['@_rdf:about']),
      title: textOf(item.title),
      link: textOf(item.link),
      published: textOf(item['dc:date']),
      summary: textOf(item.description),
      author: textOf(item['dc:creator']),
    }, baseUrl)
  })
  return { format: 'rss1', title: channel ? textOf(channel.title) : undefined, items }
}

function parseAtom(root: XmlNode, baseUrl: string): ParsedFeed {
  const feed = asArray(root.feed)[0] as XmlNode | undefined
  if (!feed) return { format: 'atom', items: [] }
  const items = asArray(feed.entry).map((raw) => {
    const entry = (raw ?? {}) as XmlNode
    const author = asArray(entry.author)[0] as XmlNode | undefined
    return normalizeItem({
      id: textOf(entry.id),
      title: textOf(entry.title),
      link: atomLink(entry.link),
      // Atom 规范里 updated 必有、published 可选；缺 published 时用 updated 兜底
      published: textOf(entry.published) ?? textOf(entry.updated),
      summary: fullest(textOf(entry.content), textOf(entry.summary)),
      author: author ? textOf(author.name) : undefined,
    }, baseUrl)
  })
  return { format: 'atom', title: textOf(feed.title), items }
}

/** 解析入口。无法识别或 XML 损坏时返回 unknown + 空列表，绝不抛给调用方。 */
export function parseFeed(xml: string, baseUrl: string): ParsedFeed {
  let root: XmlNode
  try {
    root = parser.parse(xml) as XmlNode
  } catch {
    return { format: 'unknown', items: [] }
  }
  if (!root || typeof root !== 'object') return { format: 'unknown', items: [] }
  if (root.rss !== undefined) return parseRss2(root, baseUrl)
  if (root['rdf:RDF'] !== undefined || root.RDF !== undefined) return parseRss1(root, baseUrl)
  if (root.feed !== undefined) return parseAtom(root, baseUrl)
  return { format: 'unknown', items: [] }
}