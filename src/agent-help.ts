/**
 * Agent 工具说明的**唯一文案来源**（R11 06，spec D24 / D25）。
 *
 * 本文件刻意只放数据，不放实现：
 *  - 设置页按这里的顺序渲染；README 只留一行指针，不复制任何一条文案；
 *  - 每条只有「工具名 + 一句话 + 一个示例问法」，**不写参数签名** —— 参数是 `tools.ts`
 *    的 API 文档，抄到这里必然和实现漂移（D25 的明确取舍）；
 *  - 工具名必须与 `tools.ts` 里注册的 name 一致，但本文件不 import 它：客户端半只消费
 *    文案，不应把 host 的 tools 模块拖进 bundle。
 */

export interface AgentHelpEntry {
  /** 工具名（与 tools.ts 注册名一致）。 */
  readonly name: string
  /** 一句话说明它能做什么。 */
  readonly what: string
  /** 一个用户可以直接照着问的示例。 */
  readonly example: string
}

/**
 * 四条工具说明的固定顺序（D24 验收项）：先搜索、再看目录、再读正文、最后写操作。
 * 顺序按「读者的使用顺序」而不是字母序 —— 写操作放最后，与它的审批代价一致。
 */
export const AGENT_HELP: ReadonlyArray<AgentHelpEntry> = [
  {
    name: 'rss_search',
    what: '按关键词搜索本地文章，可按订阅源、文件夹、标签、已读状态、星标和日期筛选。',
    example: '帮我找上周关于「数据库迁移」的未读文章',
  },
  {
    name: 'rss_list_feeds',
    what: '列出订阅源、文件夹与标签，并给出每个源的未读数和最近抓取健康状况。',
    example: '我订了哪些源？哪个源最近老是抓取失败？',
  },
  {
    name: 'rss_read_article',
    what: '读取一篇已缓存文章的正文；没有缓存时说明原因，不会联网抓取。',
    example: '把刚才找到的那篇讲 Rust 的文章正文读出来',
  },
  {
    name: 'rss_update_item',
    what: '修改单条文章的已读或星标状态，每次调用都要你批准。',
    example: '把这篇标为已读，再给它加个星标',
  },
]

/**
 * 分区末尾的固定提示（D25）。写操作的工具虽然只有 setRead / setStarred，
 * 但提示按用户心智写全「标记已读 / 星标 / 改标签」—— 审批闸门是逐次、无例外的。
 */
export const AGENT_APPROVAL_NOTE = '写操作（标记已读 / 星标 / 改标签）每次都需要你批准。'
