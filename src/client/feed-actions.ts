/**
 * 订阅源动作（阶段 4b 票据 05 的第四切片，收口）。
 *
 * discover / addFeed / removeFeed / clearDiscovery / moveFeedOrder 五个动作。写入的是 discovery / feedsBusy /
 * importReport / notice / error —— **不直接写 feeds**（订阅的真相在宿主，写完靠 host.reload 重取）。
 *
 * R3-03 增加 moveFeedOrder：排序同样是宿主的真相，客户端只发「整份目标顺序」，
 * 成功后 reload 取回宿主快照——**不做乐观重排**（否则宿主拒绝时会留下屏幕新、文件旧的形态）。
 */
import type { DiscoveryResult, OpmlImportResult } from '../shared.js'
import type { ReaderStoreDeps, ReaderState } from './store.js'

export interface FeedActionHost {
  get: () => ReaderState
  set: (patch: Partial<ReaderState>) => void
  rpc: ReaderStoreDeps['rpc']
  reload: () => Promise<void>
}

export function createFeedActions(host: FeedActionHost) {
  const { get, set, rpc, reload } = host
  /**
   * 排序在途标记：**刻意不进 state**。
   *
   * 它只承担「连点不堆请求」这一条纪律，界面没有第二种样子要画；进了 state 就会让整页
   * 重渲染一次，而一次本地文件写是毫秒级的。也不要借 feedsBusy：那个标记的文案是
   * 「正在逐源抓取校验…」，拿它表达排序会让界面撒谎（spec 实现决策 15）。
   */
  let reorderInFlight = false

  /**
   * 把订阅源上 / 下挪一格。
   *
   * ids 由**当前 state.feeds 的整份顺序**推出（相邻交换）：宿主收到的是完整目标顺序，
   * 未点名的源由宿主按当前有效顺序补末尾，客户端不重算顺序规则。成功后 reload ——
   * 新顺序只从宿主快照来，失败时界面自然保持原样。
   */
  const moveFeedOrder = async (feedId: string, direction: -1 | 1): Promise<void> => {
    if (reorderInFlight) return
    const feeds = get().feeds
    const from = feeds.findIndex((feed) => feed.id === feedId)
    const to = from + direction
    if (from < 0 || to < 0 || to >= feeds.length) return
    const ids = feeds.map((feed) => feed.id)
    const moved = ids[from]
    ids[from] = ids[to]
    ids[to] = moved
    reorderInFlight = true
    try {
      await rpc<{ feedOrder: string[] }>('reorderFeeds', { ids })
      await reload()
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    } finally {
      reorderInFlight = false
    }
  }
  /**
   * 只发现、不订阅：拿到候选清单后等用户挑（宿主侧零写入，见 endpoints.ts 的 discoverFeeds）。
   * 失败只写 error —— 候选列表保持上一次的样子会让人以为「刚才那次没发生」，所以先清空再请求。
   */
  const discover = async (url: string): Promise<void> => {
    set({ feedsBusy: true, discovery: undefined, importReport: undefined, error: undefined })
    try {
      const result = await rpc<DiscoveryResult>('discoverFeeds', { url })
      set({ feedsBusy: false, discovery: result })
    } catch (failure) {
      set({ feedsBusy: false, error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /** 取消挑选：清掉候选，不写任何订阅。 */
  const clearDiscovery = (): void => { set({ discovery: undefined }) }

  /** 加单个源：同样先校验再落库，避免把网页当订阅。 */
  const addFeed = async (url: string): Promise<void> => {
    set({ feedsBusy: true, importReport: undefined })
    try {
      const report = await rpc<OpmlImportResult>('addFeed', { url })
      // 落库成功即收掉候选清单：用户已经在清单里做过选择，留着它只会让人怀疑「到底加了没」。
      set({ importReport: report, feedsBusy: false, discovery: undefined })
      await reload()
    } catch (failure) {
      set({ feedsBusy: false, error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /** 退订：连带删除该源条目（宿主侧执行），不可撤销，界面要二次确认。 */
  const removeFeed = async (url: string): Promise<void> => {
    try {
      const result = await rpc<{ removed: number; items: number }>('removeFeed', { url })
      set({ notice: '已退订（连带删除 ' + result.items + ' 条条目）' })
      await reload()
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  return { discover, addFeed, removeFeed, clearDiscovery, moveFeedOrder }
}
