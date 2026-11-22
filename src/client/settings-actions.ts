/**
 * 设置页的动作域（R11 01 读 / 02 写）：打开 / 关闭 / 取一次快照 / 关掉读侧告警 / 逐项保存。
 *
 * 为什么单独成文件：store 的四个域已经按「谁写谁的 state」切分（见 store.ts 顶部的边界表），
 * 设置页的 state（快照、取数错误、告警是否已关）不属于列表 / 搜索 / 订阅 / 标签任何一块。
 * 放进任一既有域都会让那块同时管两种数据来源（端点的 settings 与条目数据）。
 */
import type { SettingsSnapshot } from '../shared.js'
import { TUNABLE_KEYS, type TunableKey } from '../settings-schema.js'
import type { ReaderState, ReaderStoreDeps } from './store.js'

/**
 * 一次保存的结果（给设置页组件渲染就地反馈）。
 *
 * `current` 是失败时**当下真正生效**的值：失败提示必须写成「保存失败：… 当前生效值仍是 N」，
 * 否则用户不知道该信输入框里的数字还是列表里的行为（spec D12）。
 */
export type SaveSettingResult =
  | { readonly ok: true; readonly settings: SettingsSnapshot }
  | { readonly ok: false; readonly message: string; readonly current: number | undefined }

/** 「恢复默认」的结果：失败只带可展示的原因；N 由动作在提交时按「生效值 vs 默认值」算出。 */
export type ResetSettingsResult =
  | { readonly ok: true; readonly settings: SettingsSnapshot }
  | { readonly ok: false; readonly message: string }

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

  /**
   * 保存串行链（风险 3）：四个参数各是一个输入框，用户可能连续改两项。
   *
   * 两条规则缺一不可：
   *  ① **串行**：一次只有一个保存在飞，后提交的排在前一个回包之后 —— 否则两次写盘可能乱序，
   *     后改的值被先改的写回；
   *  ② **只认最新一次回包**：链上更早的回包即使成功，也不许把 `settings` 快照改回旧值
   *     （编号在提交时取，回包时比对）。界面上的数字只有一个权威来源：最后一次提交的回包。
   */
  let saveChain: Promise<unknown> = Promise.resolve()
  let latestSave = 0

  const saveSetting = (key: TunableKey, value: number): Promise<SaveSettingResult> => {
    const ticket = ++latestSave
    const run = saveChain.then(async (): Promise<SaveSettingResult> => {
      try {
        const result = await rpc<{ settings?: SettingsSnapshot }>('saveSettings', { patch: { [key]: value } })
        const snapshot = result?.settings
        if (snapshot === undefined) throw new Error('saveSettings 回包缺少 settings 字段')
        if (ticket === latestSave) set({ settings: snapshot, settingsError: undefined })
        return { ok: true, settings: snapshot }
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure)
        // 顶部状态条也留一句（设置页之外看得见），就地红字负责细节（D12）。
        set({ error: '保存设置失败：' + message })
        log('warn', '[rss-reader] 保存设置失败', failure)
        return { ok: false, message, current: get().settings?.effective[key] }
      }
    })
    // 链本身永不 reject：一次失败不该让后续保存永远排在一条断掉的 Promise 后面。
    saveChain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * 页面级「恢复默认」（07 票，D28）：客户端只发一个动作，删 / 写覆盖的判断全在宿主。
   *
   * 与逐项保存共用同一条串行链和「只认最新一次回包」的规则（风险 3）：恢复默认与普通保存
   * 交错时，晚提交的那次回包才是权威值。N 在**提交那一刻**按「生效值 vs 默认值」现算 ——
   * 它既是确认框列出的变化项数，也是成功提示里的数，两处不允许各算一套。
   */
  const resetSettings = (): Promise<ResetSettingsResult> => {
    const ticket = ++latestSave
    const run = saveChain.then(async (): Promise<ResetSettingsResult> => {
      const before = get().settings
      const changed = before === undefined
        ? []
        : TUNABLE_KEYS.filter((key) => before.effective[key] !== before.defaults[key])
      try {
        const result = await rpc<{ settings?: SettingsSnapshot }>('saveSettings', { resetToDefaults: true })
        const snapshot = result?.settings
        if (snapshot === undefined) throw new Error('saveSettings 回包缺少 settings 字段')
        if (ticket === latestSave) {
          set({
            settings: snapshot,
            settingsError: undefined,
            notice: '已恢复 ' + changed.length + ' 项默认值',
          })
        }
        return { ok: true, settings: snapshot }
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure)
        set({ error: '恢复默认失败：' + message })
        log('warn', '[rss-reader] 恢复默认失败', failure)
        return { ok: false, message }
      }
    })
    saveChain = run.then(() => undefined, () => undefined)
    return run
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

  return { loadSettings, openSettings, closeSettings, toggleSettings, dismissSettingsWarning, saveSetting, resetSettings }
}
