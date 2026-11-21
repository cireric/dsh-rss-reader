/**
 * M3 02 —— 三个只读模型工具（`rss_search` / `rss_list_feeds` / `rss_read_article`）。
 *
 * 三条硬边界，都是 M3 01 的实测结论直接落成的代码约束（见 .scratch/rss-reader-m3/issues/01-host-capability-report.md）：
 *
 *  ① **只做全局注册**（插件自己的 ctx）。01 §2 实测：`agent.ctx` 的 per-agent 注册**不随插件卸载注销**，
 *     热重载后旧注册与旧闭包仍在活着的会话里 —— 只读工具本来就不需要按会话区分，没必要踩这个坑。
 *  ② **只读 = 不出网、不写库**。三个 execute 都不 import fetch、不调任何 save/update：
 *     `article` 端点会抓原站（唯一会出网的用户手势），所以正文读取**不能复用它**，只读缓存。
 *  ③ **有界输出**。每个集合（源/文件夹/标签/搜索结果）都有条数预算，每个可变长字段都有字符预算；
 *     任何一处被截断都在结果里**如实标出来**，不静默丢。
 *  ④ **写入是显式的、逐次审批的**（M3 03）。`rss_update_item` 只接受 `setRead` / `setStarred`
 *     两个显式动作（PRD §8.2 禁用 toggle，避免重试反转状态），且每次调用都要过
 *     `tools/pre-execute` 的 `ask` —— 没有审批通道时宿主会 fail-closed（M3 01 实测）。
 *     审批钩子挂在**插件自己的 ctx** 上，随 fiber 卸载一起撤掉，不留残余门禁。
 *
 * 为什么不复用 ENDPOINTS：端点的契约是「回一份可直接渲染的 UI 包封 + 未读账」，
 * 其中 overview/article 两条会触发刷新/抓取。工具要的是「同一份查询、零副作用」，
 * 因此这里只复用存储与搜索服务（同一套 SQL、同一个 worker），不经过端点层。
 */
import type { Context } from 'cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { EXTRACTOR_REVISION } from './article.js'
import { rebuildItem } from './domain.js'
import type { ItemRecord } from './domain.js'
import type { ReaderStore } from './store.js'
import { decodeFencedCursor, encodeFencedCursor, queryFenceKey } from './cursor-fence.js'
import type { SearchPage, SearchQuery } from './shared.js'

/** 搜索默认返回条数（PRD §8.2）。 */
export const SEARCH_DEFAULT_ITEMS = 10
/** 搜索硬上限：调用方传更大也只会拿到 30 条（PRD §8.2）。 */
export const SEARCH_MAX_ITEMS = 30
/** 单条片段上限（字符，按码点算）。 */
export const SNIPPET_MAX_CHARS = 280
/** 单篇正文上限（字符，按码点算）。 */
export const ARTICLE_MAX_CHARS = 8000
/** 条目标题上限。 */
export const TITLE_MAX_CHARS = 200
/** 短标签类字段（源标题 / 文件夹名 / 标签名）上限。 */
export const LABEL_MAX_CHARS = 120
/** 链接上限：超出的 URL 已不可用，截断并标记。 */
export const URL_MAX_CHARS = 2048
/** 失败原因上限。 */
export const FAILURE_MAX_CHARS = 280
/** 源目录条数上限。 */
export const FEEDS_MAX = 300
/** 文件夹目录条数上限。 */
export const FOLDERS_MAX = 100
/** 标签目录条数上限。 */
export const TAGS_MAX = 100
/** 单次搜索词上限，与端点侧 searchQuerySchema 同值（两处都是「模型输入」，口径要一致）。 */
const QUERY_MAX_CHARS = 120

/** `YYYY-MM-DD` 的**形状**（真实性另判，见 isRealDay）。 */
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** 工具的运行期依赖：只给「取 store」与「跑搜索」两件事，测试据此替换。 */
export interface ReadToolDeps {
  /** 存储可能还没打开（加载即刷新），每次调用现取 —— 与端点层同一条纪律。 */
  readonly ready: () => ReaderStore | undefined
  readonly searchItems: (
    query: SearchQuery,
    feeds: Array<[string, string]>,
    limit: number,
    signal?: AbortSignal,
  ) => Promise<SearchPage>
}

/** 取 store；未就绪时抛错（工具失败要响亮，不返回空列表冒充「没有结果」）。 */
function requireStore(deps: ReadToolDeps): ReaderStore {
  const store = deps.ready()
  if (store === undefined) throw new Error('RSS 阅读器尚未就绪（存储未打开），请稍后重试')
  return store
}

