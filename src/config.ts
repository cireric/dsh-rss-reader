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
   * 默认值仍是 8 000 000，但它的含义变了：以前是「**每个源各自** 8M 字符」，现在是「全部源合计 8M」。
   *
   * ⇒ **受影响的不是「显式配过这个值的人」，而是**所有源数 > 1 的用户**，含没配过的默认用户：
   * 旧代码是**逐源**调用闸门的，所以一个 50 源的默认用户实际拿到的额度是 50 × 8M ≈ 4 亿字符；
   * 现在他的上限塌成 8M，即**缩小了约 50 倍**。这次改动去掉的就是那个意外的 N 倍放大。
   * 后果的表现：刷新一轮后正文缓存被清到只剩一小部分（条目、已读态、星标**不受影响**，
   * 丢的只是按需正文，再打开会重新抓——但对源多的用户那是一次明显的「缓存好像不生效了」）。
   *
   * **嫌紧就把值按源数调大**：50 个源想要旧的等效额度（每源 8M）就配 400 000 000。
   * 之所以不把默认值直接改成 8M × 常见源数：那样又让这个「与源数无关」的默认预算
   * 变成事实上的无上限，而这道闸门存在的理由正是它得是个上限。
   */
  maxArticleCacheChars: number
  /** 显式清理的天数阈值：早于「现在 − 该天数」的已读条目才可清理 */
  cleanupAfterDays: number
  /** OPML 导入时的逐源校验并发上限（≥20 源逐个抓太慢，全放出去又不友好） */
  importConcurrency: number
  /**
   * 刷新时同时在飞的抓取数。
   *
   * ⚠️ **这个值至今没有实测过**（不是「测过之后定成 5」，是「还没测」）。
   * spec §9.3 要求「同一台机器、20 个真实源」实测后再定；开发环境够不到真实外部源
   * （沙箱里只有本地桩），所以默认值保持历史值 5，**没有**照抄 spec §6 的「8–12」——
   * 那是个未经本机验证的区间，照抄就等于把别人的数当成自己的测量结果。
   *
   * 待测实验（有网络的人照这个跑）：20 个真实源（覆盖慢源与快源各半），固定其它参数，
   * 扫 refreshConcurrency ∈ {1, 2, 4, 5, 8, 12}，每档重复 3 轮，记录每轮的墙钟时间与
   * 失败/超时数。**证据形式** = 一张 (并发, 中位墙钟, 超时数) 表：出现「再加并发墙钟不降」
   * 或「超时数开始上升」的那个拐点，就是该机器该网络的合理上限。
   * 拿不到那张表之前，这里的 5 只是「不比现状差」的占位值。
   *
   * 本机跑过一条**合成**标定（`实测`，但**不是** spec §9.3 要的那种）：20 个本地桩源、
   * 每源固定 20ms 延迟、每档 3 轮取中位墙钟 —— 并发 1 → 465ms、2 → 233、4 → 118、5 → 100、
   * 8 → 74、12 → 51。它只证明「这个旋钮在本机确实按并发生效、且全程仍受上限约束」；
   * 桩件没有 RTT / DNS / TLS / 限流，所以**不能**用它推真实源该取几 —— 那是上面那张表的活。
   */
  refreshConcurrency: number
  /**
   * 每轮刷新最多抓多少个源（按陈旧度取最旧的 K 个，见 refresh.ts 的 selectStalestFeeds）。
   *
   * 这是「一轮 600s」那条缺陷（spec §3：200 源 × 15s 超时 ÷ 并发 5）的修法所在：
   * 调度必须有界，否则每轮的网络工作量随订阅数线性增长。
   *
   * **默认 20 是起点值，不是测量结果**（同上：没有真实源可测，不编造「最优 K」）。
   * 它只保证最坏一轮从「源数 × 超时 ÷ 并发」变成「20 × 超时 ÷ 并发」——
   * 默认配置下即 20 × 15 ÷ 5 = 60s，与源数脱钩。
   *
   * 有界之所以安全，唯一理由是排序按**陈旧度**：本轮没选中的源下一轮最旧，必然被选中
   * （旋转论证与判据见 refresh.ts 的 selectStalestFeeds 与 tests/refresh.test.mjs 的
   * 「饥饿不变式」用例）。调大 = 每轮更全但更慢，调小 = 每轮更快但源更新更稀；
   * 一律不会被饿死。0 / 负数 / NaN 视为「未配置」⇒ 退回抓全部（不是「一个都不抓」）。
   *
   * 计时口径：一轮 = 一批（有界），不是「全部源都抓过一遍」。
   */
  refreshFeedsPerRound: number
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
  // 20 见上面的注释：起点值，不是实测值；安全性由「按陈旧度旋转」保证，不靠这个数字
  refreshFeedsPerRound: z.number().default(20),
  articleMaxBytes: z.number().default(2 * 1024 * 1024),
  articleCooldownMs: z.number().default(30000),
  refreshOnStart: z.boolean().default(true),
  minRefreshIntervalMs: z.number().default(10 * 60 * 1000),
  maxItemsShown: z.number().default(300),
  logFile: z.string().default(''),
})
