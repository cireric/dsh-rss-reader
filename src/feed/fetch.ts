/**
 * 条件请求抓取。
 *
 * 三条边界都在这里封死，失败只影响当前这一个源（单源失败就地降级）：
 *   ① 超时——AbortSignal.timeout，绝不挂死整个刷新；
 *   ② 体积上限——流式累计，越界立刻 cancel，不把 5 MB 全读进内存；
 *   ③ 非 2xx——就地判失败，不把错误页当 feed 解析。
 *
 * 304 命中即返回 not-modified：重复抓取不得发全量重抓（§3.5 增量抓取）。
 */

import { lookup } from 'node:dns/promises'

export interface FetchLimits {
  /** 单源超时（毫秒） */
  timeoutMs: number
  /** 单次响应体积上限（字节） */
  maxBytes: number
  /**
   * 目标是否来自**用户自己的配置**（订阅源、正在添加的源、OPML 里的源）——而不是 feed 内容里的
   * 链接。默认不是。
   *
   * 它只放宽「内网地址」这一条判定，而且**只对第一个请求生效**：重定向的目标永远按不可信处理
   * （响应内容由发布者控制，一个正常域名完全可以把我们 302 到 169.254.169.254）。
   *
   * 为什么需要这个区分（2026-10-07 的取舍修正）：SSRF 策略一律拒内网之后，自建在局域网的 RSS
   * 服务就用不了了——那是用户主动配置的可信目标，不该被当成攻击面。而「feed 里的条目链接」才是
   * 发布者可控的那一类，一律拒。
   */
  trustedTarget?: boolean
}

/** 有 location 才值得跟的重定向状态码。 */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/** 最多跟几跳 —— 跟得越少，越不容易被引导到内网。 */
const MAX_REDIRECTS = 5

/**
 * 出网地址策略（2026-10-07 安全评审 R3）。
 *
 * 抓取目标完全由订阅源提供：源地址来自用户，但 feed 里的条目 link 由发布者控制，而宿主会
 * 替用户去抓它。这一层必须自己兜住，不能依赖「Node 恰好不支持某协议」这类运行时巧合
 * ——实测 data: 是被接受的（HTTP 200）。
 *
 * 挡什么：非 http/https；localhost 与 *.localhost / *.local / *.internal；IPv4 的回环、
 * 私有、链路本地（169.254/16，云元数据在这儿）、CGNAT、组播/保留段；IPv6 的 ::1 / :: /
 * fc00::/7 / fe80::/10，以及 ::ffff:127.0.0.1 这类 IPv4-mapped 写法。
 * 十进制、十六进制等怪写法的 IPv4 不用单独处理：WHATWG URL 会先把它们归一成点分四段
 * （new URL('http://2130706433/').hostname 就是 '127.0.0.1'）。
 *
 * 挡不住什么（写下来，不假装封死）：域名解析到内网地址（DNS rebinding）——要真封死得在
 * connect 层做，Node 的 fetch 没有这个钩子。这一层只保证「看起来就是内网地址的，直接拒」。
 */
export function blockedReason(rawUrl: string, allowPrivateHosts = false): string | undefined {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return '不是合法 URL'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return '不支持的协议 ' + url.protocol + '（只允许 http/https）'
  }
  if (allowPrivateHosts) return undefined
  if (isPrivateHost(url.hostname)) return '拒绝访问内网地址 ' + url.hostname
  return undefined
}

function isPrivateHost(hostname: string): boolean {
  // 末尾的点是合法的 FQDN 写法（localhost. 就是 localhost）
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === '') return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true

  if (host.includes(':')) {
    const groups = ipv6Groups(host)
    // 展开不了的 IPv6 一律拒（WHATWG URL 会把合法 IPv6 归一成可展开的规范形式）
    if (groups === undefined) return true
    const first = groups[0]
    if ((first & 0xfe00) === 0xfc00) return true   // fc00::/7 唯一本地
    if ((first & 0xffc0) === 0xfe80) return true   // fe80::/10 链路本地
    if ((first & 0xff00) === 0xff00) return true   // ff00::/8 组播

    // IPv4-mapped（::ffff:0:0/96）与 IPv4-compatible（::/96）都要还原成点分四段再判：
    // 它们正是最容易绕过「只认点分写法」的形态 —— 实测 http://[::ffff:127.0.0.1]/
    // 会被 URL 归一成 [::ffff:7f00:1]，点分形式在归一化后就没了。
    const head = groups.slice(0, 6)
    const mapped = head.every((g, i) => (i === 5 ? g === 0xffff : g === 0))
    const compatible = head.every((g) => g === 0)
    if (mapped || compatible) {
      return isPrivateV4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.'))
    }
    return false
  }

  return isPrivateV4(host)
}

