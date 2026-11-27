/**
 * 精选源包的动作层（R15 08，spec §4.3.1 / §4.3.2 / §6 A13）。
 *
 * 为什么单独成文件：源包的 state（清单、搜索 / 分类筛选、加源表单）不属于列表 / 搜索 / 订阅 /
 * 标签 / 设置 / 探索任何一块。放进订阅域会把「清单」与「订阅」两种数据来源混在一起 ——
 * 而本票的核心不变量恰恰是「删源包条目 ≠ 退订」。
 *
 * 判据分工：
 *  - URL 归一化 / 去重 / 坏项丢弃在**宿主**（`normalizeCuratedSources`），客户端不复制一套；
 *  - 加源时的「抓一次解析」只调现有 `discoverFeeds`（宿主出网、解析），客户端不 fetch 任意地址；
 *  - 失败仍允许保存：原因写进 `note`（`未验证：…`），因为 wire 形状（spec §5.1）没有
 *    verified 字段，编一个不存在的字段会让下一次读盘把它丢掉。
 */
import { isHttpUrl, type CuratedSourceEntry, type DiscoveryResult, type OpmlImportResult, type SourcePackSaveResult, type SourcePackSnapshot } from '../shared.js'
import { buildSourcePackOpml } from './source-pack-opml.js'
import type { ReaderState, ReaderStoreDeps } from './store.js'

/**
 * 一次导入的条数上限（spec §4.3.2）。宿主会对每条逐源抓取校验，30 条已经是「一次请求跑几十秒」
 * 的量级；再大就不是提示分批而是让界面看起来卡死。这个数只在客户端拦（规范如此），
 * 宿主 opmlImport 本身不设限 —— 手动粘贴的 OPML 仍然一次全导。
 */
export const SOURCE_PACK_IMPORT_LIMIT = 30

/** 加源表单的草稿。`undefined` 的 sourcePack.formOpen = 表单没开。 */
export interface SourcePackDraft {
  url: string
  title: string
  category: string
  note: string
}

/**
 * 一次「抓取校验」的结果。`format` / `itemCount` 只用于界面即时显示（wire 形状里没有这两个
 * 字段，不落盘）；失败时 `reason` 会写进 `note`（`未验证：…`）保留下来。
 */
export type SourcePackProbe =
  | { readonly ok: true; readonly title?: string; readonly format?: string; readonly itemCount?: number }
  | { readonly ok: false; readonly reason: string }

/** 源包域整份状态：`view: 'sourcePack'` 时存在；离开视图后保留（再打开先用旧值，不闪空屏）。 */
export interface SourcePackState {
  entries: CuratedSourceEntry[]
  seed: { collectedAt: string; count: number }
  /** 搜索词（标题 / URL 子串，大小写不敏感）。 */
  q: string
  /** 单选分类（undefined = 全部）。 */
  category: string | undefined
  loading: boolean
  error: string | undefined
  /** 宿主的读侧 / 写侧告警（坏项被丢弃等）。 */
  warning: string | undefined
  notice: string | undefined
  saving: boolean
  /** 勾选待导入的条目 URL。真源是清单本身，这里只存 URL（条目被删时随之清理）。 */
  selected: string[]
  /** 导入请求在飞（按钮禁用、勾选冻结）。 */
  importing: boolean
  /** 上一次导入的逐条结果，宿主回包原样保存（界面不二次加工）。 */
  importReport: OpmlImportResult | undefined
  formOpen: boolean
  draft: SourcePackDraft
  probing: boolean
  probe: SourcePackProbe | undefined
}

export interface SourcePackActionHost {
  get: () => ReaderState
  set: (patch: Partial<ReaderState>) => void
  rpc: ReaderStoreDeps['rpc']
  now: ReaderStoreDeps['now']
  /** 导入后重取当前列表（与 opml-actions.importOpml 同一条路径：宿主已写入订阅）。 */
  reload: () => Promise<void>
}