/** 按**码点**截断（`[...text]`），emoji/中文不会被切坏；返回是否真的截断过。 */
function clip(text: string, max: number): { text: string; truncated: boolean } {
  const chars = [...text]
  if (chars.length <= max) return { text, truncated: false }
  return { text: chars.slice(0, max).join(''), truncated: true }
}

/**
 * 截断一个可变长字段，截断时附 `<name>Truncated: true`。
 * @param name - 结果里的字段名（标记名就是它加 Truncated 后缀）。
 * @param value - 原始字符串。
 * @param max - 字符预算。
 * @returns 可直接展开进结果对象的片段。
 */
function field(name: string, value: string, max: number): Record<string, unknown> {
  const clipped = clip(value, max)
  return clipped.truncated ? { [name]: clipped.text, [name + 'Truncated']: true } : { [name]: clipped.text }
}

/** 可空的短标签字段：null 原样保留（缺省与「空串」是两件事）。 */
function optionalField(name: string, value: string | undefined, max: number): Record<string, unknown> {
  return value === undefined ? { [name]: null } : field(name, value, max)
}

/**
 * `YYYY-MM-DD` 是不是**真实存在**的那一天。
 *
 * 只查正则不够：`2026-02-30` 形状合法，而 `Date.parse` 会把它悄悄滚成 3 月 2 日 ——
 * 于是「2 月 30 日以后的文章」这种查询会返回一批看似合理的结果（2026-11-13 审查发现）。
 * 判据是 UTC 三要素回读相等。
 * @param value - 候选日期串。
 * @returns 是否为真实日历日。
 */
function isRealDay(value: string): boolean {
  if (!DAY.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** 参数表里出现过、且类型不对 ⇒ 明确失败，绝不退回全库查询。 */
function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(name + ' 必须是字符串')
  return value
}

/** 同上，布尔版。 */
function optionalBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(name + ' 必须是布尔值')
  return value
}

/**
 * 把结构化正文块摊成 **Markdown**（模型读的那一份）；`paragraphs` 是升级前老缓存的兼容读。
 *
 * ⚠️ 名字里的 `Markdown` 是判据不是装饰：`article-text.ts` 的 `blocksToText` 输出的是**纯文本**
 * （统计 / 搜索 / 时长读它），两者语义不同、**不许合并**。合并会把「模型读 Markdown」与「统计读
 * 纯文本」合成一个口径，而下一个改 Markdown 形态的人不会想到自己顺手改了缓存额度口径。
 *
 * 正文回给模型的文本逐字节由本函数决定：`## 小节`、`- ` 列表、`pre` 围栏都是既有形态，改动即回归。
 */
function blocksToMarkdown(
  blocks: ReadonlyArray<Record<string, unknown>> | undefined,
  paragraphs: readonly string[] | undefined,
): string {
  if (blocks === undefined || blocks.length === 0) return (paragraphs ?? []).join('\n\n')
  const lines: string[] = []
  for (const block of blocks) {
    const kind = block.kind
    if (kind === 'list') {
      const listItems = Array.isArray(block.items) ? block.items.map(item => String(item)) : []
      lines.push(listItems.map((item, index) => (block.ordered === true ? index + 1 + '. ' : '- ') + item).join('\n'))
      continue
    }
    if (kind === 'img') {
      // 图片没有正文可读，但「这里有一张图」对模型仍是信息（alt 优先，其次 src）。
      lines.push('[图片] ' + String(block.alt ?? block.src ?? ''))
      continue
    }
    if (kind === 'h') {
      lines.push('#'.repeat(Math.max(1, Number(block.level ?? 1))) + ' ' + String(block.text ?? ''))
      continue
    }
    if (kind === 'pre') {
      lines.push('```\n' + String(block.text ?? '') + '\n```')
      continue
    }
    lines.push(String(block.text ?? ''))
  }
  return lines.filter(line => line !== '').join('\n\n')
}

/** 一个条目的模型可见摘要（`ItemView` → PRD §8.2 的字段表）。 */
function digestOf(item: SearchPage['items'][number]): Record<string, unknown> {
  return {
    itemId: item.id,
    ...field('title', item.title, TITLE_MAX_CHARS),
    ...field('feedTitle', item.feedTitle, LABEL_MAX_CHARS),
    publishedAt: item.publishedAt ?? null,
    ...field('url', item.link, URL_MAX_CHARS),
    ...field('snippet', item.summary ?? '', SNIPPET_MAX_CHARS),
    readAt: item.readAt ?? null,
    starred: item.starred,
  }
}

