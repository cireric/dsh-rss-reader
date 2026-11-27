/**
 * 订阅源动作（阶段 4b 票据 05 的第四切片，收口）。
 *
 * discover / addFeed / removeFeed / clearDiscovery / moveFeedOrder 五个动作。写入的是 discovery / feedsBusy /
 * importReport / notice / error —— **不直接写 feeds**（订阅的真相在宿主，写完靠 host.reload 重取）。
 *
 * R3-03 增加 moveFeedOrder：排序同样是宿主的真相，客户端只发「整份目标顺序」，
 * 成功后 reload 取回宿主快照——**不做乐观重排**（否则宿主拒绝时会留下屏幕新、文件旧的形态）。
 * R9 03 增加 backfill：同一条纪律，报告只用于展示，条目仍以 reload 后的宿主快照为准。
 */
import type { BackfillReport, DiscoveryResult, OpmlImportResult, ProbeResult } from '../shared.js'
import type { ReaderStoreDeps, ReaderState } from './store.js'

export interface FeedActionHost {
  get: () => ReaderState
  set: (patch: Partial<ReaderState>) => void
  rpc: ReaderStoreDeps['rpc']
  reload: () => Promise<void>
}

/**
 * 回溯动作的结果（R9 03）：成功带宿主报告，失败带**给行内表单就地显示**的原因。
 *
 * 为什么不直接抛异常：失败原因既要进全局 `state.error`（本文件既有的 catch 纪律），又要画在
 * 那一行的结果区；抛出去会把「谁来写 error」拆成两条路径。返回可读原因让两个落点一次写清。
 */
export type BackfillActionResult = { report: BackfillReport } | { error: string }

/**
 * 加单个源的结果（R8b 04）：探索的「已添加 ✓」回执只许在**真的落库**后出现，
 * 而 `addFeed` 原来的返回是 void —— 调用方拿不到成败，只能靠猜全局 state。
 *
 * 为什么校验失败也算 `ok: false`：`addFeed` 端点对「URL 校验不过」是**正常回包**
 *（`failed[0].reason`），不是 HTTP / 通道错误；探索必须把那条原因展示出来，不能给回执。
 * feeds-view 仍只看 `importReport`，返回值对它是透明的新增信息，既有行为不变。
 */
export type AddFeedActionResult =
  | { readonly ok: true; readonly added: number; readonly existed: number }
  | { readonly ok: false; readonly message: string }

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

  /**
   * 加单个源：同样先校验再落库，避免把网页当订阅。
   *
   * 返回值是 R8b 04 加的，只为让探索知道「到底成没成」；feeds-view 的 `onAdd` 仍丢弃它，
   * 页面表现与改动前逐字一致（报告照旧由 importReport 渲染）。
   */
  const addFeed = async (url: string): Promise<AddFeedActionResult> => {
    set({ feedsBusy: true, importReport: undefined })
    try {
      const report = await rpc<OpmlImportResult>('addFeed', { url })
      // 落库成功即收掉候选清单：用户已经在清单里做过选择，留着它只会让人怀疑「到底加了没」。
      set({ importReport: report, feedsBusy: false, discovery: undefined })
      await reload()
      const failed = report.failed[0]
      if (failed !== undefined) return { ok: false, message: failed.reason }
      return { ok: true, added: report.added, existed: report.existed }
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      set({ feedsBusy: false, error: message })
      return { ok: false, message }
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

  /**
   * 试读（R15 10）：只读探测，宿主不写库、不改订阅，因此这里也不动全局 state。
   *
   * 刻意不借 `feedsBusy`：那面旗子的文案是「正在逐源抓取校验…」，会把整页按钮一起灰掉；
   * 而试读是行内动作，用户应当能「试读一条、再决定要不要添加」。
   * 失败原因由组件就地展示（返回值），不写全局 error —— 一行候选的失败不该盖住整页。
   */
  const probe = async (urls: string[]): Promise<ProbeResult[]> => {
    return await rpc<ProbeResult[]>('probeFeeds', { urls })
  }

  /**
   * 每源在途的回溯 Promise（key = feedId）。
   *
   * 界面会把「开始」置灰，但 state 要等下一次渲染才生效：同一事件循环里的连点仍可能第二次
   * 调到这里。共享同一个 Promise 既不发第二个请求，也保证两个调用看到同一份结果。
   */
  const backfillRuns = new Map<string, Promise<BackfillActionResult>>()

  /**
   * 回溯一个源（R9 03）：只发 RPC，成功后 reload 取回宿主快照。
   *
   * **不乐观改列表**：报告里的 added 只是「宿主刚写了多少篇」的陈述，条目与源的真相仍在宿主；
   * 照着它往 state 里塞条目，会在宿主裁剪 / 并发写入时留下屏幕与库不一致的形态。
   */
  const runBackfill = async (feedId: string, archiveUrl: string, limit: number): Promise<BackfillActionResult> => {
    try {
      const report = await rpc<BackfillReport>('backfillHistory', { feedId, archiveUrl, limit })
      await reload()
      return { report }
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure)
      set({ error: reason })
      return { error: reason }
    }
  }

  const backfill = (feedId: string, archiveUrl: string, limit: number): Promise<BackfillActionResult> => {
    const running = backfillRuns.get(feedId)
    if (running !== undefined) return running
    const run = runBackfill(feedId, archiveUrl, limit).finally(() => { backfillRuns.delete(feedId) })
    backfillRuns.set(feedId, run)
    return run
  }

  return { discover, addFeed, removeFeed, clearDiscovery, moveFeedOrder, backfill, probe }
}
