/**
 * RSSHub Radar 的规则引擎（R8a 02）：**纯函数**，零网络 / 零配置 / 零 DOM。
 *
 * 为什么单独成模块：Radar 的全部价值在「页面 URL → 订阅地址」这一条推导上，而输入是实例返回的
 * 规则 JSON（社区维护、形状固定但内容会漂）。推导留在发现流程里就会被网络错误、缓存、合并
 * 三件事淹没，没法用静态样本钉死；提出来之后，03 票的接线只负责取数据与合并候选。
 *
 * 本模块**不 import 项目其它模块**：它不该知道订阅、设置或端点长什么样，输入输出都是普通对象。
 * 这样 03 票可以只按下面的签名接线，规则引擎也能脱离宿主单独验证。
 */

/** 规则表里的一条路由；字段与实例 `/api/radar/rules/{domain}` 回包一一对应。 */
export interface RadarRule {
  /** 展示给用户的路由名；实测有空缺，回落站点名 */
  title?: string
  /** 文档地址。本模块只透传不读取（不跟随、不渲染外部链接，见 spec §4.6） */
  docs?: string
  /** 可匹配的路径模板，`/` 分段、`:name` 吃一段 */
  source: string[]
  /** 从捕获参数拼出的路由模板 */
  target: string
}

/**
 * 一个注册域的规则表。`_name` 是站点名，其余键是**桶名**：桶 = host 相对注册域的子域前缀
 *（`space` 表示 `space.bilibili.com`），`.` 表示注册域本身。
 *
 * 索引签名带上 `string` 是照着实例回包的原样形状写的：`_name` 与桶数组共用同一层键。
 * 读的时候必须用 `Array.isArray` 收窄 —— 不能假设「非 `_name` 就是数组」。
 */
export interface RadarRules {
  _name?: string
  [bucket: string]: RadarRule[] | string | undefined
}

/** IPv4 字面量：四段数字。URL 解析器不校验 0–255，这里也不替它校验。 */
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * 归一化：小写 + 去掉末尾的点。
 * 末尾点是 FQDN 的写法（`example.com.`），对 DNS 有意义、对规则表的键没有 —— 不归一化就等于
 * 把同一个站点查成两个域名。大小写同理（host 本身不分大小写）。
 */
function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.+$/, '')
}

/**
 * IP 字面量：IPv4 是四段数字，IPv6 一定带冒号（`URL.hostname` 会保留方括号）。
 * 它们没有「注册域」这层概念，按点拆只会得到 `168.1.1` 这种不存在的域名。
 */
function isIpLiteral(host: string): boolean {
  return host.includes(':') || IPV4_LITERAL.test(host)
}

/**
 * 域名候选：从**最短**后缀开始（2 段 → 3 段 → … → 全长），最多 4 个。
 *
 * 为什么最短优先：实例端**不做子域回退**（实测 `www.zhihu.com` → 空、`zhihu.com` → 2.9KB），
 * 所以必须从注册域这一层往上加前缀；命中非空即停的循环在调用方（03/04）。
 * 为什么不引公共后缀表：多段后缀（`co.uk`）会多花一次空查询，代价已知且可接受；
 * 换来的是不维护一份会过期的 PSL。
 * 为什么封顶 4：注册域最多 4 段（`foo.bar.co.uk`），再长的标签都是子域，4 次请求已经覆盖。
 */
export function domainCandidates(hostname: string): string[] {
  const host = normalizeHost(hostname)
  if (host === '') return []
  if (isIpLiteral(host)) return [host]
  const labels = host.split('.')
  // 单标签主机（localhost）没有可回退的后缀，只有它自己。
  if (labels.length <= 1) return [host]
  const candidates: string[] = []
  for (let size = 2; size <= labels.length && candidates.length < 4; size += 1) {
    candidates.push(labels.slice(labels.length - size).join('.'))
  }
  return candidates
}

/**
 * 桶键：`前缀` → `.` → `www`，去重保序。
 *
 * 为什么前缀桶在最前：规则表按子域分开挂（`space.bilibili.com` 的路由只在 `space` 桶里），
 * 前缀是最具体的那个桶。`.` 是注册域本身。`www` 放最后是因为实测有 294 个域名**只**把规则
 * 挂在 `www` 桶下、没有 `.` 桶 —— 用户粘裸域时必须再回退一次，否则这些站点一条都发现不了。
 *
 * `host === domain` 时不产生空前缀桶：空前缀不是桶名，而 `.` 已经代表注册域。
 * host 不是该域名的子域（调用方传错）时同样跳过前缀，回退桶照试 —— 这里的输出不会臆造桶名。
 */
