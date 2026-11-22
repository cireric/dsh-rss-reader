/**
 * 设置页（R11 01 骨架 / 02 第一个可写参数 / 03 其余三个参数 / 06 Agent 说明与关于区 / 07 恢复默认）。
 *
 * 五个分区按 spec D13 的顺序全部占位；①「抓取与清理」的四行都是**可写**的数值输入框
 * （03 票补齐并发 / 自动刷新间隔 / 清理天数；显示开关在 04–05 票填入）；06 票填
 * ④ Agent 说明与 ⑤ 关于（版本 / 路径 / 12 个只读参数）。这里刻意不预埋假控件。
 *
 * 为什么容器自己 `tabIndex={0}` 并在挂载时聚焦：设置页要承接**浏览器原生**的空格 / d 翻页
 * （spec D22 明确要求这些键不被 preventDefault）。原生滚动的前提是焦点在可滚容器上；
 * 容器不可聚焦时，空格会落到 body 上，页面纹丝不动。
 *
 * 保存交互（D12 / D14.2）：**逐项**提交（失焦或回车），提交前先跑与宿主同一份范围判据
 * （`settings-schema.ts`），非法值零请求、就地红字；成功后输入框旁「已保存 ✓」约 1.4 秒。
 * 输入框的值是组件本地草稿（draft），只在用户没有未提交输入时跟随宿主回包 —— 保存成功后的
 * 重新渲染不许冲掉另一个框里正在打的字。
 *
 * 两种单位（D11）：整理数的键（源数 / 并发 / 天数）沿用整数解析；`minRefreshIntervalMs`
 * 在界面上以**分钟**编辑，所以行有 `mode: 'minutes'`。分钟只是显示单位，真正的权威值仍是
 * 毫秒：展示取 `String(ms / 60000)`（最短精确表示，不四舍五入、不补零），保存取
 * `Math.round(分钟 × 60000)`；范围仍由 `parseTunableValue` 按**毫秒**判定，客户端不另写一套。
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AGENT_APPROVAL_NOTE, AGENT_HELP } from '../agent-help.js'
import type { ReadOnlySettingView, SettingsSnapshot } from '../shared.js'
import { parseTunableValue, TUNABLE_RANGES, type TunableKey } from '../settings-schema.js'
import type { ResetSettingsResult, SaveSettingResult } from './settings-actions.js'

/** 成功反馈的停留时间：短到不挡视线，长到能看见（spec D14.2 定稿「约 1.4 秒」）。 */
const SAVED_FEEDBACK_MS = 1400

/** 一分钟的毫秒数。毫秒是 `minRefreshIntervalMs` 的唯一真单位，分钟只是输入框的显示单位。 */
const MINUTE_MS = 60_000

/**
 * 一行的解析模式：`integer` = 输入即目标值；`minutes` = 输入是分钟，转成毫秒再校验。
 * 不复制第二个行组件 —— 两种模式只差「怎么读草稿 / 怎么显示权威值」两处。
 */
type RowMode = 'integer' | 'minutes'

export interface SettingsViewProps {
  /** 最近一次成功取到的快照；undefined = 还在取 / 取失败。 */
  settings: SettingsSnapshot | undefined
  /** 取数失败的一句话（与全局 error 分开，页面自己说明为什么空着）。 */
  error: string | undefined
  /** 警示条是否已被本次会话关掉（D17：可关闭，不阻断）。 */
  warningDismissed: boolean
  onClose: () => void
  onDismissWarning: () => void
  /** 逐项保存：由 store 的保存串行链执行，返回是否成功与失败的当下生效值。 */
  onSave: (key: TunableKey, value: number) => Promise<SaveSettingResult>
  /** 页面级恢复默认：走同一条保存串行链，一次请求把四项恢复成默认值。 */
  onReset: () => Promise<ResetSettingsResult>
}

/**
 * 五个分区与顺序（D13）。集中成一份表而不是五段手写 JSX：顺序本身是验收项（C13），
 * 后续票往里填内容时只改对应分区的子节点，不会顺手把顺序挪了。
 */
const SECTIONS = [
  { key: 'fetch', title: '抓取与清理' },
  { key: 'display', title: '显示' },
  { key: 'feedOrder', title: '订阅源顺序' },
  { key: 'agent', title: 'Agent 说明' },
  { key: 'about', title: '关于' },
] as const

