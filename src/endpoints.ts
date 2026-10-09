/**
 * 浏览器半的读写通道：11 个端点（2026-10-07 从 index.ts 拆出）。
 *
 * 原先 Config + 日志 + 域生命周期 + 全部端点挤在一个闭包（630 行），任一能力改动都要动同一个
 * 文件。这里只留「请求 → 结果」这一层，闭包依赖显式收进 EndpointDeps —— 端点不再隐式依赖
 * apply 的局部变量。
 */
import type { Config } from './config.js'
import { EXTRACTOR_REVISION, fetchArticle, blocksToText } from './article.js'
import { rebuildItem } from './domain.js'
import { articleCharsOf, selectCleanup, type CleanupRow } from './retention.js'
import { buildOpml, parseOpml } from './opml.js'
import { validateSubscriptions } from './subscribe.js'
import type { ReaderStore } from './store.js'
import { fail, ok, recencyOf, type Endpoint, type ItemView, type Overview, type RpcResult } from './shared.js'

/** 端点需要的运行时依赖（显式传入，不靠闭包）。 */
export interface EndpointDeps {
  readonly config: Config
  readonly log: (message: string) => void
  readonly ready: () => ReaderStore | undefined
  readonly refreshNow: (options?: { force?: boolean; signal?: AbortSignal }) => Promise<boolean>
  /** 上次刷新完成时间（刷新状态留在 index.ts 那侧，这里只读） */
  readonly lastRefreshCompletedAt: () => number | undefined
  readonly articleAttempts: Map<string, number>
}