/** 一个目录的条数预算信封：`total` 永远是真实条数，`truncated` 说明有没有被截。 */
function catalogue<T>(items: readonly T[], max: number): { total: number; truncated: boolean; items: T[] } {
  return { total: items.length, truncated: items.length > max, items: items.slice(0, max) }
}

/** `rss_search`：关键词 / 时间 / 未读 / 星标 / 单源筛选 + keyset 分页。 */
function searchTool(deps: ReadToolDeps): ToolDefinition {
  return {
    name: 'rss_search',
    description:
      'Search the reader\'s locally stored RSS items and return paginated summaries with source links. '
      + 'Read-only: it never contacts the original sites and never changes read state. '
      + 'Use rss_read_article to get the full cached text of one item.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Keywords, space-separated. Omit or leave empty to match every stored item.' },
        feedId: { type: 'string', description: 'Restrict to one feed id taken from rss_list_feeds.' },
        unread: { type: 'boolean', description: 'true = only unread items.' },
        starred: { type: 'boolean', description: 'true = only starred items.' },
        since: { type: 'string', description: 'Inclusive lower bound on the item date, a real YYYY-MM-DD day.' },
        limit: { type: 'integer', description: 'Page size, 1-' + SEARCH_MAX_ITEMS + ', default ' + SEARCH_DEFAULT_ITEMS + '.' },
        cursor: { type: 'string', description: 'nextCursor from the previous call with the same filters.' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(rawArgs, exec) {
      const store = requireStore(deps)
      const args = (rawArgs ?? {}) as Record<string, unknown>

      const rawQuery = optionalString(args, 'query')
      const text = (rawQuery ?? '').trim()
      if ([...text].length > QUERY_MAX_CHARS) {
        throw new Error('query 过长：上限 ' + QUERY_MAX_CHARS + ' 个字符')
      }
      // 空串等价于「不限关键词」，但**类型错了**绝不退化成全库查询（审查发现：传入数字会静默返回全部）。
      const rawFeedId = optionalString(args, 'feedId')
      if (rawFeedId !== undefined && rawFeedId.trim() === '') {
        throw new Error('feedId 不能是空字符串（省略它才表示不按源筛选）')
      }
      const feedId = rawFeedId
      if (feedId !== undefined && store.feed(feedId) === undefined) {
        throw new Error('未知的订阅源 id：' + feedId + '（先用 rss_list_feeds 取有效 id）')
      }
      const rawSince = optionalString(args, 'since')
      const since = rawSince === undefined || rawSince === '' ? undefined : rawSince
      if (since !== undefined && !isRealDay(since)) {
        throw new Error('since 必须是真实存在的 YYYY-MM-DD 日期')
      }
      const unread = optionalBoolean(args, 'unread') === true
      const starred = optionalBoolean(args, 'starred') === true
      const rawCursor = optionalString(args, 'cursor')
      const rawLimit = args.limit
      if (rawLimit !== undefined && (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit <= 0)) {
        throw new Error('limit 必须是正整数')
      }
      const limit = Math.min(typeof rawLimit === 'number' ? rawLimit : SEARCH_DEFAULT_ITEMS, SEARCH_MAX_ITEMS)

      const feeds: Array<[string, string]> = store.listFeeds()
        .filter(([id]) => feedId === undefined || id === feedId)
        .map(([id, feed]) => [id, feed.title ?? id])

      // 与 searchItems 端点共用同一份查询栅栏（src/cursor-fence.ts）：换条件必须换键。
      const key = queryFenceKey([text, unread, starred, since, feeds.map(([id]) => id).sort()])
      const supplied = rawCursor === '' ? undefined : rawCursor
      const parsed = decodeFencedCursor(key, supplied)
      if (parsed.status === 'mismatch') throw new Error('分页游标与当前搜索条件不匹配，请重新搜索')

      const page = await deps.searchItems({
        text,
        ...(feedId === undefined ? {} : { feedId }),
        ...(unread ? { read: 'unread' as const } : {}),
        ...(starred ? { starred: true } : {}),
        ...(since === undefined ? {} : { from: since }),
        ...(parsed.inner === undefined ? {} : { cursor: parsed.inner }),
      }, feeds, limit, exec.signal)

      return {
        query: text,
        count: page.items.length,
        items: page.items.map(digestOf),
        ...(page.nextCursor === undefined ? {} : { nextCursor: encodeFencedCursor(key, page.nextCursor) }),
      }
    },
  }
}

