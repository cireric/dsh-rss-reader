/**
 * 设置页的动作域（R11 01）：打开 / 关闭 / 取一次快照 / 关掉读侧告警。
 *
 * 为什么单独成文件：store 的四个域已经按「谁写谁的 state」切分（见 store.ts 顶部的边界表），
 * 设置页的 state（快照、取数错误、告警是否已关）不属于列表 / 搜索 / 订阅 / 标签任何一块。
 * 放进任一既有域都会让那块同时管两种数据来源（端点的 settings 与条目数据）。
 *
 * 本票只读：写路径（saveSettings）是 02 票的事。
 */
import type { SettingsSnapshot } from '../shared.js'
import type { ReaderState, ReaderStoreDeps } from './store.js'

export interface SettingsActionHost {
  get: () => ReaderState
  set: (patch: Partial<ReaderState>) => void
  rpc: ReaderStoreDeps['rpc']
  log: ReaderStoreDeps['log']
}

export function createSettingsActions(host: SettingsActionHost) {
  const { get, set, rpc, log } = host

  /**
   * 正在飞的取数。设置页每次进入都重取（值可能被另一个入口或直接改文件变过），
   * 连点「设置」时不该堆出一串同样的请求。
   */
  let inFlight: Promise<void> | undefined

  const loadSettings = async (): Promise<void> => {
    if (inFlight !== undefined) return inFlight
    inFlight = (async () => {
      try {
        const result = await rpc<{ settings?: SettingsSnapshot }>('settings')
        const snapshot = result?.settings
        // 回包缺字段是宿主契约被破坏，不能当成「设置全是 undefined」画到页面上。
        if (snapshot === undefined) throw new Error('settings 回包缺少 settings 字段')
        set({ settings: snapshot, settingsError: undefined })
      } catch (failure) {
        log('warn', '[rss-reader] 读取设置失败', failure)
        set({ settingsError: failure instanceof Error ? failure.message : String(failure) })
      } finally {
        inFlight = undefined
      }
    })()
    return inFlight
  }

  /** 进入设置页并取一次快照。返回固定回列表（D20：不记 prevView）。 */
  const openSettings = (): void => {
    set({ view: 'settings' })
    void loadSettings()
  }

  const closeSettings = (): void => { set({ view: 'list' }) }

  /** 工具栏按钮与既有「订阅」按钮同型：再点一次回列表。 */
  const toggleSettings = (): void => {
    if (get().view === 'settings') closeSettings()
    else openSettings()
  }

  /** 关闭警示条只影响本次会话的显示（D17：警示不阻断任何功能）。 */
  const dismissSettingsWarning = (): void => { set({ settingsWarningDismissed: true }) }

  return { loadSettings, openSettings, closeSettings, toggleSettings, dismissSettingsWarning }
}
