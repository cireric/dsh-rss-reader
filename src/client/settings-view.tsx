/**
 * 设置页（R11 01 骨架 / 02 第一个可写参数 / 06 Agent 说明与关于区）。
 *
 * 五个分区按 spec D13 的顺序全部占位；①「抓取与清理」的第一行是**可写**的数值输入框
 * （`refreshFeedsPerRound`），其余三行、显示开关在 03–05 票填入；06 票填 ④ Agent 说明与
 * ⑤ 关于（版本 / 路径 / 12 个只读参数）。这里刻意不预埋假控件。
 *
 * 为什么容器自己 `tabIndex={0}` 并在挂载时聚焦：设置页要承接**浏览器原生**的空格 / d 翻页
 * （spec D22 明确要求这些键不被 preventDefault）。原生滚动的前提是焦点在可滚容器上；
 * 容器不可聚焦时，空格会落到 body 上，页面纹丝不动。
 *
 * 保存交互（D12 / D14.2）：**逐项**提交（失焦或回车），提交前先跑与宿主同一份范围判据
 * （`settings-schema.ts`），非法值零请求、就地红字；成功后输入框旁「已保存 ✓」约 1.4 秒。
 * 输入框的值是组件本地草稿（draft），只在用户没有未提交输入时跟随宿主回包 —— 保存成功后的
 * 重新渲染不许冲掉另一个框里正在打的字。
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AGENT_APPROVAL_NOTE, AGENT_HELP } from '../agent-help.js'
import type { ReadOnlySettingView, SettingsSnapshot } from '../shared.js'
import { parseTunableValue, TUNABLE_RANGES, type TunableKey } from '../settings-schema.js'
import type { SaveSettingResult } from './settings-actions.js'

/** 成功反馈的停留时间：短到不挡视线，长到能看见（spec D14.2 定稿「约 1.4 秒」）。 */
const SAVED_FEEDBACK_MS = 1400

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

interface NumberSettingRowProps {
  readonly settingKey: TunableKey
  readonly label: string
  readonly unit: string
  readonly help: string
  /** 更细的语义放 title，不铺在页面上（D14.2）。 */
  readonly hint: string
  readonly value: number | undefined
  readonly onSave: SettingsViewProps['onSave']
}

/**
 * 一个数值设置行：名称 + 输入框 + 单位 + 一句帮助。
 *
 * 提交只发生在失焦 / 回车（D12：不是每键入一次就跑校验）；回车只是把焦点交出去，
 * 提交逻辑只有 `commit` 一份，两条路径不会漂移。
 */
function NumberSettingRow(props: NumberSettingRowProps): ReactNode {
  const { settingKey, label, unit, help, hint, value, onSave } = props
  const inputId = useId()
  const helpId = useId()
  const effectiveText = value === undefined ? '' : String(value)
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
    const text = draft.trim()
    // 只认十进制整数：'1e3' / '0x10' 会被 Number() 收下，但用户输入的不是他看到的那个数。
    const parsed = /^-?\d+$/.test(text) ? Number(text) : undefined
    const next = parsed === undefined ? undefined : parseTunableValue(settingKey, parsed)
    if (next === undefined) {
      const range = TUNABLE_RANGES[settingKey]
      setError('请输入 ' + range.min + '–' + range.max + ' 的整数')
      setSaved(false)
      return
    }
    // 没改过就不发请求：点进输入框再点走不该凭空写一条覆盖（稀疏覆盖的前提）。
    if (next === value && text === effectiveText) {
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
        type="text" inputMode="numeric" autoComplete="off" spellCheck={false}
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
  const { settings, error, warningDismissed, onClose, onDismissWarning, onSave } = props
  const box = useRef<HTMLDivElement | null>(null)
  // 进入即聚焦滚动容器（见文件头注释）。依赖空数组：只在挂载时做一次，重新渲染不该抢焦点。
  useEffect(() => { box.current?.focus() }, [])
  const warning = settings?.warning
  const readOnly = settings?.readOnly ?? []
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
            <NumberSettingRow
              settingKey="refreshFeedsPerRound"
              label="每次刷新抓取源数"
              unit="源"
              help="0 = 抓全部源（源多时一轮会很慢）"
              hint="一轮只抓一批，不是全部源"
              value={settings?.effective.refreshFeedsPerRound}
              onSave={onSave}
            />
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
    </div>
  )
}