/**
 * 恢复默认的四个键与界面文案（D28）。顺序与上面的输入行一致；`mode` 决定「15 → 10」这种
 * 展示用分钟还是原值，**不复制第二套单位判断**。
 */
const RESET_ROWS = [
  { key: 'refreshFeedsPerRound', label: '每次刷新抓取源数', mode: 'integer' },
  { key: 'refreshConcurrency', label: '抓取并发', mode: 'integer' },
  { key: 'minRefreshIntervalMs', label: '自动刷新间隔', mode: 'minutes' },
  { key: 'cleanupAfterDays', label: '清理天数', mode: 'integer' },
] as const satisfies ReadonlyArray<{ readonly key: TunableKey; readonly label: string; readonly mode: RowMode }>

interface ResetChange {
  readonly key: TunableKey
  readonly text: string
}

/**
 * 确认框里「将变化的项与目标值」。判据与宿主 D28 同源：**当前生效值 ≠ 默认值**的项，
 * 恢复默认后必然变化；相等的项不在列表里，也是按钮 N = 0 的判据。
 */
function resetChangesOf(settings: SettingsSnapshot | undefined): ResetChange[] {
  if (settings === undefined) return []
  return RESET_ROWS.flatMap((row) => {
    const current = settings.effective[row.key]
    const target = settings.defaults[row.key]
    if (current === target) return []
    return [{
      key: row.key,
      text: row.label + ' ' + displayOf(row.mode, current) + ' → ' + displayOf(row.mode, target),
    }]
  })
}

interface NumberSettingRowProps {
  readonly settingKey: TunableKey
  readonly label: string
  readonly unit: string
  readonly help: string
  /** 更细的语义放 title，不铺在页面上（D14.2）。 */
  readonly hint: string
  readonly mode?: RowMode
  readonly value: number | undefined
  readonly onSave: SettingsViewProps['onSave']
}

/** 权威值 → 输入框展示文本。分钟模式不做四舍五入：1.50205 就是 1.50205（D11）。 */
function displayOf(mode: RowMode, value: number): string {
  return mode === 'minutes' ? String(value / MINUTE_MS) : String(value)
}

/**
 * 草稿文本 → 要提交的值（`undefined` = 不合法）。
 *
 * 分钟模式先按分钟解析、按 D11 取整成毫秒，再用**宿主同一份** `parseTunableValue`
 * 复核范围。这样 1440.1 分钟会被毫秒上限挡下，且错误文案仍能说「分钟」。
 */
function parseDraft(mode: RowMode, key: TunableKey, text: string): number | undefined {
  if (mode === 'minutes') {
    // 只认十进制小数：'1e2' / '0x10' 会被 Number() 收下，但用户输入的不是他看到的那个数。
    if (!/^-?\d+(\.\d+)?$/.test(text)) return undefined
    return parseTunableValue(key, Math.round(Number(text) * MINUTE_MS))
  }
  // 整数模式只认十进制整数：小数（1.5）不是「四舍五入后合法」，而是非法输入。
  if (!/^-?\d+$/.test(text)) return undefined
  return parseTunableValue(key, Number(text))
}

/** 就地红字的范围文案：数值从 `TUNABLE_RANGES` 现取，不在 UI 里再抄一份 min/max。 */
function rangeErrorText(mode: RowMode, key: TunableKey): string {
  const range = TUNABLE_RANGES[key]
  if (mode === 'minutes') {
    return '请输入 ' + range.min / MINUTE_MS + '–' + range.max / MINUTE_MS + ' 的分钟数（可带小数）'
  }
  return '请输入 ' + range.min + '–' + range.max + ' 的整数'
}

/**
 * 一个数值设置行：名称 + 输入框 + 单位 + 一句帮助。
 *
 * 提交只发生在失焦 / 回车（D12：不是每键入一次就跑校验）；回车只是把焦点交出去，
 * 提交逻辑只有 `commit` 一份，两条路径不会漂移。
 */
