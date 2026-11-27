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
import type { TranslateBatchResult, TranslateInfo } from '../shared.js'
import {
  DEFAULT_TARGET_LANGUAGE,
  isTargetLanguage,
  type TargetLanguage,
  type TranslateFailureReason,
  TRANSLATE_LIMIT_TEXT,
} from '../translate-copy.js'
import {
  articleTranslatePlanOf,
  pickBatch,
  TRANSLATE_ARTICLE_MAX_CHARS,
  translateCharsOf,
  type TranslateArticlePlan,
  type TranslateBlockRect,
  type TranslateGeometry,
  type TranslateRequestItem,
} from '../translate-blocks.js'
import { appliedEntryOf, batchFailureReasonOf, requestItemsOf } from './translate-entry.js'
import { hasTranslations, nextTranslationMode, type TranslationEntry, type TranslationMode } from './translate-state.js'
import type { ReaderState, ReaderStoreDeps } from './store.js'

/** 连续多少批失败就整篇停止（spec §4.7 / D15）：三批。 */
const TRANSLATE_MAX_CONSECUTIVE_FAILURES = 3

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
  /** 目标语言属于视图记忆（ViewPreferences.translateTarget），改动要走整份落盘。 */
  persistView: () => void
  /**
   * 写首次外发确认标记（R7 06 / spec §4.2）：走设置域的 saveSettings 串行链与 patch 白名单，
   * 返回 false = 写盘失败。失败**不阻断**本次翻译（用户已经当面确认），但下次仍要再问。
   */
  saveNoticeAck: () => Promise<boolean>
}

/** 一场翻译的身份：token 用来判代，其余字段用来判「当前打开的还是不是这一篇」。 */
interface TranslateSession {
  readonly token: number
  readonly key: string
  readonly itemId: string
  readonly contentVersion: string
  readonly target: TargetLanguage
}