export function createDispatch(deps: EndpointDeps): (endpoint: string, payload: unknown) => Promise<RpcResult<unknown>> {
  const { config, log, ready, refreshNow, lastRefreshCompletedAt, articleAttempts } = deps

/**
 * 按需正文缓存的**内容版本** = 抽取器版本（定义在 article.ts，与抽取逻辑同文件）。
 *
 * 缓存命中要求版本相等——版本落后就被判为过期并**自动重抓一次**，否则抽取规则的改进对已有
 * 缓存永远不生效（实测两次：库里 9 条老缓存导致「图片怎么都不显示」；上一轮改了抽取但没抬版本，
 * 已缓存的文章继续显示站点头像与二维码）。**不要再在这里写死数字**——那正是它上次漂移的方式。
 */
const ARTICLE_REVISION = EXTRACTOR_REVISION
  const buildOverview = (refreshed: boolean): Overview => {
    const refreshedAtMs = lastRefreshCompletedAt()
    const target = ready()
    if (!target) return { feeds: [], items: [], unread: 0, refreshed }

    const feeds = target.listFeeds().map(([feedId, record]) => ({
      id: feedId,
      title: record.title ?? feedId,
      lastFetchedAt: record.lastFetchedAt,
      lastFailure: record.lastFailure,
    }))

    // **一次遍历全部条目**。原先是对每个源各调一次 listItems(feedId)，而那个实现每次都要遍历
    // 全表 ⇒ O(源数 × 条目数)：实测 100 源 × 400 条时遍历 400 万次、耗时 35ms（2026-10-07 实测）。
    // 只收「所属源还在」的条目，与原先由 listFeeds 驱动的语义保持一致。
    const titles = new Map(feeds.map((feed) => [feed.id, feed.title]))
    const items: ItemView[] = []
    for (const [itemId, item] of target.allItems()) {
      const feedTitle = titles.get(item.feedId)
      if (feedTitle === undefined) continue
      items.push({
        id: itemId,
        feedId: item.feedId,
        feedTitle,
        title: item.title,
        link: item.link,
        publishedAt: item.publishedAt,
        fetchedAt: item.fetchedAt,
        readAt: item.readAt,
        starred: item.starred,
        keptUnread: item.keptUnread,
        summary: item.summary,
      })
    }
    items.sort((a, b) => {
      const byTime = recencyOf(b).localeCompare(recencyOf(a))
      return byTime !== 0 ? byTime : a.id.localeCompare(b.id)
    })

    return {
      feeds,
      items: items.slice(0, config.maxItemsShown),
      unread: items.filter((item) => item.readAt === undefined).length,
      refreshed,
      // 让界面能说明「上次到底什么时候抓过」——否则「按住刷新没反应」无从判断
      refreshedAt: refreshedAtMs === undefined ? undefined : new Date(refreshedAtMs).toISOString(),
    }
  }

  const countUnread = (target: ReaderStore): number =>
    target.listFeeds().reduce((sum, [feedId]) => sum + target.listItems(feedId).filter(([, i]) => i.readAt === undefined).length, 0)

  // 浏览器半的读写通道：宿主自有 HTTP 路由 + connection 的准入检查（见 shared.ts 注释）。
  const dispatch = async (endpoint: string, payload: unknown): Promise<RpcResult<unknown>> => {
    // 不把异常 throw 进通道：调用方需要的是带 code 的失败信封
    try {
      const target = ready()
      if (!target) return fail('not-ready', '存储域尚未就绪，稍后重试')

      switch (endpoint as Endpoint) {
        case 'overview':
          return ok(buildOverview(false))

        case 'refresh': {
          const refreshed = await refreshNow()
          return ok(buildOverview(refreshed))
        }

        case 'markRead': {
          const body = payload as { itemIds?: unknown; skipKept?: unknown; before?: unknown } | null
          const itemIds = Array.isArray(body?.itemIds) ? (body as { itemIds: unknown[] }).itemIds.map(String) : []
          if (itemIds.length === 0) return fail('bad-request', 'markRead 需要 itemIds 数组')
          // 「全部标为已读」（A 键）走这条时带 skipKept：**保持未读的条目要活下来**
          // —— 那正是规格 §3.3 里 kept-unread 的用处；而单条打开/显式标记不带它，
          // 那种情况下按规格「标为已读即移除 kept-unread」。
          const skipKept = body?.skipKept === true
          // 「只标**早于** X 的」（规格 §3.3 的 panic button，2009-08 加入）。客户端会先按范围过滤一遍，
          // 这里是**第二道闸**：客户端列表只是快照，宿主手上的 recency 才是权威。
          const before = typeof body?.before === 'string' && body.before !== '' ? body.before : undefined
          const stamp = new Date().toISOString()
          let changed = 0
          for (const itemId of itemIds) {
            const existing = target.item(itemId)
            if (existing === undefined || existing.readAt !== undefined) continue
            if (skipKept && existing.keptUnread === true) continue
            // 判据与排序同源（recency = 发布时间优先、缺则抓取时间），ISO 字符串可直接比大小
            if (before !== undefined && recencyOf(existing) >= before) continue
            // 幂等：已读的原时间戳不动。用 rebuildItem 是为了同时把 kept-unread 去掉
            await target.saveItem(itemId, rebuildItem(existing, { omit: ['keptUnread'], set: { readAt: stamp } }))
            changed += 1
          }
          return ok({ changed, unread: countUnread(target) })
        }

        case 'unmarkRead': {
          // 只服务于「全部标记已读」的短时撤销
          const itemIds = Array.isArray((payload as { itemIds?: unknown } | null)?.itemIds)
            ? ((payload as { itemIds: unknown[] }).itemIds.map(String))
            : []
          if (itemIds.length === 0) return fail('bad-request', 'unmarkRead 需要 itemIds 数组')
          let changed = 0
          for (const itemId of itemIds) {
            const existing = target.item(itemId)
            if (existing === undefined || existing.readAt === undefined) continue
            // 只去掉 readAt：原先这里调的那个 helper 按 7 个字段重建，会把 article 缓存
            // 一起丢掉——撤销「全部已读」不该动内容缓存（2026-10-07 随三处重建收敛时修掉）
            await target.saveItem(itemId, rebuildItem(existing, { omit: ['readAt'] }))
            changed += 1
          }
          return ok({ changed, unread: countUnread(target) })
        }

        case 'article': {
          // 按需正文（V 键）：先看缓存，再冷却，最后才抓原站。三步都留日志——这是唯一会
          // 出网的用户手势，出问题时必须能从日志里还原过程。
          const itemId = String((payload as { itemId?: unknown } | null)?.itemId ?? '')
          if (!itemId) return fail('bad-request', 'article 需要 itemId')
          const existing = target.item(itemId)
          if (existing === undefined) return fail('not-found', '条目不存在：' + itemId)
          // 命中缓存的前提：**缓存的内容版本等于当前版本**。
          // 老缓存（升级前抓的，只有纯文本 paragraphs）没有版本号 ⇒ 判为过期、自动重抓一次。
          // 否则模型升级后老缓存会永远挡住新逻辑——实测：9 条老缓存导致「图片怎么都不显示」。
          if (existing.article !== undefined && existing.article.revision === ARTICLE_REVISION) {
            return ok({
              itemId, cached: true, title: existing.article.title,
              blocks: existing.article.blocks, paragraphs: existing.article.paragraphs,
              frameable: existing.article.frameable,
            })
          }
          if (existing.link === '') return fail('bad-request', '该条目没有可抓取的链接')

          const lastAt = articleAttempts.get(itemId)
          if (lastAt !== undefined && Date.now() - lastAt < config.articleCooldownMs) {
            const wait = Math.ceil((config.articleCooldownMs - (Date.now() - lastAt)) / 1000)
            return fail('cooldown', '刚刚取过这篇正文，请 ' + wait + ' 秒后再试')
          }
          articleAttempts.set(itemId, Date.now())

          log('取正文：' + existing.link)
          const fetched = await fetchArticle(existing.link, {
            timeoutMs: config.timeoutMs,
            maxBytes: config.articleMaxBytes,
          })
          if (fetched.kind === 'failed') {
            // 失败原因存进条目：用户重开时能看到，且不必再等一次网络往返
            await target.saveItem(itemId, { ...existing, articleFailure: fetched.reason })
            log('取正文失败：' + existing.link + ' → ' + fetched.reason)
            return ok({ itemId, cached: false, failure: fetched.reason })
          }
          const article = {
            fetchedAt: new Date().toISOString(),
            revision: ARTICLE_REVISION,
            title: fetched.title,
            blocks: fetched.blocks,
            frameable: fetched.frameable,
          }
          // 成功要清掉旧的失败原因：交给 rebuildItem（它按 schema 字段表搬运，不会漏字段）
          await target.saveItem(itemId, rebuildItem(existing, { omit: ['articleFailure'], set: { article } }))
          log('取正文成功：' + existing.link + '（' + fetched.blocks.length + ' 块 ' +
            blocksToText(fetched.blocks).length + ' 字符）')
          return ok({ itemId, cached: false, title: article.title, blocks: article.blocks, frameable: article.frameable })
        }

        case 'opmlExport': {
          const feeds = target.listFeeds().map(([feedUrl, record]) => ({
            url: feedUrl, title: record.title, folder: record.folder,
          }))
          return ok({ opml: buildOpml(feeds), feedCount: feeds.length })
        }

        case 'opmlImport': {
          // §3.1：导入时**逐源抓取校验**，坏源单独标注、不阻断其余。
          const text = String((payload as { opml?: unknown } | null)?.opml ?? '')
          if (text.trim() === '') return fail('bad-request', 'opmlImport 需要 opml 文本')
          const parsed = parseOpml(text)
          if (parsed.subscriptions.length === 0) {
            return ok({
              added: 0, existed: 0, failed: [], skipped: parsed.skipped, accepted: [],
            })
          }

          const checked = await validateSubscriptions(
            parsed.subscriptions.map((subscription) => subscription.xmlUrl),
            { limits: { timeoutMs: config.timeoutMs, maxBytes: config.maxBytes, trustedTarget: true }, concurrency: config.importConcurrency },
          )

          const byUrl = new Map(parsed.subscriptions.map((subscription) => [subscription.xmlUrl, subscription]))
          const accepted: Array<{ url: string; title?: string; folder?: string }> = []
          const failed: Array<{ url: string; reason: string }> = []
          let added = 0
          let existed = 0

          for (const result of checked) {
            if (!result.ok) {
              failed.push({ url: result.url, reason: result.reason ?? '校验失败' })
              continue
            }
            const subscription = byUrl.get(result.url)
            const previous = target.feed(result.url)
            existed += previous === undefined ? 0 : 1
            added += previous === undefined ? 1 : 0
            // 已存在的源保留其 folder（用户可能在界面上改过），新源才写入 OPML 的分组
            await target.saveFeed(result.url, {
              url: result.url,
              title: result.title ?? subscription?.title ?? previous?.title,
              folder: previous?.folder ?? subscription?.folder,
              etag: previous?.etag,
              lastModified: previous?.lastModified,
              lastFetchedAt: previous?.lastFetchedAt,
            })
            accepted.push({ url: result.url, title: result.title ?? subscription?.title, folder: previous?.folder ?? subscription?.folder })
          }

          log('导入 OPML：新增 ' + added + ' 源，已存在 ' + existed + ' 源，校验失败 ' + failed.length +
            ' 源，文件内跳过 ' + parsed.skipped.length + ' 项')
          return ok({ added, existed, failed, skipped: parsed.skipped, accepted })
        }

        case 'addFeed': {
          const raw = String((payload as { url?: unknown } | null)?.url ?? '')
          const checked = await validateSubscriptions([raw], {
            limits: { timeoutMs: config.timeoutMs, maxBytes: config.maxBytes, trustedTarget: true },
            concurrency: 1,
          })
          const result = checked[0]
          if (result === undefined || !result.ok) {
            return ok({ added: 0, existed: 0, failed: [{ url: raw, reason: result?.reason ?? '校验失败' }], skipped: [], accepted: [] })
          }
          const previous = target.feed(result.url)
          await target.saveFeed(result.url, {
            url: result.url,
            title: result.title ?? previous?.title,
            folder: previous?.folder,
            etag: previous?.etag,
            lastModified: previous?.lastModified,
            lastFetchedAt: previous?.lastFetchedAt,
          })
          return ok({
            added: previous === undefined ? 1 : 0,
            existed: previous === undefined ? 0 : 1,
            failed: [], skipped: [],
            accepted: [{ url: result.url, title: result.title, folder: previous?.folder }],
          })
        }

        case 'removeFeed': {
          const feedId = String((payload as { url?: unknown } | null)?.url ?? '')
          if (!feedId) return fail('bad-request', 'removeFeed 需要 url')
          const known = target.feed(feedId)
          if (known === undefined) return fail('not-found', '订阅不存在：' + feedId)
          // 连带删掉该源的全部条目与游标——留着孤儿条目只会让人困惑
          const items = target.listItems(feedId)
          for (const [itemId] of items) await target.deleteItem(itemId)
          await target.deleteFeed(feedId)
          log('退订 ' + feedId + '（连带删除 ' + items.length + ' 条条目）')
          return ok({ removed: 1, items: items.length })
        }

        case 'cleanup': {
          // 显式清理（用户点按钮触发，**不设定时器**——验收项之一就是不残留定时器）。
          // 判据刻意保守：已读 + 未星标 + 早于阈值，三个条件缺一不可（见 retention.ts 注释）。
          const cutoff = new Date(Date.now() - config.cleanupAfterDays * 24 * 3600 * 1000).toISOString()
          const all = target.allItems()
          const rows: CleanupRow[] = all.map(([itemId, record]) => ({
            id: itemId,
            starred: record.starred,
            kept: record.keptUnread === true,
            read: record.readAt !== undefined,
            recency: recencyOf(record),
            articleChars: articleCharsOf(record.article),
          }))
          const doomed = selectCleanup(rows, cutoff)
          const freedChars = rows.filter((row) => doomed.includes(row.id))
            .reduce((sum, row) => sum + row.articleChars + (target.item(row.id)?.summary?.length ?? 0), 0)
          for (const itemId of doomed) await target.deleteItem(itemId)
          log('清理：删除 ' + doomed.length + ' 条已读旧条目（阈值 ' + config.cleanupAfterDays + ' 天，释放约 ' +
            freedChars + ' 字符）')
          return ok({ deleted: doomed.length, freedChars, cutoff, unread: countUnread(target) })
        }

        case 'toggleKeepUnread': {
          // 「保持未读」在 GR 里**没有快捷键**（规格 §3.4 的键位列是「—」），是条目下方的链接。
          // 所以这个端点服务于客户端的那个链接，不接键位。
          const itemId = String((payload as { itemId?: unknown } | null)?.itemId ?? '')
          if (!itemId) return fail('bad-request', 'toggleKeepUnread 需要 itemId')
          const existing = target.item(itemId)
          if (existing === undefined) return fail('not-found', '条目不存在：' + itemId)
          const keptUnread = existing.keptUnread !== true
          // 取消时把键去掉而不是写 false —— 缺省即「未保持」，少一个键更干净
          await target.saveItem(itemId, keptUnread
            ? rebuildItem(existing, { set: { keptUnread: true } })
            : rebuildItem(existing, { omit: ['keptUnread'] }))
          return ok({ itemId, keptUnread, unread: countUnread(target) })
        }

        case 'toggleStar': {
          const itemId = String((payload as { itemId?: unknown } | null)?.itemId ?? '')
          if (!itemId) return fail('bad-request', 'toggleStar 需要 itemId')
          const existing = target.item(itemId)
          if (existing === undefined) return fail('not-found', '条目不存在：' + itemId)
          const starred = !existing.starred
          await target.saveItem(itemId, { ...existing, starred })
          return ok({ itemId, starred, unread: countUnread(target) })
        }

        default:
          return fail('unknown-endpoint', '未知端点：' + endpoint)
      }
    } catch (error) {
      log('请求失败（' + endpoint + '）：' + String(error))
      return fail('internal', error instanceof Error ? error.message : String(error))
    }
  }


  return dispatch
}
