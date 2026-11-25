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
  isTranslateFailureReason,
  type TargetLanguage,
  type TranslateFailureReason,
  TRANSLATE_LIMIT_TEXT,
} from '../translate-copy.js'
import {
  articleTranslatePlanOf,
  pickBatch,
  TRANSLATE_ARTICLE_MAX_CHARS,
  translateCharsOf,
  translatableTextOf,
  type TranslateArticlePlan,
  type TranslateBlockRect,
  type TranslateGeometry,
  type TranslateRequestItem,
} from '../translate-blocks.js'
import {
  nextTranslationMode,
  RpcError,
  type ReaderState,
  type ReaderStoreDeps,
  type TranslationEntry,
  type TranslationMode,
} from './store.js'

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

/**
 * 从 rpc 失败里取四类原因之一（R7 05）。
 *
 * 只认 `RpcError` + `code === 'translate-failed'` + details.reason 属于四类枚举：
 * 别用 message 文本反推 —— 文案是界面资产，改一个标点就会让重试分类静默失效。
 * 其它 code（bad-request / 通道错误）不是「这一批模型失败」，返回 undefined 交给调用方
 * 按整篇失败处理：那些错误继续跑下一批只会重复撞同一面墙。
 */
function batchFailureReasonOf(failure: unknown): TranslateFailureReason | undefined {
  if (!(failure instanceof RpcError) || failure.code !== 'translate-failed') return undefined
  // 手写 RpcError 可能漏传 details；先确认是对象再读 reason，别让读失败本身变成一次崩溃。
  if (typeof failure.details !== 'object' || failure.details === null) return undefined
  const details = failure.details as { readonly reason?: unknown }
  return isTranslateFailureReason(details.reason) ? details.reason : undefined
}

/** 回包 model 只在非空字符串时采信；空 / 缺字段等于「这次不知道是谁译的」，保留上一个值。 */
function modelOfResult(result: TranslateBatchResult): string | undefined {
  return typeof result.model === 'string' && result.model.trim() !== '' ? result.model : undefined
}

