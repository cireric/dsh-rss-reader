/**
 * 设置页的动作域（R11 01 读 / 02 写）：打开 / 关闭 / 取一次快照 / 关掉读侧告警 / 逐项保存。
 *
 * 为什么单独成文件：store 的四个域已经按「谁写谁的 state」切分（见 store.ts 顶部的边界表），
 * 设置页的 state（快照、取数错误、告警是否已关）不属于列表 / 搜索 / 订阅 / 标签任何一块。
 * 放进任一既有域都会让那块同时管两种数据来源（端点的 settings 与条目数据）。
 */
import type { RsshubSettingsSnapshot, RsshubTestResult, SettingsSnapshot } from '../shared.js'
import { changedNumberTunableKeys, type TunableKey } from '../settings-schema.js'
import type { ReaderState, ReaderStoreDeps } from './store.js'

/**
 * 一次保存的结果（给设置页组件渲染就地反馈）。
 *
 * `current` 是失败时**当下真正生效**的值：失败提示必须写成「保存失败：… 当前生效值仍是 N」，
 * 否则用户不知道该信输入框里的数字还是列表里的行为（spec D12）。
 */
export type SaveSettingResult =
  | { readonly ok: true; readonly settings: SettingsSnapshot }
  | { readonly ok: false; readonly message: string; readonly current: string | number | boolean | undefined }

/**
 * 实例池保存的结果（R15 01）。失败只带可展示原因：池子没有「当前生效值仍是多少」的单值可回，
 * 界面保留用户刚编的列表、红字说清楚为什么没存下即可。
 */
export type SaveRsshubSettingsResult =
  | { readonly ok: true; readonly rsshub: RsshubSettingsSnapshot }
  | { readonly ok: false; readonly message: string }

/** 宿主 saveRsshubSettings 的 wire 形状：instances 必填，其余筛选偏好可选（R15 06 / 07）。 */
interface RsshubSettingsWirePatch {
  instances: string[]
  hiddenNamespaces?: string[]
  hideNsfw?: boolean
}

/**
 * 翻译路由的一次性 patch（R7 02）：provider / model / effort 必须**一起**提交。
 *
 * 分三次写会经过「provider 已换、model 还是旧的」这类中间态；模型选择器切换时那一瞬
 * 可能被翻译端点读走。一次 patch 落盘，生效值是原子的。
 */
