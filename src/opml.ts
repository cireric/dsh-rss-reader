/**
 * OPML 导入/导出 —— 纯函数，故可用固定夹具单测。
 *
 * 为什么单独成模块：OPML 是**别人的文件**，格式宽容度极大（大小写标签、属性顺序、嵌套 folder、
 * `xmlUrl` vs `xmlurl`、同名重复、`type="rss"` 缺失……）。这些差异我无法靠读文档穷举，
 * 只能：①用真实形态的夹具测；②解析失败时**如实报告**而不是猜。
 *
 * 只做「文本 ⇄ 结构化」这一层；抓取校验、去重、落库都由调用方编排。
 */
import { XMLParser } from 'fast-xml-parser'
import { normalizeFeedUrl } from './refresh.js'
import { asArray } from './xml-node.js'

/** 导入得到的一条订阅：URL 必填，其余可选。 */
export interface OpmlSubscription {
  xmlUrl: string
  title?: string
  /** 所属分组：嵌套 outline 的层级用 / 连接 */
  folder?: string
  htmlUrl?: string
}

export interface OpmlParseResult {
  subscriptions: OpmlSubscription[]
  /** 被跳过的条目及原因（没有 xmlUrl、URL 非法等）——必须可见，不能静默吞掉 */
  skipped: Array<{ title?: string; reason: string }>
}

/** 属性名大小写不敏感地取值（真实 OPML 里 xmlUrl/xmlurl/XMLURL 都出现过）。 */
function attr(node: Record<string, unknown>, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_') && key.slice(2).toLowerCase() === wanted) {
      const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim()
      if (text !== '') return text
    }
  }
  return undefined
}

/** 标签名大小写不敏感地取值（`outline`/`Outline` 都见过）。 */
function childOf(node: Record<string, unknown>, name: string): unknown {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith('@_') && key.toLowerCase() === wanted) return value
  }
  return undefined
}



/**
 * 解析 OPML 文本。
 *
 * 递归遍历 outline：**有 xmlUrl 的算订阅**，没有的当分组容器（其 text/title 作为 folder 名
 * 拼进子项的 folder）。这条规则让「folder 与 subscription 混在同一层」的常见写法也能正确处理。
 */
export function parseOpml(xml: string): OpmlParseResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: true,
    parseTagValue: false,
    isArray: (name) => name.toLowerCase() === 'outline',
  })

  let root: Record<string, unknown>
  try {
    root = parser.parse(xml) as Record<string, unknown>
  } catch (error) {
    return { subscriptions: [], skipped: [{ reason: 'OPML 解析失败：' + (error instanceof Error ? error.message : String(error)) }] }
  }

  const opml = childOf(root, 'opml')
  const body = opml === undefined ? undefined : childOf(asArray(opml)[0] as Record<string, unknown>, 'body')
  if (body === undefined) {
    return { subscriptions: [], skipped: [{ reason: '不是 OPML：找不到 <opml><body>' }] }
  }

  const subscriptions: OpmlSubscription[] = []
  const skipped: Array<{ title?: string; reason: string }> = []
  const seen = new Set<string>()

  const walk = (nodes: unknown[], folder: string | undefined): void => {
    for (const raw of nodes) {
      if (raw === null || typeof raw !== 'object') continue
      const node = raw as Record<string, unknown>
      const title = attr(node, 'title') ?? attr(node, 'text')
      const xmlUrl = attr(node, 'xmlUrl')
      const children = asArray(childOf(node, 'outline'))

      if (xmlUrl !== undefined) {
        let normalized: string
        try {
          normalized = normalizeFeedUrl(xmlUrl)
        } catch {
          skipped.push({ title, reason: 'URL 非法：' + xmlUrl })
          continue
        }
        if (seen.has(normalized)) {
          skipped.push({ title, reason: '同一文件内重复：' + normalized })
          continue
        }
        seen.add(normalized)
        subscriptions.push({
          xmlUrl: normalized,
          title,
          folder,
          htmlUrl: (() => {
            const html = attr(node, 'htmlUrl')
            if (html === undefined) return undefined
            try {
              return new URL(html).toString()
            } catch {
              return undefined
            }
          })(),
        })
      } else if (children.length > 0) {
        // 分组容器：把它的名字拼进子项的 folder（多级用 / 连接）
        const name = title ?? undefined
        walk(children, name === undefined ? folder : (folder === undefined ? name : folder + '/' + name))
      } else {
        skipped.push({ title, reason: '既没有 xmlUrl 也没有子项' })
      }

      // 有 xmlUrl 也可能同时挂子 outline（少见但合法）：子项继承同一个 folder
      if (xmlUrl !== undefined && children.length > 0) walk(children, folder)
    }
  }

  const topLevel = asArray(childOf(asArray(body)[0] as Record<string, unknown>, 'outline'))
  walk(topLevel, undefined)
  return { subscriptions, skipped }
}

/** 转义 XML 文本与属性值（& 必须最先替换，否则会把自己引入的实体再转义一次）。 */
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 导出为 OPML 2.0 文本。folder 用嵌套 outline 还原，同 folder 的连续条目合并到一层。 */
export function buildOpml(feeds: ReadonlyArray<{ url: string; title?: string; folder?: string }>, title = 'DSH RSS 订阅'): string {
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<opml version="2.0">')
  lines.push('  <head><title>' + escapeXml(title) + '</title></head>')
  lines.push('  <body>')

  // 按 folder 分组；无 folder 的直接列在 body 下（分组顺序保持首次出现顺序，输出稳定可 diff）
  const groups = new Map<string, Array<{ url: string; title?: string }>>()
  const loose: Array<{ url: string; title?: string }> = []
  for (const feed of feeds) {
    if (feed.folder === undefined || feed.folder === '') {
      loose.push({ url: feed.url, title: feed.title })
      continue
    }
    const bucket = groups.get(feed.folder) ?? []
    bucket.push({ url: feed.url, title: feed.title })
    groups.set(feed.folder, bucket)
  }

  const outline = (feed: { url: string; title?: string }, indent: string): string =>
    indent + '<outline type="rss" text="' + escapeXml(feed.title ?? feed.url) +
    '" title="' + escapeXml(feed.title ?? feed.url) + '" xmlUrl="' + escapeXml(feed.url) + '"/>'

  for (const feed of loose) lines.push(outline(feed, '    '))
  for (const [folder, bucket] of groups) {
    lines.push('    <outline text="' + escapeXml(folder) + '" title="' + escapeXml(folder) + '">')
    for (const feed of bucket) lines.push(outline(feed, '      '))
    lines.push('    </outline>')
  }

  lines.push('  </body>')
  lines.push('</opml>')
  return lines.join('\n') + '\n'
}
