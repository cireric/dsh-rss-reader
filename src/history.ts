/**
 * 归档页回溯的**纯函数层**（R9 01）。
 *
 * 只做三件事：从一页 HTML 里抽链接、按已订阅条目的链接形态判断「哪些链接像文章」、
 * 把已知的链接去掉。不联网、不读写存储、不碰配置，也**不 import 任何 node 内建**——
 * 这些判断只跟字符串有关；放进 host-only 模块就会把 node 依赖带进任何想复用它们的地方
 * （同 docs/pitfalls.md §1.7b 的教训）。
 *
 * 三条判据来自 spec §4.2，都写成这里的单一实现：调用方只做取舍（样本不足就拒绝），
 * 不自己再筛一遍。
 */
import { decodeEntities } from './html-text.js'
import { sameArticleKeyOf } from './duplicates.js'

/**
 * `<a href>` 的三种引号形态：双引号 / 单引号 / 无引号。
 *
 * `(?:\s)href` 要求 href 是一个**独立属性**：`data-href` 前面是 `-` 不是空白，因此不会被
 * 当成链接（真实站点里 data-href 多是懒加载占位值，收进来就是假链接）。
 */
const ANCHOR_WITH_HREF = /<a\b[^>]*?(?:\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/gi

/**
 * 归档页 HTML → 绝对链接表（文档顺序，已去重）。
 *
 * 规则（spec §4.2）：只留 `http:` / `https:`；相对地址按 `base`（调用方传**最终落点**）解析；
 * 去 fragment；同一个地址只留第一次出现。认不出的地址直接跳过——不猜、不补。
 */
export function extractArchiveLinks(html: string, base: string): string[] {
  const links: string[] = []
  const seen = new Set<string>()
  for (const match of html.matchAll(ANCHOR_WITH_HREF)) {
    // 实体解码必须在 new URL 之前：`?a=1&amp;b=2` 不解码会把 `amp;b` 当成参数名的一部分
    const raw = decodeEntities(match[1] ?? match[2] ?? match[3] ?? '').trim()
    let url: URL
    try {
      url = new URL(raw, base)
    } catch {
      continue // 解析不出来的 href（例如只有非法字符）不是链接，静默跳过
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
    url.hash = ''
    const absolute = url.toString()
    if (seen.has(absolute)) continue
    seen.add(absolute)
    links.push(absolute)
  }
  return links
}

/** 一条链接的「形状」：判断它是否与已订阅条目同类，只看这四个字段。 */
interface LinkShape {
  /** host（含端口）；协议不参与，因为 http/https 只是同一站点的两种入口。 */
  readonly host: string
  /** 整条路径的数字串换成 `#`。 */
  readonly path: string
  /** 目录部分的数字串换成 `#`（含末尾 `/`）。 */
  readonly directory: string
  /** 文件扩展名（含点）；没有扩展名时是空串。 */
  readonly extension: string
}

/** 数字串 → `#`：`/blog/2026/09/weekly-issue-413.html` ⇒ `/blog/#/#/weekly-issue-#.html`。 */
function digitsToShape(path: string): string {
  return path.replace(/\d+/g, '#')
}

function shapeOf(link: string): LinkShape | undefined {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  const path = url.pathname
  const slash = path.lastIndexOf('/')
  const directory = path.slice(0, slash + 1)
  const file = path.slice(slash + 1)
  const dot = file.lastIndexOf('.')
  // dot <= 0：没有点、或点在开头（`.hidden` 不是扩展名）
  const extension = dot <= 0 ? '' : file.slice(dot)
  return { host: url.host, path: digitsToShape(path), directory: digitsToShape(directory), extension }
}

/**
 * 用已订阅条目的链接**样本**推出「这篇文章链接长什么样」。
 *
 * 样本 **< 3 条 ⇒ undefined**：一条链接可能只是首页或一篇特例，推不出形态；调用方据此
 * 拒绝整次回溯，绝不退回「全收」（spec §4.2 / A3）。
 *
 * 规则（任一命中即算文章，host 必须与样本一致、忽略协议）：
 *   1. 整路径形状：数字串→`#` 后与某个样本完全相同；
 *   2. 目录形状 + 扩展名：目录（数字串→`#`）与扩展名都相同——这条保证「换了 slug 的同一版式」
 *      也能认出来（`/blog/2020/01/deno-intro.html` 与样本 `/blog/2026/11/weekly-issue-420.html`）。
 *
 * 规则 2 要求扩展名非空：否则 `/blog/2020/01/` 这种月份索引会与「无扩展名的 slug 文章」同形，
 * 把整页月份索引收成候选——那正是本功能要滤掉的东西。
 */
export function deriveLinkFilter(sampleLinks: readonly string[]): ((url: string) => boolean) | undefined {
  if (sampleLinks.length < 3) return undefined
  const samples: LinkShape[] = []
  for (const link of sampleLinks) {
    const shape = shapeOf(link)
    if (shape !== undefined) samples.push(shape)
  }
  return (url: string): boolean => {
    const shape = shapeOf(url)
    if (shape === undefined) return false
    return samples.some((sample) => sample.host === shape.host && (
      sample.path === shape.path
      || (shape.extension !== '' && sample.directory === shape.directory && sample.extension === shape.extension)
    ))
  }
}

/** `selectBackfillCandidates` 的入参：链接、形态过滤器、已知链接、本次最多取几篇。 */
export interface BackfillCandidateInput {
  readonly links: readonly string[]
  readonly filter: (url: string) => boolean
  readonly knownLinks: readonly string[]
  readonly limit: number
}

/**
 * 候选 = 形态命中 − 已知链接，按**归档页文档顺序**取前 `limit` 条。
 *
 * 判重口径是 `sameArticleKeyOf`（同文键，忽略协议），不是 `linkKeyOf`：归档页与 atom 常把
 * 同一篇写成两种协议（ADR-0011）。空键（非 http(s) / 解析不出）不参与判重，但没有键的链接
 * 本来也过不了 `filter`。
 */
export function selectBackfillCandidates(input: BackfillCandidateInput): string[] {
  if (input.limit <= 0) return []
  const known = new Set<string>()
  for (const link of input.knownLinks) {
    const key = sameArticleKeyOf(link)
    if (key !== '') known.add(key)
  }
  const candidates: string[] = []
  for (const link of input.links) {
    if (!input.filter(link)) continue
    const key = sameArticleKeyOf(link)
    if (key !== '' && known.has(key)) continue
    candidates.push(link)
    if (candidates.length >= input.limit) break
  }
  return candidates
}