export type TranslateRouteSettingsPatch = {
  readonly translateProvider: string
  readonly translateModel: string
  readonly translateEffort: string
}

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

  /**
   * 一条保存请求的公共执行体（R11 02 / R7 02）：
   * 串行 + 只认最新回包 + 失败时回「此刻真正生效的值」。
   *
   * 单键保存与翻译三键 patch 共用它：两条路径各写一遍串行链时，后一次改动可能被前一次
   * 的旧回包覆盖（风险 3），而这个 bug 只在连续操作时显形。
   */
  const runSave = (
    payload: { readonly patch: Record<string, string | number | boolean> },
    currentOf: () => string | number | boolean | undefined,
  ): Promise<SaveSettingResult> => {
    const ticket = ++latestSave
    const run = saveChain.then(async (): Promise<SaveSettingResult> => {
      try {
        const result = await rpc<{ settings?: SettingsSnapshot }>('saveSettings', payload)
        const snapshot = result?.settings
        if (snapshot === undefined) throw new Error('saveSettings 回包缺少 settings 字段')
        if (ticket === latestSave) set({ settings: snapshot, settingsError: undefined })
        return { ok: true, settings: snapshot }
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure)
        // 顶部状态条也留一句（设置页之外看得见），就地红字负责细节（D12）。
        set({ error: '保存设置失败：' + message })
        log('warn', '[rss-reader] 保存设置失败', failure)
        return { ok: false, message, current: currentOf() }
      }
    })
    // 链本身永不 reject：一次失败不该让后续保存永远排在一条断掉的 Promise 后面。
    saveChain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * RSSHub 实例池的取数（R15 01）：与 settings 分开取 —— 它住在 config.json，不是 settings.json
   * 的标量覆盖层。失败只写分区级错误（`rsshubSettingsError`），不把整页设置打成错误。
   */
  let rsshubInFlight: Promise<void> | undefined

  const loadRsshubSettings = async (): Promise<void> => {
    if (rsshubInFlight !== undefined) return rsshubInFlight
    rsshubInFlight = (async () => {
      try {
        const result = await rpc<{ rsshub?: RsshubSettingsSnapshot }>('rsshubSettings')
        const snapshot = result?.rsshub
        // 回包缺字段是宿主契约被破坏，不能当成「池子为空」画到页面上（那会静默关闭 RSSHub）。
        if (snapshot === undefined) throw new Error('rsshubSettings 回包缺少 rsshub 字段')
        set({ rsshubSettings: snapshot, rsshubSettingsError: undefined })
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure)
        set({ rsshubSettingsError: message })
        log('warn', '[rss-reader] 读取 RSSHub 实例池失败', failure)
      } finally {
        rsshubInFlight = undefined
      }
    })()
    return rsshubInFlight
  }

  /**
   * 实例池保存（R15 01）：与设置保存同一条纪律 —— **串行**且只认最新一次回包。
   * 增 / 删 / 上下移各自提交整份数组；连点时晚提交的顺序才是权威顺序。
   */
  let rsshubChain: Promise<unknown> = Promise.resolve()
  let latestRsshubSave = 0

  const runRsshubSave = (payload: RsshubSettingsWirePatch): Promise<SaveRsshubSettingsResult> => {
    const ticket = ++latestRsshubSave
    const run = rsshubChain.then(async (): Promise<SaveRsshubSettingsResult> => {
      try {
        const result = await rpc<{ rsshub?: RsshubSettingsSnapshot }>('saveRsshubSettings', payload)
        const snapshot = result?.rsshub
        if (snapshot === undefined) throw new Error('saveRsshubSettings 回包缺少 rsshub 字段')
        if (ticket === latestRsshubSave) set({ rsshubSettings: snapshot, rsshubSettingsError: undefined })
        return { ok: true, rsshub: snapshot }
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure)
        // 保存失败由分区组件就地红字展示（它知道是哪次动作失败）；`rsshubSettingsError`
        // 只表示「读不出池子」，不能把保存失败写成「读取失败」。
        log('warn', '[rss-reader] 保存 RSSHub 实例池失败', failure)
        return { ok: false, message }
      }
    })
    // 链本身永不 reject：一次失败不该让后续保存永远排在一条断掉的 Promise 后面。
    rsshubChain = run.then(() => undefined, () => undefined)
    return run
  }

  const saveRsshubInstances = (instances: readonly string[]): Promise<SaveRsshubSettingsResult> =>
    runRsshubSave({ instances: [...instances] })

  /**
   * 保存探索页的「显示 NSFW」开关（R15 06）：hideNsfw 住在 config.rsshub，写路径与实例池共用一条串行链。
   *
   * 为什么必须带上当前实例池：宿主的 saveRsshubSettings 是整份 rsshub 快照语义，只发 hideNsfw
   * 会因缺 instances 被判坏入参；带上旧池子才能只改这一位。快照还没到手时明确失败，绝不发空数组
   * —— 那会把「用户配好的池子」静默清空（功能被关闭）。
   */
  const saveRsshubHideNsfw = (hideNsfw: boolean): Promise<SaveRsshubSettingsResult> => {
    const instances = get().rsshubSettings?.instances
    if (instances === undefined) {
      return Promise.resolve({ ok: false, message: '实例池快照尚未加载，无法保存 NSFW 偏好' })
    }
    return runRsshubSave({ instances: [...instances], hideNsfw })
  }

  /**
   * 保存隐藏列表（R15 07）：与 NSFW 开关共用同一条串行链和同一条约束 —— 必须带上当前实例池。
   *
   * `saveRsshubSettings` 是整份 `rsshub` 快照语义：只发 hiddenNamespaces 会因缺 instances 被判
   * 坏入参；发空 instances 则会把用户配好的池子静默清空（功能关闭）。快照未到手时明确失败。
   */
  const saveRsshubHiddenNamespaces = (hiddenNamespaces: readonly string[]): Promise<SaveRsshubSettingsResult> => {
    const snapshot = get().rsshubSettings
    if (snapshot === undefined) {
      return Promise.resolve({ ok: false, message: '实例池快照尚未加载，无法保存隐藏列表' })
    }
    return runRsshubSave({ instances: [...snapshot.instances], hiddenNamespaces: [...hiddenNamespaces] })
  }

  /** 隐藏一个站点（R15 07）：已隐藏时不重复追加（写盘侧也去重，这里少发一次无意义的写）。 */
  const hideRsshubNamespace = (namespace: string): Promise<SaveRsshubSettingsResult> => {
    const snapshot = get().rsshubSettings
    if (snapshot === undefined) {
      return Promise.resolve({ ok: false, message: '实例池快照尚未加载，无法隐藏站点' })
    }
    const next = snapshot.hiddenNamespaces.includes(namespace)
      ? [...snapshot.hiddenNamespaces]
      : [...snapshot.hiddenNamespaces, namespace]
    return saveRsshubHiddenNamespaces(next)
  }

  /** 全部恢复（R15 07）：空列表 = 不隐藏任何站点，与加这个字段之前的行为一致。 */
  const restoreHiddenNamespaces = (): Promise<SaveRsshubSettingsResult> => saveRsshubHiddenNamespaces([])

  const saveSetting = (key: TunableKey, value: string | number | boolean): Promise<SaveSettingResult> =>
    // 计算键的类型在运行时就是该键本身；宿主端点会用同一份 parseTunableValue 再验一次。
    runSave({ patch: { [key]: value } }, () => get().settings?.effective[key])

  /** 翻译路由三键一次落盘（R7 02）：设置页选中模型 / 强度时调用，成功后由 store 刷新探测。 */
  const saveTranslateRoute = (patch: TranslateRouteSettingsPatch): Promise<SaveSettingResult> =>
    runSave({ patch }, () => {
      const effective = get().settings?.effective
      // 失败提示里的「当前生效值」：三键一起改，用 provider/model 组合回答「现在到底用的哪条路由」。
      return effective === undefined ? undefined : effective.translateProvider + '/' + effective.translateModel
    })

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
      // 与恢复默认确认框同一份判据（S5）：变化的项只算一次，不在这里另写一个过滤。
      const changed = before === undefined ? [] : changedNumberTunableKeys(before.effective, before.defaults)
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

  /**
   * RSSHub「测试连接」（R8a 01）：只把地址交给宿主，浏览器不直连实例（CSP 与信任边界都在宿主）。
   *
   * 探活失败（超时 / 非 2xx / 非 JSON）是**观测结果**而不是通道错误，宿主会用 `passed: false`
   * + 可读原因回包；真正抛异常的只有通道本身。两种都在这里折成同一形状，设置页只画一行字。
   */
  const testRsshub = async (base: string): Promise<RsshubTestResult> => {
    try {
      const result = await rpc<{ passed?: boolean; message?: string }>('testRsshub', { base })
      if (result === undefined || typeof result.passed !== 'boolean' || typeof result.message !== 'string') {
        throw new Error('testRsshub 回包缺少 passed / message')
      }
      return { passed: result.passed, message: result.message }
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      log('warn', '[rss-reader] RSSHub 测试连接失败', failure)
      return { passed: false, message: '测试连接失败：' + message }
    }
  }

  /** 进入设置页并取一次快照。返回固定回列表（D20：不记 prevView）。 */
  const openSettings = (): void => {
    set({ view: 'settings' })
    void loadSettings()
    // 池子与 settings 是两处数据：进设置页时一并取，别让 RSSHub 分区先闪一屏空值。
    void loadRsshubSettings()
  }

  const closeSettings = (): void => { set({ view: 'list' }) }

  /** 工具栏按钮与既有「订阅」按钮同型：再点一次回列表。 */
  const toggleSettings = (): void => {
    if (get().view === 'settings') closeSettings()
    else openSettings()
  }

  /** 关闭警示条只影响本次会话的显示（D17：警示不阻断任何功能）。 */
  const dismissSettingsWarning = (): void => { set({ settingsWarningDismissed: true }) }

  return {
    loadSettings, loadRsshubSettings, openSettings, closeSettings, toggleSettings, dismissSettingsWarning,
    saveSetting, saveRsshubInstances, saveRsshubHideNsfw,
    hideRsshubNamespace, restoreHiddenNamespaces,
    saveTranslateRoute, resetSettings, testRsshub,
  }
}
