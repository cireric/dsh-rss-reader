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
import { discoverFeedUrls, isSameOrigin, MAX_CANDIDATES } from './feed/discover.js'
import { candidatesFromRules } from './rsshub.js'
import { lookupRadarRules } from './radar.js'
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
  /**
   * RSSHub 实例源站（R8a 03，来自 `ctx.config.rsshubBase`）。空串 / 缺省 = 功能关闭：
   * **一个 Radar 请求都不发，也不产警告** —— 用户没主动配置实例，不该让每次发现都替他把网址
   * 送给第三方（spec D1）。
   */
  rsshubBase?: string
  /**
   * 发现流程的诊断日志（端点传 `ctx.log`）。只用于「Radar 命中了什么」这一行，
   * 与 DiscoveryResult 分开：日志是排查用的，不是给客户端的第二条数据通道（spec §6）。
   */
  log?: (message: string) => void
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

/** Radar 支路的结果：候选 + 最多一条警告（实例故障或跳过计数）。 */
interface RadarBranch {
  candidates: FeedCandidate[]
  warnings: DiscoveryWarning[]
}

/**
 * 合并：页面候选在前、Radar 在后；按归一化 URL 去重（**页面优先**）；总数封顶 MAX_CANDIDATES。
 *
 * 顺序是承重的（spec §4.2 / A1）：Radar 候选没有抓取校验，页面自己声明的才是更可信的那一类；
 * 同一个地址两边都有时，留下的必须是页面那条（带 format / itemCount），不能被 Radar 覆盖。
 * 上限也在这里统一裁：`discoverFeedUrls` 已把页面候选封在 5，但合并后仍可能超（4 页面 + 5 Radar），
 * Radar 只补到上限为止。
 */
function mergeCandidates(page: readonly FeedCandidate[], radar: readonly FeedCandidate[]): FeedCandidate[] {
  const merged: FeedCandidate[] = []
  const seen = new Set<string>()
  for (const candidate of [...page, ...radar]) {
    if (merged.length >= MAX_CANDIDATES) break
    const key = candidateKey(candidate.url)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(candidate)
  }
  return merged
}

/** 去重键：URL 归一化（小写主机、默认端口、点段）。两边来源产出的都是合法绝对地址。 */
function candidateKey(url: string): string {
  try {
    return new URL(url).toString()
  } catch {
    return url
  }
}

/**
 * Radar 支路（spec §4.2 ②）：配置为空 ⇒ 零请求零警告；实例故障 ⇒ 一条警告；有规则 ⇒ 拼候选。
 *
 * `pageUrl` 是**雷达视角的页面地址**：页面抓成功时用 finalUrl（站点可能 301 到别处，规则该按
 * 真正落地的域名/路径算）；页面抓失败时没有 finalUrl，用用户给的 URL（D7：Radar 只要 URL，
 * 不要页面内容 —— 「站点挡爬虫、RSSHub 反而能拿到」正是这一路的典型场景）。
 */
