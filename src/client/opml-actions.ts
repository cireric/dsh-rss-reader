/**
 * OPML 导入 / 导出（阶段 4b 票据 05 的第一刀）。
 *
 * 这两个动作与订阅域的其余部分（feeds / folders / navSelection）不同：它们**不碰**任何 UI 状态，
 * 只调一个端点、把结果交给 set 或下载器。所以它们可以先搬，不必等 persistView 的归属定下来。
 */
import type { OpmlExportResult, OpmlImportResult } from '../shared.js'
import type { ReaderStoreDeps, ReaderState } from './store.js'

export interface OpmlActionHost {
  set: (patch: Partial<ReaderState>) => void
  rpc: ReaderStoreDeps['rpc']
  saveFile: ReaderStoreDeps['saveFile']
  /** 导入完重取当前页（宿主侧已写入订阅，本地必须跟上）。 */
  reload: () => Promise<void>
}

export function createOpmlActions(host: OpmlActionHost) {
  const { set, rpc, saveFile, reload } = host

  const exportOpml = async (): Promise<void> => {
    try {
      const result = await rpc<OpmlExportResult>('opmlExport')
      const name = 'dsh-rss-subscriptions.opml'
      saveFile(name, result.opml, 'text/x-opml;charset=utf-8')
      set({ notice: '已导出 ' + result.feedCount + ' 个订阅（' + name + '）' })
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /** 导入 OPML：逐源抓取校验，坏源单独列出、不阻断其余（§3.1）。 */
  const importOpml = async (text: string): Promise<void> => {
    set({ feedsBusy: true, importReport: undefined })
    try {
      const report = await rpc<OpmlImportResult>('opmlImport', { opml: text })
      set({ importReport: report, feedsBusy: false })
      await reload()
    } catch (failure) {
      set({ feedsBusy: false, error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  return { exportOpml, importOpml }
}
