/**
 * 订阅管理面板（2026-10-07 从 index.tsx 拆出；M2 03 加文件夹管理；R9 03 加逐源回溯）：
 * OPML 导入导出、加源、退订，文件夹的创建/改名/删除与订阅移动，以及行内的归档页回溯表单。
 * 纯展示 —— 动作全部由入口的 store 通过 props 传进来。
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { BACKFILL_LIMIT, feedHealthOf, isHttpUrl, type BackfillReport, type DiscoveryResult, type FeedView, type FolderView, type OpmlExportResult, type OpmlImportResult, type ProbeResult, type TagView } from '../shared.js'
import { rsshubNamespaceOf } from '../rsshub-source.js'
import type { BackfillActionResult } from './feed-actions.js'
import { relativeTime } from './store.js'

/** 文件夹管理里一次改名草稿。 */
interface RenameDraft {
  name: string
  draft: string
}
interface TagRenameDraft {
  id: string
  draft: string
}

/** 回溯表单的草稿。篇数保留输入原文：空串 / 小数 / 越界都要能就地报原因，不能被 Number('') 洗成 0。 */
interface BackfillDraft {
  feedId: string
  url: string
  limit: string
}

/** 从按源索引的表里删掉一项；没有该键时返回原引用，避免无谓的整表复制。 */
function withoutKey<T>(table: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  if (table[key] === undefined) return table
  const next = { ...table }
  delete next[key]
  return next
}

/**
 * 回溯入参的客户端预检：返回可读原因，undefined = 可以发请求。
 *
 * 为什么客户端要拦一遍：宿主也会回 bad-request，但那一来一回既慢又只能显示在顶部；
 * 行内表单的「就地原因」必须在请求之前就有。判定与宿主 payload schema 同口径
 *（http(s) 协议 + 1–50 的整数），不另造更宽或更窄的规则。
 */
function backfillInputReason(rawUrl: string, rawLimit: string): string | undefined {
  // 协议判据与宿主 payload 声明共用 shared.ts 的 isHttpUrl；篇数边界共用 BACKFILL_LIMIT。
  // 客户端只负责「就地原因」，不再维护第二套数字/协议清单（两道校验仍都要有）。
  if (!isHttpUrl(rawUrl.trim())) return '归档页地址必须是 http(s) 地址'
  const limitText = rawLimit.trim()
  const limitReason = '篇数必须是 ' + BACKFILL_LIMIT.min + '–' + BACKFILL_LIMIT.max + ' 的整数'
  if (!/^\d+$/.test(limitText)) return limitReason
  const limit = Number(limitText)
  if (limit < BACKFILL_LIMIT.min || limit > BACKFILL_LIMIT.max) return limitReason
  return undefined
}

/** 健康状态的三个人话标签（判据在 shared.ts 的 feedHealthOf，这里只负责措辞）。 */
function feedHealthLabel(feed: FeedView): string {
  const health = feedHealthOf(feed)
  return health === 'ok' ? '正常' : health === 'warn' ? '有告警' : '从未成功'
}

/**
 * 试读结果的一行文案（spec §4.3.3）：成功是「可用 N 条 · 耗时 X ms」，失败直接给原因。
 *
 * 不在这里补「0 条」之类的默认值：`ok` 为真时 itemCount 一定来自解析器（空 feed 就是 0），
 * 缺字段只可能是契约漂移，写成「可用 · 耗时」比编一个数字诚实。
 */
function probeResultLabel(result: ProbeResult): string {
  if (!result.ok) return result.reason ?? '试读失败'
  const count = result.itemCount === undefined ? '' : ' ' + result.itemCount + ' 条'
  return '可用' + count + ' · 耗时 ' + result.elapsedMs + ' ms'
}

/**
 * 订阅管理视图：导入 OPML（逐源校验、坏源逐条列出）、导出、加源、退订、文件夹管理。
 *
 * 设计取舍：
 *  - **坏源报告必须逐条可读**（§3.1 要求「坏源单独标注」），而不是只报「3 个失败」。
 *  - **删除确认用行内确认条，而不是 window.confirm**：取消后要把焦点还给触发删除的按钮；
 *    原生 confirm 的焦点行为不可控，也无法在真实 DOM 测试里钉住（M2 03 的验收项）。
 *  - 输入框里的 Enter/Esc 自己处理并 stopPropagation：全局快捷键挂在 document 上，不能截走输入。
 */
