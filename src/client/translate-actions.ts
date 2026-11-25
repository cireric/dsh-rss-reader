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
  blockIndexOfTranslateId,
  pickBatch,
  TRANSLATE_ARTICLE_MAX_CHARS,
  translateBlockIdOf,
  translateCharsOf,
  translatableTextOf,
  type TranslateArticlePlan,
  type TranslateBlockRect,
  type TranslateGeometry,
  type TranslateRequestItem,
} from '../translate-blocks.js'
import {
  hasTranslations,
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
    const index = blockIndexOfTranslateId(item.id)
    if (index === undefined) continue
    blocks.set(index, item.text)
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
    items.push({ id: translateBlockIdOf(index), text })
  }
  return items
}

/**
 * 一批成功回包 → 新条目（评审修复 B6）。
 *
 * 自动编排与手动重试此前各写了一份「写 blocks / 清失败记录 / 标题 / model / done」的逐行代码；
 * 两份一旦有一处漏改（例如只在一处处理 titleFailed），同一份回包会在两条路径里产生不同状态。
 * 这里只做落库投影，不决定 status 的终态：调用方成功后该继续（running）还是完成（done）由它自己定。
 *
 * @param titleSent 这一批是否带了标题：只有带标题的批次**成功**且回包无标题时才置 titleFailed
 *                   （spec §4.3 —— 后续批回包里没有 title 是正常现象，不能据此判标题失败）。
 * @param head 失败批的批首下标：成功即清掉这条失败记录。
 */