function NumberSettingRow(props: NumberSettingRowProps): ReactNode {
  const { settingKey, label, unit, help, hint, mode = 'integer', value, onSave } = props
  const inputId = useId()
  const helpId = useId()
  const effectiveText = value === undefined ? '' : displayOf(mode, value)
  const [draft, setDraft] = useState(effectiveText)
  const [error, setError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  // 用户有未提交输入时，外部回包不许覆盖草稿（否则另一个框里打的字会被一次保存冲掉）。
  const dirty = useRef(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (!dirty.current) setDraft(effectiveText)
  }, [effectiveText])

  // 卸载时清掉计时器：定时器回调更新一个已卸载组件的 state 是无意义的泄漏。
  useEffect(() => () => {
    if (savedTimer.current !== undefined) clearTimeout(savedTimer.current)
  }, [])

  const commit = async (): Promise<void> => {
    // 快照还没到（仍在取 / 取失败）：没有「当前生效值」可对照，不提交。
    if (value === undefined) return
    // 用户没编辑过这一项（只是聚焦又失焦）：直接跳过，不发请求、不写覆盖。
    // 用「是否被编辑」而不是「文本是否等于生效值」作主判据，聚焦本身永远不会变成一次写盘。
    if (!dirty.current) return
    const next = parseDraft(mode, settingKey, draft.trim())
    if (next === undefined) {
      setError(rangeErrorText(mode, settingKey))
      setSaved(false)
      return
    }
    // 编辑过但数值没变（如 10 → 10.0）：同样不写盘，并把输入框归位成权威值的展示形式。
    if (next === value) {
      dirty.current = false
      setDraft(effectiveText)
      setError(undefined)
      return
    }
    setError(undefined)
    setSaved(false)
    const result = await onSave(settingKey, next)
    if (result.ok) {
      dirty.current = false
      setSaved(true)
      if (savedTimer.current !== undefined) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaved(false), SAVED_FEEDBACK_MS)
      return
    }
    // 失败保留输入（dirty 仍为 true，回包不会把它冲掉），并把「此刻真正生效的值」写在同一句里。
    setError('保存失败：' + result.message
      + (result.current === undefined ? '' : ' 当前生效值仍是 ' + result.current))
  }

  return (
    <div className="dsh-rss-settings-row" data-rss-setting={settingKey}>
      <label className="dsh-rss-settings-label" htmlFor={inputId}>{label}</label>
      <input id={inputId} className="dsh-rss-settings-input" data-rss-setting-input={settingKey}
        type="text" inputMode={mode === 'minutes' ? 'decimal' : 'numeric'} autoComplete="off" spellCheck={false}
        title={hint} aria-describedby={helpId} aria-invalid={error !== undefined}
        value={draft} disabled={value === undefined}
        onChange={(event) => {
          dirty.current = true
          setDraft(event.target.value)
          setError(undefined)
        }}
        onBlur={() => { void commit() }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          // 只交出焦点，提交仍走 onBlur 那一条路。
          event.currentTarget.blur()
        }} />
      <span className="dsh-rss-settings-unit">{unit}</span>
      {saved && (
        <span className="dsh-rss-settings-saved" data-rss-setting-saved={settingKey} role="status">已保存 ✓</span>
      )}
      {/* D11 / D14.2：只有非整分钟才显示真实毫秒；600000 这种整分钟不显示「= 600000 ms」的噪音。 */}
      {mode === 'minutes' && value !== undefined && value % MINUTE_MS !== 0 && (
        <p className="dsh-rss-settings-hint" data-rss-setting-ms-hint={settingKey}>{'= ' + value + ' ms'}</p>
      )}
      <p className="dsh-rss-settings-help" id={helpId}>{help}</p>
      {error !== undefined && (
        <p className="dsh-rss-settings-error" data-rss-setting-error={settingKey} role="alert">{error}</p>
      )}
    </div>
  )
}

/**
 * 只读参数的展示文本。`logFile` 空串是「没设」而不是「空路径」——
 * 说清它仍会走宿主日志，免得读者以为日志被关了（D14.1）。
 */
function readOnlyText(entry: ReadOnlySettingView): string {
  if (entry.key === 'logFile' && entry.value === '') return '（未设置，仅走宿主日志）'
  return String(entry.value)
}