export function createTranslateActions(host: TranslateActionHost) {
  const { get, set, rpc, log, persistView, saveNoticeAck } = host

  /** 场次代号：每次开始 / 停止都自增。 */
  let generation = 0
  /** 当前唯一在场的那一场翻译；undefined = 没有正在跑的编排。 */
  let active: TranslateSession | undefined
  /**
   * 每个 key 的场次所有权（评审修复 A3）。
   *
   * 只靠全局 `generation` 分不清两件完全不同的事：**被中止**（同一 key 没有更新的场次，
   * 在途批应该把结果写回来，否则「继续」会把已经付过钱的批重发）与**被新场次取代**
   * （同一 key 已经开了新的一场，旧回包必须丢弃，否则会往新进度里塞旧译文 / 重复累计进度）。
   * 新场次开始时接管自己 key 的所有权；旧场次只在仍持有所有权时才允许写 store。
   */
  const ownerByKey = new Map<string, number>()
  /** 手动重试是否在飞：按钮可能被连点，同一时刻只许一条重试请求。 */
  let retrying = false
  /**
   * 全局单任务队列（spec §4.3 / 评审修复 A5）。
   *
   * HTTP 层取消不了在途请求，所以「开始新一场先中止旧的」只能做到不再发下一批；如果新场次
   * 立刻发自己的第一批，旧请求仍可能挂着 ⇒ 两批同时在飞。所有 translateBatch 都排进这一条
   * 队列：前一条落地（成功 / 失败）后才发下一条，新场次自然等旧在途批跑完。
   */
  let requestQueue: Promise<void> = Promise.resolve()

  /** 整份替换 Map（不改原对象，React 才会看到变化）。 */
  const storeEntry = (entry: TranslationEntry): void => {
    const next = new Map(get().translations)
    next.set(entry.key, entry)
    set({ translations: next })
  }

  /**
   * 标记「这一批正在飞」：正文面据此在每组原文下方画 loading 占位（R7 优化）。
   *
   * 为什么不放进 `TranslationEntry`：条目在每批回包时会被整份替换（appliedEntryOf），
   * pending 若跟着走就得在每个出口各清一次；独立字段只有「发请求 / 请求落地」两个写入点。
   */
  const markPending = (key: string, indices: readonly number[]): void => {
    set({ translatePending: { key, indices: [...indices] } })
  }

  /** 只清自己那一篇的占位：另一篇若已接手，别把它的 spinner 抹掉。 */
  const clearPending = (key: string): void => {
    if (get().translatePending?.key === key) set({ translatePending: undefined })
  }

  /**
   * 走全局单任务队列发一条翻译请求。
   *
   * 排队期间可能已经被停止 / 被新场次取代：真正出队时再查一次 token，旧场次不许再发。
   * 返回值把「没发」与「发了但失败」分开，调用方才能区分「中止」与「批失败」。
   */
  const requestQueued = (
    session: TranslateSession,
    payload: { readonly target: TargetLanguage; readonly items: readonly TranslateRequestItem[] },
  ): Promise<
    | { readonly kind: 'ok'; readonly result: TranslateBatchResult }
    | { readonly kind: 'failed'; readonly failure: unknown }
    | { readonly kind: 'aborted' }
  > => {
    const result = requestQueue.then(async () => {
      if (session.token !== generation) return { kind: 'aborted' as const }
      try {
        const value = await rpc<TranslateBatchResult>('translateBatch', payload)
        return { kind: 'ok' as const, result: value }
      } catch (failure) {
        return { kind: 'failed' as const, failure }
      }
    })
    // 队列自身只负责「前一条已落地」，不传播失败：每条请求的结果由它自己的调用方处理。
    requestQueue = result.then(() => undefined, () => undefined)
    return result
  }

  /** 等一下当前在途请求落地（新场次发第一批前调用；返回时队列已空）。 */
  const waitForIdle = async (): Promise<void> => {
    await requestQueue
  }

  /** 这个场次是否仍持有自己 key 的所有权（没有更新的同 key 场次接手）。 */
  const ownsSession = (session: TranslateSession): boolean => ownerByKey.get(session.key) === session.token

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

  /**
   * 把当前场次标成 stopped（在途批已跑完，blocks 保留已经写入的进度）。
   *
   * 所有权判据必须按 key：旧场次被同 key 的新场次取代后不许写 stopped（那会把新场次的
   * running 覆盖掉）；但换了条目 / 切了视图时它仍持有旧 key 的所有权，必须把旧条目如实标停。
   */
  const markStopped = (session: TranslateSession): void => {
    if (!ownsSession(session)) return
    const entry = get().translations.get(session.key)
    if (entry !== undefined && entry.status === 'running') storeEntry({ ...entry, status: 'stopped' })
    if (active?.token === session.token) active = undefined
  }

  /**
   * 读一次可用性探测（R7 02，spec §4.1）：面板加载时探一次，设置保存成功后由 store 再刷一次。
   *
   * 失败时不编造原因：保持上一份结果（通常是 undefined）→ 文章面不渲染「译」按钮，
   * 设置页显示「正在探测」而不是一个假 reason。原因由宿主裁决，客户端只搬运。
   */
  const loadTranslateInfo = async (): Promise<void> => {
    try {
      const info = await rpc<TranslateInfo>('translateInfo', {})
      if (info === null || typeof info !== 'object' || typeof info.available !== 'boolean') {
        throw new Error('translateInfo 回包缺少 available')
      }
      set({ translationInfo: info })
    } catch (failure) {
      log('warn', '[rss-reader] 读取翻译可用性失败', failure)
    }
  }

  /**
   * 改目标语言（R7 02，spec §5.3）：`Aa` 面板与设置页共用这一个值。
   *
   * 落盘走既有的整份视图记忆通道（persistView），不新开端点：旧译文按
   * `${itemId}:${contentVersion}:${target}` 分键，换语言既不冒充也不清空（spec 验收 13）。
   */
  const setTranslateTarget = (target: TargetLanguage): void => {
    if (!isTargetLanguage(target) || get().translateTarget === target) return
    // 换语言 = 换一篇要译的东西：在飞的那一场属于旧语言，必须停掉后续批（在途那批允许跑完，
    // 结果写回旧语言的键，切回去还能看见）。不停的话旧语言会继续烧后面所有批。
    if (active !== undefined && active.target !== target) stopTranslate()
    set({ translateTarget: target })
    persistView()
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
    // 确认框还开着时也一起收掉：离开正文 / 切面板 / 点「停止」都不该把「待外发」留到下一次。
    // 取消语义由这里统一兜底 —— 只清状态，不写 settings、不发请求。
    if (get().translateConfirm !== undefined) set({ translateConfirm: undefined })
    // 停止 = 立刻收起 loading 占位；在途那批仍会跑完并写回结果（A3），但界面不再转圈。
    set({ translatePending: undefined })
    if (session === undefined) return
    const entry = get().translations.get(session.key)
    if (entry !== undefined && entry.status === 'running') storeEntry({ ...entry, status: 'stopped' })
  }

  /**
   * 手动选两态（R7 03 / spec §4.5）。
   *
   * **只改渲染状态**：不碰 translations、不发任何 rpc ——「切到译文再切回原文」是纯视图动作
   * （验收 12 / 本票第 7 条），重新翻译只能走「译 / 重译」。
   */
  const setTranslationMode = (mode: TranslationMode): void => {
    if (get().translationMode === mode) return
    set({ translationMode: mode })
  }

  /**
   * `t` 键（D14 / 验收 14）：无译文 ⇒ 等同点「译」（首次仍弹确认框）；有译文 ⇒ 两态循环。
   *
   * 视图守卫在这里再挡一次（不只是 routeKey 的守卫）：正文未加载 / 失败时没有可翻块，
   * 也不该因为一次按键产生外发。判据与工具栏按钮同源：都走 `requestTranslate` / `continueTranslate`，
   * 键盘与鼠标不允许各造一条外发入口。
   */
  const cycleTranslationMode = (geometry?: TranslateGeometry): void => {
    const state = get()
    if (state.view !== 'article') return
    const article = state.article
    if (article === undefined || article.loading === true || article.failure !== undefined) return
    if (article.itemId === undefined || article.contentVersion === undefined || article.blocks === undefined) return
    const entry = translationEntryOf(state, article.itemId, article.contentVersion, state.translateTarget)
    if (state.translationInfo?.available !== true) return
    // 正在译：`t` 什么都不做。否则会走 requestTranslate → beginSession 把在飞的一场中止重来，
    // 用户按一下「切换显示」就白烧掉一批（甚至整篇重发）。
    if (entry !== undefined && entry.status === 'running') return
    // 与工具栏同一套判定（2026-11-26）：有缺块且没在跑 ⇒ 继续补；有译文且完整 ⇒ 切两态；
    // 一条译文都没有 ⇒ 从头开始。键盘与鼠标不允许各造一条状态机。
    if (entry !== undefined && entry.status !== 'running' && entry.total - entry.blocks.size > 0) {
      void continueTranslate(geometry)
      return
    }
    if (hasTranslations(entry)) {
      setTranslationMode(nextTranslationMode(state.translationMode))
      return
    }
    void requestTranslate(geometry)
  }

  /**
   * 串行跑完一篇。
   *
   * 批次选择每一轮都重新走 `pickBatch`：第一批带视口矩形；后续只给文档顺序（rect 全 undefined），
   * 于是「其余批按文档顺序」不依赖用户此刻滚到了哪里。`settled` 集合保证前进，不会重发。
   *
   * 两种入场方式共用这一条编排（06 / spec §4.1 / D19）：
   *  - `fresh`：清空该 key 的 blocks / models / failures，整篇重发（首次「译」与「重译」）；
   *  - `continue`：以现有 entry.blocks 为已译集，把失败批与空回包的缺口重新纳入选择
   *    （旧失败记录清空，避免旧原因挂在界面上；成功块不重发）。
   *
   * 失败（R7 05）按**批**处理：这一批的块记进 `failures` 并退出后续选择（否则下一轮会原地
   * 重选同一批），其余批继续；只有连续 3 批失败才整篇 `status: 'failed'`。
   */
  const run = async (
    session: TranslateSession,
    blocks: readonly Record<string, unknown>[],
    plan: TranslateArticlePlan,
    geometry: TranslateGeometry | undefined,
    mode: 'fresh' | 'continue',
  ): Promise<void> => {
    const chars = blocks.map((block) => translateCharsOf(block))
    /** 后续批的候选：只有可翻且不超长的块，矩形缺席 ⇒ 纯文档顺序。 */
    const documentOrder: TranslateBlockRect[] = plan.eligibleBlocks.map((index) => ({ index, rect: undefined }))
    const prior = get().translations.get(session.key)
    // `continue` 才有「继承」；`fresh` 必须从空集开始，否则「重译」会继续跳过旧块、变成假重译。
    const resumeEntry = mode === 'continue' ? prior : undefined
    // pickBatch 的 `translated` 语义是「别再自动选到」：**只有已成功回填的块**。
    // 失败批与空回包的块不在 blocks 里 ⇒ 继续翻译时会被重新选中重发（旧版把它们也塞进
    // settled，结果「继续」只补从没试过的块，失败批永远留着 —— 用户实测 75/95 卡住）。
    const settled = new Set<number>(resumeEntry?.blocks.keys() ?? [])
    let entry: TranslationEntry = resumeEntry === undefined
      ? {
        key: session.key,
        blocks: new Map(),
        models: new Map(),
        failures: new Map(),
        total: plan.totalBlocks,
        status: 'running',
      }
      : {
        key: session.key,
        blocks: new Map(resumeEntry.blocks),
        models: new Map(resumeEntry.models),
        failures: new Map(),
        total: plan.totalBlocks,
        status: 'running',
        ...(resumeEntry.model === undefined ? {} : { model: resumeEntry.model }),
      }
    storeEntry(entry)

    let consecutiveFailures = 0

    /**
     * 本场是否已经被中止（停止 / 换条目 / 离开正文 / 组件卸载）。
     *
     * 中止与「被新场次取代」是两件事（评审修复 A3）：中止时在途批的结果仍要写回，
     * 否则用户点「继续」会把已经付过钱的批重发；被同 key 的新场次取代时才丢弃回包。
     */
    const stoppedNow = (): boolean => session.token !== generation || sessionAborted(session)

    /**
     * 记一次批级失败并推进游标。返回 true = 连续失败已达上限、整篇必须停止。
     *
     * 失败块放进 `settled` 是关键：它们没进 `blocks`，若不让 pickBatch 跳过，下一轮会
     * 立刻重新选中同一批，用户会看到「同一批无限重试」，而「其余批继续」永远轮不到。
     */
    const failBatch = (batch: readonly number[], reason: TranslateFailureReason): boolean => {
      consecutiveFailures += 1
      const failures = new Map(entry.failures)
      failures.set(batch[0] ?? 0, {
        indices: [...batch],
        reason,
      })
      entry = { ...entry, failures, status: 'running' }
      storeEntry(entry)
      for (const index of batch) settled.add(index)
      if (consecutiveFailures < TRANSLATE_MAX_CONSECUTIVE_FAILURES) return false
      // 连续失败到上限：保留已成功块与失败批位置，但不再发后续批（spec §4.7）。
      entry = { ...entry, status: 'failed', stoppedReason: reason }
      storeEntry(entry)
      if (active?.token === session.token) active = undefined
      return true
    }

    const nextBatch = (): number[] => pickBatch({
      rects: documentOrder,
      container: undefined,
      translated: settled,
      chars,
    })

    let batch = pickBatch({
      rects: geometry?.blocks ?? documentOrder,
      container: geometry?.container,
      translated: settled,
      chars,
    })
    while (batch.length > 0) {
      if (stoppedNow()) { markStopped(session); return }
      const items = requestItemsOf(blocks, batch)
      // pickBatch 已经滤掉空块；走到这里还为空说明输入自相矛盾，不能发一个必被拒的空批次。
      if (items.length === 0) break
      markPending(session.key, batch)
      const outcome = await requestQueued(session, {
        target: session.target,
        items,
      })
      clearPending(session.key)
      if (outcome.kind === 'aborted') { markStopped(session); return }

      if (outcome.kind === 'failed') {
        // 排队 / 在途期间被同 key 的新场次取代：旧场次一个字都不许写。
        if (!ownsSession(session)) return
        // 被停止 / 换条目：这一批没有产出可保留的译文，只把状态如实留在 stopped，不再记失败。
        if (stoppedNow()) { markStopped(session); return }
        const reason = batchFailureReasonOf(outcome.failure)
        log('warn', '[rss-reader] 翻译请求失败', outcome.failure)
        if (reason === undefined) {
          // 不是四类模型失败（bad-request / 通道错误 / 未知 code）：继续下一批只会重复撞同一面墙，
          // 保持「整篇 failed」的旧行为，并原样显示错误文本（不伪造成四类原因之一）。
          const message = outcome.failure instanceof Error ? outcome.failure.message : String(outcome.failure)
          storeEntry({ ...entry, status: 'failed', error: message })
          if (active?.token === session.token) active = undefined
          return
        }
        if (failBatch(batch, reason)) return
        // 失败记录写回后若已被中止：如实标停，别把 running 留在界面上（评审修复 A3）。
        if (stoppedNow()) { markStopped(session); return }
        batch = nextBatch()
        continue
      }

      // 成功回包：被同 key 的新场次取代 ⇒ 丢弃（新场次会按自己的进度重写）。
      if (!ownsSession(session)) return
      const nextEntry = appliedEntryOf(entry, outcome.result, new Set(items.map((item) => item.id)), {
        head: batch[0] ?? 0,
      })
      if (nextEntry === undefined) {
        // 回包结构不可用（id 不属于本批 / 重复 / 字段类型错）：按「没有返回可用译文」记批失败。
        if (failBatch(batch, 'empty')) return
        if (stoppedNow()) { markStopped(session); return }
        batch = nextBatch()
        continue
      }

      // 一批成功就清零连续失败计数：spec 说的是「连续 3 批」，中间成功过就不算连续。
      consecutiveFailures = 0
      entry = nextEntry
      storeEntry(entry)
      for (const index of batch) settled.add(index)

      // 被停止 / 换条目 / 卸载：本批结果已经写回（钱不白花），状态如实 stopped，不再发下一批。
      if (stoppedNow()) { markStopped(session); return }
      batch = nextBatch()
    }

    // 全部批次跑完：只有确实轮到了这一篇、且没被中止，才进入完成态。
    if (!ownsSession(session)) return
    if (session.token !== generation) { markStopped(session); return }
    const latest = get().translations.get(session.key)
    if (latest !== undefined && latest.status === 'running') {
      // blocks.size 每批都如实写（失败批 / 空回包不计入），这里只改状态。
      storeEntry({ ...latest, status: 'done' })
    }
    if (active?.token === session.token) active = undefined
  }

  /**
   * 手动重试一个失败批（R7 05 / spec 验收 9）：重发该批**原来的全部 indices**。
   *
   * 不碰其它块：已成功译文原样保留，`blocks` 只加这一批实际回填成功的条数。
   *
   * 重试也是「一场翻译」（评审修复 A5）：先按「开始新一场先中止旧的」处理并登记自己为当前
   * 场次，再走同一条全局队列。否则重试在飞时点「重译」会两批并发，且重试回包会往新进度里
   * 重复累计进度。排队等待期间用户的切条目 / 改语言 / 离开正文都要重新校验，不拿旧快照发请求。
   */
  const retryBatch = async (headIndex: number): Promise<void> => {
    if (retrying) return
    const state = get()
    const article = state.article
    if (article === undefined || article.loading === true) return
    if (article.itemId === undefined || article.contentVersion === undefined || article.blocks === undefined) return
    const target = state.translateTarget
    const key = translationKeyOf(article.itemId, article.contentVersion, target)
    const entry = state.translations.get(key)
    const record = entry?.failures.get(headIndex)
    if (entry === undefined || record === undefined) return
    // 整篇还在跑时由 run 的编排负责；重试按钮本身也是 disabled（双保险）。
    if (entry.status === 'running') return
    const items = requestItemsOf(article.blocks, record.indices)
    if (items.length === 0) return

    if (active !== undefined) stopTranslate()
    retrying = true
    let session: TranslateSession | undefined
    try {
      // 排队等旧请求的这段时间里，切面板 / 离开正文会调 stopTranslate（代号自增）：这次重试作废。
      const idleGeneration = generation
      // 旧在途批必须落地后才发这一条：全局单任务不允许两批同时在飞（A5 的并发判据）。
      await waitForIdle()
      if (generation !== idleGeneration) return
      const afterWait = get()
      if (afterWait.view !== 'article') return
      if (afterWait.article?.itemId !== article.itemId
        || afterWait.article.contentVersion !== article.contentVersion
        || afterWait.translateTarget !== target) return
      const latestEntry = afterWait.translations.get(key)
      const latestRecord = latestEntry?.failures.get(headIndex)
      if (latestEntry === undefined || latestRecord === undefined) return
      if (latestEntry.status === 'running') return

      generation += 1
      session = {
        token: generation,
        key,
        itemId: article.itemId,
        contentVersion: article.contentVersion,
        target,
      }
      ownerByKey.set(key, session.token)
      active = session

      markPending(key, record.indices)
      const outcome = await requestQueued(session, { target, items })
      clearPending(key)
      // 被停止 / 被新场次取代：回包丢弃（A3 的「被取代」分支）。
      if (outcome.kind === 'aborted' || !ownsSession(session)) return
      if (outcome.kind === 'failed') {
        const reason = batchFailureReasonOf(outcome.failure)
        log('warn', '[rss-reader] 重试翻译批次失败', outcome.failure)
        if (reason === undefined) return
        const latest = get().translations.get(key)
        if (latest === undefined) return
        // 重试仍失败：原因可能变了（例如上次 timeout、这次 truncated），按最新回包更新标签。
        // 失败记录只保留 indices / reason；标题已不在客户端发送范围（2026-11-26）。
        const failures = new Map(latest.failures)
        failures.set(headIndex, { indices: record.indices, reason })
        storeEntry({ ...latest, failures })
        return
      }

      const latest = get().translations.get(key)
      if (latest === undefined) return
      const nextEntry = appliedEntryOf(latest, outcome.result, new Set(items.map((item) => item.id)), {
        head: headIndex,
      })
      if (nextEntry === undefined) {
        const failures = new Map(latest.failures)
        failures.set(headIndex, { indices: record.indices, reason: 'empty' })
        storeEntry({ ...latest, failures })
        return
      }
      // 所有失败批都补齐且 total 到齐才升 done；否则保持原状态（不把 stopped / failed 谎报成完成）。
      const finished = nextEntry.failures.size === 0 && nextEntry.blocks.size >= nextEntry.total
      storeEntry({ ...nextEntry, ...(finished ? { status: 'done' as const } : { status: latest.status }) })
    } finally {
      retrying = false
      if (session !== undefined && active?.token === session.token) active = undefined
    }
  }

  /**
   * 一场翻译的公共入口（06 / spec §4.1 / §4.6 / D18）：校验上限与空文章、维持全局单任务，
   * 然后交给 `run`。`fresh` = 清空重译；`continue` = 接着现有进度补剩余批。
   *
   * 「开始任何一场新翻译前先中止旧的」只在这一处做：先 `stopTranslate()` 让旧场 token 失效，
   * 再发新 token。任何新入口（按钮 / t / 继续 / 重译）都绕不过这条 —— 复制第二份判断就会出现
   * 「两个动作各中止一次、或各漏一次」的漂移。
   */
  const beginSession = async (
    mode: 'fresh' | 'continue',
    geometry?: TranslateGeometry,
    knownPlan?: TranslateArticlePlan,
  ): Promise<void> => {
    const state = get()
    const article = state.article
    if (article === undefined || article.loading === true || article.failure !== undefined) return
    if (article.itemId === undefined || article.contentVersion === undefined || article.blocks === undefined) return
    const target = state.translateTarget
    const key = translationKeyOf(article.itemId, article.contentVersion, target)

    // 计划只算一次：`requestTranslate` 为了确认框已经算过时直接复用（评审修复 B6）。
    const plan = knownPlan ?? articleTranslatePlanOf(article.blocks)
    // D3：整篇上限用「大于」，恰好 30000 必须放行；拒绝时连一条请求都不发。
    if (plan.tooLong) {
      set({ notice: TRANSLATE_LIMIT_TEXT.articleTooLong(plan.chars, TRANSLATE_ARTICLE_MAX_CHARS) })
      return
    }
    // 没有可翻块、也没有超长块可标：按钮本该禁用，这里再从动作层挡一次空跑。
    if (plan.totalBlocks === 0 && plan.overlongBlocks.length === 0) return

    // 全局单任务：同一篇正在跑时忽略重复点击（重复点只会白花两份钱）；换了一篇 / 在重试则先中止旧场次。
    const prior = active
    if (prior !== undefined && prior.key === key && get().translations.get(key)?.status === 'running') return
    if (prior !== undefined) stopTranslate()
    // 等待期间若组件卸载 / 离开正文（stopTranslate 会再自增一次代号），这次入场必须作废：
    // 「切走不再发新批」不能只在 run 的循环里判，排队等旧请求的那段时间也要算数。
    const idleGeneration = generation
    // 旧的在途批必须先落地：HTTP 层取消不了它，若新场次立刻发第一批就是两批并发（A5）。
    // 同一 key 的「继续」也要等它：落地后 blocks 已写回，续跑才不会把这一批重发（A3）。
    await waitForIdle()
    if (generation !== idleGeneration) return
    const afterWait = get()
    if (afterWait.view !== 'article') return
    if (afterWait.article?.itemId !== article.itemId
      || afterWait.article.contentVersion !== article.contentVersion
      || afterWait.translateTarget !== target) return
    // 等待期间原地重试 / 其它入口可能已经把剩余批补完：continue 不再启动一个 0 剩余的空场次。
    if (mode === 'continue') {
      const resumed = afterWait.translations.get(key)
      // 2026-11-26：缺块可能来自停止、批失败或空回包，状态可能是 stopped / done / failed ——
      // 判据只看「有没有缺块」，不再认某一种 status。
      if (resumed === undefined || resumed.status === 'running' || resumed.total - resumed.blocks.size <= 0) return
    }

    // 有译文时默认落「对照」（2026-11-26 用户拍板：翻译＝原文段落下方直接给译文，可对照读）。
    // 只在**全新一场**时切一次：继续翻译时用户可能正停在原文 / 对照态核对进度，
    // 不该被一次「继续」硬拽回对照。
    if (mode === 'fresh') setTranslationMode('parallel')

    generation += 1
    const session: TranslateSession = {
      token: generation,
      key,
      itemId: article.itemId,
      contentVersion: article.contentVersion,
      target,
    }
    // 新场次接管这个 key：旧场次即使还有在途回包也不许再写（A3 的「被取代」分支）。
    ownerByKey.set(key, session.token)
    active = session
    await run(session, article.blocks, plan, geometry, mode)
  }

  /**
   * 点「译」（或按 `t`）的第一个入口（R7 06 / spec §4.2）：
   * 首次外发前先弹确认框；已确认过则直接开始。确认框只写 store 状态，取消不留任何副作用。
   */
  const requestTranslate = async (geometry?: TranslateGeometry): Promise<void> => {
    const state = get()
    const article = state.article
    if (article === undefined || article.loading === true || article.failure !== undefined) return
    if (article.itemId === undefined || article.contentVersion === undefined || article.blocks === undefined) return
    if (state.translationInfo?.available !== true) return
    const plan = articleTranslatePlanOf(article.blocks)
    if (plan.tooLong) {
      set({ notice: TRANSLATE_LIMIT_TEXT.articleTooLong(plan.chars, TRANSLATE_ARTICLE_MAX_CHARS) })
      return
    }
    if (plan.totalBlocks === 0 && plan.overlongBlocks.length === 0) return
    const route = state.translationInfo.route
    if (route === undefined) {
      // 可用性说 true 却没有路由是宿主契约被破坏：不编造 provider/model 去填确认框，也不外发。
      log('warn', '[rss-reader] 翻译可用但没有路由，无法确认外发对象')
      return
    }
    // 只有明确 `true` 才跳过确认：settings 还没取到（undefined）时按「没确认过」处理，宁可多问一次。
    if (state.settings?.effective.translateNoticeAck !== true) {
      set({ translateConfirm: { chars: plan.chars, provider: route.provider, model: route.model } })
      return
    }
    // 计划已经在这里算过：交给 beginSession 复用，别再对同一份 blocks 算第二遍（评审修复 B6）。
    await beginSession('fresh', geometry, plan)
  }

  /**
   * 确认外发（R7 06）：先写 `settings.json` 的翻译确认标记，再开始翻译。
   *
   * 写标记失败**不阻断**本次翻译 —— 用户已经当面确认过这次外发，此时反悔只会让人以为按钮坏了；
   * 但要留 warn，且标记没写成功意味着下次仍会再问（如实反映「没记住」）。
   */
  const confirmTranslate = async (geometry?: TranslateGeometry): Promise<void> => {
    const pending = get().translateConfirm
    if (pending === undefined) return
    // 先清框再写盘：确认按钮不可重复触发，且写盘失败也不会把模态留在屏幕上。
    set({ translateConfirm: undefined })
    try {
      if (!(await saveNoticeAck())) {
        log('warn', '[rss-reader] 写入翻译外发确认标记失败，本次照常翻译，下次仍会提示')
      }
    } catch (failure) {
      log('warn', '[rss-reader] 写入翻译外发确认标记失败，本次照常翻译，下次仍会提示', failure)
    }
    await beginSession('fresh', geometry)
  }

  /** 取消外发确认（spec §4.2）：什么都不做，不留状态 —— 不写 settings、不发 rpc。 */
  const cancelTranslate = (): void => {
    if (get().translateConfirm === undefined) return
    set({ translateConfirm: undefined })
  }

  /**
   * 「继续翻译（还剩 N/M）」：以现有进度续跑，已成功块不重发（spec §4.1 / D19）。
   *
   * 缺块可能来自停止、批失败或空回包，状态可能是 stopped / done / failed —— 判据只看
   * 「还剩多少块」，不再绑定某一种 status（2026-11-26 用户拍板：继续要补没译成的块）。
   */
  const continueTranslate = async (geometry?: TranslateGeometry): Promise<void> => {
    const state = get()
    const article = state.article
    if (article === undefined || article.itemId === undefined || article.contentVersion === undefined) return
    const entry = translationEntryOf(state, article.itemId, article.contentVersion, state.translateTarget)
    if (entry === undefined || entry.status === 'running') return
    // 「还缺多少」按实际回填的块算：停止 / 批失败 / 空回包留下的缺口都算。
    if (entry.total - entry.blocks.size <= 0) return
    await beginSession('continue', geometry)
  }

  /** 「重译」：清空该 key 的 blocks / models / failures 后整篇重发（spec §4.1 / D19）。 */
  const retranslate = async (geometry?: TranslateGeometry): Promise<void> => {
    await beginSession('fresh', geometry)
  }

  return {
    requestTranslate, confirmTranslate, cancelTranslate,
    continueTranslate, retranslate, stopTranslate, retryBatch, loadTranslateInfo, setTranslateTarget,
    setTranslationMode, cycleTranslationMode,
  }
}