/** 把 IPv6 字面量展开成 8 个 16 位分组；不是合法 IPv6 时返回 undefined。 */
function ipv6Groups(host: string): number[] | undefined {
  const parse = (part: string): number[] | undefined => {
    if (part === '') return []
    const out: number[] = []
    for (const piece of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return undefined
      out.push(Number.parseInt(piece, 16))
    }
    return out
  }
  const halves = host.split('::')
  if (halves.length > 2) return undefined
  const head = parse(halves[0])
  const tail = halves.length === 2 ? parse(halves[1]) : []
  if (head === undefined || tail === undefined) return undefined
  if (halves.length === 1) return head.length === 8 ? head : undefined
  const fill = 8 - head.length - tail.length
  if (fill < 0) return undefined
  return [...head, ...new Array<number>(fill).fill(0), ...tail]
}

/** 回环 / 私有 / 链路本地 / CGNAT / 组播保留段。 */
function isPrivateV4(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4 === null) return false
  const a = Number(v4[1])
  const b = Number(v4[2])
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return a >= 224
}

/** 上次抓取存下的协商缓存凭据，回带即可能命中 304。 */
export interface FeedValidators {
  etag?: string
  lastModified?: string
}

export type FetchResult =
  | { kind: 'ok'; body: string; etag?: string; lastModified?: string }
  | { kind: 'not-modified' }
  | { kind: 'failed'; reason: string }

const USER_AGENT = 'dsh-rss-reader/0.0.1'
const ACCEPT = 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5'

/**
 * 字节 → 文本。按 BOM 与 XML 声明里的 encoding 解码；声明不可用则退回 UTF-8。
 * 中文 feed 里 GBK/gb2312 仍有存量，一律按 UTF-8 读会得到乱码。
 */
export function decodeXmlBody(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 512))
  const declared = /encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/i.exec(head)?.[1]?.toLowerCase()
  if (declared === undefined || declared === 'utf-8' || declared === 'utf8') {
    return new TextDecoder('utf-8').decode(bytes)
  }
  try {
    return new TextDecoder(declared).decode(bytes)
  } catch {
    // 平台不认这个标签（如缺 full-icu）：退回 UTF-8，至少不抛给调用方
    return new TextDecoder('utf-8').decode(bytes)
  }
}

function describeFailure(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return `超时（${timeoutMs}ms）`
    if (error.name === 'AbortError') return '已中止'
    return error.message || error.name
  }
  return String(error)
}

type AddressLookup = (hostname: string) => Promise<readonly string[]>

/** 真实解析器：取全部 A/AAAA 记录（CNAME 已展开成最终地址）。 */
const resolveAll: AddressLookup = async (hostname) => {
  const found = await lookup(hostname, { all: true })
  return found.map((entry) => entry.address)
}

/**
 * 在真正 fetch 之前多一道**解析层**检查：域名解析出来的地址里只要有一个是内网，就直接拒。
 *
 * 为什么需要它（2026-10-07 安全评审 R3 的残留项）：blockedReason 只看**名字**，而攻击者可以让一个
 * 看起来正常的域名解析到 127.0.0.1 / 169.254.169.254。这一步挡掉 rebinding 的前置形态。
 *
 * 仍然挡不住什么（写清楚，不假装封死）：解析与连接之间有时间差，我们查到的地址与实际连上的地址
 * 理论上可以不同（真正的 TOCTOU）。要彻底封死得把连接也钉死在已校验的地址上——那需要给 fetch 传
 * 自定义 dispatcher，也就是引入 undici 依赖，不在本插件当前的依赖面里（要做得先问过）。
 */
