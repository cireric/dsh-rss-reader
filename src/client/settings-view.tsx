/**
 * 设置页（R11 01 的骨架 + R11 06 的 Agent 说明 / 关于区）。
 *
 * 01 只做「能进能出 + 第一个参数只读」：五个分区按 spec D13 的顺序全部占位，
 * ①「抓取与清理」的第一行显示 `refreshFeedsPerRound` 的当前生效值。02–05 票往其余分区
 * 填入输入框 / 显示开关 / 清理按钮；06 票填 ④ Agent 说明与 ⑤ 关于（版本 / 路径 / 12 个只读参数）。
 *
 * 为什么容器自己 `tabIndex={0}` 并在挂载时聚焦：设置页要承接**浏览器原生**的空格 / d 翻页
 * （spec D22 明确要求这些键不被 preventDefault）。原生滚动的前提是焦点在可滚容器上；
 * 容器不可聚焦时，空格会落到 body 上，页面纹丝不动。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { AGENT_APPROVAL_NOTE, AGENT_HELP } from '../agent-help.js'
import type { ReadOnlySettingView, SettingsSnapshot } from '../shared.js'

export interface SettingsViewProps {
  /** 最近一次成功取到的快照；undefined = 还在取 / 取失败。 */
  settings: SettingsSnapshot | undefined
  /** 取数失败的一句话（与全局 error 分开，页面自己说明为什么空着）。 */
  error: string | undefined
  /** 警示条是否已被本次会话关掉（D17：可关闭，不阻断）。 */
  warningDismissed: boolean
  onClose: () => void
  onDismissWarning: () => void
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
 * 只读参数的展示文本。`logFile` 空串是「没设」而不是「空路径」——
 * 说清它仍会走宿主日志，免得读者以为日志被关了（D14.1）。
 */
function readOnlyText(entry: ReadOnlySettingView): string {
  if (entry.key === 'logFile' && entry.value === '') return '（未设置，仅走宿主日志）'
  return String(entry.value)
}

export function SettingsView(props: SettingsViewProps): ReactNode {
  const { settings, error, warningDismissed, onClose, onDismissWarning } = props
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
            <div className="dsh-rss-settings-row" data-rss-setting="refreshFeedsPerRound">
              <span className="dsh-rss-settings-label">每次刷新抓取源数</span>
              <span className="dsh-rss-settings-value" data-rss-setting-value="">
                {settings === undefined ? '…' : String(settings.effective.refreshFeedsPerRound)}
              </span>
              <span className="dsh-rss-settings-unit">源</span>
              <p className="dsh-rss-settings-help">0 = 抓全部源（源多时一轮会很慢）</p>
            </div>
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
