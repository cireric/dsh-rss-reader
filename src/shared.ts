/**
 * 浏览器半 ↔ 主进程半的 wire 约定（见 dsh-plugin-dev: references/connection-rpc.md）。
 *
 * 只放字符串、类型，以及与两侧都无关的纯常量与纯函数——没有实现细节，也保证两侧各自 import
 * 时谁都不需要运行时依赖对方。
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

export type Endpoint = 'overview' | 'refresh' | 'markRead' | 'unmarkRead' | 'toggleStar' | 'article' | 'cleanup'
  | 'opmlExport' | 'opmlImport' | 'addFeed' | 'removeFeed'

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
  starred: boolean
  summary?: string
}

export interface Overview {
  feeds: FeedView[]
  /** 跨源合并、按时间倒序（river of news） */
  items: ItemView[]
  unread: number
  /** 本次调用是否真的发起了抓取（被节流或并入在途刷新时为 false） */
  refreshed: boolean
  /** 上次抓取完成时间（ISO）；undefined = 本次进程内还没成功抓过 */
  refreshedAt?: string
}
/** 按需正文（`article` 端点）的返回：成功给段落，失败给可直接显示的原因。 */
export interface ArticlePayload {
  itemId: string
  /** 命中存储里的缓存时为 true（没有跑网络） */
  cached: boolean
  title?: string
  /**
   * 结构化正文块（段落/标题/代码/图片/列表/引用）。客户端按 kind 排版——
   * 纯文本无法表达「这是标题/这是图片」，图片更是会被丢弃（用户实测反馈）。
   */
  blocks?: Array<Record<string, unknown>>
  /** 旧版本回传的纯文本段落；仅为兼容尚未刷新的老缓存，不再写入 */
  paragraphs?: string[]
  /** 抓取/抽取失败的原因；与 blocks 互斥 */
  failure?: string
  /** 站点是否允许被 iframe 嵌入（决定能否切到「原站视图」） */
  frameable?: boolean
}
/** 显式清理（`cleanup` 端点）的结果：删除条数、释放字符数与阈值。 */
export interface CleanupResult {
  deleted: number
  freedChars: number
  cutoff: string
  unread: number
}
/** OPML 导出（`opmlExport`）的返回。 */
export interface OpmlExportResult {
  opml: string
  feedCount: number
}

/** OPML 导入（`opmlImport`）的返回：逐源结果 + 汇总，坏源单独列出（§3.1）。 */
export interface OpmlImportResult {
  /** 新增（此前不在订阅里）的源数 */
  added: number
  /** 已存在、本次跳过校验后仍保留的源数 */
  existed: number
  /** 校验失败的源，逐条带原因 */
  failed: Array<{ url: string; reason: string }>
  /** OPML 里被跳过的条目（缺 xmlUrl / URL 非法 / 重复） */
  skipped: Array<{ title?: string; reason: string }>
  /** 通过校验并落库的源（供界面回显） */
  accepted: Array<{ url: string; title?: string; folder?: string }>
}

/**
 * 「这算不算正文」的长度门槛（字符）。
 *
 * 一个值、两个使用面：抽取层用它滤掉导航残留（低于它的段落多是「分类：xxx」「相关阅读」），
 * 列表里用它判断摘要够不够读（实测 HN 的 feed 里 description 恒为 68 字符的 HTML，剥标签后
 * 只剩 Comments 一个词）。**必须是同一个值** —— 否则会出现「抽取时丢掉的，列表里却当正文显示」。
 */
export const MIN_CONTENT_CHARS = 40

/**
 * 条目的排序用时间：优先发布时间，缺则退到抓取时间。
 *
 * 宿主侧（列表排序、按源裁剪、显式清理）与浏览器半（列表显示）都用它——原先三处各写一份，
 * 任何一处改了规则都会让列表顺序与清理判据悄悄不一致。
 */
export function recencyOf(record: { publishedAt?: string; fetchedAt: string }): string {
  return record.publishedAt ?? record.fetchedAt
}

/** 成功信封（两侧共用的信封构造器：宿主端点与客户端解包都按这个形状）。 */
export function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}
export function fail<T = never>(code: string, message: string, details: object = {}): RpcResult<T> {
  // details 必填：宿主信封 ConnectionRpcFailure 要求它（源码为准，技能文档样板落后）
  return { ok: false, error: { code, message, details } }
}
