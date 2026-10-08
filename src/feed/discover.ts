/**
 * Feed auto-discovery —— 规格 §3.1 的第二种订阅途径：用户粘的是**站点首页**，站点自己声明了 feed。
 *
 * 标准做法是 HTML 里的 link rel=alternate + type=application/rss+xml|atom+xml；
 * 规格还记了「找不到 feed 时的官方指引：在页面上搜 subscribe / syndicate / feed / rss / xml / atom」，
 * 所以再加一层 a 标签兜底（匹配出现在 href 里的这些词 —— 不去扫链接文字，那需要跨标签的惰性匹配，
 * 而 HTML 是外部数据，不许让它在正则引擎里爆）。
 *
 * 扫描方式：**逐标签线性匹配**，每个正则都没有嵌套量词（与 article.ts 里那批抽取器同一条理由）。
 */

/** 从一个标签串里取属性值（双引号 / 单引号 / 裸值三种写法都吃）。 */
function attr(tag: string, name: string): string | undefined {
  const match = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i').exec(tag)
  if (match === null) return undefined
  return match[1] ?? match[2] ?? match[3]
}

const FEED_LINK_TAG = /<link\b[^>]*>/gi
const ANCHOR_TAG = /<a\b[^>]*>/gi
/** 声明 feed 的 type：RSS / Atom 都是 feed+xml 这一族 */
const FEED_TYPE = /(?:rss|atom)\+xml/i
/** §3.1 的官方兜底词表 */
const FEED_HINT = /rss|atom|feed|syndicate|subscribe|\/xml/i

/** 最多返回几个候选：一个页面可能挂几十个链接，不能顺着全抓一遍。 */
const MAX_CANDIDATES = 5

/**
 * 从 HTML 里找出它声明的 feed 地址（绝对化、去重、保序）。
 *
 * 只认 http(s)：页面里出现 data: / javascript: / file: 这类 href 时直接丢。
 */
export function discoverFeedUrls(html: string, baseUrl: string): string[] {
  const found: string[] = []
  const push = (href: string | undefined): void => {
    if (href === undefined || href.trim() === '') return
    let resolved: URL
    try {
      resolved = new URL(href.trim(), baseUrl)
    } catch {
      return
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return
    const value = resolved.toString()
    if (found.includes(value) || found.length >= MAX_CANDIDATES) return
    found.push(value)
  }

  // 主路径：标准的 link rel=alternate
  for (const tag of html.match(FEED_LINK_TAG) ?? []) {
    const rel = attr(tag, 'rel') ?? ''
    if (!/\balternate\b/i.test(rel)) continue
    if (!FEED_TYPE.test(attr(tag, 'type') ?? '')) continue
    push(attr(tag, 'href'))
  }
  if (found.length > 0) return found

  // 兜底：页面上那个「橙色图标」通常就是个 <a href="…/feed">（§3.1 的官方指引）
  for (const tag of html.match(ANCHOR_TAG) ?? []) {
    const href = attr(tag, 'href')
    if (href === undefined || !FEED_HINT.test(href)) continue
    push(href)
  }
  return found
}

/** 两个 URL 是否同源 —— 「信任不跨源传播」这条规则的判据。 */
export function isSameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}
