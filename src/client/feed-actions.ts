/**
 * 订阅源动作（阶段 4b 票据 05 的第四切片，收口）。
 *
 * discover / addFeed / removeFeed / clearDiscovery 四个动作。写入的是 discovery / feedsBusy /
 * importReport / notice / error —— **不直接写 feeds**（订阅的真相在宿主，写完靠 host.reload 重取）。
 */
import type { DiscoveryResult, OpmlImportResult } from '../shared.js'
import type { ReaderStoreDeps, ReaderState } from './store.js'

export interface FeedActionHost {
  set: (patch: Partial<ReaderState>) => void
  rpc: ReaderStoreDeps['rpc']
  reload: () => Promise<void>
}

export function createFeedActions(host: FeedActionHost) {
  const { set, rpc, reload } = host
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

  return { discover, addFeed, removeFeed, clearDiscovery }
}