/** `rss_list_feeds`：订阅源目录 + 文件夹 + 标签 + 每源未读/健康。 */
function feedsTool(deps: ReadToolDeps): ToolDefinition {
  return {
    name: 'rss_list_feeds',
    description:
      'List the reader\'s feeds with folder, unread count and last fetch health, plus the folder and tag catalogues. '
      + 'Read-only: metadata only, no article text and no network. Every catalogue reports its true total and whether it was truncated.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute() {
      const store = requireStore(deps)
      const feeds = store.listFeeds()
      const unread = store.unreadPerFeed(feeds.map(([id]) => id))
      const rows = feeds.map(([id, feed]) => ({
        ...field('id', id, URL_MAX_CHARS),
        ...field('title', feed.title ?? id, LABEL_MAX_CHARS),
        ...optionalField('folder', feed.folder, LABEL_MAX_CHARS),
        unread: unread[id] ?? 0,
        lastFetchedAt: feed.lastFetchedAt ?? null,
        ...optionalField('lastFailure', feed.lastFailure, FAILURE_MAX_CHARS),
      }))
      const folders = store.listFolders().map(folder => ({
        ...field('name', folder.name, LABEL_MAX_CHARS),
        feedCount: folder.feedIds.length,
      }))
      const tags = store.listTags().map(tag => ({
        id: tag.id,
        ...field('name', tag.name, LABEL_MAX_CHARS),
      }))
      return {
        feeds: catalogue(rows, FEEDS_MAX),
        folders: catalogue(folders, FOLDERS_MAX),
        tags: catalogue(tags, TAGS_MAX),
      }
    },
  }
}

/** `rss_read_article`：只读缓存正文；缺缓存时给出**可解释**的原因，绝不联网。 */
function articleTool(deps: ReadToolDeps): ToolDefinition {
  return {
    name: 'rss_read_article',
    description:
      'Read the cached full text of one stored item by id. Read-only: it never fetches the original page and never '
      + 'marks the item as read. Returns cached:false with a reason when no usable cache exists.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { itemId: { type: 'string', description: 'Item id from rss_search.' } },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(rawArgs) {
      const store = requireStore(deps)
      const args = (rawArgs ?? {}) as Record<string, unknown>
      const rawItemId = args.itemId
      if (rawItemId !== undefined && typeof rawItemId !== 'string') throw new Error('itemId 必须是字符串')
      const itemId = String(rawItemId ?? '')
      if (itemId === '') throw new Error('itemId 必填')

      const record: ItemRecord | undefined = store.item(itemId)
      if (record === undefined) {
        return { itemId, cached: false, reason: '条目不存在：可能从未抓取过，或已被清理' }
      }
      // ⚠️ **先确认这条还属于当前订阅，再谈任何元数据/正文**（审查发现）：
      // 正常退订会连同条目一起删掉（store.deleteSubscription），但半途失败或手工改库仍可能留下
      // 孤儿行。照搬 record.feedId 回给模型，等于让一个已退订的来源继续通过 Agent 对外提供标题与正文。
      const subscribed = new Set(store.listFeeds().map(([id]) => id))
      if (!subscribed.has(record.feedId)) {
        return { itemId, cached: false, reason: '该条目所属订阅源已退订，内容不再对外提供' }
      }

      const base = {
        itemId,
        ...field('title', record.title, TITLE_MAX_CHARS),
        ...field('url', record.link, URL_MAX_CHARS),
        feedId: record.feedId,
        publishedAt: record.publishedAt ?? null,
      }
      const article = record.article
      if (article === undefined) {
        return {
          ...base,
          cached: false,
          reason: record.articleFailure === undefined
            ? '尚未缓存正文（阅读器里还没打开过这篇，本工具不联网抓取）'
            : '上次取正文失败：' + record.articleFailure,
        }
      }
      if (article.revision !== EXTRACTOR_REVISION) {
        return {
          ...base,
          cached: false,
          reason: '缓存正文已过期（抽取器版本变化），需在阅读器里重新打开该篇',
        }
      }
      const text = blocksToMarkdown(article.blocks, article.paragraphs)
      const clipped = clip(text, ARTICLE_MAX_CHARS)
      return {
        ...base,
        cached: true,
        chars: [...text].length,
        text: clipped.text,
        ...(clipped.truncated ? { truncated: true } : {}),
      }
    },
  }
}

