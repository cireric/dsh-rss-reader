/**
 * 插件的配置面（Schemastery）—— 2026-10-07 从 index.ts 拆出。
 *
 * 接口与 schema 必须挨着放：值、默认值、注释三者分开就会漂。
 */
import z from 'schemastery'

export interface Config {
  /**
   * 订阅源种子 URL：仅用于首次把订阅落进存储域（幂等）。
   * 订阅源的真相在存储域里，M2 界面与 M4 的 OPML 导入都写同一张表。
   */
  feeds: string[]
  /** 单源超时（毫秒） */
  timeoutMs: number
  /** 单次响应体积上限（字节） */
  maxBytes: number
  /** 每源保留条目数 */
  maxItemsPerFeed: number
  /** 每源去重窗口大小（只存 id，必须远大于 maxItemsPerFeed，否则老条目会重新变未读） */
  maxSeenPerFeed: number
  /** 单条正文的存储上限（字符）：正文优先取 content 后需要有这个闸门，见 refresh.ts 注释 */
  maxContentChars: number
  /**
   * **全局**按需正文缓存总量上限（字符，全部源共摊）：超限从最旧的开始清，
   * 见 refresh.ts 的 capArticleCache。
   *
   * ⚠️ **2026-10-11：语义由「每源」改成「全局」——这是一次真实的破坏性变更。**
   * 默认值仍是 8 000 000，但它的含义变了：以前是「每个源各自 8M 字符」，现在是「全部源合计 8M」。
   * ⇒ 显式配过这个值的用户，实际生效上限会**缩小到原来的 1/源数**：50 个源即缩到 1/50，
   * 于是刷新一轮后正文缓存会被清到只剩一小部分（条目与已读/星标不受影响，丢的只是按需正文，
   * 再打开会重新抓——但对源多的用户那是一次明显的「缓存好像不生效了」）。
   * 嫌紧就把值按源数调大（50 源 ⇒ 配 400 000 000 才等价于旧值的每源 8M）。
   * 之所以不跟着调默认值：8M 全局对单源用户与旧值完全一致，而把它改成 N×8M 会让
   * 「无源数概念」的默认预算重新变成事实上的无上限。
   */
  maxArticleCacheChars: number
  /** 显式清理的天数阈值：早于「现在 − 该天数」的已读条目才可清理 */
  cleanupAfterDays: number
  /** OPML 导入时的逐源校验并发上限（≥20 源逐个抓太慢，全放出去又不友好） */
  importConcurrency: number
  /** 刷新时同时在飞的抓取数（逐源串行是 N x RTT 的线性等待，见 refresh.ts） */
  refreshConcurrency: number
  /** 按需抓原站正文的体积上限（字节）——单篇文章比 feed 大，与 maxBytes 分开 */
  articleMaxBytes: number
  /** 同一篇文章两次抓取之间的最小间隔（缓存未命中时），防连按造成的请求风暴 */
  articleCooldownMs: number
  /** 装载时刷新一次 */
  refreshOnStart: boolean
  /** 打开面板时的最小刷新间隔（毫秒）：节流不打网络，但不引入常驻定时器 */
  minRefreshIntervalMs: number
  /** 面板一次最多取多少条（跨源合并后的尾部截断） */
  maxItemsShown: number
  /** 刷新日志路径；空串 = 仅走 ctx.logger */
  logFile: string
}

export const Config: z<Config> = z.object({
  feeds: z.array(z.string()).default([]),
  timeoutMs: z.number().default(15000),
  maxBytes: z.number().default(5 * 1024 * 1024),
  maxItemsPerFeed: z.number().default(500),
  maxSeenPerFeed: z.number().default(5000),
  maxContentChars: z.number().default(50000),
  // 全局预算：全部源合计 8 000 000 字符（2026-10-11 起不再是每源一份，见上面的注释）
  maxArticleCacheChars: z.number().default(8_000_000),
  cleanupAfterDays: z.number().default(30),
  importConcurrency: z.number().default(5),
  refreshConcurrency: z.number().default(5),
  articleMaxBytes: z.number().default(2 * 1024 * 1024),
  articleCooldownMs: z.number().default(30000),
  refreshOnStart: z.boolean().default(true),
  minRefreshIntervalMs: z.number().default(10 * 60 * 1000),
  maxItemsShown: z.number().default(300),
  logFile: z.string().default(''),
})