/** 打开视图时的空状态：种子元信息先留空（宿主回包立刻填），清单在飞。 */
function emptySourcePack(): SourcePackState {
  return {
    entries: [],
    seed: { collectedAt: '', count: 0 },
    q: '',
    category: undefined,
    loading: true,
    error: undefined,
    warning: undefined,
    notice: undefined,
    saving: false,
    selected: [],
    importing: false,
    importReport: undefined,
    formOpen: false,
    draft: { url: '', title: '', category: '', note: '' },
    probing: false,
    probe: undefined,
  }
}

/** 把宿主快照并进现有状态：entries / seed / warning 是宿主的真相，其余是视图私有。 */
function withSnapshot(state: SourcePackState, snapshot: SourcePackSnapshot): SourcePackState {
  // 清单被整份替换后，勾选里指向已删条目的 URL 必须丢掉 —— 否则「导入所选（1/N）」会指向
  // 一个不存在的条目，点下去只能得到一条空 OPML。
  const present = new Set(snapshot.entries.map((entry) => entry.url))
  return {
    ...state,
    entries: snapshot.entries,
    seed: snapshot.seed,
    warning: snapshot.warning,
    loading: false,
    selected: state.selected.filter((url) => present.has(url)),
  }
}

export function createSourcePackActions(host: SourcePackActionHost) {
  const { get, set, rpc, now, reload } = host

  const load = async (): Promise<void> => {
    const current = get().sourcePack
    if (current === undefined) return
    set({ sourcePack: { ...current, loading: true, error: undefined } })
    try {
      const result = await rpc<{ sourcePack: SourcePackSnapshot }>('sourcePack')
      const state = get().sourcePack
      if (state === undefined) return
      set({ sourcePack: withSnapshot(state, result.sourcePack) })
    } catch (failure) {
      const state = get().sourcePack
      if (state === undefined) return
      // 取数失败不是「空清单」：错误原样留在视图里。
      set({
        sourcePack: {
          ...state, loading: false,
          error: failure instanceof Error ? failure.message : String(failure),
        },
      })
    }
  }

  /** 打开 / 关闭「精选源」视图（左栏那一行是 toggle，与控制台按钮同型）。 */
  const openSourcePack = (): void => {
    if (get().view === 'sourcePack') { set({ view: 'list' }); return }
    // 保留上一次的清单，打开时后台刷新：79+ 条不算大，但「每次打开都先闪一屏空清单」是可感知的。
    const existing = get().sourcePack
    set({
      view: 'sourcePack',
      sourcePack: existing === undefined
        ? emptySourcePack()
        : {
            ...existing, loading: true, error: undefined, notice: undefined,
            formOpen: false, probe: undefined, probing: false, saving: false,
            // 不清 importing：离开视图不会中止在飞请求，重开时必须如实显示「导入中…」。
            importReport: undefined,
          },
    })
    void load()
  }

  const closeSourcePack = (): void => { set({ view: 'list' }) }

  const setSourcePackQuery = (q: string): void => {
    const state = get().sourcePack
    if (state === undefined) return
    set({ sourcePack: { ...state, q } })
  }

  const setSourcePackCategory = (category: string | undefined): void => {
    const state = get().sourcePack
    if (state === undefined) return
    set({ sourcePack: { ...state, category } })
  }

  const openSourcePackForm = (): void => {
    const state = get().sourcePack
    if (state === undefined) return
    set({
      sourcePack: {
        ...state, formOpen: true, notice: undefined, error: undefined,
        draft: { url: '', title: '', category: '', note: '' }, probe: undefined, probing: false,
      },
    })
  }

  const closeSourcePackForm = (): void => {
    const state = get().sourcePack
    if (state === undefined) return
    set({ sourcePack: { ...state, formOpen: false, probe: undefined, probing: false, error: undefined } })
  }

  const setSourcePackDraft = (patch: Partial<SourcePackDraft>): void => {
    const state = get().sourcePack
    if (state === undefined) return
    set({ sourcePack: { ...state, draft: { ...state.draft, ...patch } } })
  }

  /** 粘贴 URL → 宿主抓一次并解析（复用 discoverFeeds，不新造校验引擎）。 */
  const probeSourcePackUrl = async (): Promise<void> => {
    const state = get().sourcePack
    if (state === undefined || state.probing) return
    const url = state.draft.url.trim()
    if (url === '') {
      set({ sourcePack: { ...state, probe: { ok: false, reason: '请先粘贴一个地址' } } })
      return
    }
    if (!isHttpUrl(url)) {
      set({ sourcePack: { ...state, probe: { ok: false, reason: '地址必须是绝对 http(s) 链接' } } })
      return
    }
    set({ sourcePack: { ...state, probing: true, probe: undefined, error: undefined } })
    try {
      const result = await rpc<DiscoveryResult>('discoverFeeds', { url })
      const current = get().sourcePack
      if (current === undefined) return
      const candidate = result.candidates.find((entry) => entry.url === result.url)
        ?? result.candidates.find((entry) => entry.url === url)
        ?? result.candidates[0]
      if (candidate === undefined) {
        const reason = result.warnings[0]?.reason ?? '没有找到可解析的 feed'
        set({ sourcePack: { ...current, probing: false, probe: { ok: false, reason } } })
        return
      }
      set({
        sourcePack: {
          ...current,
          probing: false,
          probe: { ok: true, title: candidate.title, format: candidate.format, itemCount: candidate.itemCount },
          // 标题只在用户没自己填时预填：用户输入优先。
          draft: {
            ...current.draft,
            title: current.draft.title.trim() === '' ? (candidate.title ?? '') : current.draft.title,
          },
        },
      })
    } catch (failure) {
      const current = get().sourcePack
      if (current === undefined) return
      set({
        sourcePack: {
          ...current, probing: false,
          probe: { ok: false, reason: failure instanceof Error ? failure.message : String(failure) },
        },
      })
    }
  }

  /**
   * 保存当前草稿。`force = true` 是「仍然保存」：没验证通过也允许入库，
   * 但把原因写进 note（`未验证：…`）—— 字段形状没有 verified 位，这是唯一不丢信息的合法位置。
   */
  const saveSourcePackDraft = async (force = false): Promise<void> => {
    const state = get().sourcePack
    if (state === undefined || state.saving) return
    const probe = state.probe
    if (probe === undefined) return
    if (!probe.ok && !force) return
    const url = state.draft.url.trim()
    if (!isHttpUrl(url)) return
    const note = state.draft.note.trim()
    // 校验结论（含格式 / 失败原因）写进 note：wire 形状（spec §5.1）没有 verified / format 字段，
    // 这是唯一能「重启后仍然看得见」的合法位置。用户自己的备注在前，机器结论放括号里。
    const marker = probe.ok
      ? `已验证：${probe.format === undefined ? '格式未识别' : probe.format}`
      : `未验证：${probe.reason}`
    const entry: CuratedSourceEntry = {
      url,
      addedAt: new Date(now()).toISOString(),
      ...(state.draft.title.trim() === '' ? {} : { title: state.draft.title.trim() }),
      ...(state.draft.category.trim() === '' ? {} : { category: state.draft.category.trim() }),
      note: note === '' ? marker : `${note}（${marker}）`,
    }
    await saveEntries([...state.entries, entry], { closeForm: true, notice: '已添加 ✓' })
  }

  /** 勾选 / 取消勾选一条。删条目后由 withSnapshot 兜底清理（勾选只存 URL，不存副本）。 */
  const toggleSourcePackSelection = (url: string): void => {
    const state = get().sourcePack
    // 导入在飞时冻结勾选：结果落地会清空勾选，期间的改动注定丢掉（30 条可能要跑几十秒）。
    if (state === undefined || state.importing) return
    const selected = state.selected.includes(url)
      ? state.selected.filter((item) => item !== url)
      : [...state.selected, url]
    set({ sourcePack: { ...state, selected } })
  }

  /**
   * 导入当前勾选（spec §4.3.2 / A14）。
   *
   * 一次最多 30 条：超限**只提示、不发请求**（这是本票的硬边界，测试钉「31 条时 opmlImport 零调用」）。
   * 客户端只负责拼 OPML，逐源抓取校验 / 去重 / 落库仍全部由宿主 opmlImport 做 —— 不新增端点、
   * 不跳过校验。失败条目由宿主挡在库外，客户端只把失败原因如实摆出来。
   *
   * 导入**不动**源包清单：它是清单不是订阅（08 的核心不变量），这里一次 saveSourcePack 都不发。
   */
  const importSelectedSourcePack = async (): Promise<void> => {
    const state = get().sourcePack
    if (state === undefined || state.importing) return
    // 以清单顺序为准（勾选只存 URL，不保证顺序；清单里已删的 URL 由 withSnapshot 清掉）。
    const chosen = state.entries.filter((entry) => state.selected.includes(entry.url))
    if (chosen.length === 0) return
    if (chosen.length > SOURCE_PACK_IMPORT_LIMIT) {
      set({
        sourcePack: {
          ...state,
          error: '一次最多导入 ' + SOURCE_PACK_IMPORT_LIMIT + ' 条（当前勾选 ' + chosen.length + ' 条），请分批导入',
        },
      })
      return
    }

    set({ sourcePack: { ...state, importing: true, error: undefined, importReport: undefined } })
    try {
      const report = await rpc<OpmlImportResult>('opmlImport', { opml: buildSourcePackOpml(chosen) })
      const current = get().sourcePack
      if (current === undefined) return
      // 结果原样留在视图里；勾选清空，避免用户以为「还没导」再点一次。
      set({ sourcePack: { ...current, importing: false, importReport: report, selected: [] } })
      // 与 opml-actions.importOpml 同一条路径：宿主写完订阅后本地必须重取，否则左栏看不到新源。
      await reload()
    } catch (failure) {
      const current = get().sourcePack
      if (current === undefined) return
      // 失败保留勾选：用户可以直接重试，不用重新一条条点。
      set({
        sourcePack: {
          ...current, importing: false,
          error: failure instanceof Error ? failure.message : String(failure),
        },
      })
    }
  }

  const removeSourcePackEntry = async (url: string): Promise<void> => {
    const state = get().sourcePack
    if (state === undefined || state.saving) return
    await saveEntries(state.entries.filter((entry) => entry.url !== url), { notice: '已删除' })
  }

  /** 恢复内置快照：只补缺失 URL（宿主算），不清用户自己的条目。 */
  const restoreSourcePackSeed = async (): Promise<void> => {
    const state = get().sourcePack
    if (state === undefined || state.saving) return
    await saveEntries(state.entries, { restoreSeed: true })
  }

  /**
   * 所有写操作的唯一出口：整份替换 + 用宿主回包覆盖本地清单。
   * 失败不改本地清单（否则界面显示删了、重启又回来）。
   */
  const saveEntries = async (
    entries: CuratedSourceEntry[],
    options: { restoreSeed?: boolean; closeForm?: boolean; notice?: string },
  ): Promise<void> => {
    const state = get().sourcePack
    if (state === undefined || state.saving) return
    // 清单要变了：上一份导入结果属于旧清单，继续挂着只会让人以为它还是这次操作的结论。
    set({ sourcePack: { ...state, saving: true, error: undefined, notice: undefined, importReport: undefined } })
    try {
      const result = await rpc<SourcePackSaveResult>(
        'saveSourcePack',
        { entries, ...(options.restoreSeed === true ? { restoreSeed: true } : {}) },
      )
      const current = get().sourcePack
      if (current === undefined) return
      const notice = options.restoreSeed === true
        ? (result.restored > 0 ? `已恢复 ${result.restored} 条内置源` : '内置源已全部在清单里')
        : options.notice
      const next = withSnapshot(current, result.sourcePack)
      set({
        sourcePack: {
          ...next,
          saving: false,
          ...(options.closeForm === true
            ? { formOpen: false, probe: undefined, draft: { url: '', title: '', category: '', note: '' } }
            : {}),
          ...(notice === undefined ? {} : { notice }),
        },
      })
    } catch (failure) {
      const current = get().sourcePack
      if (current === undefined) return
      set({
        sourcePack: {
          ...current, saving: false,
          error: failure instanceof Error ? failure.message : String(failure),
        },
      })
    }
  }

  return {
    openSourcePack, closeSourcePack, loadSourcePack: load,
    setSourcePackQuery, setSourcePackCategory, toggleSourcePackSelection,
    importSelectedSourcePack,
    openSourcePackForm, closeSourcePackForm, setSourcePackDraft,
    probeSourcePackUrl, saveSourcePackDraft, removeSourcePackEntry, restoreSourcePackSeed,
  }
}
