/**
 * 浏览器半 ↔ 主进程半的 wire 约定（见 dsh-plugin-dev: references/connection-rpc.md）。
 *
 * 只放字符串与类型，不放实现——两侧各自 import，谁也不需要运行时依赖对方。
 */

/**
 * 浏览器半读写的 HTTP 路由前缀（同源相对路径）。
 *
 * 为什么不用 `ctx.connection.rpc.handle`（技能文档推荐的那条）：它把 owner 绑定到
 * connection 插件自己的 ctx，而那个 ctx 解析不到 webServer，实测抛
 * `cannot get property "webServer" without inject`（2026-10-06，本部署；全部产品插件
 * 也都没用它）。改用宿主自有能力：`ctx.webServer.register` 挂路由 +
 * `ctx.connection.requestRejection(req)` 套用同一套 Host/Origin 与浏览器鉴权。
 */
export const ROUTE_PATH = '/rss-reader-api'

export type Endpoint = 'overview' | 'markRead' | 'refresh'

export type RpcResult<T> =
  | { ok: true; value: T }
  // details 是宿主信封的必填字段（ConnectionRpcFailure，2026-10-06 源码核对；
  // 技能文档里的样板落后于源码，少了它 tsc 直接拒绝）
  | { ok: false; error: { code: string; message: string; details: object } }

export interface FeedView {
  id: string
  title: string
  /** ISO8601 UTC；从未成功抓取过则为 undefined */
  lastFetchedAt?: string
  /** 最近一次失败原因；成功后清空 */
  lastFailure?: string
}

export interface ItemView {
  id: string
  feedId: string
  feedTitle: string
  title: string
  link: string
  publishedAt?: string
  fetchedAt: string
  /** 已读 = 有值（用户 2026-10-05 定的粒度） */
  readAt?: string
  summary?: string
}

export interface Overview {
  feeds: FeedView[]
  /** 跨源合并、按时间倒序（river of news） */
  items: ItemView[]
  unread: number
  /** 本次是否真的发起了抓取（被最小间隔节流时为 false） */
  refreshed: boolean
  /** 上次刷新完成时间 */
  refreshedAt?: string
}
