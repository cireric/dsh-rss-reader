/**
 * 订阅导入的编排：逐源抓取校验，**坏源单独标注、不阻断其余**。
 *
 * 抽成独立模块是为了可测：并发上限、失败隔离、"校验通过才算订阅"这三条都是编排语义，
 * 用桩抓取函数就能完整覆盖，不必起宿主也不必真的出网。
 */
import { mapConcurrent } from './concurrency.js'
import { fetchFeed, type FetchLimits } from './feed/fetch.js'
import { parseFeed } from './feed/parse.js'
import { normalizeFeedUrl } from './refresh.js'
import { discoverFeedUrls, isSameOrigin } from './feed/discover.js'
import type { DiscoveryResult, DiscoveryWarning, FeedCandidate } from './shared.js'

/** 一条导入结果。`ok` 为假时 reason 必须给出可直接展示的原因。 */
export interface SubscribeOutcome {
  url: string
  ok: boolean
  /** 通过校验时从 feed 里读到的标题（比 OPML 里的更可信） */
  title?: string
  format?: string
  itemCount?: number
  /** 这条是通过**首页自动发现**拿到的：值是用户原本给的那个页面 URL */
  discoveredFrom?: string
  reason?: string
}

export interface SubscribeOptions {
  limits: FetchLimits
  /** 并发上限：≥20 个源逐个抓太慢，但也不能全放出去（对站点与本地都不友好） */
  concurrency: number
  /** 单源校验用的抓取实现（测试注入桩） */
  fetchImpl?: typeof fetchFeed
}

/**
 * 逐源校验。
 *
 * 判定「是不是可订阅的 feed」用**解析结果**而不是 HTTP 状态：有些站点对任意路径都回 200
 * HTML，只看状态码会把一堆网页当订阅源存下来（这正是"保存前抓取校验"要挡的）。
 */
export async function validateSubscriptions(
  urls: readonly string[],
  options: SubscribeOptions,
): Promise<SubscribeOutcome[]> {
  const fetchImpl = options.fetchImpl ?? fetchFeed
  // 有界并发 + 保序：与 refresh.ts 共用同一个实现（见 concurrency.ts）
  return mapConcurrent(urls, options.concurrency, (raw) => validateOne(raw, options, fetchImpl))
}

async function validateOne(
  raw: string,
  options: SubscribeOptions,
  fetchImpl: typeof fetchFeed,
): Promise<SubscribeOutcome> {
  let feedUrl: string
  try {
    feedUrl = normalizeFeedUrl(raw)
  } catch {
    return { url: raw, ok: false, reason: '不是合法 URL' }
  }

  const fetched = await fetchImpl(feedUrl, {}, options.limits)
  if (fetched.kind === 'failed') return { url: feedUrl, ok: false, reason: fetched.reason }
  if (fetched.kind === 'not-modified') {
    // 校验时不带条件请求，正常不该出现 304；出现了就当失败上报，别静默当成成功
    return { url: feedUrl, ok: false, reason: '校验请求收到了 304（不应发生）' }
  }

  const parsed = parseFeed(fetched.body, feedUrl)
  if (parsed.format === 'unknown') {
    // 不是 feed —— 也许用户给的是**站点首页**：按 §3.1 找它自己声明的 feed（auto-discovery）
    return await discoverAndValidate(feedUrl, fetched.body, options, fetchImpl)
  }
  return {
    url: feedUrl,
    ok: true,
    title: parsed.title,
    format: parsed.format,
    itemCount: parsed.items.length,
  }
}

/**
 * 首页 → feed：把页面里声明的候选逐个试，第一个能解析成 feed 的就算成功。
 *
 * **信任不跨源传播**（这里是最要紧的一条）：候选链接是**页面内容**决定的（发布者可控），
 * 所以只有当它与用户给的那个 URL 同源时才继承「用户配置的可信目标」；跨源一律按不可信处理，
 * 内网地址会被拒。没有这条，一个正常站点就能用 link rel=alternate 把我们指向 169.254.169.254。
 */
async function discoverAndValidate(
  pageUrl: string,
  html: string,
  options: SubscribeOptions,
  fetchImpl: typeof fetchFeed,
): Promise<SubscribeOutcome> {
  const candidates = discoverFeedUrls(html, pageUrl)
  if (candidates.length === 0) {
    return { url: pageUrl, ok: false, reason: '不是可识别的 feed（RSS 2.0 / RSS 1.0 / Atom 皆不匹配），页面里也没声明 feed' }
  }
  for (const candidate of candidates) {
    const checked = await checkCandidate(candidate, limitsForCandidate(candidate, pageUrl, options.limits), fetchImpl)
    if (!checked.ok) continue
    return {
      url: candidate,
      ok: true,
      title: checked.title,
      format: checked.format,
      itemCount: checked.itemCount,
      discoveredFrom: pageUrl,
    }
  }
  return { url: pageUrl, ok: false, reason: '页面里声明了 feed，但都没有通过校验（共 ' + candidates.length + ' 个候选）' }
}