/** 正文标题（只发一次；空白标题不发）。 */
function articleTitleOf(article: ReaderState['article']): string | undefined {
  return article !== undefined && typeof article.title === 'string' && article.title.trim() !== ''
    ? article.title
    : undefined
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
  const { get, set, rpc, log, persistView, saveNoticeAck } = host

  /** 场次代号：每次开始 / 停止都自增。旧场次拿着旧 token 回来时只许静默退出。 */
  let generation = 0
  /** 当前唯一在场的那一场翻译；undefined = 没有正在跑的编排。 */
  let active: TranslateSession | undefined
  /** 手动重试是否在飞：按钮可能被连点，同一时刻只许一条重试请求。 */
  let retrying = false

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
   * `t` 键（D14 / 验收 14）：无译文 ⇒ 等同点「译」（首次仍弹确认框）；有译文 ⇒ 三态循环。
   *
   * 视图守卫在这里再挡一次（不只是 routeKey 的守卫）：正文未加载 / 失败时没有可翻块，
   * 也不该因为一次按键产生外发。判据与工具栏按钮同源：都走 `requestTranslate` / `continueTranslate`，
   * 键盘与鼠标不允许各造一条外发入口。
   */
  const cycleTranslationMode = (): void => {
    const state = get()
    if (state.view !== 'article') return
    const article = state.article
    if (article === undefined || article.loading === true || article.failure !== undefined) return
    if (article.itemId === undefined || article.contentVersion === undefined || article.blocks === undefined) return
    const entry = translationEntryOf(state, article.itemId, article.contentVersion, state.translateTarget)
    // 「有译文」按实际产出的块判：空条目（一开就被停止 / 全批失败）不算有译文，
    // 否则按 t 会去切一个没有内容的译文态。
    if (entry !== undefined && entry.blocks.size > 0) {
      setTranslationMode(nextTranslationMode(state.translationMode))
      return
    }
    if (state.translationInfo?.available !== true) return
    if (entry !== undefined && entry.status === 'stopped' && entry.total - entry.done > 0) {
      void continueTranslate()
      return
    }
    void requestTranslate()
  }

  /**
   * 串行跑完一篇。
   *
   * 批次选择每一轮都重新走 `pickBatch`：第一批带视口矩形；后续只给文档顺序（rect 全 undefined），
   * 于是「其余批按文档顺序」不依赖用户此刻滚到了哪里。`settled` 集合保证前进，不会重发。
   *
   * 两种入场方式共用这一条编排（06 / spec §4.1 / D19）：
   *  - `fresh`：清空该 key 的 blocks / done / failures / 标题，整篇重发（首次「译」与「重译」）；
   *  - `continue`：以现有 entry.blocks 为已译集，并跳过失败批（那些块有各自的重试按钮），
   *    只补从没尝试过的剩余批；done/total/failures 原样保留。
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
    const article = get().article
    const title = articleTitleOf(article)
    const prior = get().translations.get(session.key)
    // `continue` 才有「继承」；`fresh` 必须从空集开始，否则「重译」会继续跳过旧块、变成假重译。
    const resumeEntry = mode === 'continue' ? prior : undefined
    // pickBatch 的 `translated` 语义是「别再自动选到」：已成功块 + 失败批块都在里面。
    const settled = new Set<number>(resumeEntry?.blocks.keys() ?? [])
    if (resumeEntry !== undefined) {
      for (const failure of resumeEntry.failures.values()) {
        for (const index of failure.indices) settled.add(index)
      }
    }
    let entry: TranslationEntry = resumeEntry === undefined
      ? {
        key: session.key,
        blocks: new Map(),
        failures: new Map(),
        done: 0,
        total: plan.totalBlocks,
        status: 'running',
      }
      : {
        key: session.key,
        ...(resumeEntry.title === undefined ? {} : { title: resumeEntry.title }),
        ...(resumeEntry.titleFailed === undefined ? {} : { titleFailed: resumeEntry.titleFailed }),
        blocks: new Map(resumeEntry.blocks),
        failures: new Map(resumeEntry.failures),
        done: resumeEntry.done,
        total: plan.totalBlocks,
        status: 'running',
        ...(resumeEntry.model === undefined ? {} : { model: resumeEntry.model }),
      }
    storeEntry(entry)

    let consecutiveFailures = 0
    /** 标题只随第一批发送；已经译过 / 已判失败就不再重复发（重试路径单独判断）。 */
    const sendTitle = title !== undefined && entry.title === undefined && entry.titleFailed !== true

    /**
     * 记一次批级失败并推进游标。返回 true = 连续失败已达上限、整篇必须停止。
     *
     * 失败块放进 `settled` 是关键：它们没进 `blocks`，若不让 pickBatch 跳过，下一轮会
     * 立刻重新选中同一批，用户会看到「同一批无限重试」，而「其余批继续」永远轮不到。
     */
    const failBatch = (batch: readonly number[], reason: TranslateFailureReason): boolean => {
      consecutiveFailures += 1
      const failures = new Map(entry.failures)
      failures.set(batch[0] ?? 0, { indices: [...batch], reason })
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
    let firstBatch = true
    while (batch.length > 0) {
      if (session.token !== generation) return
      if (sessionAborted(session)) { markStopped(session); return }
      const items = requestItemsOf(blocks, batch)
      // pickBatch 已经滤掉空块；走到这里还为空说明输入自相矛盾，不能发一个必被拒的空批次。
      if (items.length === 0) break
      const withTitle = firstBatch && sendTitle
      let result: TranslateBatchResult
      try {
        result = await rpc<TranslateBatchResult>('translateBatch', {
          target: session.target,
          ...(withTitle ? { title } : {}),
          items,
        })
      } catch (failure) {
        if (session.token !== generation) return
        const reason = batchFailureReasonOf(failure)
        log('warn', '[rss-reader] 翻译请求失败', failure)
        if (reason === undefined) {
          // 不是四类模型失败（bad-request / 通道错误 / 未知 code）：继续下一批只会重复撞同一面墙，
          // 保持「整篇 failed」的旧行为，并原样显示错误文本（不伪造成四类原因之一）。
          const message = failure instanceof Error ? failure.message : String(failure)
          storeEntry({ ...entry, status: 'failed', error: message })
          if (active?.token === session.token) active = undefined
          return
        }
        if (failBatch(batch, reason)) return
        firstBatch = false
        batch = nextBatch()
        continue
      }
      // 在途期间可能已经开了新一场 / 被停止：旧场次不许再写 store，免得覆盖新场次的进度。
      if (session.token !== generation) return

      const translatedBlocks = translatedBlocksOf(result, new Set(items.map((item) => item.id)))
      if (translatedBlocks === undefined) {
        // 回包结构不可用（id 不属于本批 / 重复 / 字段类型错）：按「没有返回可用译文」记批失败。
        if (failBatch(batch, 'empty')) return
        firstBatch = false
        batch = nextBatch()
        continue
      }

      // 一批成功就清零连续失败计数：spec 说的是「连续 3 批」，中间成功过就不算连续。
      consecutiveFailures = 0
      const nextBlocks = new Map(entry.blocks)
      for (const [index, text] of translatedBlocks) nextBlocks.set(index, text)
      let nextTitle = entry.title
      let nextTitleFailed = entry.titleFailed
      // 标题只随第一批发送；后续批回包没有 title 是正常现象，不能据此把标题标成失败。
      if (withTitle) {
        const resultTitle = typeof result.title === 'string' && result.title.trim() !== '' ? result.title : undefined
        if (resultTitle === undefined) nextTitleFailed = true
        else nextTitle = resultTitle
      }
      const nextFailures = new Map(entry.failures)
      nextFailures.delete(batch[0] ?? 0)
      const resultModel = modelOfResult(result)
      entry = {
        ...entry,
        ...(nextTitle === undefined ? {} : { title: nextTitle }),
        ...(nextTitleFailed === undefined ? {} : { titleFailed: nextTitleFailed }),
        blocks: nextBlocks,
        failures: nextFailures,
        done: entry.done + items.length,
        status: 'running',
        // 多批回包的 model 可能不同：取最后一条非空回包（见 TranslationEntry.model 的注释）。
        ...(resultModel === undefined ? {} : { model: resultModel }),
      }
      storeEntry(entry)
      for (const index of batch) settled.add(index)
      firstBatch = false

      if (sessionAborted(session)) { markStopped(session); return }
      batch = nextBatch()
    }

    // 全部批次跑完：只有确实轮到了这一篇、且没被中止，才进入完成态。
    if (session.token !== generation) return
    const latest = get().translations.get(session.key)
    if (latest !== undefined && latest.status === 'running') {
      // 有失败批时不把 done 强行改成 total：进度必须如实显示「还有哪些块没译成」，
      // 失败位置由 failures 长期指出，读者不会把「停在半路」误认为「全篇已译」。
      storeEntry({
        ...latest,
        status: 'done',
        ...(latest.failures.size > 0 ? {} : { done: plan.totalBlocks }),
      })
    }
    if (active?.token === session.token) active = undefined
  }

  /**
   * 手动重试一个失败批（R7 05 / spec 验收 9）：重发该批**原来的全部 indices**。
   *
   * 不碰其它块：已成功译文原样保留，`done` 只加这一批实际发出去的条数。
   * 与自动编排共用 `active` 的单任务约束 —— 正在跑整篇时按钮可点但动作直接返回，
   * 避免两批同时在飞。
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
    if (active !== undefined) return
    const items = requestItemsOf(article.blocks, record.indices)
    if (items.length === 0) return
    const title = articleTitleOf(article)
    const sendTitle = title !== undefined && entry.title === undefined && entry.titleFailed !== true

    retrying = true
    try {
      let result: TranslateBatchResult
      try {
        result = await rpc<TranslateBatchResult>('translateBatch', {
          target,
          ...(sendTitle ? { title } : {}),
          items,
        })
      } catch (failure) {
        const reason = batchFailureReasonOf(failure)
        log('warn', '[rss-reader] 重试翻译批次失败', failure)
        if (reason === undefined) return
        const latest = get().translations.get(key)
        if (latest === undefined) return
        // 重试仍失败：原因可能变了（例如上次 timeout、这次 truncated），按最新回包更新标签。
        const failures = new Map(latest.failures)
        failures.set(headIndex, { indices: record.indices, reason })
        storeEntry({ ...latest, failures })
        return
      }

      // 在途期间切走条目 / 改语言：回包属于旧条目，不许写进当前这篇的译文档。
      const after = get()
      if (after.article?.itemId !== article.itemId
        || after.article.contentVersion !== article.contentVersion
        || after.translateTarget !== target) return
      const latest = after.translations.get(key)
      if (latest === undefined) return

      const translatedBlocks = translatedBlocksOf(result, new Set(items.map((item) => item.id)))
      if (translatedBlocks === undefined) {
        const failures = new Map(latest.failures)
        failures.set(headIndex, { indices: record.indices, reason: 'empty' })
        storeEntry({ ...latest, failures })
        return
      }

      const nextBlocks = new Map(latest.blocks)
      for (const [index, text] of translatedBlocks) nextBlocks.set(index, text)
      const nextFailures = new Map(latest.failures)
      nextFailures.delete(headIndex)
      const done = latest.done + items.length
      const resultModel = modelOfResult(result)
      const resultTitle = typeof result.title === 'string' && result.title.trim() !== '' ? result.title : undefined
      storeEntry({
        ...latest,
        ...(sendTitle
          ? (resultTitle === undefined ? { titleFailed: true } : { title: resultTitle })
          : {}),
        blocks: nextBlocks,
        failures: nextFailures,
        done,
        ...(resultModel === undefined ? {} : { model: resultModel }),
        ...(nextFailures.size === 0 && done >= latest.total ? { status: 'done' as const } : {}),
      })
    } finally {
      retrying = false
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
  ): Promise<void> => {
    const state = get()
    const article = state.article
    if (article === undefined || article.loading === true || article.failure !== undefined) return
    if (article.itemId === undefined || article.contentVersion === undefined || article.blocks === undefined) return
    const target = state.translateTarget
    const key = translationKeyOf(article.itemId, article.contentVersion, target)

    const plan = articleTranslatePlanOf(article.blocks)
    // D3：整篇上限用「大于」，恰好 30000 必须放行；拒绝时连一条请求都不发。
    if (plan.tooLong) {
      set({ notice: TRANSLATE_LIMIT_TEXT.articleTooLong(plan.chars, TRANSLATE_ARTICLE_MAX_CHARS) })
      return
    }
    // 没有可翻块、也没有超长块可标：按钮本该禁用，这里再从动作层挡一次空跑。
    if (plan.totalBlocks === 0 && plan.overlongBlocks.length === 0) return

    // 全局单任务：同一篇正在跑时忽略重复点击（重复点只会白花两份钱）；换了一篇则先中止旧场次。
    const prior = active
    if (prior !== undefined && prior.key === key && get().translations.get(key)?.status === 'running') return
    if (prior !== undefined) stopTranslate()

    // 有译文时默认落「译文」（spec §4.5 / D5）。只在**全新一场**时切一次：继续翻译时用户
    // 可能正停在原文 / 对照态核对进度，不该被一次「继续」硬拽回译文。
    if (mode === 'fresh') setTranslationMode('translated')

    generation += 1
    const session: TranslateSession = {
      token: generation,
      key,
      itemId: article.itemId,
      contentVersion: article.contentVersion,
      target,
    }
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
    await beginSession('fresh', geometry)
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
   * 「继续翻译（还剩 N/M）」：以现有进度续跑，已译块与失败批都不重发（spec §4.1 / D19）。
   * 只对 `stopped` 生效；`done` / `failed` 的下一步是「重译」或逐批重试，不在本动作里混着做。
   */
  const continueTranslate = async (geometry?: TranslateGeometry): Promise<void> => {
    const state = get()
    const article = state.article
    if (article === undefined || article.itemId === undefined || article.contentVersion === undefined) return
    const entry = translationEntryOf(state, article.itemId, article.contentVersion, state.translateTarget)
    if (entry === undefined || entry.status !== 'stopped') return
    if (entry.total - entry.done <= 0) return
    await beginSession('continue', geometry)
  }

  /** 「重译」：清空该 key 的 blocks / done / failures / 标题后整篇重发（spec §4.1 / D19）。 */
  const retranslate = async (geometry?: TranslateGeometry): Promise<void> => {
    await beginSession('fresh', geometry)
  }

  /** 旧入口：与「首次点译且已确认」等价（仅供既有调用点；新代码走 requestTranslate）。 */
  const startTranslate = async (geometry?: TranslateGeometry): Promise<void> => {
    await beginSession('fresh', geometry)
  }

  return {
    startTranslate, requestTranslate, confirmTranslate, cancelTranslate,
    continueTranslate, retranslate, stopTranslate, retryBatch, loadTranslateInfo, setTranslateTarget,
    setTranslationMode, cycleTranslationMode,
  }
}
