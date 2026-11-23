/**
 * 跨源重复提示的**判定规则**（M5 03，纯函数）。
 *
 * 只做一件事：把「原文 URL 规范化之后相同」的条目认成一对候选，**跨源**才有提示价值。
 * 刻意**不**碰 identity-repair.ts 的同源合并 —— 那个改数据（把两条并成一条），
 * 这里只产出一个「可能重复」的提示，不动任何条目、已读、星标与未读账。
 *
 * 三条边界来自票据，逐条在下面写成判据：
 *   ① 同源条目不算（同一链接在同一源里重复是 identity-repair 的活，这里再报一次只会重复报警）；
 *   ② 缺链接的条目不算（空链接会把一堆不相干的文章连成一组）；
 *   ③ 仅标题相同不算（标题相似只是线索，不是同一份原文的证据）。
 *
 * **两个键，不是一套口径，不许合并**（ADR-0011）：
 *   - `linkKeyOf` / `link_key` 回答「两个源是不是在说同一篇」——跨源重复提示用，刻意把 http 与
 *     https 当成不同文章（已存的派生列，改规则要整库重算）；
 *   - `sameArticleKeyOf` 回答「这条链接是不是同一篇原文（回溯在同一源内判重）」——由 `linkKeyOf`
 *     派生、只去掉协议，因为归档页与 atom 常把同一篇写成两种协议（实测 3 篇会被重复抓取）。
 */

/**
 * 会被丢掉的跟踪参数。**样本驱动**：只有在实测里真的见过它造成「同一篇文章两个 URL」才加进来，
 * 不做「看起来像跟踪参数就删」（那会把 ?ref= 这种有语义的参数一起吃掉）。
 *
 * 目前来源：爱范儿的 `?p=1682933&utm_…` 与 `?p=17644` → 永久链接（M1 的身份分叉实测），
 * 以及分享链接常见的 fbclid / gclid / spm / mc_cid / mc_eid。
 */
const TRACKING_PARAMS = ['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'spm'] as const

/** 归一化的**版本**：规则一改，已存的 link_key 就全过期了（迁移里要重算一次）。 */
export const LINK_KEY_VERSION = 1

/**
 * 原文链接 → 归一化键。**'' = 不参与重复判定**（空串、非 http(s)、解析不出来）。
 *
 * 规则（都由下面的固定样本钉住，改规则必须同时改样本）：
 *  - 协议与主机大小写不敏感（URL 规范本身就这么定义）；**http 与 https 视为不同** ——
 *    把两者并起来是「更激进的归并」，票据要求等样本；
 *  - 丢掉 `#fragment`（同一篇文章的锚点不是另一篇）；
 *  - 丢掉 TRACKING_PARAMS 与所有 `utm_*`；
 *  - 其余查询参数**排序**后保留（`?b=1&a=2` 与 `?a=2&b=1` 是同一个资源）；
 *  - 路径保留大小写（`/A` 与 `/a` 在真实站点上经常是两篇文章），只把末尾的 `/` 去掉；
 *  - **不**去掉 `www.`（保守：有站点把 www 与裸域分到不同站点上）。
 */
export function linkKeyOf(link: string): string {
  const trimmed = link.trim()
  if (trimmed === '') return ''
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return '' // 解析不出来就不猜（相对链接应该在抽取阶段就被解析成绝对地址了）
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''

  const params: Array<[string, string]> = []
  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase().startsWith('utm_')) continue
    if ((TRACKING_PARAMS as readonly string[]).includes(key.toLowerCase())) continue
    params.push([key, value])
  }
  // 排序让「参数顺序不同」归到同一个键。**只用 key**：同名多值的相对顺序可能带语义
  //（?tag=a&tag=b），按值再排会把它们并成同一个键 —— 那是「更激进的归并」，票据要求有样本才做。
  // Array#sort 是稳定排序，同 key 的项因此保留原始相对顺序。
  params.sort((a, b) => a[0].localeCompare(b[0]))

  let path = url.pathname
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  if (path === '/') path = ''
  const query = params.length === 0
    ? ''
    : '?' + params.map(([key, value]) => key + '=' + value).join('&')
  return url.protocol + '//' + url.host + path + query
}

/**
 * 回溯专用**同文键**：`linkKeyOf` 的结果去掉协议前缀（`https://x/a` ⇒ `x/a`）。
 *
 * 规则不复制，直接派生——这是 ADR-0011 的缓解措施：两边将来只会一起变，唯一差别永远是协议。
 * 为什么需要它：归档页写 `https://`、atom 写 `http://` 时，`linkKeyOf` 判成两篇文章，回溯会把
 * 已在库里的 3 篇再抓一遍（实测样本）；而 `link_key` 是跨源重复提示的口径，不能为回溯改它。
 * **它只用于回溯在同一订阅源内的「这篇是不是已经在库里」**；跨源重复仍由 `link_key` 负责。
 */
export function sameArticleKeyOf(link: string): string {
  const key = linkKeyOf(link)
  const separator = key.indexOf('://')
  return separator === -1 ? key : key.slice(separator + 3)
}

/** 参与重复判定的最小信息：一条条目在「一个源里」的身份。 */
export interface DuplicateRow {
  readonly id: string
  readonly feedId: string
  readonly title: string
  readonly link: string
  readonly readAt?: string
}

/** 一条提示：这个条目在**别的源**里还有哪些同链接的条目。 */
export interface DuplicateHint {
  readonly itemId: string
  readonly others: ReadonlyArray<{
    readonly itemId: string
    readonly feedId: string
    readonly title: string
    readonly link: string
    readonly readAt?: string
  }>
}

/**
 * 从「候选行」里挑出跨源重复，按**可见条目**归位。
 *
 * @param visible 当前这一页的条目（用户看得见的那些）
 * @param candidates 同一批链接键命中的**全部**条目（可以含别的页、别的源）
 * @returns 只给「至少有一个别的源的兄弟」的条目；同源兄弟一律过滤掉
 */
export function duplicateHintsOf(
  visible: readonly DuplicateRow[],
  candidates: readonly DuplicateRow[],
): DuplicateHint[] {
  const byKey = new Map<string, DuplicateRow[]>()
  for (const row of candidates) {
    const key = linkKeyOf(row.link)
    if (key === '') continue
    const group = byKey.get(key)
    if (group === undefined) byKey.set(key, [row])
    else group.push(row)
  }

  const hints: DuplicateHint[] = []
  for (const item of visible) {
    const key = linkKeyOf(item.link)
    if (key === '') continue
    const group = byKey.get(key)
    if (group === undefined) continue
    // 同源不算（票据边界①）：identity-repair 管的就是这一族，这里再报一次只会重复报警
    const others = group
      .filter((row) => row.id !== item.id && row.feedId !== item.feedId)
      .map((row) => ({
        itemId: row.id, feedId: row.feedId, title: row.title, link: row.link,
        ...(row.readAt === undefined ? {} : { readAt: row.readAt }),
      }))
    if (others.length > 0) hints.push({ itemId: item.id, others })
  }
  return hints
}