function appliedEntryOf(
  entry: TranslationEntry,
  result: TranslateBatchResult,
  requestedIds: ReadonlySet<string>,
  options: { readonly titleSent: boolean; readonly head: number },
): TranslationEntry | undefined {
  const translatedBlocks = translatedBlocksOf(result, requestedIds)
  // 回包结构不可用（id 不属于本批 / 重复 / 字段类型错）：由调用方按「没有返回可用译文」记批失败。
  if (translatedBlocks === undefined) return undefined
  const nextBlocks = new Map(entry.blocks)
  for (const [index, text] of translatedBlocks) nextBlocks.set(index, text)
  let nextTitle = entry.title
  let nextTitleFailed = entry.titleFailed
  if (options.titleSent) {
    const resultTitle = typeof result.title === 'string' && result.title.trim() !== '' ? result.title : undefined
    if (resultTitle === undefined) nextTitleFailed = true
    else nextTitle = resultTitle
  }
  const nextFailures = new Map(entry.failures)
  nextFailures.delete(options.head)
  const resultModel = modelOfResult(result)
  return {
    ...entry,
    ...(nextTitle === undefined ? {} : { title: nextTitle }),
    ...(nextTitleFailed === undefined ? {} : { titleFailed: nextTitleFailed }),
    blocks: nextBlocks,
    failures: nextFailures,
    done: entry.done + requestedIds.size,
    status: 'running',
    // 多批回包的 model 可能不同：取最后一条非空回包（见 TranslationEntry.model 的注释）。
    ...(resultModel === undefined ? {} : { model: resultModel }),
  }
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
   * （同一 key 已经开了新的一场，旧回包必须丢弃，否则会往新进度里塞旧译文 / 重复加 done）。
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
   * 走全局单任务队列发一条翻译请求。
   *
   * 排队期间可能已经被停止 / 被新场次取代：真正出队时再查一次 token，旧场次不许再发。
   * 返回值把「没发」与「发了但失败」分开，调用方才能区分「中止」与「批失败」。
   */
  const requestQueued = (
    session: TranslateSession,
    payload: { readonly target: TargetLanguage; readonly title?: string; readonly items: readonly TranslateRequestItem[] },
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
   * 把当前场次标成 stopped（在途批已跑完，done 保留已经写入的进度）。
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
  const cycleTranslationMode = (geometry?: TranslateGeometry): void => {
    const state = get()
    if (state.view !== 'article') return
    const article = state.article
    if (article === undefined || article.loading === true || article.failure !== undefined) return
    if (article.itemId === undefined || article.contentVersion === undefined || article.blocks === undefined) return
    const entry = translationEntryOf(state, article.itemId, article.contentVersion, state.translateTarget)
    // 「有译文」按实际产出的块判（hasTranslations）：空条目（一开就被停止 / 全批失败）不算有译文，
    // 否则按 t 会去切一个没有内容的译文态。
    if (hasTranslations(entry)) {
      setTranslationMode(nextTranslationMode(state.translationMode))
      return
    }
    if (state.translationInfo?.available !== true) return
    if (entry !== undefined && entry.status === 'stopped' && entry.total - entry.done > 0) {
      // 与工具栏「继续」同一条入口：几何一起交回，键盘与鼠标的首批选择不许分家（评审修复 A2）。
      void continueTranslate(geometry)
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
    /** 标题只随第一批发送；已经译过 / 已判失败就不再重复发（重试路径按失败记录的 carriesTitle 判断）。 */
    const sendTitle = title !== undefined && entry.title === undefined && entry.titleFailed !== true

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
     *
     * `titleCarrier` = 这一批带了标题（即本场第一批）。记在失败记录上，重试它时必须再带标题 ——
     * 否则首批失败后标题永远没有第二次机会（评审修复 A6）。
     */
    const failBatch = (batch: readonly number[], reason: TranslateFailureReason, titleCarrier: boolean): boolean => {
      consecutiveFailures += 1
      const failures = new Map(entry.failures)
      failures.set(batch[0] ?? 0, {
        indices: [...batch],
        reason,
        ...(titleCarrier ? { carriesTitle: true } : {}),
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
    let firstBatch = true
    while (batch.length > 0) {
      if (stoppedNow()) { markStopped(session); return }
      const items = requestItemsOf(blocks, batch)
      // pickBatch 已经滤掉空块；走到这里还为空说明输入自相矛盾，不能发一个必被拒的空批次。
      if (items.length === 0) break
      const withTitle = firstBatch && sendTitle
      const outcome = await requestQueued(session, {
        target: session.target,
        ...(withTitle ? { title } : {}),
        items,
      })
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
        if (failBatch(batch, reason, withTitle)) return
        // 失败记录写回后若已被中止：如实标停，别把 running 留在界面上（评审修复 A3）。
        if (stoppedNow()) { markStopped(session); return }
        firstBatch = false
        batch = nextBatch()
        continue
      }

      // 成功回包：被同 key 的新场次取代 ⇒ 丢弃（新场次会按自己的进度重写）。
      if (!ownsSession(session)) return
      const nextEntry = appliedEntryOf(entry, outcome.result, new Set(items.map((item) => item.id)), {
        titleSent: withTitle,
        head: batch[0] ?? 0,
      })
      if (nextEntry === undefined) {
        // 回包结构不可用（id 不属于本批 / 重复 / 字段类型错）：按「没有返回可用译文」记批失败。
        if (failBatch(batch, 'empty', withTitle)) return
        if (stoppedNow()) { markStopped(session); return }
        firstBatch = false
        batch = nextBatch()
        continue
      }

      // 一批成功就清零连续失败计数：spec 说的是「连续 3 批」，中间成功过就不算连续。
      consecutiveFailures = 0
      entry = nextEntry
      storeEntry(entry)
      for (const index of batch) settled.add(index)
      firstBatch = false

      // 被停止 / 换条目 / 卸载：本批结果已经写回（钱不白花），状态如实 stopped，不再发下一批。
      if (stoppedNow()) { markStopped(session); return }
      batch = nextBatch()
    }

    // 全部批次跑完：只有确实轮到了这一篇、且没被中止，才进入完成态。
    if (!ownsSession(session)) return
    if (session.token !== generation) { markStopped(session); return }
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
   *
   * 重试也是「一场翻译」（评审修复 A5）：先按「开始新一场先中止旧的」处理并登记自己为当前
   * 场次，再走同一条全局队列。否则重试在飞时点「重译」会两批并发，且重试回包会往新进度里
   * 重复加 done。排队等待期间用户的切条目 / 改语言 / 离开正文都要重新校验，不拿旧快照发请求。
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
      const title = articleTitleOf(afterWait.article)
      // 只有「首批那次尝试」的失败记录带 carriesTitle：重试它才再次带标题（A6）。
      const sendTitle = latestRecord.carriesTitle === true && title !== undefined
        && latestEntry.title === undefined && latestEntry.titleFailed !== true

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

      const outcome = await requestQueued(session, {
        target,
        ...(sendTitle ? { title } : {}),
        items,
      })
      // 被停止 / 被新场次取代：回包丢弃（A3 的「被取代」分支）。
      if (outcome.kind === 'aborted' || !ownsSession(session)) return
      if (outcome.kind === 'failed') {
        const reason = batchFailureReasonOf(outcome.failure)
        log('warn', '[rss-reader] 重试翻译批次失败', outcome.failure)
        if (reason === undefined) return
        const latest = get().translations.get(key)
        if (latest === undefined) return
        // 重试仍失败：原因可能变了（例如上次 timeout、这次 truncated），按最新回包更新标签；
        // carriesTitle 必须保留，否则第二次重试会把标题弄丢。
        const failures = new Map(latest.failures)
        failures.set(headIndex, {
          indices: record.indices,
          reason,
          ...(record.carriesTitle === true ? { carriesTitle: true } : {}),
        })
        storeEntry({ ...latest, failures })
        return
      }

      const latest = get().translations.get(key)
      if (latest === undefined) return
      const nextEntry = appliedEntryOf(latest, outcome.result, new Set(items.map((item) => item.id)), {
        titleSent: sendTitle,
        head: headIndex,
      })
      if (nextEntry === undefined) {
        const failures = new Map(latest.failures)
        failures.set(headIndex, {
          indices: record.indices,
          reason: 'empty',
          ...(record.carriesTitle === true ? { carriesTitle: true } : {}),
        })
        storeEntry({ ...latest, failures })
        return
      }
      // 所有失败批都补齐且 total 到齐才升 done；否则保持原状态（不把 stopped / failed 谎报成完成）。
      const finished = nextEntry.failures.size === 0 && nextEntry.done >= nextEntry.total
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
      if (resumed === undefined || resumed.status !== 'stopped' || resumed.total - resumed.done <= 0) return
    }

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

  return {
    requestTranslate, confirmTranslate, cancelTranslate,
    continueTranslate, retranslate, stopTranslate, retryBatch, loadTranslateInfo, setTranslateTarget,
    setTranslationMode, cycleTranslationMode,
  }
}
