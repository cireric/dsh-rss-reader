/**
 * RSSHub 路由目录的**取表**层（R8b 02）：网络 + 12 小时实例键缓存；投影仍留在 01 的纯函数模块里。
 *
 * 为什么单独一个模块而不是并进投影模块：投影是「不可信 JSON → 紧凑索引」的纯计算，判据能用
 * 静态夹具钉死；取表则要处理超时、体积、私网拒绝与缓存。两者混在一起，测试失败时分不清是
 * 「表解析错了」还是「这次没拉到表」。
 *
 * 失败分型刻意保留原始可读原因，不在这里改写成「实例故障」：客户端直接展示这一句（spec §4.2），
 * 而私网实例被拒时必须说「内网地址」——把它折叠成「实例故障」会让用户去查一个根本不存在的
 * 网络问题。
 */

import { fetchFeed, type FetchLimits } from './feed/fetch.js'
import { parseRsshubBase } from './settings-schema.js'

/**
 * 目录拉取专用预算（spec §4.2 / D4）：实测 gzip 首拉 8.9 s / 638 KB、解压后 3.29 MB，feed 的
 * 默认 15 s / 5 MiB 对这两个量都只剩薄余量。硬编码、不进设置 UI —— 它是这条一次性命中路径的
 * 属性，不是用户可调的抓取偏好。
 */
const CATALOG_TIMEOUT_MS = 60_000
const CATALOG_MAX_BYTES = 16 * 1024 * 1024

/** 目录缓存 12 小时（spec §4.7 / D3）：硬编码，不加设置键。 */
const CATALOG_TTL_MS = 12 * 60 * 60 * 1000

/**
 * 投影结果可选附带的目录口径计数。有它，成功日志才能报「N 站 / M 路由」；没有就退化成
 * 「成功」——不为了凑一句日志去改 01 的投影签名，也不猜数字。
 */
export interface CatalogTotals {
  readonly siteTotal: number
  readonly routeTotal: number
}

/** 一次投影的结果：成功带投影值与可选计数；失败带可直接展示的原因。 */
export type CatalogProjection<T> =
  | { readonly ok: true; readonly value: T; readonly totals?: CatalogTotals }
  | { readonly ok: false; readonly reason: string }

/** `loadCatalog` 的可选依赖：测试注入桩 fetch 与时钟，日志沿用宿主的 `ctx.log`。 */
export interface LoadCatalogOptions {
  fetchImpl?: typeof fetchFeed
  now?: () => number
  log?: (message: string) => void
}

/** 取表结果：成功给整份投影，失败给可读原因（不缓存失败）。 */
export type CatalogLoadResult<T> =
  | { readonly kind: 'ok'; readonly catalog: T }
  | { readonly kind: 'failure'; readonly reason: string }

interface CachedCatalog<T> {
  readonly value: T
  /** 过期时刻（毫秒，取自可注入时钟）。 */
  readonly expiresAt: number
}

/**
 * 进程内缓存，不落盘；重启即空。键 = `parseRsshubBase` 归一后的**实例源站** ——
 * 换实例在构造上不可能命中旧表（spec §4.7），不需要也不该在构造外另写清空逻辑。
 */
const catalogCache = new Map<string, CachedCatalog<unknown>>()

/**
 * 清空进程内缓存——**只给测试隔离用**。生产路径不需要它：换实例由键自然隔离，过期由每条
 * 记录自己的 expiresAt 处理；测试文件之间共享同一个进程模块实例，必须显式复位。
 */
export function clearCatalogCache(): void {
  catalogCache.clear()
}

/**
 * 实例的路由表地址：`{base}/api/namespace`。
 *
 * **唯一**拼法（与 `radarRulesUrl` 同一手法）：03 的端点接线只调它，否则两处各自拼字符串，
 * 一处忘了归一化就会请求到 `/api/api/namespace` 这类地址。`base` 必须是 `parseRsshubBase`
 * 归一后的源站（`loadCatalog` 内部也是这样传的）。
 */
export function catalogUrl(base: string): string {
  return base + '/api/namespace'
}

/**
 * 拉一张实例的整盘路由表，并按实例源站缓存 12 小时。
 *
 * 只在用户第一次打开探索时调用（spec §4.2）：插件启动 / 刷新订阅 / 打开主面板都不预取。
 * `project` 是 01 的纯投影：本层只负责「把不可信 body 变成 JSON、把 JSON 交给投影」，
 * 顶层形状是否合法由投影回答（`ok: false` 的原因原样上抛）。
 */
