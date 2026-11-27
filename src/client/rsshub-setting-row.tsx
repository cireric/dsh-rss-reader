/**
 * RSSHub 分区（R8a 01 的单地址行 → R15 01 的**实例池**编辑器）。
 *
 * 这里只做一件事：把「0–5 个实例、顺序即优先级」的池子交给用户维护 —— 增 / 删 / 上移下移 /
 * 测试连接。地址校验与保存后的归一都由宿主用 `parseRsshubBase` 做（客户端只做同一份判据的
 * 即时预检：非法值零请求），保存走 `saveRsshubSettings`（config.json，先落盘再改内存）。
 *
 * 为什么是即时保存而不是「编辑草稿 + 保存按钮」：与设置页其它行（失焦提交）保持同一种交互，
 * 且每次操作提交的是**整份数组**（顺序本身就是数据），不存在「提交一半」的中间态。
 *
 * 推荐卡片刻意只在**空池**时出现：推荐实例是「给没配过的人一个起点」，不是产品默认值 ——
 * 用户不点「启用这 3 个」就一个字节都不写（未配置 = 零请求的隐私边界）。池子里已有实例时
 * 再展示「启用这 3 个」既可能覆盖用户的选择，也让「默认不启用」变成一句空话。
 */
import { useId, useState, type ReactNode } from 'react'
import type { RsshubSettingsSnapshot, RsshubTestResult } from '../shared.js'
import { parseTunableValue } from '../settings-schema.js'
import type { SaveRsshubSettingsResult } from './settings-actions.js'

/** 实例地址不合法时的就地红字：判据来自 `parseTunableValue`，这里只说怎么改。 */
const RSSHUB_BASE_ERROR = '请输入 http(s):// 的实例地址（不能带路径、查询或参数）'

/** 上限与宿主同值（spec §4.1.1）：客户端先禁用按钮，宿主仍会拒绝绕过界面的请求。 */
const MAX_INSTANCES = 5

/** 推荐实例（spec §4.1.6）：只是展示，点「启用这 3 个」才写入。 */
const RECOMMENDED_INSTANCES = ['https://hub.slarker.me', 'https://rsshub.rss.tips', 'https://rsshub.cups.moe'] as const

export interface RsshubSettingRowProps {
  /** 宿主下发的生效池子；undefined = 还没取到（加载中 / 取失败）。 */
  readonly snapshot: RsshubSettingsSnapshot | undefined
  /** 取数失败的一句话（分区内展示，不把整页打成错误）。 */
  readonly error: string | undefined
  /** 保存整份实例数组；成功回包里的快照由 store 落进权威状态。 */
  readonly onSave: (instances: string[]) => Promise<SaveRsshubSettingsResult>
  /** 探活一个实例地址（复用既有 testRsshub 端点；浏览器不直连实例）。 */
  readonly onTest: (base: string) => Promise<RsshubTestResult>
}

/** 测试结果的落点：第几行的结果，避免多行结果互相覆盖成一句无法定位的话。 */
type TestResultAt = { readonly index: number; readonly result: RsshubTestResult }