/** `rss_update_item`：显式动作的写工具（setRead / setStarred），每次调用都要人点头。 */
function updateTool(deps: ReadToolDeps): ToolDefinition {
  return {
    name: 'rss_update_item',
    description:
      'Change the read or starred state of exactly one stored item. Write tool: every call requires an explicit '
      + 'human approval. Uses explicit actions (setRead / setStarred), never toggles, so a retry cannot flip state. '
      + 'It never fetches the original page and never touches the cached article text.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        itemId: { type: 'string', description: 'Item id from rss_search.' },
        setRead: { type: 'boolean', description: 'true = mark as read, false = mark as unread. Omit to leave unchanged.' },
        setStarred: { type: 'boolean', description: 'true = star, false = unstar. Omit to leave unchanged.' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(rawArgs) {
      const store = requireStore(deps)
      const args = (rawArgs ?? {}) as Record<string, unknown>

      const rawItemId = args.itemId
      if (rawItemId !== undefined && typeof rawItemId !== 'string') throw new Error('itemId 必须是字符串')
      const itemId = String(rawItemId ?? '')
      if (itemId === '') throw new Error('itemId 必填')

      const setRead = optionalBoolean(args, 'setRead')
      const setStarred = optionalBoolean(args, 'setStarred')
      // 一个动作都没有 = 调用方以为自己在写但什么都不会发生。响亮拒绝，别回一个「成功」。
      if (setRead === undefined && setStarred === undefined) {
        throw new Error('至少提供 setRead 或 setStarred 之一（本工具不接受 toggle）')
      }

      const existing = store.item(itemId)
      if (existing === undefined) throw new Error('条目不存在：' + itemId)
      // 与只读工具同一条归属判据：退订源的残留条目不许被 Agent 改。
      const subscribed = new Set(store.listFeeds().map(([id]) => id))
      if (!subscribed.has(existing.feedId)) {
        throw new Error('该条目所属订阅源已退订，不允许修改')
      }

      let changed = false
      let next: ItemRecord | undefined
      // **原子读改写**（store 契约）：fn 看到的是库里的当前值，并发窗口内不会互相覆盖。
      await store.updateItem(itemId, current => {
        const omit: Array<keyof ItemRecord> = []
        const set: Partial<ItemRecord> = {}
        if (setRead === true && current.readAt === undefined) {
          // 与 markRead 端点同一语义：标为已读时同时清掉 kept-unread（规格 §3.3）
          omit.push('keptUnread')
          set.readAt = new Date().toISOString()
        }
        if (setRead === false && current.readAt !== undefined) {
          // 只撤销 readAt；keptUnread 与正文缓存都不动（unmarkRead 的同一条教训）
          omit.push('readAt')
        }
        if (setStarred !== undefined && current.starred !== setStarred) set.starred = setStarred
        if (omit.length === 0 && Object.keys(set).length === 0) {
          next = current
          return current
        }
        changed = true
        next = rebuildItem(current, { omit, set })
        return next
      })

      const record = next ?? store.item(itemId)
      if (record === undefined) throw new Error('写入后读不回条目：' + itemId)
      return {
        itemId,
        readAt: record.readAt ?? null,
        starred: record.starred,
        changed,
      }
    },
  }
}

/**
 * 在插件自己的 ctx 上注册 Agent 工具（随 fiber 卸载自动注销；不要改成 `agent.ctx`）。
 *
 * 写入的**逐次审批**是 PRD §8.1 的硬要求，实现点只有下面这个 `tools/pre-execute`：
 * `ask` 交给宿主审批服务，没有通道时宿主 fail-closed（M3 01 §5 实测的
 * "requires approval, but no approval channel is available"）。
 * 它是 **waterfall**：非本工具的调用必须 `next()` 放行，漏掉一句就等于把全站工具闸死。
 * @param ctx - 插件上下文，需已注入 `tools`。
 * @param deps - 取 store 与跑搜索的两个入口。
 */
export function registerAgentTools(ctx: Context, deps: ReadToolDeps): void {
  // 必须 in inject 里声明过 `tools`：未声明的服务经服务解析器求值会得到 undefined，
  // 而这里若写成「取不到就返回」，插件在真机上会**静默**少掉三个工具（2026-11-13 实测踩到：
  // test 夹具里 ctx.tools 有值所以全绿，活体宿主里没有注入就是 undefined）。
  ctx.tools.register(searchTool(deps))
  ctx.tools.register(feedsTool(deps))
  ctx.tools.register(articleTool(deps))
  ctx.tools.register(updateTool(deps))

  // 逐次审批：挂插件自己的 ctx ⇒ 卸载时随 fiber 一起撤掉（不留残余门禁）。
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name !== 'rss_update_item') return next()
    const args = (exec.arguments ?? {}) as { itemId?: unknown }
    return Promise.resolve({
      kind: 'ask' as const,
      reason: 'rss_update_item 请求修改条目 ' + String(args.itemId ?? '(未知)') + ' 的阅读状态，请确认是否允许',
    })
  })
}
