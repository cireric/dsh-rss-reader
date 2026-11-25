/**
 * 翻译域的客户端动作（R7 01 / 04）。
 *
 * 04 起这里编排**整篇**翻译：点一次「译」→ 视口可见块先成第一批 → 之后按文档顺序把剩余块逐批
 * 发完。三条不变量收在这一个文件里，因为它们是同一条链路的三半：
 *   ① 同时只有一批在飞（串行）；
 *   ② 同一时刻只允许一场翻译（`active`）；开新场先中止旧场；
 *   ③ 中止判定（`session.token` + 当前文章身份）在每批之间现查 —— 06 只需要在视图 / 条目
 *      变化时调 `stopTranslate()`，不需要自己维护「还剩哪些批」。
 *
 * 为什么动作住在独立文件而不是 store.ts：store 已经是 800 行的汇合点；翻译的写边界只有
 * `translations` 一个字段，独立成工厂后 02/03/05 扩展编排时不必在 store 里穿针。
 */
import type { TranslateBatchResult } from '../shared.js'
import {
  DEFAULT_TARGET_LANGUAGE,
  type TargetLanguage,
  TRANSLATE_LIMIT_TEXT,
} from '../translate-copy.js'
import {
  articleTranslatePlanOf,
  pickBatch,
  TRANSLATE_ARTICLE_MAX_CHARS,
  translateCharsOf,
  translatableTextOf,
  type PickBatchInput,
  type TranslateArticlePlan,
  type TranslateBlockRect,
  type TranslateGeometry,
  type TranslateRequestItem,
} from '../translate-blocks.js'
import {
  nextTranslationMode,
  type ReaderState,
  type ReaderStoreDeps,
  type TranslationEntry,
  type TranslationMode,
} from './store.js'

/** 内存键：条目 + 正文版本 + 目标语言（spec §4.6 / D11）。 */
export function translationKeyOf(itemId: string, contentVersion: string, target: TargetLanguage): string {
  return itemId + ':' + contentVersion + ':' + target
}

/** 从 store 快照里取某篇正文的译文；正文版本或语言不同都取不到（旧译文不冒充）。 */
export function translationEntryOf(
  state: ReaderState,
  itemId: string,
  contentVersion: string | undefined,
  target: TargetLanguage = DEFAULT_TARGET_LANGUAGE,
): TranslationEntry | undefined {
  if (contentVersion === undefined) return undefined
  return state.translations.get(translationKeyOf(itemId, contentVersion, target))
}

export interface TranslateActionHost {
  get: () => ReaderState
  set: (patch: Partial<ReaderState>) => void
  rpc: ReaderStoreDeps['rpc']
  log: ReaderStoreDeps['log']
}

/** 一场翻译的身份：token 用来判代，其余字段用来判「当前打开的还是不是这一篇」。 */
interface TranslateSession {
  readonly token: number
  readonly key: string
  readonly itemId: string
  readonly contentVersion: string
  readonly target: TargetLanguage
}

/**
 * 宿主回包的 items → 块下标译文。
 *
 * 这里**不用** `applyBatch`：那是宿主校验模型输出的判据（少给 / 多给 / 重复一律整批失败）。
 * 宿主已经把空白译文从回包里丢掉（见 translate.ts 的 items 拼装），客户端若要求「请求 id 一个
 * 不少」会把「某块模型返回空白」误判成整批失败 —— 而 spec 明确空白块只退回原文、不计批失败。
 * 客户端只守住自己收到的形状：id 必须属于本批、不许重复；缺的那条按「无译文」处理。
 */
function translatedBlocksOf(
  result: TranslateBatchResult,
  requestedIds: ReadonlySet<string>,
): Map<number, string> | undefined {
  if (!Array.isArray(result.items)) return undefined
  const blocks = new Map<number, string>()
  const seen = new Set<string>()
  for (const item of result.items) {
    if (typeof item.id !== 'string' || typeof item.text !== 'string') return undefined
    if (!requestedIds.has(item.id) || seen.has(item.id)) return undefined
    seen.add(item.id)
    if (item.text.trim() === '') continue
    const match = /^b(\d+)$/.exec(item.id)
    if (match === null) continue
    blocks.set(Number(match[1]), item.text)
  }
  return blocks
}

/** 正文块下标 → 请求项；空白块不发送（端点会整批 bad-request）。 */
function requestItemsOf(blocks: readonly Record<string, unknown>[], indices: readonly number[]): TranslateRequestItem[] {
  const items: TranslateRequestItem[] = []
  for (const index of indices) {
    const block = blocks[index]
    if (block === undefined) continue
    const text = translatableTextOf(block)
    if (text.trim() === '') continue
    items.push({ id: 'b' + index, text })
  }
  return items
}