async function radarBranch(
  pageUrl: string,
  options: SubscribeOptions,
  fetchImpl: typeof fetchFeed,
): Promise<RadarBranch> {
  const base = options.rsshubBase?.trim() ?? ''
  // A5：默认状态（未配置）不该天天吵 —— 不请求、不产警告、不写日志。
  if (base === '') return { candidates: [], warnings: [] }

  const page = new URL(pageUrl)
  const lookup = await lookupRadarRules(base, page.hostname, options.limits, fetchImpl)
  if (lookup.failure !== undefined) {
    options.log?.('Radar：' + page.hostname + ' → 查询失败：' + lookup.failure)
    return {
      candidates: [],
      warnings: [{ url: base, reason: 'RSSHub 实例查询失败：' + lookup.failure }],
    }
  }
  if (lookup.domain === undefined || lookup.rules === undefined) {
    // 「该域没规则」是正常结果（实测实例回 200 + 空 body），不是警告。
    options.log?.('Radar：' + page.hostname + ' → 命中 0 条，跳过 0 条')
    return { candidates: [], warnings: [] }
  }

  const found = candidatesFromRules(lookup.rules, page, base, lookup.domain)
  const skipped = found.skipped.missingParam + found.skipped.wildcard + found.skipped.regex
  // 命中数是规则引擎的产出（合并前的口径）：日志要回答的是「这家实例对这个站给了什么」，
  // 不是「最后界面上剩几行」—— 后者还受去重与上限影响，合并结果由端点另一行日志报告。
  options.log?.('Radar：' + lookup.domain + ' → 命中 ' + found.candidates.length + ' 条，跳过 ' + skipped + ' 条')
  const warnings: DiscoveryWarning[] = skipped > 0
    // §4.3：跳过计数汇总成**一条**警告，不逐条刷屏。
    ? [{ url: lookup.domain, reason: skipped + ' 条规则无法拼出完整地址' }]
    : []
  return {
    candidates: found.candidates.map((candidate) => ({
      url: candidate.url,
      title: candidate.title,
      siteName: candidate.siteName,
      source: 'rsshub',
    })),
    warnings,
  }
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
 * 顺序固定（R8a 03 / spec §4.2）：① 页面抓取与声明发现（现状）② Radar 规则查询 ③ 合并。
 * 用户给的就是 feed 时提前返回，**不查 Radar**（A10）—— 那是最快路径，也没有「发现」可言。
 *
 * 上限：页面候选由 discover.ts 的 MAX_CANDIDATES 封顶（5），与 Radar 合并后再统一裁到 5；
 * 体积与超时走 options.limits（每个候选各一份）⇒ 最坏一轮 = 1 次页面 + 5 次候选抓取，
 * 外加 Radar 的最多 4 次域名回退查询（04 票已在 radar.ts 里按「实例 + 域名」缓存 6h / 失败 60s）。
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

  // 用户给的就是 feed：直接作为唯一候选（与 §9.2「直达 RSS/Atom 地址走现有校验」同一语义）。
  // 订阅身份保留用户给的那个 URL，不换成重定向落点 —— addFeed 存的是同一个键。
  // 位置必须在 Radar 之前：这一支提前返回，Radar 一次都不查（A10）。
  if (page.kind === 'ok') {
    const direct = parseFeed(page.body, userUrl)
    if (direct.format !== 'unknown') {
      const only: FeedCandidate = {
        url: userUrl, title: direct.title, format: direct.format, itemCount: direct.items.length, source: 'page',
      }
      return { url: userUrl, candidates: [only], warnings: [] }
    }
  }

  const pageCandidates: FeedCandidate[] = []
  const warnings: DiscoveryWarning[] = []
  if (page.kind === 'failed') {
    // D7：页面失败**不是**发现的失败 —— 原因记下来，Radar 照查（下面的 pageUrl 回落到 userUrl）。
    warnings.push({ url: userUrl, reason: page.reason })
  } else if (page.kind === 'not-modified') {
    warnings.push({ url: userUrl, reason: '发现请求收到了 304（不应发生）' })
  } else {
    const declared = discoverFeedUrls(page.body, page.finalUrl)
    if (declared.length === 0) {
      warnings.push({ url: userUrl, reason: '未发现公开声明的订阅源（页面里没有 link rel=alternate 的 RSS/Atom 声明）' })
    } else {
      for (const candidate of declared) {
        const checked = await checkCandidate(candidate, limitsForCandidate(candidate, userUrl, options.limits), fetchImpl)
        if (checked.ok) {
          pageCandidates.push({
            url: candidate, title: checked.title, format: checked.format, itemCount: checked.itemCount, source: 'page',
          })
        } else {
          warnings.push({ url: candidate, reason: checked.reason })
        }
      }
    }
  }

  const radar = await radarBranch(page.kind === 'ok' ? page.finalUrl : userUrl, options, fetchImpl)
  return {
    url: userUrl,
    candidates: mergeCandidates(pageCandidates, radar.candidates),
    warnings: [...warnings, ...radar.warnings],
  }
}