export async function resolvedBlockedReason(
  rawUrl: string,
  allowPrivateHosts = false,
  lookupImpl: AddressLookup = resolveAll,
): Promise<string | undefined> {
  const direct = blockedReason(rawUrl, allowPrivateHosts)
  if (direct !== undefined) return direct
  if (allowPrivateHosts) return undefined
  const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '')
  // 字面量地址在 blockedReason 里已经判过，不必再查一遍 DNS
  if (host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return undefined
  let addresses: readonly string[]
  try {
    addresses = await lookupImpl(host)
  } catch {
    return '域名解析失败：' + host
  }
  const privateAddress = addresses.find((address) => isPrivateHost(address))
  if (privateAddress !== undefined) return '域名 ' + host + ' 解析到内网地址 ' + privateAddress
  return undefined
}

export async function fetchFeed(
  url: string,
  validators: FeedValidators,
  limits: FetchLimits,
  externalSignal?: AbortSignal,
  /**
   * 可选：响应一到就回调，让调用方能读响应头（如判断站点是否允许被 iframe 嵌入）。
   * 放在这里而不是扩展返回值，是为了不把「嵌入策略」这类上层关心的事塞进 feed 层。
   */
  onResponse?: (response: Response) => void,
): Promise<FetchResult> {
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: ACCEPT }
  if (validators.etag) headers['if-none-match'] = validators.etag
  if (validators.lastModified) headers['if-modified-since'] = validators.lastModified

  const trusted = limits.trustedTarget === true
  const blocked = await resolvedBlockedReason(url, trusted)
  if (blocked !== undefined) return { kind: 'failed', reason: blocked }

  const timeout = AbortSignal.timeout(limits.timeoutMs)
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout

  // 手动跟重定向：**每一跳都重新过一遍地址策略**。用 redirect:'follow' 只能看到落点，
  // 中间跳（例如先跳到 169.254.169.254 再跳回来）根本拦不住。
  let current = url
  let response: Response | undefined
  for (let hop = 0; ; hop += 1) {
    let res: Response
    try {
      res = await fetch(current, { headers, redirect: 'manual', signal })
    } catch (error) {
      return { kind: 'failed', reason: describeFailure(error, limits.timeoutMs) }
    }
    const location = REDIRECT_STATUS.has(res.status) ? res.headers.get('location') : null
    if (location === null) {
      response = res
      break
    }
    if (hop >= MAX_REDIRECTS) return { kind: 'failed', reason: '重定向超过 ' + MAX_REDIRECTS + ' 跳' }
    let next: string
    try {
      next = new URL(location, current).toString()
    } catch {
      return { kind: 'failed', reason: '重定向到一个非法地址' }
    }
    // 重定向目标**永远**按不可信处理：它的地址由响应内容决定，连可变 chain 都不算
    const hopBlocked = await resolvedBlockedReason(next, false)
    if (hopBlocked !== undefined) return { kind: 'failed', reason: '重定向被拒：' + hopBlocked }
    current = next
  }
  if (response === undefined) return { kind: 'failed', reason: '未能取到响应' }

  onResponse?.(response)
  if (response.status === 304) return { kind: 'not-modified' }
  if (!response.ok) {
    return { kind: 'failed', reason: `HTTP ${response.status}` }
  }

  const chunks: Uint8Array[] = []
  let received = 0
  try {
    const reader = response.body?.getReader()
    if (!reader) {
      return { kind: 'failed', reason: '响应没有可读的 body' }
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        received += value.byteLength
        if (received > limits.maxBytes) {
          await reader.cancel()
          return { kind: 'failed', reason: `响应超过体积上限 ${limits.maxBytes} 字节` }
        }
        chunks.push(value)
      }
    }
  } catch (error) {
    return { kind: 'failed', reason: describeFailure(error, limits.timeoutMs) }
  }

  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  const etag = response.headers.get('etag') ?? undefined
  const lastModified = response.headers.get('last-modified') ?? undefined
  return { kind: 'ok', body: decodeXmlBody(new Uint8Array(bytes)), etag, lastModified }
}