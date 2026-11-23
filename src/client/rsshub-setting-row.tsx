/**
 * RSSHub 分区（R8a 01；评审 #4 从 settings-view.tsx 整块搬出，DOM 锚点与行为不变）：
 * 地址输入 + 测试连接 + 恢复默认（清空）。
 *
 * 保存复用与四个数字行**同一条** `onSave`（= store 的保存串行链 + 「已保存 ✓」反馈）：
 * 另写一套写路径就会出现「地址存下了但另三个框的回包把界面冲掉」这类两套状态互相踩的缺陷。
 * 草稿 / 脏标记 / 已保存闪显由 `settings-draft.ts` 的 useSettingsDraft 提供 —— 这一块原先
 * 是 NumberSettingRow 状态机的 45 行复制品，两份在「别的保存回包不冲掉草稿」上必须一致。
 *
 * 测试连接探的是**输入框里的草稿值**而不是上次保存的生效值：用户改完地址直接点测试时，
 * 探的必须是他眼前写的那个；草稿非法或为空时按钮禁用（见下面的 canTest）。
 */
import { useId, useState, type ReactNode } from 'react'
import type { RsshubTestResult } from '../shared.js'
import { parseTunableValue, type TunableKey } from '../settings-schema.js'
import type { SaveSettingResult } from './settings-actions.js'
import { useSettingsDraft } from './settings-draft.js'

/** RSSHub 地址不合法时的就地红字：判据来自 `parseTunableValue`，这里只说怎么改。 */
const RSSHUB_BASE_ERROR = '请输入 http(s):// 的实例地址（不能带路径、查询或参数）'

export interface RsshubSettingRowProps {
  readonly value: string | undefined
  readonly onSave: (key: TunableKey, value: string | number) => Promise<SaveSettingResult>
  readonly onTest: (base: string) => Promise<RsshubTestResult>
}

export function RsshubSettingRow(props: RsshubSettingRowProps): ReactNode {
  const { value, onSave, onTest } = props
  const inputId = useId()
  const helpId = useId()
  const effectiveText = value ?? ''
  const form = useSettingsDraft(effectiveText)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<RsshubTestResult | undefined>(undefined)

  const commit = async (raw: string): Promise<void> => {
    if (value === undefined) return
    if (!form.isDirty()) return
    // 与宿主 / 读侧同一个判据：trim、http(s)、不带 path / query / hash、去尾斜杠。
    const next = parseTunableValue('rsshubBase', raw)
    if (next === undefined) {
      form.reject(RSSHUB_BASE_ERROR)
      return
    }
    if (next === value) {
      form.revert()
      return
    }
    form.beginSave()
    const result = await onSave('rsshubBase', next)
    if (result.ok) {
      form.succeed()
      return
    }
    form.fail('保存失败：' + result.message
      + (result.current === undefined ? '' : ' 当前生效值仍是 ' + result.current))
  }

  /**
   * 探的是**输入框里当前这个地址**（而不是上次保存的旧值）：用户改完地址直接点测试时，
   * 探的必须是他眼前写的那个；输入非法 / 为空时按钮本来就是禁用的。
   */
  const runTest = async (): Promise<void> => {
    const base = parseTunableValue('rsshubBase', form.draft)
    if (base === undefined || base === '') return
    setTesting(true)
    setTestResult(undefined)
    try {
      setTestResult(await onTest(base))
    } finally {
      setTesting(false)
    }
  }

  /** 「恢复默认（清空）」= 同一个键写下空串；不发明第二条删覆盖的通道。 */
  const clear = async (): Promise<void> => {
    if (value === undefined || value === '') return
    form.replace('')
    setTestResult(undefined)
    const result = await onSave('rsshubBase', '')
    if (result.ok) form.succeed()
    else form.fail('恢复默认失败：' + result.message)
  }

  // 测试按钮跟随**草稿**：未配置（空）或草稿形状不合法时禁用；清空按钮只跟随已保存值。
  const draftBase = parseTunableValue('rsshubBase', form.draft)
  const canTest = draftBase !== undefined && draftBase !== ''
  const configured = value !== undefined && value !== ''
  return (
    <div className="dsh-rss-settings-row" data-rss-setting="rsshubBase">
      <label className="dsh-rss-settings-label" htmlFor={inputId}>实例地址</label>
      <input id={inputId} className="dsh-rss-settings-input dsh-rss-settings-input--url" data-rss-setting-input="rsshubBase"
        type="text" inputMode="url" autoComplete="off" spellCheck={false}
        placeholder="https://rsshub.example" title="只支持公网实例；地址不能带路径 / 查询 / 参数"
        aria-describedby={helpId} aria-invalid={form.error !== undefined}
        value={form.draft} disabled={value === undefined}
        onChange={(event) => {
          form.edit(event.target.value)
          setTestResult(undefined)
        }}
        onBlur={() => { void commit(form.draft) }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          event.currentTarget.blur()
        }} />
      {form.saved && (
        <span className="dsh-rss-settings-saved" data-rss-setting-saved="rsshubBase" role="status">已保存 ✓</span>
      )}
      <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-rsshub-test=""
        title="向 {实例}/api/radar/rules/zhihu.com 探一次；这是启发式，不保证每个站点都有规则"
        disabled={!canTest || testing}
        onClick={() => { void runTest() }}>
        {testing ? '测试中…' : '测试连接'}
      </button>
      <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-rsshub-reset=""
        disabled={!configured || testing}
        onClick={() => { void clear() }}>恢复默认（清空）</button>
      <p className="dsh-rss-settings-help" id={helpId}>
        实例源站（如 https://rsshub.example），只支持公网实例。未配置时 RSSHub 候选不出现。
      </p>
      <p className="dsh-rss-settings-help" data-rss-rsshub-instances="">
        公共实例由社区维护，可能失效；可从{' '}
        <a href="https://docs.rsshub.app/guide/instances" target="_blank" rel="noopener noreferrer">官方实例列表</a>
        {' '}挑一个。
      </p>
      {testResult !== undefined && (
        <p className={testResult.passed ? 'dsh-rss-settings-saved' : 'dsh-rss-settings-error'}
          data-rss-rsshub-result="" role="status">{testResult.message}</p>
      )}
      {form.error !== undefined && (
        <p className="dsh-rss-settings-error" data-rss-setting-error="rsshubBase" role="alert">{form.error}</p>
      )}
    </div>
  )
}
