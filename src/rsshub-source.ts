/**
 * RSSHub 订阅来源（provenance）的**唯一识别判据**（R15 02，spec §4.1.3）。
 *
 * 规则只有三条，顺序固定：
 *  ① 记录已有 `rsshub` 字段 ⇒ 是 RSSHub 源 —— 那是已经认过的**历史事实**，
 *     不能因为用户后来把实例移出池子就退回「不是」（否则来源信息会随设置变化闪断）；
 *  ② 没有字段，但 URL 的 **origin** 命中 `rsshub.instances` 中某一项 ⇒ 是 RSSHub 源，
 *     `instance` = 命中的那个实例（老记录 `baoyu/blog` 走这条，无需迁移）；
 *  ③ 其余一律不是，行为不变。
 *
 * **为什么是 origin 而不是 pathname 前缀**：池里的地址按 `parseRsshubBase` 只留 `URL.origin`，
 * 而不同实例的同一路由路径完全相同；反过来，普通站点的原生 feed 也完全可能长成 `/github/...`。
 * 按路径猜会同时产生两种错：真正的 RSSHub 源换个实例就认不出、普通源被误判成 RSSHub。
 *
 * 纯模块：零 IO、零网络。池子由调用方（端点 / 刷新 / 视图投影）每次传进来，本模块不缓存 ——
 * 设置页改了池子之后下一次调用必须立刻生效。
 */
import type { RsshubProvenance } from './shared.js'

/**
 * 把一个「实例地址」归一成 `URL.origin`。
 *
 * 池子在写盘时已被 `parseRsshubBase` 归一过，但 `config.json` 允许手改（末尾斜杠、大写主机、
 * 默认端口都可能留下）。识别判据不能因为写法差异漂移，所以两边都过一次 URL 解析。
 * 非法输入 / 非 http(s) 一律认不出，不抛错。
 */
function parseHttpUrl(raw: string): URL | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  return url
}

/**
 * RSSHub 地址的 **namespace = pathname 首段**（`/github/issues/x` → `github`）。
 *
 * 单独导出是因为 R15 07 的候选行也要用它：候选 URL 是从某个实例拼出来的，站点身份只有
 * 路径首段这一条线索。认不出（非法 URL / 只有 `/`）返回 undefined —— 不编造 namespace。
 *
 * ⚠️ 调用方必须先确认 `source === 'rsshub'` 再用它：普通站点的原生 feed 完全可能长成
 * `/github/feed.xml`，按路径给页面候选判站点会把用户的订阅误隐藏。
 */
export function rsshubNamespaceOf(url: string): string | undefined {
  const parsed = parseHttpUrl(url)
  if (parsed === undefined) return undefined
  const namespace = parsed.pathname.split('/')[1] ?? ''
  if (parsed.pathname === '/' || namespace === '') return undefined
  return namespace
}

/**
 * 把一个实例地址归一成 `URL.origin`；非法 / 非 http(s) 返回 undefined。
 *
 * 实例池在写盘时已归一，但 `config.json` 允许手改（末尾斜杠、大写主机、默认端口都可能留下）。
 * 「比较两个实例是不是同一台」的判据只有这一份：来源识别（本模块）与刷新切换（rsshub-failover.ts）
 * 都调它，不各自写一遍 URL 解析。
 */
export function rsshubOriginOf(raw: string): string | undefined {
  return parseHttpUrl(raw)?.origin
}

/**
 * 按 origin 识别一个 URL 是不是 RSSHub 源。
 *
 * @returns `{ namespace, path, instance }`；认不出（非法 URL / 不在池里 / 源站根路径）返回 undefined。
 */
export function rsshubProvenanceOf(url: string, instances: readonly string[]): RsshubProvenance | undefined {
  const parsed = parseHttpUrl(url)
  if (parsed === undefined) return undefined
  const origin = parsed.origin
  const matched = instances.some((instance) => rsshubOriginOf(instance) === origin)
  if (!matched) return undefined

  // pathname 至少要有一个非空段才算一条 RSSHub 路由。`/` 是实例源站本身：
  // domain 的 schema 要求 namespace / path 都 min(1)，这里认不出就返回 undefined，不编造。
  const namespace = rsshubNamespaceOf(url)
  if (namespace === undefined) return undefined
  return { namespace, path: parsed.pathname, instance: origin }
}

/**
 * 一条订阅记录的 RSSHub 来源：字段优先，否则按 origin 现算。
 *
 * 这是端点投影、写入、刷新补写三处共用的**同一份裁决**。调用方不要各自写 `record.rsshub ?? ...`，
 * 否则「字段优先」这条历史事实规则会在某一处先漂。
 */
export function rsshubSourceOf(
  record: { readonly url: string; readonly rsshub?: RsshubProvenance },
  instances: readonly string[],
): RsshubProvenance | undefined {
  if (record.rsshub !== undefined) return record.rsshub
  return rsshubProvenanceOf(record.url, instances)
}