export async function loadCatalog<T>(
  base: string,
  project: (raw: unknown) => CatalogProjection<T>,
  options: LoadCatalogOptions = {},
): Promise<CatalogLoadResult<T>> {
  const log = options.log ?? (() => {})
  const fail = (reason: string): CatalogLoadResult<T> => {
    log('探索：拉取路由表失败（' + reason + '）')
    return { kind: 'failure', reason }
  }

  // 归一化只认 parseRsshubBase 这一份：空串 = 未配置（探索入口在这种情况下根本不渲染，
  // spec §4.1 / D11），走到这里说明调用方漏判 —— 必须零请求地如实报错，不能替它兜成一个空目录。
  const origin = parseRsshubBase(base)
  if (origin === '') return fail('未配置 RSSHub 实例地址')
  if (origin === undefined) {
    return fail('实例地址不合法（只支持 http(s) 源站，不能带路径 / 查询 / 参数）')
  }

  const now = options.now ?? Date.now
  // 缓存键 = 归一后的实例源站：换实例在构造上失效（spec §4.7）。单独命名让「键里必须有
  // 实例」这条判据只有一个落点，不被读 / 写两处各自传参掩盖。
  const cacheKey = origin
  const cached = readCached<T>(cacheKey, now())
  if (cached !== undefined) return { kind: 'ok', catalog: cached.value }

  // 白名单式重建 limits，只带超时与体积：目录地址来自用户配置的实例，但 spec §4.2 / §4.8
  // 明确它**不是** trustedTarget —— 私网实例必须在 fetch 层的地址策略处被拒。展开调用方对象
  // 或加 trustedTarget 都会把「用户配置」误当成「可信目标」，把 SSRF 边界让出去。
  const catalogLimits: FetchLimits = {
    timeoutMs: CATALOG_TIMEOUT_MS,
    maxBytes: CATALOG_MAX_BYTES,
  }
  const fetched = await (options.fetchImpl ?? fetchFeed)(catalogUrl(origin), {}, catalogLimits)
  if (fetched.kind === 'not-modified') {
    // 拉表不带条件头，正常不该出现 304；出现了当实例故障上报，不静默当成一张空表。
    return fail('实例返回了 304（拉取路由表不应带条件头）')
  }
  if (fetched.kind === 'failed') return fail(fetched.reason)

  let raw: unknown
  try {
    raw = JSON.parse(fetched.body)
  } catch {
    // 网关的 HTML 错误页 / 空 body 都走这里；不能把 JSON.parse 的英文异常直接给用户看。
    return fail('响应不是路由表 JSON')
  }

  const projected = project(raw)
  if (!projected.ok) return fail(projected.reason)

  const at = now()
  // 失败不缓存：写缓存只发生在整条链路（出网 + JSON + 投影）都成功之后，
  // 用户再点一次就是表达「再试一次」（spec §4.7，与 Radar 的 60 s 失败缓存刻意不同）。
  writeCached(cacheKey, projected.value, at)

  if (projected.totals === undefined) {
    log('探索：拉取 ' + origin + ' 路由表成功')
  } else {
    log('探索：拉取 ' + origin + ' 路由表 → ' + projected.totals.siteTotal + ' 站 / ' + projected.totals.routeTotal + ' 路由')
  }
  return { kind: 'ok', catalog: projected.value }
}

/**
 * 命中才返回整条记录；过期条目顺手删掉，不让换了实例的旧投影一直占着进程内存。
 * 返回记录而不是裸值：投影值泛型 T 理论上可以是 `undefined`，用裸值 + undefined 当「未命中」
 * 会把一次成功的空投影误判成缓存不命中。
 */
function readCached<T>(key: string, now: number): CachedCatalog<T> | undefined {
  const entry = catalogCache.get(key)
  if (entry === undefined) return undefined
  if (now < entry.expiresAt) return entry as CachedCatalog<T>
  catalogCache.delete(key)
  return undefined
}

function writeCached<T>(key: string, value: T, now: number): void {
  catalogCache.set(key, { value, expiresAt: now + CATALOG_TTL_MS })
}