export function createTranslateActions(host: TranslateActionHost) {
  const { get, set, rpc, log } = host

  /** 场次代号：每次开始 / 停止都自增。旧场次拿着旧 token 回来时只许静默退出。 */
  let generation = 0
  /** 当前唯一在场的那一场翻译；undefined = 没有正在跑的编排。 */
  let active: TranslateSession | undefined

  /** 整份替换 Map（不改原对象，React 才会看到变化）。 */
  const storeEntry = (entry: TranslationEntry): void => {
    const next = new Map(get().translations)
    next.set(entry.key, entry)
    set({ translations: next })
  }

  /**
   * 中止判据（spec §4.6 / D18）：换条目 / 离开正文视图 / 组件卸载后，后续批必须停。
   *
   * 组件卸载由 article-pane 的 cleanup 调 `stopTranslate()`；这里仍保留状态判据，是因为
   * `j` / `k` 换条目时组件不卸载 —— 只在每批之间现查状态，才能保证「不再发下一批」。
   */
  const sessionAborted = (session: TranslateSession): boolean => {
    const state = get()
    if (state.view !== 'article') return true
    if (state.article?.itemId !== session.itemId) return true
    if (state.article?.contentVersion !== session.contentVersion) return true
    return false
  }

  /** 把当前场次标成 stopped（在途批已跑完，done 保留已经写入的进度）。 */
  const markStopped = (session: TranslateSession): void => {
    // 旧代次不能写 store：同一 key 可能已经被新一场翻译接手，写 stopped 会覆盖 running。
    if (session.token !== generation) return
    const entry = get().translations.get(session.key)
    if (entry !== undefined && entry.status === 'running') storeEntry({ ...entry, status: 'stopped' })
    if (active?.token === session.token) active = undefined
  }

  /**
   * 中止当前这一场：不再发下一批；在途的那一批允许跑完（HTTP 层本来就取消不了）。
   *
   * 06 的停止按钮 / 视图与条目变化都接这里。默认可在什么都没跑时调用（幂等）。
   */
  const stopTranslate = (): void => {
    const session = active
    generation += 1
    active = undefined
    if (session === undefined) return
    const entry = get().translations.get(session.key)
    if (entry !== undefined && entry.status === 'running') storeEntry({ ...entry, status: 'stopped' })
  }

  /**
   * 手动选三态（R7 03 / spec §4.5）。
   *
   * **只改渲染状态**：不碰 translations、不发任何 rpc ——「切到译文再切回原文」是纯视图动作
   * （验收 12 / 本票第 7 条），重新翻译只能走「译 / 重译」。
   */
  const setTranslationMode = (mode: TranslationMode): void => {
    if (get().translationMode === mode) return
    set({ translationMode: mode })
  }

  /**
   * `t` 的三态循环（D14）。无译文时**什么都不做**：06 票才把「无译文 ⇒ 触发翻译」接上，
   * 本票先保持「按 t 无事发生」，避免在 06 之前多出一个未经确认的外发入口。
   */
  const cycleTranslationMode = (): void => {
    const state = get()
    const article = state.article
    if (article === undefined || article.itemId === undefined || article.contentVersion === undefined) return
    if (translationEntryOf(state, article.itemId, article.contentVersion) === undefined) return
    setTranslationMode(nextTranslationMode(state.translationMode))
  }

  /**
   * 串行跑完一篇。
   *
   * 批次选择每一轮都重新走 `pickBatch`：第一批带视口矩形；后续只给文档顺序（rect 全 undefined），
   * 于是「其余批按文档顺序」不依赖用户此刻滚到了哪里。已翻集合 `translated` 保证前进，不会重发。
   */
  const run = async (
    session: TranslateSession,
    blocks: readonly Record<string, unknown>[],
    plan: TranslateArticlePlan,
    geometry: TranslateGeometry | undefined,
  ): Promise<void> => {
    const chars = blocks.map((block) => translateCharsOf(block))
    /** 后续批的候选：只有可翻且不超长的块，矩形缺席 ⇒ 纯文档顺序。 */
    const documentOrder: TranslateBlockRect[] = plan.eligibleBlocks.map((index) => ({ index, rect: undefined }))
    const allTranslated = new Set<number>()
    const article = get().article
    const title = article !== undefined && typeof article.title === 'string' && article.title.trim() !== ''
      ? article.title
      : undefined
    let entry: TranslationEntry = {
      key: session.key,
      blocks: new Map(),
      done: 0,
      total: plan.totalBlocks,
      status: 'running',
    }
    storeEntry(entry)

    const firstInput: PickBatchInput = {
      rects: geometry?.blocks ?? documentOrder,
      container: geometry?.container,
      translated: allTranslated,
      chars,
    }
    let batch = pickBatch(firstInput)
    let firstBatch = true
    while (batch.length > 0) {
      if (session.token !== generation) return
      if (sessionAborted(session)) { markStopped(session); return }
      const items = requestItemsOf(blocks, batch)
      // pickBatch 已经滤掉空块；走到这里还为空说明输入自相矛盾，不能发一个必被拒的空批次。
      if (items.length === 0) break
      let result: TranslateBatchResult
      try {
        result = await rpc<TranslateBatchResult>('translateBatch', {
          target: session.target,
          ...(firstBatch && title !== undefined ? { title } : {}),
          items,
        })
      } catch (failure) {
        if (session.token !== generation) return
        const message = failure instanceof Error ? failure.message : String(failure)
        log('warn', '[rss-reader] 翻译请求失败', failure)
        storeEntry({ ...entry, status: 'failed', error: message })
        if (active?.token === session.token) active = undefined
        return
      }
      // 在途期间可能已经开了新一场 / 被停止：旧场次不许再写 store，免得覆盖新场次的进度。
      if (session.token !== generation) return

      const translatedBlocks = translatedBlocksOf(result, new Set(items.map((item) => item.id)))
      if (translatedBlocks === undefined) {
        storeEntry({ ...entry, status: 'failed', error: '译文与请求块对不上' })
        if (active?.token === session.token) active = undefined
        return
      }

      const nextBlocks = new Map(entry.blocks)
      for (const [index, text] of translatedBlocks) nextBlocks.set(index, text)
      let nextTitle = entry.title
      let nextTitleFailed = entry.titleFailed
      // 标题只随第一批发送；后续批回包没有 title 是正常现象，不能据此把标题标成失败。
      if (firstBatch && title !== undefined) {
        const resultTitle = typeof result.title === 'string' && result.title.trim() !== '' ? result.title : undefined
        if (resultTitle === undefined) nextTitleFailed = true
        else nextTitle = resultTitle
      }
      entry = {
        ...entry,
        ...(nextTitle === undefined ? {} : { title: nextTitle }),
        ...(nextTitleFailed === undefined ? {} : { titleFailed: nextTitleFailed }),
        blocks: nextBlocks,
        done: entry.done + items.length,
        status: 'running',
      }
      storeEntry(entry)
      for (const index of batch) allTranslated.add(index)
      firstBatch = false

      if (sessionAborted(session)) { markStopped(session); return }
      batch = pickBatch({
        rects: documentOrder,
        container: undefined,
        translated: allTranslated,
        chars,
      })
    }

    // 全部批次跑完：只有确实轮到了这一篇、且没被中止，才进入完成态。
    if (session.token !== generation) return
    const latest = get().translations.get(session.key)
    if (latest !== undefined && latest.status === 'running') {
      storeEntry({ ...latest, status: 'done', done: plan.totalBlocks })
    }
    if (active?.token === session.token) active = undefined
  }

  /**
   * 点「译」：整篇可翻字符 > 30000 直接拒绝并提示，不发任何请求。
   * 否则开始一场新翻译（先中止旧的），先发视口批，再串行发完剩余批。
   */
  const startTranslate = async (geometry?: TranslateGeometry): Promise<void> => {
    const state = get()
    const article = state.article
    if (article === undefined || article.loading === true) return
    if (article.itemId === undefined || article.contentVersion === undefined || article.blocks === undefined) return
    const target = DEFAULT_TARGET_LANGUAGE
    const key = translationKeyOf(article.itemId, article.contentVersion, target)

    const plan = articleTranslatePlanOf(article.blocks)
    // D3：整篇上限用「大于」，恰好 30000 必须放行；拒绝时连一条请求都不发。
    if (plan.tooLong) {
      set({ notice: TRANSLATE_LIMIT_TEXT.articleTooLong(plan.chars, TRANSLATE_ARTICLE_MAX_CHARS) })
      return
    }
    // 没有可翻块、也没有超长块可标：按钮本该禁用（02 票），这里再从动作层挡一次空跑。
    if (plan.totalBlocks === 0 && plan.overlongBlocks.length === 0) return

    // 全局单任务：同一篇正在跑时忽略重复点击（没有停止按钮时重复点只会白花两份钱）；
    // 换了一篇则先中止旧场次（D7 / D18）。
    const prior = active
    if (prior !== undefined && prior.key === key && get().translations.get(key)?.status === 'running') return
    if (prior !== undefined) stopTranslate()

    // 有译文时默认落「译文」（spec §4.5 / D5）。只在**开始一场翻译**时切一次：
    // 若每批回包都切，用户看到一半切去「对照」会被下一批硬拽回「译文」。
    setTranslationMode('translated')

    generation += 1
    const session: TranslateSession = {
      token: generation,
      key,
      itemId: article.itemId,
      contentVersion: article.contentVersion,
      target,
    }
    active = session
    await run(session, article.blocks, plan, geometry)
  }

  return { startTranslate, stopTranslate, setTranslationMode, cycleTranslationMode }
}