export function bucketKeys(hostname: string, domain: string): string[] {
  const host = normalizeHost(hostname)
  const base = normalizeHost(domain)
  const keys: string[] = []
  if (base !== '' && host !== base && host.endsWith('.' + base)) {
    keys.push(host.slice(0, host.length - base.length - 1))
  }
  keys.push('.', 'www')
  // Set 保插入序：重复键（host 已是 `www.…`）只留第一次出现的位置。
  return [...new Set(keys)]
}

/** 段模板：`:name` 吃一段。名字允许大小写与数字 —— 实测规则里有 `:roomID`。 */
const PARAM_SEGMENT = /^:([A-Za-z0-9_]+)$/

/**
 * 模板匹配：把 `source` 与 pathname 都按 `/` 切段逐段比。
 *
 * 为什么必须吃完整个 path：`/user/:id` 若允许前缀匹配，`/user/1/settings` 也会被当成某个
 * 用户的订阅地址 —— 拼出来的路由指向另一个页面，用户点「添加」后拿到的是错的内容。
 * 字面量不区分大小写（站点路径大小写不敏感是常态）；`:name` 吃下的那一段**解码**，
 * 因为拼地址时要先拿到原文再 `encodeURIComponent`。
 *
 * 空段与畸形百分号编码都判「不匹配」：前者不是一段路径，后者说明这个 URL 本身不合法，
 * 都不该被当成捕获值。解码失败不抛异常 —— 发现流程不能因为一个坏 URL 整轮失败。
 */
export function matchSource(pattern: string, pathname: string): Record<string, string> | undefined {
  const patternSegments = pattern.split('/')
  const pathSegments = pathname.split('/')
  if (patternSegments.length !== pathSegments.length) return undefined
  const params: Record<string, string> = {}
  for (let i = 0; i < patternSegments.length; i += 1) {
    const template = patternSegments[i]
    const actual = pathSegments[i]
    const param = PARAM_SEGMENT.exec(template)
    if (param !== null) {
      let decoded: string
      try {
        decoded = decodeURIComponent(actual)
      } catch {
        return undefined
      }
      if (decoded === '') return undefined
      params[param[1]] = decoded
      continue
    }
    if (template.toLowerCase() !== actual.toLowerCase()) return undefined
  }
  return params
}

/** 段模板：`:name?` 是可选参数（实测 github「User Repo」的 target 有三个可选段）。 */
const OPTIONAL_PARAM_SEGMENT = /^:([A-Za-z0-9_]+)\?$/

/**
 * 一条 target 的拼装结果。失败原因必须**分型**：调用方要按「缺参 / 通配 / 正则」分别计数，
 * 若只回 `undefined`，计数就得在调用方把同一套判定再写一遍 —— 两处迟早会漂。
 */
type RouteBuild =
  | { kind: 'ok'; url: string }
  | { kind: 'missing' }
  | { kind: 'wildcard' }
  | { kind: 'regex' }

/**
 * 拼装路由：`:name` 换成 `encodeURIComponent(值)`，`:name?` 缺值时整段省略。
 *
 * 先判 `*` 与 `{}` 再逐段填：这两类是 RSSHub 的通配 / 正则参数，现有引擎不解释它们，
 * 任何「试着填一下」的行为都会拼出一个看起来对、实际指向别的路由的地址。宁可整条跳过。
 * 必填参数缺失同样整条跳过 —— 半成品地址（如 `/36kr/hot-list/undefined`）会被用户当成
 * 可订阅的源，真正的失败要推迟到「添加」那一刻才暴露。
 */
function buildRouteResult(target: string, params: Readonly<Record<string, string>>): RouteBuild {
  if (target.includes('*')) return { kind: 'wildcard' }
  if (target.includes('{') || target.includes('}')) return { kind: 'regex' }
  const filled: string[] = []
  for (const segment of target.split('/')) {
    const optional = OPTIONAL_PARAM_SEGMENT.exec(segment)
    if (optional !== null) {
      const value = params[optional[1]]
      if (value === undefined || value === '') continue
      filled.push(encodeURIComponent(value))
      continue
    }
    const required = PARAM_SEGMENT.exec(segment)
    if (required !== null) {
      const value = params[required[1]]
      if (value === undefined || value === '') return { kind: 'missing' }
      filled.push(encodeURIComponent(value))
      continue
    }
    filled.push(segment)
  }
  const url = filled.join('/')
  return { kind: 'ok', url: url.startsWith('/') ? url : '/' + url }
}

/**
 * 拼地址：`target` 里的 `:name` 用捕获值填；任一必填参数缺失、或 target 含 `*` / `{}` 返回
 * `undefined`。返回值一定以 `/` 开头（调用方拿它和实例地址拼）。
 *
 * 对外只给 `string | undefined`：调用方关心的是「能不能拼出来」；分型计数留在本模块内部，
 * 通过 `candidatesFromRules` 的 `skipped` 暴露。
 */