/**
 * 候选的抓取限额：**只有与「用户给的那个 URL」同源**时才继承「可信目标」。
 *
 * 这条判据是 addFeed 的首个有效源路径与发现列表路径**共用**的那一份（原先只写在
 * discoverAndValidate 里，发现列表要复用同一条边界，抄第二份就等于给第二处留漂移的口子）。
 *
 * ⚠️ 用 userUrl 而不是重定向落点：重定向目标本身按不可信处理（fetch.ts 的每跳校验），
 * 拿它的源去继承信任，等于让一次 302 把信任升级到发布者挑的域名上。
 */
function limitsForCandidate(candidate: string, pageUrl: string, limits: FetchLimits): FetchLimits {
  const inherited = limits.trustedTarget === true && isSameOrigin(candidate, pageUrl)
  return inherited ? limits : { ...limits, trustedTarget: false }
}

type CandidateCheck =
  | { ok: true; title: string | undefined; format: string; itemCount: number }
  | { ok: false; reason: string }

/**
 * 抓一个候选并**按解析结果**判定它是不是 feed（不看状态码：有些站点对任意路径都回 200 HTML）。
 * 失败一律带可直接展示的原因 —— 发现列表要把「这个候选为什么不行」逐条列出来。
 */
async function checkCandidate(
  candidate: string,
  limits: FetchLimits,
  fetchImpl: typeof fetchFeed,
): Promise<CandidateCheck> {
  const attempt = await fetchImpl(candidate, {}, limits)
  if (attempt.kind === 'failed') return { ok: false, reason: attempt.reason }
  if (attempt.kind === 'not-modified') return { ok: false, reason: '校验请求收到了 304（不应发生）' }
  const parsed = parseFeed(attempt.body, candidate)
  if (parsed.format === 'unknown') return { ok: false, reason: '不是可识别的 feed（RSS 2.0 / RSS 1.0 / Atom 皆不匹配）' }
  return { ok: true, title: parsed.title, format: parsed.format, itemCount: parsed.items.length }
}

/**
 * **只发现、不订阅**：把页面声明的候选逐个校验，全部结果交给用户挑。
 *
 * 与 addFeed 的差别只有一处：那条路径取**第一个**通过的候选直接落库，这条把候选连同失败
 * 原因一起交出来，等用户确认后走同一个 addFeed 端点写入。所以本函数**不碰 store**（零写入），
 * 也不做任何"顺手订阅"的兜底。
 *
 * 相对链接按**最终页面 URL**（跟完重定向的落点，每跳都过地址策略）解析 —— 见 fetch.ts 的 finalUrl。
 * 信任边界不因此放宽：候选仍只在与「用户给的 URL」同源时才继承可信目标（limitsForCandidate）。
 *
 * 上限：候选数由 discover.ts 的 MAX_CANDIDATES 封顶（5），体积与超时走 options.limits
 * （每个候选各一份）⇒ 最坏一轮 = 1 次页面 + 5 次候选抓取 × timeoutMs。
 */
export async function discoverCandidates(
  raw: string,
  options: SubscribeOptions,
): Promise<DiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? fetchFeed
  let userUrl: string
  try {
    userUrl = normalizeFeedUrl(raw)
  } catch {
    return { url: raw, candidates: [], warnings: [{ reason: '不是合法 URL' }] }
  }

  const page = await fetchImpl(userUrl, {}, options.limits)
  if (page.kind === 'failed') {
    return { url: userUrl, candidates: [], warnings: [{ url: userUrl, reason: page.reason }] }
  }
  if (page.kind === 'not-modified') {
    return { url: userUrl, candidates: [], warnings: [{ url: userUrl, reason: '发现请求收到了 304（不应发生）' }] }
  }

  // 用户给的就是 feed：直接作为唯一候选（与 §9.2「直达 RSS/Atom 地址走现有校验」同一语义）。
  // 订阅身份保留用户给的那个 URL，不换成重定向落点 —— addFeed 存的是同一个键。
  const direct = parseFeed(page.body, userUrl)
  if (direct.format !== 'unknown') {
    const only: FeedCandidate = { url: userUrl, title: direct.title, format: direct.format, itemCount: direct.items.length }
    return { url: userUrl, candidates: [only], warnings: [] }
  }

  const declared = discoverFeedUrls(page.body, page.finalUrl)
  if (declared.length === 0) {
    return {
      url: userUrl,
      candidates: [],
      warnings: [{ url: userUrl, reason: '未发现公开声明的订阅源（页面里没有 link rel=alternate 的 RSS/Atom 声明）' }],
    }
  }

  const candidates: FeedCandidate[] = []
  const warnings: DiscoveryWarning[] = []
  for (const candidate of declared) {
    const checked = await checkCandidate(candidate, limitsForCandidate(candidate, userUrl, options.limits), fetchImpl)
    if (checked.ok) candidates.push({ url: candidate, title: checked.title, format: checked.format, itemCount: checked.itemCount })
    else warnings.push({ url: candidate, reason: checked.reason })
  }
  return { url: userUrl, candidates, warnings }
}