export function RsshubSettingRow(props: RsshubSettingRowProps): ReactNode {
  const { snapshot, error, onSave, onTest } = props
  const inputId = useId()
  const helpId = useId()
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const [testingIndex, setTestingIndex] = useState<number | undefined>(undefined)
  const [testResult, setTestResult] = useState<TestResultAt | undefined>(undefined)

  const instances = snapshot?.instances ?? []
  const unavailable = snapshot === undefined
  const disabled = unavailable || busy

  /**
   * 提交整份数组。上限先判（宿主还会再判一次，两道防线各自有理由：这里给即时反馈，
   * 宿主防绕过界面）：**超过 5 条一律不写盘**。
   */
  const apply = async (next: readonly string[]): Promise<boolean> => {
    if (next.length > MAX_INSTANCES) {
      setSaveError(`最多 ${MAX_INSTANCES} 个实例，请先删减`)
      return false
    }
    setBusy(true)
    setSaveError(undefined)
    setSaved(false)
    // 列表一变，上一行的测试结果就失去了归属（下标可能指向另一条实例）。
    setTestResult(undefined)
    try {
      const result = await onSave([...next])
      if (!result.ok) {
        setSaveError('保存失败：' + result.message)
        return false
      }
      setSaved(true)
      return true
    } finally {
      setBusy(false)
    }
  }

  const add = async (): Promise<void> => {
    const parsed = parseTunableValue('rsshubBase', draft)
    if (parsed === undefined || parsed === '') {
      setDraftError(RSSHUB_BASE_ERROR)
      return
    }
    if (instances.includes(parsed)) {
      setDraftError('这个实例已经在列表里')
      return
    }
    if (instances.length >= MAX_INSTANCES) {
      setDraftError(`最多 ${MAX_INSTANCES} 个实例`)
      return
    }
    setDraftError(undefined)
    // 只有落盘成功才清空输入框；失败时用户的输入必须还在，方便改一个字符重试。
    if (await apply([...instances, parsed])) setDraft('')
  }

  const remove = async (index: number): Promise<void> => {
    await apply(instances.filter((_, current) => current !== index))
  }

  const move = async (index: number, delta: -1 | 1): Promise<void> => {
    const target = index + delta
    if (target < 0 || target >= instances.length) return
    const next = [...instances]
    ;[next[index], next[target]] = [next[target], next[index]]
    await apply(next)
  }

  const runTest = async (index: number): Promise<void> => {
    const base = instances[index]
    if (base === undefined) return
    setTestingIndex(index)
    setTestResult(undefined)
    try {
      setTestResult({ index, result: await onTest(base) })
    } finally {
      setTestingIndex(undefined)
    }
  }

  return (
    <div className="dsh-rss-settings-row" data-rss-setting="rsshubPool">
      <span className="dsh-rss-settings-label">实例池</span>
      <p className="dsh-rss-settings-help">
        按顺序尝试；未配置时 RSSHub 候选不出现，也不会向任何第三方实例发请求。
      </p>

      {error !== undefined && (
        <p className="dsh-rss-settings-error" data-rss-rsshub-pool-error="" role="alert">
          实例池读取失败：{error}
        </p>
      )}
      {unavailable && error === undefined && (
        <p className="dsh-rss-settings-help" data-rss-rsshub-loading="">正在读取实例池…</p>
      )}

      {snapshot !== undefined && (
        <>
          {instances.length > 0 ? (
            <ol className="dsh-rss-rsshub-pool" data-rss-rsshub-pool="">
              {instances.map((instance, index) => (
                <li key={index + ':' + instance} className="dsh-rss-rsshub-instance" data-rss-rsshub-instance={index}>
                  <span className="dsh-rss-rsshub-instance-url" data-rss-rsshub-instance-url="">
                    {instance}
                  </span>
                  <span className="dsh-rss-settings-help dsh-rss-rsshub-rank">
                    {index === 0 ? '首选' : '第 ' + (index + 1) + ' 位'}
                  </span>
                  <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-rsshub-test={index}
                    title="向 {实例}/api/radar/rules/zhihu.com 探一次；这是启发式，不保证每个站点都有规则"
                    disabled={disabled || testingIndex !== undefined}
                    onClick={() => { void runTest(index) }}>
                    {testingIndex === index ? '测试中…' : '测试连接'}
                  </button>
                  <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-rsshub-up={index}
                    disabled={disabled || index === 0}
                    onClick={() => { void move(index, -1) }}>上移</button>
                  <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-rsshub-down={index}
                    disabled={disabled || index === instances.length - 1}
                    onClick={() => { void move(index, 1) }}>下移</button>
                  <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-rsshub-remove={index}
                    disabled={disabled}
                    onClick={() => { void remove(index) }}>删除</button>
                  {testResult?.index === index && (
                    <p className={testResult.result.passed ? 'dsh-rss-settings-saved' : 'dsh-rss-settings-error'}
                      data-rss-rsshub-result="" role="status">{testResult.result.message}</p>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="dsh-rss-settings-help" data-rss-rsshub-empty="">
              实例池为空：RSSHub 功能关闭。需要时在下面添加一个实例。
            </p>
          )}

          <div className="dsh-rss-settings-row">
            <label className="dsh-rss-settings-label" htmlFor={inputId}>添加实例</label>
            <input id={inputId} className="dsh-rss-settings-input dsh-rss-settings-input--url"
              data-rss-rsshub-add-input=""
              type="text" inputMode="url" autoComplete="off" spellCheck={false}
              placeholder="https://rsshub.example" title="只支持公网实例；地址不能带路径 / 查询 / 参数"
              aria-describedby={helpId} aria-invalid={draftError !== undefined}
              value={draft} disabled={disabled}
              onChange={(event) => {
                setDraft(event.target.value)
                setDraftError(undefined)
                setSaved(false)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                void add()
              }} />
            <button type="button" className="dsh-rss-btn" data-rss-rsshub-add=""
              disabled={disabled || instances.length >= MAX_INSTANCES}
              onClick={() => { void add() }}>添加</button>
            <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-rsshub-reset=""
              disabled={disabled || instances.length === 0}
              onClick={() => { void apply([]) }}>清空实例池</button>
            <p className="dsh-rss-settings-help" id={helpId}>
              实例源站（如 https://rsshub.example），只支持公网实例；最多 5 个，顺序即优先级。
            </p>
          </div>

          {draftError !== undefined && (
            <p className="dsh-rss-settings-error" data-rss-rsshub-draft-error="" role="alert">{draftError}</p>
          )}
          {saveError !== undefined && (
            <p className="dsh-rss-settings-error" data-rss-rsshub-pool-error="" role="alert">{saveError}</p>
          )}
          {saved && (
            <span className="dsh-rss-settings-saved" data-rss-rsshub-saved="" role="status">已保存 ✓</span>
          )}
          {snapshot.warning !== undefined && (
            <p className="dsh-rss-settings-help" data-rss-rsshub-warning="" role="status">{snapshot.warning}</p>
          )}

          {instances.length === 0 && (
            <div className="dsh-rss-rsshub-recommend" data-rss-rsshub-recommend="">
              <span className="dsh-rss-settings-label">推荐实例</span>
              <ul className="dsh-rss-rsshub-recommend-list">
                {RECOMMENDED_INSTANCES.map((instance) => (
                  <li key={instance}><code>{instance}</code></li>
                ))}
              </ul>
              <button type="button" className="dsh-rss-btn" data-rss-rsshub-recommend-enable=""
                disabled={disabled}
                onClick={() => { void apply([...RECOMMENDED_INSTANCES]) }}>启用这 3 个</button>
              <p className="dsh-rss-settings-help">
                推荐实例由社区维护，可能失效；只有点这个按钮才会写入，不会自动连接。
              </p>
            </div>
          )}

          <p className="dsh-rss-settings-help" data-rss-rsshub-instances="">
            公共实例由社区维护，可能失效；可从{' '}
            <a href="https://docs.rsshub.app/guide/instances" target="_blank" rel="noopener noreferrer">官方实例列表</a>
            {' '}挑一个。
          </p>
        </>
      )}
    </div>
  )
}