export function FeedsView({
  feeds, folders, busy, report, notice, discovery,
  onImport, onExport, onAdd, onRemove, onDiscover, onClearDiscovery, onProbe, onHideNamespace,
  onCreateFolder, onRenameFolder, onDeleteFolder, onMoveFeed, onMoveOrder,
  onBackfill,
  tags, onCreateTag, onRenameTag, onDeleteTag, onBack,
  exploreAvailable, onExplore,
}: {
  feeds: FeedView[]
  folders: FolderView[]
  busy: boolean
  report: OpmlImportResult | undefined
  notice: string | undefined
  /** 发现结果（undefined = 没在挑选）。只展示候选，落库要等用户点「添加」走 onAdd。 */
  discovery: DiscoveryResult | undefined
  onImport: (text: string) => void
  onExport: () => void
  onAdd: (url: string) => void
  /** 只发现、不订阅：候选交给用户挑（宿主侧零写入） */
  onDiscover: (url: string) => void
  /** 试读（R15 10）：只读探测，返回逐条结果；不写库、不改订阅。 */
  onProbe: (urls: string[]) => Promise<ProbeResult[]>
  onClearDiscovery: () => void
  /**
   * 隐藏整个 RSSHub 站点（R15 07）：只对 `source === 'rsshub'` 的候选给入口，
   * namespace 取候选 URL 的 pathname 首段。
   */
  onHideNamespace: (namespace: string) => void
  onRemove: (url: string) => void
  onCreateFolder: (name: string) => void
  onRenameFolder: (from: string, to: string) => void
  onDeleteFolder: (name: string) => void
  onMoveFeed: (feedId: string, folder: string | undefined) => void
  /** 上 / 下挪一格（R3-03）。只发意图，行序等宿主回包后的 reload。 */
  onMoveOrder: (feedId: string, direction: -1 | 1) => void
  /**
   * 回溯一个源（R9 03）：只发 RPC，成功后宿主侧 reload；界面只展示返回的报告 / 可读原因。
   * 组件保持纯展示 —— 网络与 state 写入都在 store 动作里。
   */
  onBackfill: (feedId: string, archiveUrl: string, limit: number) => Promise<BackfillActionResult>
  tags: TagView[]
  onCreateTag: (name: string) => void
  onRenameTag: (id: string, name: string) => void
  onDeleteTag: (id: string) => void
  onBack: () => void
  /** 探索入口是否可见（R8b 04 / D11）：判据由入口按 settings 快照统一算好。 */
  exploreAvailable: boolean
  /** 打开探索视图（订阅管理页只发意图）。 */
  onExplore: () => void
}): ReactNode {
  const [draft, setDraft] = useState('')
  /**
   * 试读状态（R15 10）。候选结果按 URL 存：同一批候选里各看各的，互不覆盖；
   * 地址输入框的结果单独一份（它还没有「候选 URL」这个身份）。
   */
  const [inputProbe, setInputProbe] = useState<ProbeResult | undefined>(undefined)
  const [inputProbing, setInputProbing] = useState(false)
  const [candidateProbes, setCandidateProbes] = useState<Readonly<Record<string, ProbeResult>>>({})
  const [probingCandidates, setProbingCandidates] = useState<ReadonlySet<string>>(() => new Set())
  /** 连点的同步守卫：setState 要等下一次渲染才置灰，同一事件循环的第二下会赶在它之前。 */
  const probeInFlight = useRef(new Set<string>())
  const [fileError, setFileError] = useState<string | undefined>(undefined)
  const [folderDraft, setFolderDraft] = useState('')
  const [renaming, setRenaming] = useState<RenameDraft | undefined>(undefined)
  const [confirmingDelete, setConfirmingDelete] = useState<string | undefined>(undefined)
  const [tagDraft, setTagDraft] = useState('')
  const [tagRenaming, setTagRenaming] = useState<TagRenameDraft | undefined>(undefined)
  const [tagConfirmingDelete, setTagConfirmingDelete] = useState<string | undefined>(undefined)
  const renameButtons = useRef(new Map<string, HTMLButtonElement | null>())
  const deleteButtons = useRef(new Map<string, HTMLButtonElement | null>())
  const tagRenameButtons = useRef(new Map<string, HTMLButtonElement | null>())
  /**
   * 回溯相关状态（R9 03）。结果 / 原因按源保存：一次运行结束后收起表单也要能回看，
   * 而且每个源的结果互不覆盖（上层允许对不同的源各跑一次）。
   */
  const [backfillDraft, setBackfillDraft] = useState<BackfillDraft | undefined>(undefined)
  /**
   * 正在跑的源集合（不是单个 id）：不同源可以同时跑，各自的行只按自己是否在集合里置灰。
   * 用 Set 而不是一个 string，是因为后开始的源会把单个 id 覆盖掉，前一行会提前解禁。
   */
  const [backfillRunning, setBackfillRunning] = useState<ReadonlySet<string>>(() => new Set())
  const [backfillReports, setBackfillReports] = useState<Readonly<Record<string, BackfillReport>>>({})
  const [backfillReasons, setBackfillReasons] = useState<Readonly<Record<string, string>>>({})
  const backfillButtons = useRef(new Map<string, HTMLButtonElement | null>())
  /**
   * 连点的同步守卫：`backfillRunning` 要等下一次渲染才把「开始」置灰，
   * 同一事件循环里的第二下点击会赶在那之前。这里用 ref，setState 挡不住的那一下由它挡。
   */
  const backfillSubmitting = useRef(new Set<string>())

  /** 收起表单并把焦点还给触发它的「回溯」按钮（取消 / Esc 共用一条路径）。 */
  const closeBackfill = (feedId: string): void => {
    setBackfillDraft((current) => (current?.feedId === feedId ? undefined : current))
    backfillButtons.current.get(feedId)?.focus()
  }

  /**
   * 回溯输入框的键盘纪律（与本文件既有行内表单同一条）：
   * Enter 提交、Esc 取消，两者都 preventDefault + stopPropagation —— 全局快捷键挂在 document 上，
   * 输入框里的键不能被它截走（尤其 Esc，否则会顺手把订阅管理页关掉）。
   */
  const onBackfillFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>, feedId: string): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      void submitBackfill(feedId)
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeBackfill(feedId)
    }
  }

  /**
   * 提交一行回溯。客户端先拦非法输入（零请求），通过后才交给 store 动作。
   * 连点由 ref 守卫兜住；结束后无论成败都解除，允许用户改参数重跑。
   */
  const submitBackfill = async (feedId: string): Promise<void> => {
    const draft = backfillDraft
    if (draft === undefined || draft.feedId !== feedId) return
    const reason = backfillInputReason(draft.url, draft.limit)
    // 新一轮开始先清旧结果：留着上一次的数字会让人以为这次也跑完了。
    setBackfillReports((current) => withoutKey(current, feedId))
    setBackfillReasons((current) => withoutKey(current, feedId))
    if (reason !== undefined) {
      setBackfillReasons((current) => ({ ...current, [feedId]: reason }))
      return
    }
    if (backfillSubmitting.current.has(feedId)) return
    backfillSubmitting.current.add(feedId)
    setBackfillRunning((current) => new Set(current).add(feedId))
    try {
      const outcome = await onBackfill(feedId, draft.url.trim(), Number(draft.limit.trim()))
      if ('error' in outcome) setBackfillReasons((current) => ({ ...current, [feedId]: outcome.error }))
      else setBackfillReports((current) => ({ ...current, [feedId]: outcome.report }))
    } finally {
      backfillSubmitting.current.delete(feedId)
      setBackfillRunning((current) => {
        const next = new Set(current)
        next.delete(feedId)
        return next
      })
    }
  }

  const pickFile = (event: { target: { files?: ArrayLike<File> | null; value?: string } }): void => {
    const file = event.target.files?.[0]
    if (file === undefined || file === null) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : ''
      if (text.trim() === '') { setFileError('文件是空的'); return }
      setFileError(undefined)
      onImport(text)
    }
    reader.onerror = () => { setFileError('读取文件失败：' + String(reader.error ?? '未知原因')) }
    reader.readAsText(file)
  }

  /**
   * 试读输入框里的地址（R15 10）。返回的单条结果就地显示；通道错误也变成同一行的可读原因，
   * 不写全局 error（一次试读失败不该把整页打成错误）。
   */
  const probeInput = async (): Promise<void> => {
    const url = draft.trim()
    if (url === '' || inputProbing) return
    const startedAt = Date.now()
    setInputProbing(true)
    setInputProbe(undefined)
    try {
      const results = await onProbe([url])
      setInputProbe(results[0])
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure)
      setInputProbe({ url, ok: false, elapsedMs: Date.now() - startedAt, reason: '试读请求失败：' + reason })
    } finally {
      setInputProbing(false)
    }
  }

  /** 试读一条候选；结果按 URL 存，连点由 ref 同步挡住（按钮置灰要等下一帧）。 */
  const probeCandidate = async (url: string): Promise<void> => {
    if (probeInFlight.current.has(url)) return
    probeInFlight.current.add(url)
    const startedAt = Date.now()
    setProbingCandidates((current) => new Set(current).add(url))
    try {
      const results = await onProbe([url])
      const result = results[0]
      if (result !== undefined) setCandidateProbes((current) => ({ ...current, [url]: result }))
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure)
      setCandidateProbes((current) => ({
        ...current,
        [url]: { url, ok: false, elapsedMs: Date.now() - startedAt, reason: '试读请求失败：' + reason },
      }))
    } finally {
      probeInFlight.current.delete(url)
      setProbingCandidates((current) => {
        const next = new Set(current)
        next.delete(url)
        return next
      })
    }
  }

  const commitRename = (): void => {
    const target = renaming
    if (target === undefined) return
    const name = target.draft.trim()
    if (name === '') return
    setRenaming(undefined)
    onRenameFolder(target.name, name)
    // 重命名按钮始终在 DOM 里（草稿输入在它下方），所以这里能同步把焦点还给它；
    // 若等 React 重渲染再 focus，jsdom/真机上都会有一帧读到旧节点。
    renameButtons.current.get(target.name)?.focus()
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 22px 24px', fontSize: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" onClick={onBack}>← 返回列表（Esc）</button>
        <strong style={{ fontSize: 15 }}>订阅管理</strong>
        <span style={{ opacity: 0.6, fontSize: 12 }}>{feeds.length} 个源 · {folders.length} 个文件夹</span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <label className="dsh-rss-btn" style={{ cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.55 : 1 }}>
          导入 OPML…
          <input type="file" accept=".opml,.xml,text/xml,text/x-opml" disabled={busy}
            style={{ display: 'none' }} onChange={pickFile} />
        </label>
        <button type="button" className="dsh-rss-btn" disabled={busy || feeds.length === 0} onClick={onExport}>导出 OPML</button>
        <span style={{ flex: 1 }} />
        <input data-rss-add-input="" value={draft} placeholder="粘贴 feed 地址或站点首页（会自动发现 feed）后回车" disabled={busy}
          onChange={(event) => { setDraft(event.target.value); setInputProbe(undefined) }}
          onKeyDown={(event) => {
            // 本插件的全局快捷键挂在 document 上，输入框里的键不该被它截走；
            // 这里的 stopPropagation 是**双保险**（守卫已按 target 判断，但回车提交不该外泄）
            if (event.key === 'Enter' && draft.trim() !== '') {
              event.stopPropagation()
              onAdd(draft.trim())
              setDraft('')
              setInputProbe(undefined)
            }
            if (event.key === 'Escape') {
              event.stopPropagation()
              setDraft('')
              setInputProbe(undefined)
            }
          }}
          style={{ flex: '0 1 320px', fontSize: 13, padding: '4px 8px' }} />
        {/* 「试读」只观测、不写入（R15 10）：和「发现候选」并列，给手填的地址一个先看再存的机会。 */}
        <button type="button" className="dsh-rss-btn" data-rss-add-probe=""
          disabled={busy || inputProbing || draft.trim() === ''}
          onClick={() => { void probeInput() }}>{inputProbing ? '试读中…' : '试读'}</button>
        {/* 「发现」与回车「直接添加」并存：回车保持既有语义（粘贴 feed 地址一步到位），
            发现是显式的第二条路 —— 站点首页常常有多个声明，挑哪个只有用户知道。 */}
        <button type="button" className="dsh-rss-btn" data-rss-discover=""
          disabled={busy || draft.trim() === ''}
          onClick={() => { onDiscover(draft.trim()) }}>发现候选</button>
        {/* R8b 04 / D11：未配置实例时入口整个不渲染（与设置页那条同一判据）。 */}
        {exploreAvailable && (
          <button type="button" className="dsh-rss-btn" data-rss-explore-open="" onClick={onExplore}>
            浏览路由表
          </button>
        )}
      </div>

      {inputProbe !== undefined && (
        <div data-rss-add-probe-result="" style={{
          fontSize: 12, marginBottom: 10, wordBreak: 'break-all',
          color: inputProbe.ok ? undefined : '#c0392b',
        }}>
          {probeResultLabel(inputProbe)}
        </div>
      )}

      {/* 说明文案提前讲清边界（R3-4）：排序只是显示先后，OPML 标准没有顺序字段，别把它当备份。 */}
      <div data-rss-feed-order-hint="" style={{ fontSize: 12, opacity: 0.65, marginBottom: 10 }}>
        ↑ / ↓ 调整顺序，只影响显示先后；OPML 不记录顺序，导出再导入不保证原顺序。
      </div>

      {discovery !== undefined && (
        <section data-rss-discovery="" aria-label="发现的订阅候选"
          style={{ marginBottom: 16, padding: '10px 12px', background: 'color-mix(in srgb, currentColor 6%, transparent)', borderRadius: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <strong style={{ fontSize: 13 }}>订阅候选</strong>
            <span style={{ opacity: 0.6, fontSize: 12, wordBreak: 'break-all' }}>
              {discovery.candidates.length} 个候选 · {discovery.url}
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-discovery-cancel=""
              disabled={busy} onClick={onClearDiscovery}>取消</button>
          </div>
          {discovery.candidates.length === 0 && (
            <div data-rss-discovery-empty="" style={{ fontSize: 12, opacity: 0.8 }}>
              没有发现可订阅的源。可以继续用上面的输入框手动添加 feed 地址。
            </div>
          )}
          {discovery.candidates.map((candidate) => {
            // 两类候选混排（spec D9）：来源徽标 + 第二行措辞不同。Radar 候选**没有抓取校验**
            // （ADR-0010），初始只写「站点名 · 未验证」而不编造 format / 条数；用户点「试读」后
            // 才换成「可用 N 条 · 耗时」或失败原因。页面候选保留原有的「地址 · 格式 · N 条」，
            // 试读结果另起一行。真正的校验仍在「添加」时由 addFeed 做。
            const isRadar = candidate.source === 'rsshub'
            // 只有 RSSHub 候选才有「站点」可隐藏：namespace 是 pathname 首段。页面候选的路径
            // 首段只是站点自己的目录（/github/feed.xml），按它隐藏会误杀普通订阅。
            const candidateNamespace = isRadar ? rsshubNamespaceOf(candidate.url) : undefined
            const probe = candidateProbes[candidate.url]
            const probing = probingCandidates.has(candidate.url)
            return (
              <div key={candidate.url} data-rss-candidate={candidate.url} title={candidate.url}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid color-mix(in srgb, currentColor 8%, transparent)' }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block' }}>
                    {candidate.title !== undefined && candidate.title !== '' ? candidate.title : candidate.url}
                    <span data-rss-candidate-source={candidate.source}
                      style={{
                        marginLeft: 6, padding: '0 5px', borderRadius: 3, border: '1px solid currentColor',
                        fontSize: 10, opacity: 0.65, whiteSpace: 'nowrap',
                      }}>{isRadar ? 'RSSHub' : '页面声明'}</span>
                  </span>
                  <span style={{ display: 'block', fontSize: 11, opacity: 0.6, wordBreak: 'break-all' }}>
                    {isRadar ? (
                      <>
                        {candidate.siteName !== undefined && candidate.siteName !== '' ? candidate.siteName + ' · ' : ''}
                        <span data-rss-candidate-probe-result={probe === undefined ? undefined : candidate.url}
                          style={probe !== undefined && !probe.ok ? { color: '#c0392b' } : undefined}>
                          {probe === undefined ? '未验证' : probeResultLabel(probe)}
                        </span>
                      </>
                    ) : (
                      <>
                        {candidate.url}
                        {candidate.format !== undefined ? ' · ' + candidate.format : ''}
                        {candidate.itemCount !== undefined ? ' · ' + candidate.itemCount + ' 条' : ''}
                      </>
                    )}
                  </span>
                  {!isRadar && probe !== undefined && (
                    <span data-rss-candidate-probe-result={candidate.url} style={{
                      display: 'block', fontSize: 11, wordBreak: 'break-all',
                      color: probe.ok ? undefined : '#c0392b',
                    }}>
                      {probeResultLabel(probe)}
                    </span>
                  )}
                </span>
                <button type="button" className="dsh-rss-btn" data-rss-candidate-probe={candidate.url}
                  disabled={busy || probing}
                  onClick={() => { void probeCandidate(candidate.url) }}>{probing ? '试读中…' : '试读'}</button>
                {candidateNamespace !== undefined && (
                  <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-candidate-hide={candidate.url}
                    title={'不再显示「' + (candidate.siteName ?? candidateNamespace) + '」的候选；已订阅的源与条目不受影响'}
                    disabled={busy} onClick={() => { onHideNamespace(candidateNamespace) }}>隐藏此站点</button>
                )}
                <button type="button" className="dsh-rss-btn" data-rss-candidate-add={candidate.url}
                  disabled={busy} onClick={() => { onAdd(candidate.url) }}>添加</button>
              </div>
            )
          })}
          {discovery.warnings.length > 0 && (
            <div style={{ fontSize: 12, color: '#c0392b', marginTop: 4 }}>
              {discovery.warnings.map((warning, index) => (
                <div key={index} data-rss-discovery-warning="" style={{ wordBreak: 'break-all' }}>
                  · {warning.url ?? discovery.url} —— {warning.reason}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <section style={{ marginBottom: 16 }} aria-label="文件夹管理">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <strong style={{ fontSize: 13 }}>文件夹</strong>
          <span style={{ opacity: 0.6, fontSize: 12 }}>空文件夹也会保留</span>
        </div>
        <form data-rss-folder-create="" style={{ display: 'flex', gap: 6, marginBottom: 8 }}
          onSubmit={(event) => {
            event.preventDefault()
            const name = folderDraft.trim()
            if (name === '') return
            onCreateFolder(name)
            setFolderDraft('')
          }}>
          <input data-rss-folder-new="" value={folderDraft} disabled={busy}
            placeholder="新建文件夹名称（1–80 个字符）"
            onChange={(event) => setFolderDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.stopPropagation(); setFolderDraft('') }
            }}
            style={{ flex: '0 1 260px', fontSize: 13, padding: '4px 8px' }} />
          <button type="submit" className="dsh-rss-btn" disabled={busy || folderDraft.trim() === ''}>新建文件夹</button>
        </form>

        {folders.length === 0 && <div style={{ padding: '4px 0', opacity: 0.7, fontSize: 12 }}>还没有文件夹。</div>}
        {folders.map((folder) => (
          <div key={folder.name} data-rss-folder-manage={folder.name} style={{ padding: '6px 0', borderTop: '1px solid color-mix(in srgb, currentColor 8%, transparent)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block' }}>{folder.name}</span>
                <span style={{ display: 'block', fontSize: 11, opacity: 0.6 }}>{folder.feedIds.length} 个订阅</span>
              </span>
              <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
                data-rss-folder-rename={folder.name}
                ref={(node) => { renameButtons.current.set(folder.name, node) }}
                disabled={busy}
                onClick={() => setRenaming({ name: folder.name, draft: folder.name })}>重命名</button>
              <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
                data-rss-folder-delete={folder.name}
                ref={(node) => { deleteButtons.current.set(folder.name, node) }}
                disabled={busy}
                onClick={() => setConfirmingDelete(folder.name)}>删除</button>
            </div>

            {renaming?.name === folder.name && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <input data-rss-folder-rename-input={folder.name} value={renaming.draft} autoFocus
                  onChange={(event) => setRenaming({ name: folder.name, draft: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); commitRename() }
                    if (event.key === 'Escape') {
                      event.preventDefault(); event.stopPropagation(); setRenaming(undefined)
                      renameButtons.current.get(folder.name)?.focus()
                    }
                  }}
                  style={{ flex: '0 1 240px', fontSize: 13, padding: '4px 8px' }} />
                <button type="button" className="dsh-rss-btn" data-rss-folder-rename-save={folder.name}
                  disabled={busy || renaming.draft.trim() === ''} onClick={commitRename}>保存</button>
                <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-folder-rename-cancel={folder.name}
                  onClick={() => {
                    setRenaming(undefined)
                    renameButtons.current.get(folder.name)?.focus()
                  }}>取消</button>
              </div>
            )}

            {confirmingDelete === folder.name && (
              <div role="alertdialog" aria-label={'删除文件夹 ' + folder.name} data-rss-folder-confirm={folder.name}
                onKeyDown={(event) => {
                  // 确认条里的 Esc = 取消，并把焦点还给触发删除的按钮（与输入框的 Esc 同一约定）。
                  if (event.key === 'Escape') {
                    event.preventDefault(); event.stopPropagation(); setConfirmingDelete(undefined)
                    deleteButtons.current.get(folder.name)?.focus()
                  }
                }}
                style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 6, padding: '6px 8px', background: 'color-mix(in srgb, currentColor 6%, transparent)', borderRadius: 6 }}>
                <span style={{ flex: '1 1 260px', fontSize: 12 }}>
                  删除「{folder.name}」？成员会变为未分类；不会退订，也不会删除文章。
                </span>
                <button type="button" className="dsh-rss-btn" data-rss-folder-confirm-yes={folder.name}
                  autoFocus disabled={busy}
                  onClick={() => { setConfirmingDelete(undefined); onDeleteFolder(folder.name) }}>确认删除</button>
                <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-folder-confirm-no={folder.name}
                  onClick={() => {
                    setConfirmingDelete(undefined)
                    deleteButtons.current.get(folder.name)?.focus()
                  }}>取消</button>
              </div>
            )}
          </div>
        ))}
      </section>

      <section style={{ marginBottom: 16 }} aria-label="标签管理">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <strong style={{ fontSize: 13 }}>标签</strong>
          <span style={{ opacity: 0.6, fontSize: 12 }}>只分类；删除标签不会删除文章</span>
        </div>
        <form data-rss-tag-create="" style={{ display: 'flex', gap: 6, marginBottom: 8 }}
          onSubmit={(event) => {
            event.preventDefault()
            const name = tagDraft.trim()
            if (name === '') return
            onCreateTag(name)
            setTagDraft('')
          }}>
          <input data-rss-tag-new="" value={tagDraft} disabled={busy}
            placeholder="新建标签名称（1–80 个字符）"
            onChange={(event) => setTagDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.stopPropagation(); setTagDraft('') }
            }}
            style={{ flex: '0 1 260px', fontSize: 13, padding: '4px 8px' }} />
          <button type="submit" className="dsh-rss-btn" disabled={busy || tagDraft.trim() === ''}>新建标签</button>
        </form>

        {tags.length === 0 && <div style={{ padding: '4px 0', opacity: 0.7, fontSize: 12 }}>还没有标签。</div>}
        {tags.map((tag) => (
          <div key={tag.id} data-rss-tag-manage={tag.id} style={{ padding: '6px 0', borderTop: '1px solid color-mix(in srgb, currentColor 8%, transparent)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block' }}># {tag.name}</span>
                <span style={{ display: 'block', fontSize: 11, opacity: 0.6 }}>{tag.itemCount ?? 0} 篇文章</span>
              </span>
              <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
                data-rss-tag-rename={tag.id}
                ref={(node) => { tagRenameButtons.current.set(tag.id, node) }}
                disabled={busy}
                onClick={() => setTagRenaming({ id: tag.id, draft: tag.name })}>重命名</button>
              <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
                data-rss-tag-delete={tag.id} disabled={busy}
                onClick={() => setTagConfirmingDelete(tag.id)}>删除</button>
            </div>
            {tagRenaming?.id === tag.id && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <input data-rss-tag-rename-input={tag.id} value={tagRenaming.draft} autoFocus
                  onChange={(event) => setTagRenaming({ id: tag.id, draft: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault(); event.stopPropagation()
                      const name = tagRenaming.draft.trim()
                      if (name !== '') { onRenameTag(tag.id, name); setTagRenaming(undefined); tagRenameButtons.current.get(tag.id)?.focus() }
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault(); event.stopPropagation(); setTagRenaming(undefined)
                      tagRenameButtons.current.get(tag.id)?.focus()
                    }
                  }}
                  style={{ flex: '0 1 240px', fontSize: 13, padding: '4px 8px' }} />
                <button type="button" className="dsh-rss-btn" data-rss-tag-rename-save={tag.id}
                  disabled={busy || tagRenaming.draft.trim() === ''}
                  onClick={() => {
                    const name = tagRenaming.draft.trim()
                    if (name === '') return
                    onRenameTag(tag.id, name); setTagRenaming(undefined); tagRenameButtons.current.get(tag.id)?.focus()
                  }}>保存</button>
                <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-tag-rename-cancel={tag.id}
                  onClick={() => { setTagRenaming(undefined); tagRenameButtons.current.get(tag.id)?.focus() }}>取消</button>
              </div>
            )}
            {tagConfirmingDelete === tag.id && (
              <div role="alertdialog" aria-label={'删除标签 ' + tag.name} data-rss-tag-confirm={tag.id}
                style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 6, padding: '6px 8px', background: 'color-mix(in srgb, currentColor 6%, transparent)', borderRadius: 6 }}>
                <span style={{ flex: '1 1 260px', fontSize: 12 }}>删除标签「{tag.name}」？只清除文章关联，不删除文章。</span>
                <button type="button" className="dsh-rss-btn" data-rss-tag-confirm-yes={tag.id}
                  disabled={busy} onClick={() => { setTagConfirmingDelete(undefined); onDeleteTag(tag.id) }}>确认删除</button>
                <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-tag-confirm-no={tag.id}
                  onClick={() => setTagConfirmingDelete(undefined)}>取消</button>
              </div>
            )}
          </div>
        ))}
      </section>

      {busy && <div style={{ opacity: 0.75, marginBottom: 8 }}>正在逐源抓取校验…（并发受限，源多时需要一会儿）</div>}
      {fileError !== undefined && <div style={{ color: '#c0392b', marginBottom: 8 }}>{fileError}</div>}
      {notice !== undefined && <div style={{ opacity: 0.85, marginBottom: 8 }}>{notice}</div>}

      {report !== undefined && (
        <div style={{ marginBottom: 14, padding: '10px 12px', background: 'color-mix(in srgb, currentColor 6%, transparent)', borderRadius: 6 }}>
          <div style={{ marginBottom: 6 }}>
            导入结果：新增 <strong>{report.added}</strong> 个，已存在 {report.existed} 个，
            校验失败 <strong style={{ color: report.failed.length > 0 ? '#c0392b' : 'inherit' }}>{report.failed.length}</strong> 个，
            文件内跳过 {report.skipped.length} 项
          </div>
          {report.failed.length > 0 && (
            <div style={{ fontSize: 12, color: '#c0392b' }}>
              <div style={{ marginBottom: 2 }}>以下源校验失败（未加入订阅，其余不受影响）：</div>
              {report.failed.map((row) => (
                <div key={row.url} style={{ wordBreak: 'break-all' }}>· {row.url} —— {row.reason}</div>
              ))}
            </div>
          )}
          {report.skipped.length > 0 && (
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
              <div style={{ marginBottom: 2 }}>文件里被跳过的条目：</div>
              {report.skipped.map((row, index) => (
                <div key={index}>· {row.title ?? '(无标题)'} —— {row.reason}</div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ borderTop: '1px solid color-mix(in srgb, currentColor 12%, transparent)' }}>
        {feeds.length === 0 && <div style={{ padding: '12px 0', opacity: 0.7 }}>还没有订阅源。可以用上面的「导入 OPML…」。</div>}
        {feeds.map((feed, index) => {
          // 运行中：本行的写操作与回溯入口一起置灰；别的源不受影响（各源的回溯互不共享写盘）。
          const backfillBusy = backfillRunning.has(feed.id)
          const draft = backfillDraft?.feedId === feed.id ? backfillDraft : undefined
          const backfillReport = backfillReports[feed.id]
          const backfillReason = backfillReasons[feed.id]
          return (
            <div key={feed.id} data-rss-feed-row={feed.id} style={{
              padding: '8px 0',
              borderBottom: '1px solid color-mix(in srgb, currentColor 8%, transparent)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block' }}>{feed.title ?? feed.id}</span>
                  <span style={{ display: 'block', fontSize: 11, opacity: 0.6, wordBreak: 'break-all' }}>
                    {feed.id}{feed.folder !== undefined ? ' · 文件夹：' + feed.folder : ' · 未分类'}
                  </span>
                  {/* R15 02：来源由宿主裁决并下发（FeedView.rsshub），客户端**不拿实例池重判** ——
                      两个裁决者迟早漂。非 RSSHub 源没有这个字段，这里什么都不渲染。 */}
                  {feed.rsshub !== undefined && (
                    <span data-rss-feed-rsshub={feed.id}
                      style={{ display: 'block', fontSize: 11, opacity: 0.75, wordBreak: 'break-all' }}>
                      {'RSSHub · ' + (feed.rsshub.instance ?? '实例未知')}
                    </span>
                  )}
                  {/* 健康信息（M4 02）：状态 / 连败次数 / 最近尝试 / 上次成功 / 最近错误。
                      连败次数缺失时写「次数未知」而不是 0 —— 老记录从来没记过计数（见 domain.ts 的三态）。 */}
                  <span data-rss-feed-health={feed.id} style={{ display: 'block', fontSize: 11, opacity: 0.75, wordBreak: 'break-all' }}>
                    {'健康：' + feedHealthLabel(feed)}
                    {' · 连续失败：' + (feed.failureCount === undefined ? '次数未知' : feed.failureCount + ' 次')}
                    {' · 最近尝试：' + (feed.lastAttemptedAt === undefined ? '从未' : relativeTime(feed.lastAttemptedAt))}
                    {' · 上次成功：' + (feed.lastFetchedAt === undefined ? '从未' : relativeTime(feed.lastFetchedAt))}
                    {feed.lastFailure !== undefined ? ' · 最近错误：' + feed.lastFailure : ''}
                  </span>
                </span>
                {/* 原生按钮即可满足「可聚焦、回车触发」；**不承诺空格**（空格是全局翻页键）。
                    首行 ↑ / 末行 ↓ 置灰；busy（导入/加源在途）或本行回溯运行中时全灰——
                    同一份订阅文件与同一条源不能有两个写手。 */}
                <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
                  data-rss-feed-order-up={feed.id}
                  aria-label={'上移「' + (feed.title ?? feed.id) + '」'}
                  title="上移一位"
                  disabled={busy || backfillBusy || index === 0}
                  onClick={() => onMoveOrder(feed.id, -1)}>↑</button>
                <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
                  data-rss-feed-order-down={feed.id}
                  aria-label={'下移「' + (feed.title ?? feed.id) + '」'}
                  title="下移一位"
                  disabled={busy || backfillBusy || index === feeds.length - 1}
                  onClick={() => onMoveOrder(feed.id, 1)}>↓</button>
                <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                  移动到
                  <select data-rss-feed-folder={feed.id} value={feed.folder ?? ''} disabled={busy || backfillBusy}
                    onChange={(event) => onMoveFeed(feed.id, event.target.value === '' ? undefined : event.target.value)}>
                    <option value="">未分类</option>
                    {folders.map((folder) => <option key={folder.name} value={folder.name}>{folder.name}</option>)}
                  </select>
                </label>
                {/* 回溯入口（R9 03）：展开一页归档页 + 篇数，结果留在同一行。 */}
                <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
                  data-rss-feed-backfill={feed.id}
                  ref={(node) => { backfillButtons.current.set(feed.id, node) }}
                  title="从归档页补更早的文章"
                  disabled={busy || backfillBusy}
                  onClick={() => {
                    if (backfillDraft?.feedId === feed.id) setBackfillDraft(undefined)
                    else setBackfillDraft({ feedId: feed.id, url: '', limit: String(BACKFILL_LIMIT.default) })
                  }}>回溯</button>
                <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
                  data-rss-feed-remove={feed.id}
                  title="退订并删除该源的全部条目（含星标，不可撤销）"
                  disabled={busy || backfillBusy}
                  onClick={() => {
                    if (window.confirm('退订该源并删除它的全部条目？\n\n' + feed.id +
                      '\n\n全部条目（包括你星标的）会被永久删除，此操作不可撤销。')) onRemove(feed.id)
                  }}>退订</button>
              </div>

              {draft !== undefined && (
                <form data-rss-backfill-form="" onSubmit={(event) => { event.preventDefault(); void submitBackfill(feed.id) }}
                  onKeyDown={(event) => {
                    // 表单内的 Esc 只收表单：stopPropagation 防止全局 Esc 把订阅管理页一起关掉。
                    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeBackfill(feed.id) }
                  }}
                  style={{
                    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 6,
                    padding: '6px 8px', background: 'color-mix(in srgb, currentColor 6%, transparent)', borderRadius: 6,
                  }}>
                  <input data-rss-backfill-url="" value={draft.url} autoFocus disabled={backfillBusy}
                    placeholder="归档页地址（http/https）"
                    onChange={(event) => setBackfillDraft({ ...draft, url: event.target.value })}
                    onKeyDown={(event) => onBackfillFieldKeyDown(event, feed.id)}
                    style={{ flex: '1 1 300px', fontSize: 13, padding: '4px 8px' }} />
                  <input data-rss-backfill-limit="" value={draft.limit} inputMode="numeric" disabled={backfillBusy}
                    placeholder="篇数（1–50）"
                    onChange={(event) => setBackfillDraft({ ...draft, limit: event.target.value })}
                    onKeyDown={(event) => onBackfillFieldKeyDown(event, feed.id)}
                    style={{ width: 96, fontSize: 13, padding: '4px 8px' }} />
                  <button type="submit" className="dsh-rss-btn" data-rss-backfill-start=""
                    disabled={backfillBusy}>开始</button>
                  <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-backfill-cancel=""
                    disabled={backfillBusy} onClick={() => closeBackfill(feed.id)}>取消</button>
                </form>
              )}

              {(backfillReason !== undefined || backfillReport !== undefined) && (
                <div data-rss-backfill-result="" aria-live="polite"
                  role={backfillReason === undefined ? undefined : 'alert'}
                  style={{
                    marginTop: 6, padding: '6px 8px', fontSize: 12, borderRadius: 6,
                    background: 'color-mix(in srgb, currentColor 5%, transparent)',
                  }}>
                  {backfillReason !== undefined && (
                    <div data-rss-backfill-error="" style={{ color: '#c0392b', wordBreak: 'break-all' }}>{backfillReason}</div>
                  )}
                  {backfillReport !== undefined && (
                    <>
                      <div data-rss-backfill-summary="">
                        {'新增 '}<strong>{backfillReport.added}</strong>{' 篇 · 已存在 ' + backfillReport.existing
                          + ' 篇 · 形态命中 ' + backfillReport.matched + ' 篇'}
                        {'（归档页链接 ' + backfillReport.archiveLinks + ' 条，尝试 ' + backfillReport.attempted
                          + ' 篇，剩余 ' + backfillReport.remaining + ' 篇）'}
                      </div>
                      {/* stoppedBy 的两种原因各给一句人话：只回字段值等于让用户自己猜。 */}
                      {backfillReport.stoppedBy === 'deadline' && (
                        <div data-rss-backfill-stopped="deadline" style={{ marginTop: 2 }}>
                          {'已到单轮 120 秒预算，这次不再发起新请求；剩余 ' + backfillReport.remaining + ' 篇可重跑接着补。'}
                        </div>
                      )}
                      {backfillReport.stoppedBy === 'limit' && (
                        <div data-rss-backfill-stopped="limit" style={{ marginTop: 2 }}>
                          {'受每源上限限制，这次只回溯了 ' + backfillReport.attempted + ' 篇；剩余 '
                            + backfillReport.remaining + ' 篇可先调大每源上限或清理条目后再跑。'}
                        </div>
                      )}
                      {/* 失败必须逐条列出原因；没有失败时整块不渲染，不留一个空列表。 */}
                      {backfillReport.failures.length > 0 && (
                        <div data-rss-backfill-failures="" style={{ marginTop: 2, color: '#c0392b' }}>
                          <div>{'失败 ' + backfillReport.failures.length + ' 篇：'}</div>
                          {backfillReport.failures.map((failure, failureIndex) => (
                            <div key={failure.url + '#' + String(failureIndex)} data-rss-backfill-failure=""
                              style={{ wordBreak: 'break-all' }}>
                              {'· ' + failure.url + ' —— ' + failure.reason}
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 阅读器内的正文视图（D 方案）：段落由宿主抽取后回传，这里只做排版。 */
/**
 * 段落判定：含换行的段落来自 <pre>（宿主抽取时保留内部换行）⇒ 按代码块渲染。
 * 这是为了解决「代码全变样」——等宽字体 + 保留缩进 + 横向可滚动，而不是当普通文字折行。
 */