export function SettingsView(props: SettingsViewProps): ReactNode {
  const { settings, error, warningDismissed, onClose, onDismissWarning, onSave, onReset } = props
  const box = useRef<HTMLDivElement | null>(null)
  const resetButton = useRef<HTMLButtonElement | null>(null)
  const resetConfirmButton = useRef<HTMLButtonElement | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | undefined>(undefined)
  // 进入即聚焦滚动容器（见文件头注释）。依赖空数组：只在挂载时做一次，重新渲染不该抢焦点。
  useEffect(() => { box.current?.focus() }, [])
  // 恢复默认的确认框打开即聚焦确认键：键盘流不用先摸方向键（与 MarkAllConfirm 同一约定）。
  useEffect(() => { if (resetOpen) resetConfirmButton.current?.focus() }, [resetOpen])
  const warning = settings?.warning
  const readOnly = settings?.readOnly ?? []
  const resetChanges = resetChangesOf(settings)

  /**
   * 关闭确认框并把焦点还给「恢复默认」按钮（D14.2）。
   *
   * 成功恢复后四项全是默认值，按钮随即变成禁用态；浏览器不会把焦点留在一个禁用按钮上，
   * 这时退回设置页容器 —— 至少 Esc / 原生滚动仍然落在设置页，而不是掉到 body。
   */
  const closeReset = (): void => {
    setResetOpen(false)
    setResetError(undefined)
    const button = resetButton.current
    if (button !== null && !button.disabled) button.focus()
    else box.current?.focus()
  }

  const confirmReset = async (): Promise<void> => {
    setResetting(true)
    setResetError(undefined)
    const result = await onReset()
    setResetting(false)
    if (result.ok) closeReset()
    else setResetError('恢复失败：' + result.message)
  }
  return (
    <div ref={box} tabIndex={0} className="dsh-rss-settings-page" data-rss-settings-page="">
      <div className="dsh-rss-settings-head">
        <button type="button" className="dsh-rss-btn" data-rss-settings-back="" onClick={onClose}>
          ← 返回列表（Esc）
        </button>
        <h2 className="dsh-rss-settings-title">设置</h2>
      </div>
      {warning !== undefined && !warningDismissed && (
        <div className="dsh-rss-status dsh-rss-status--error dsh-rss-settings-warning" role="alert"
          data-rss-settings-warning="">
          <span>{warning}</span>
          <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
            style={{ marginLeft: 8 }} onClick={onDismissWarning}>知道了</button>
        </div>
      )}
      {error !== undefined && (
        <div className="dsh-rss-status dsh-rss-status--error" role="alert" data-rss-settings-error="">
          读取设置失败：{error}
        </div>
      )}
      {SECTIONS.map((section) => (
        <section key={section.key} className="dsh-rss-settings-section"
          data-rss-settings-section={section.key}>
          <h3 className="dsh-rss-settings-section-title">{section.title}</h3>
          {section.key === 'fetch' && (
            <>
              <NumberSettingRow
                settingKey="refreshFeedsPerRound"
                label="每次刷新抓取源数"
                unit="源"
                help="0 = 抓全部源（源多时一轮会很慢）"
                hint="一轮只抓一批，不是全部源"
                value={settings?.effective.refreshFeedsPerRound}
                onSave={onSave}
              />
              <NumberSettingRow
                settingKey="refreshConcurrency"
                label="抓取并发"
                unit="个"
                help="一轮里同时抓几个源"
                hint="同时进行的抓取请求数；调大更快，也更占带宽与内存"
                value={settings?.effective.refreshConcurrency}
                onSave={onSave}
              />
              <NumberSettingRow
                settingKey="minRefreshIntervalMs"
                mode="minutes"
                label="自动刷新间隔"
                unit="分钟"
                help="0 = 不节流（手点刷新不受它限制）"
                hint="两次自动刷新之间的最短间隔；以分钟编辑，保存时按毫秒取整"
                value={settings?.effective.minRefreshIntervalMs}
                onSave={onSave}
              />
              <NumberSettingRow
                settingKey="cleanupAfterDays"
                label="清理天数"
                unit="天"
                help="只清理早于这个天数的已读条目（未星标、未保持未读）"
                hint="清理判据：已读、未星标、未保持未读，且发布时间早于该天数；0 会清光已读条目，所以非法"
                value={settings?.effective.cleanupAfterDays}
                onSave={onSave}
              />
              {/* D14.2 / D28：恢复默认影响整组，用一条分隔线与上面的单项参数区隔开。 */}
              <div className="dsh-rss-settings-reset" data-rss-reset-row="">
                <button ref={resetButton} type="button" className="dsh-rss-btn" data-rss-reset-defaults=""
                  disabled={resetChanges.length === 0 || resetting}
                  onClick={() => {
                    setResetError(undefined)
                    setResetOpen(true)
                  }}>
                  恢复默认
                </button>
                <span className="dsh-rss-settings-help">
                  把上面四项数值恢复成代码默认值；显示区的两个开关不受影响。
                </span>
              </div>
            </>
          )}
          {section.key === 'agent' && (
            // 文案逐字来自 AGENT_HELP（D24 单一来源）；这里只负责排版，不改写、不补签名。
            <div data-rss-agent-help="">
              {AGENT_HELP.map((entry) => (
                <div key={entry.name} className="dsh-rss-settings-row" data-rss-agent-tool={entry.name}>
                  <span className="dsh-rss-settings-label">{entry.name}</span>
                  <p className="dsh-rss-settings-help">{entry.what}</p>
                  <p className="dsh-rss-settings-help">示例：{entry.example}</p>
                </div>
              ))}
              <p className="dsh-rss-settings-help" data-rss-agent-approval="">{AGENT_APPROVAL_NOTE}</p>
            </div>
          )}
          {section.key === 'about' && (
            <div data-rss-about="">
              <div className="dsh-rss-settings-row" data-rss-about="version">
                <span className="dsh-rss-settings-label">版本</span>
                <span className="dsh-rss-settings-value dsh-rss-about-value">{settings?.version ?? '…'}</span>
              </div>
              <div className="dsh-rss-settings-row" data-rss-about="dataDir">
                <span className="dsh-rss-settings-label">数据目录</span>
                <span className="dsh-rss-settings-value dsh-rss-about-value">{settings?.dataDir ?? '…'}</span>
              </div>
              <div className="dsh-rss-settings-row" data-rss-about="settingsPath">
                <span className="dsh-rss-settings-label">设置文件</span>
                <span className="dsh-rss-settings-value dsh-rss-about-value">{settings?.settingsPath ?? '…'}</span>
              </div>
              {readOnly.length > 0 && (
                // 默认折叠：12 个参数是排障用的，不该占满设置页首屏。数量取回包长度，
                // 不在客户端再抄一个「12」——白名单变了标签跟着变。
                <details className="dsh-rss-about-readonly" data-rss-about-readonly="">
                  <summary className="dsh-rss-about-summary">其余 {readOnly.length} 个参数（只读）</summary>
                  {readOnly.map((entry) => (
                    <div key={entry.key} className="dsh-rss-settings-row" data-rss-about-key={entry.key}>
                      <span className="dsh-rss-settings-label">{entry.key}</span>
                      <span className="dsh-rss-settings-value dsh-rss-about-value">{readOnlyText(entry)}</span>
                    </div>
                  ))}
                </details>
              )}
            </div>
          )}
        </section>
      ))}
      {resetOpen && (
        <div className="dsh-rss-confirm">
          <div className="dsh-rss-confirm-card" role="dialog" aria-modal="true"
            aria-labelledby="dsh-rss-reset-title" data-rss-reset-confirm=""
            onKeyDown={(event) => {
              // Esc 只关确认框，不能冒泡到设置页的「Esc 回列表」（与 MarkAllConfirm 同一条）。
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              if (!resetting) closeReset()
            }}>
            <div className="dsh-rss-confirm-title" id="dsh-rss-reset-title">恢复默认设置？</div>
            <div className="dsh-rss-confirm-note" data-rss-reset-changes="">
              将变化的项：{resetChanges.map((change) => change.text).join('；')}
            </div>
            {resetError !== undefined && (
              <p className="dsh-rss-settings-error" role="alert" data-rss-reset-error="">{resetError}</p>
            )}
            <div className="dsh-rss-confirm-actions">
              <button type="button" className="dsh-rss-btn" data-rss-reset-cancel=""
                disabled={resetting} onClick={closeReset}>取消</button>
              <button ref={resetConfirmButton} type="button" className="dsh-rss-btn dsh-rss-btn--primary"
                data-rss-reset-ok="" disabled={resetting} onClick={() => { void confirmReset() }}>
                {resetting ? '恢复中…' : '恢复默认'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