export function buildRoute(target: string, params: Readonly<Record<string, string>>): string | undefined {
  const result = buildRouteResult(target, params)
  return result.kind === 'ok' ? result.url : undefined
}

/** 一条 Radar 候选的最小形状：03 票直接渲染 `.title` / `.siteName`，把 `.source` 透传给 FeedCandidate。 */
export interface RadarCandidate {
  url: string
  title: string
  siteName: string
  source: 'rsshub'
}

/**
 * 拼不出地址的规则计数，按原因分桶。
 * 只计数、不带文案：调用方把三者加总成**一条**警告「N 条规则无法拼出完整地址」，
 * 文案与阈值由 03 票决定（本模块不写 UI 文案）。
 */
export interface SkippedRules {
  /** 必填参数没捕获到（如 36kr 的 `/` → `/36kr/hot-list/:category`） */
  missingParam: number
  /** target 含 `*` */
  wildcard: number
  /** target 含 `{}`（RSSHub 的正则参数） */
  regex: number
}

/** `candidatesFromRules` 的回包：候选按产出顺序，跳过原因分开计数。 */
export interface RadarCandidatesResult {
  candidates: RadarCandidate[]
  skipped: SkippedRules
}

/** 默认上限，与 spec §4.3 / discover.ts 的 MAX_CANDIDATES 一致。 */
const DEFAULT_CANDIDATE_LIMIT = 5

/**
 * 从规则表拼候选。
 *
 * `domain` 是**命中的注册域**（调用方逐级回退时拿到的那个），不能省：桶键是相对注册域算的
 *（`space` 只对 `bilibili.com` 成立），而 host 本身无法唯一反推注册域
 *（`a.b.co.uk` 的注册域可能是 `b.co.uk`，也可能是 `a.b.co.uk`）—— 这正是 domainCandidates
 * 返回一个**列表**的原因。ticket 的签名省略了它，实现里补成第 4 个必填参数，见交付报告。
 *
 * 遍历顺序 = 桶顺序（`bucketKeys`）→ 规则顺序 → `source` 顺序。命中即产出，不因上限而中断
 * 计数：跳过的规则数要和 limit 无关，否则同一条警告会随上限变化而变。
 *
 * `url` 允许字符串是为了 03 的现有形态（`discoverCandidates(raw)` 里是字符串）；非法 URL 直接
 * 抛 TypeError —— 不静默返回空列表，那会把「调用方传错」伪装成「这个页面没有候选」。
 * 末尾斜杠在这里归一化：用户从地址栏复制常带 `/`，而规则模板从不声明它；多出来的空段会让
 * 本该命中的规则全部落空（`/DIYgod/RSSHub/` 应当等价于 `/DIYgod/RSSHub`）。
 */
export function candidatesFromRules(
  rules: RadarRules,
  url: URL | string,
  base: string,
  domain: string,
  limit: number = DEFAULT_CANDIDATE_LIMIT,
): RadarCandidatesResult {
  const page = typeof url === 'string' ? new URL(url) : url
  const siteName = rules._name ?? ''
  const path = page.pathname
  const pathname = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  const candidates: RadarCandidate[] = []
  const seen = new Set<string>()
  const skipped: SkippedRules = { missingParam: 0, wildcard: 0, regex: 0 }
  // 实例地址末尾常带 `/`：先削掉，避免拼出 `//github/...`（逐条规则削一次纯属浪费）
  const origin = base.replace(/\/+$/, '')

  for (const bucket of bucketKeys(page.hostname, domain)) {
    const bucketRules = rules[bucket]
    // `_name` 与桶数组共用一层键：不是数组的键（含缺失的桶）跳过，不假设「非 _name 即数组」
    if (!Array.isArray(bucketRules)) continue
    for (const rule of bucketRules) {
      let failure: Exclude<RouteBuild['kind'], 'ok'> | undefined
      let produced = false
      for (const source of rule.source) {
        const params = matchSource(source, pathname)
        if (params === undefined) continue
        const built = buildRouteResult(rule.target, params)
        if (built.kind !== 'ok') {
          // 记下第一条失败原因：多条 source 同时命中时，先失败的那条说明这规则的形状不支持
          failure ??= built.kind
          continue
        }
        produced = true
        const candidateUrl = origin + built.url
        if (!seen.has(candidateUrl) && candidates.length < limit) {
          seen.add(candidateUrl)
          candidates.push({ url: candidateUrl, title: rule.title ?? siteName, siteName, source: 'rsshub' })
        }
        break
      }
      if (produced || failure === undefined) continue
      if (failure === 'missing') skipped.missingParam += 1
      else if (failure === 'wildcard') skipped.wildcard += 1
      else skipped.regex += 1
    }
  }
  return { candidates, skipped }
}
