/**
 * 键盘动作的**路由与守卫**（第 2 层）。
 *
 * 一次按键分三层走完：
 *   第 1 层 键 → 动作名          ${B}src/keys.ts${B} 的 ${B}resolveReaderKey${B}（领域词汇，帮助浮窗也读它）
 *   第 2 层 动作名 + 当前视图 ⇒ 做什么、该不该拦   ← **本文件**
 *   第 3 层 真正改数据          ${B}src/client/store.ts${B}
 *
 * 为什么这层要有自己的文件（2026-10-15 从 src/client/index.tsx 搬出）：
 *  ① 它此前住在组件体内，**无法单测** —— 而它那 10 处 view 守卫是两次实测缺陷的现场：
 *     2026-10-06 正文页按 o 会展开「背后那个看不见的列表」；
 *     2026-10-09 空格 / n / p 因闭包捕获了容器而静默失效。
 *     搬成独立函数后，这些守卫能被 tests/keyboard-routing.test.mjs 直接驱动。
 *  ② 与 keys.ts 隔着同一个 ${B}ReaderKeyAction${B} 联合类型：帮助浮窗显示什么、这里执行什么，
 *     将来加键只改一处会被 tsc 抓到。
 *  ③ **为什么在 ${B}src/client/${B} 而不是 ${B}src/${B} 根**：host 的 tsc 是 ${B}lib:["ES2023"]${B}
 *     （无 DOM），而本文件必须碰 ${B}scrollTop${B} / ${B}clientHeight${B} / ${B}getClientRects()${B}。
 *     ${B}src/${B} 根下的 keys.ts / list-scroll.ts 之所以能被 host 编译，正是因为它们**刻意不碰 DOM**
 *     （签名全是 number，只留 SCROLL_ATTR 这个字符串常量）—— 本文件做不到那一点。
 *     ⇒ 单测走 ${B}tests/keyboard-routing.test.mjs${B}：vm 加载 lib/client.js 取本函数（与
 *     tests/scroll-dom.test.mjs 同一套路），需要 ${B}index.tsx${B} 在入口 re-export 它。
 *
 * **它验不了什么**（别误读成「按键行为已全覆盖」）：监听器有没有正确重注册、闭包有没有捕获
 * 旧值，那两类必须靠真 DOM 层 —— tests/scroll-dom.test.mjs 用真 React + 真 KeyboardEvent 做。
 */
import { resolveReaderKey } from '../keys.js'
import {
  scanTop, pageTop, halfPageTop, scanStepFor, scrollSelectorFor, lineStepFrom,
} from '../list-scroll.js'
import { isElementNode } from './element-node.js'
import { nextExpandedOf, type ReaderState, type ReaderStore } from './store.js'
import { articleTranslateGeometryOf } from './translate-geometry.js'
import { EMPTY_IMAGE_GROUPS, baselineExpandedOf } from '../image-fold.js'

export interface KeyRoutingCtx {
  /**
   * 面板根节点：判定「面板是否真在前台」（宿主可能把非当前主栏面板保活在后台），
   * 并用它 querySelector 取滚动容器 —— **不用裸 document/getComputedStyle**：
   * bundle 会被塞进宿主页面，多窗口与测试环境里裸全局不保证存在（docs/pitfalls.md §3.2）。
   */
  readonly root: HTMLDivElement | null
  readonly store: ReaderStore
  /** 「哪条展开着」与它的 setter —— **组件局部 state，不进 store**（裁决 Q2）。 */
  readonly expanded: string | undefined
  readonly setExpanded: (next: string | undefined) => void
  /** 帮助浮窗是否开着：Esc 的优先级判据（开着时 Esc 只关它）。 */
  readonly helpOpen: boolean
  readonly setHelpOpen: (next: boolean) => void
  /**
   * 图片折叠的**篇级覆盖**（R6 04，spec 决策 5 / 14）：本次阅读里 `i` 写的瞬时值，
   * `undefined` 表示「这一篇还没按过 `i`」⇒ 落回偏好。
   *
   * 与 `expanded` / `helpOpen` 同一条通道，理由也一样：`i` 的语义是「翻**基线**」，
   * 而基线 = `篇级覆盖 ?? 偏好`，所以 `routeKey` 必须**读**它。它必须在 effect 依赖数组里，
   * 否则监听器闭包读到注册那一刻的值 ⇒ 第二次按 `i` 不生效（`expanded` 的既存事故同族）。
   */
  readonly imagesExpanded: boolean | undefined
  readonly setImagesExpanded: (next: boolean | undefined) => void
  /**
   * 组级覆盖（被读者点开的组序号，R6 03 的 state）。
   *
   * `i` 要**清空**它（spec 决策 10）：不清的话，读者点过的那一组会逆着 `i` 的方向留在展开态，
   * `i` 就不再是「整篇一个开关」。
   *
   * ⚠️ 本文件**只写不读**它（`grep ctx.expandedGroups` 在本文件零命中，唯一用法是
   * `ctx.setExpandedGroups(EMPTY_IMAGE_GROUPS)`）。它留在 `KeyRoutingCtx` 里是因为
   * 与 `imagesExpanded` / `lightboxSrc` 走同一条通道、同一个 effect 依赖数组 ——
   * 那里保留它的理由与代价写在 `index.tsx` 依赖数组的注释里（取舍，不是漏删）。
   */
  readonly expandedGroups: ReadonlySet<number>
  readonly setExpandedGroups: (next: ReadonlySet<number>) => void
  /**
   * 灯箱正在显示的那张图的 `src`（R6 07，spec 决策 14 / 26）：`undefined` = 关着。
   *
   * 与 `expanded` / `helpOpen` / `imagesExpanded` 同一条通道，理由完全同源：`Esc` 的优先级
   * （帮助 → 灯箱 → 退出正文）实现在本文件的 `back` 动作里，而 `back` 读的是 `ctx`。
   * 状态留在 `ArticleView` 里，`Esc` 就永远读不到它（spec 决策 14 明写「必须抬上来，不是可选」）。
   * 它只被 `back` 与 `toggleImages` **读**（判断该不该关），写入路径是图上的 `onClick`。
   * 同样要在 effect 依赖数组里 —— 否则监听器闭包读到注册那一刻的 `undefined`，
   * `Esc` 会径直跳过灯箱去关文章（`expanded` 的既存事故同族，pitfalls §3.1）。
   */
  readonly lightboxSrc: string | undefined
  readonly setLightboxSrc: (next: string | undefined) => void
  /**
   * A 的二次确认框是否开着（2026-11-21）。
   *
   * 为什么要进 ctx：它是模态，Esc 必须能关掉它。焦点落在框内时 document 层的 routeKey 会被
   * `isTypingTarget` 挡住（`role="dialog"` 分支），那条路由由对话框自己处理；但焦点还在框外
   * （刚按下 A、React 尚未把焦点移进按钮）时，Esc 只能靠这里。两处都写是**同一判据的两个入口**，
   * 不是两份实现：都只做「关掉」。
   */
  readonly markAllConfirm: boolean
  readonly setMarkAllConfirm: (next: boolean) => void
}

/**
 * 快捷键的守卫：焦点在输入框、可编辑区或弹层里时不响应。
 *
 * 为什么不再要求「阅读器持有焦点」：用户实测切到阅读器后必须先用鼠标点一下才能用快捷键——
 * 因为宿主在面板切换后并不把按键交给我们的节点。现在监听挂在 document 上（面板卸载即移除），
 * 于是「只有阅读器存在时才可能响应」由生命周期保证，而「别抢输入框的键」由本函数保证。
 *
 * ⚠️ 逐字搬自 src/client/index.tsx（2026-10-15）。搬运时若简化这三条，会静默改变行为：
 *  ① 弹层守卫 `closest('[role="dialog"], [aria-modal="true"], dialog')` 漏掉 ⇒ 弹层开着时按键被抢；
 *  ② try/catch 漏掉 ⇒ 判定抛错时整套键位被一起带走（不是「按非输入框放行」）；
 *  ③ use isElementNode 而不是 instanceof HTMLElement —— 后者依赖全局标识符，
 *     全局缺失时会在这一行抛 ReferenceError（见 list-scroll.ts 的说明）。
 */
function isTypingTarget(target: EventTarget | null): boolean {
  // 用 isElementNode 而不是 instanceof HTMLElement：后者依赖全局标识符，
  // 全局缺失时会在这一行抛 ReferenceError，把整套键位一起带走（见 list-scroll.ts 的说明）
  if (!isElementNode(target)) return false
  try {
    if (target.isContentEditable) return true
    if (target.closest('[role="dialog"], [aria-modal="true"], dialog') !== null) return true
    const tag = target.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  } catch (error) {
    // 不能静默降级：判定失败意味着「这次按键会被当成非输入框而放行」，那是行为上的改变，
    // 必须在控制台留下证据（浏览器里 console 是本插件唯一可见的通道）。
    console.warn('[rss-reader] 输入框判定失败，本次按键按「非输入框」处理', error)
    return false
  }
  return false
}

/**
 * 量列表「一行条目」的高度。量不到返回 undefined，由 scanStepFor 决定兜底 ——
 * 这里不自己编一个常数，否则「兜底多少」就会散落在两个文件里。
 *
 * ⚠️ 逐字搬：原实现读 `offsetHeight`（jsdom 下恒为 0，真机上是实值）。
 * 若改成 getBoundingClientRect().height 就不等价了 —— 后者含缩放且 jsdom 也恒为 0，
 * 「量不到」的两种原因会混在一起。
 */
function measureRowHeight(box: HTMLElement): number | undefined {
  const row = box.querySelector('[data-rss-row]')
  if (!isElementNode(row)) return undefined
  const height = row.offsetHeight
  return Number.isFinite(height) && height > 0 ? height : undefined
}

/**
 * 量「正文一行」的高度。
 *
 * ⚠️ 必须量**承载正文的元素**，不能量容器本身：容器上只有 flex/overflow 这些布局样式，
 * 字号行高是从面板根继承来的（14px × 1.55 = 21.7），而正文是内层块自己的
 * 16px × 1.85 = 29.6 —— 量错对象会得到一个小一号的步长，而且看起来「有值」，不会被兜底发现。
 * 优先取正文段落（`p`），它才是读者眼里的「一行」。
 *
 * win 取自面板的 document，不用裸全局（docs/pitfalls.md §3.2）。
 */
function measureLineStep(box: HTMLElement, win: Window | undefined): number | undefined {
  if (win === undefined) return undefined
  const sample = box.querySelector('p') ?? box
  const style = win.getComputedStyle(sample)
  return lineStepFrom(style.fontSize, style.lineHeight)
}

/**
 * 「非阅读视图」：这些视图里阅读键（j/k/空格/g/G/d/u…）一律不接管，只留帮助 / 订阅管理 / 返回。
 *
 * 为什么是集合而不是每加一个视图就往 10 个 case 里各补一条 `if`：本层的 `run()` 都带
 * preventDefault，而这两个视图都要求阅读键**完全不动**、空格 / d 交给浏览器原生滚动；
 * 「不接管」必须发生在 switch 之前。加视图只改这一处，不会漏掉某个 case（R11 01 的 settings
 * 与 R8b 04 的 explore 是同一条规则）。
 */
const NON_READING_VIEWS: ReadonlySet<ReaderState['view']> = new Set(['settings', 'explore', 'sourcePack'])

/**
 * 一次按键 → 零次或一次动作。
 *
 * 同步返回：异步动作（openArticle / toggleStar / markAllRead…）由 store 自己兜，
 * 这里只负责「该不该触发、触发哪个」。
 */
export function routeKey(event: KeyboardEvent, ctx: KeyRoutingCtx): void {
  if (isTypingTarget(event.target)) return
  // 宿主可能把非当前主栏面板保活在后台（ui-layout 的 retainMainPanels 就是这个意图）：
  // 面板没真正显示时不响应，否则你在对话里按 j/k 会去动一个看不见的列表。
  // 用 getClientRects().length 判可见：display:none 或未挂载时为 0，且不受定位方式影响。
  if (ctx.root === null || ctx.root.getClientRects().length === 0) return
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
  const store = ctx.store
  const view = store.get().view
  /**
   * 探索视图的 `b` = 返回（spec §4.1）。
   *
   * 刻意**不**把 b 加进 keys.ts 的全局表：那会让 b 在正文页也变成「关闭文章」，凭空多出一个
   * 用户没要求的危险键。探索是唯一需要它的地方，所以判据也留在这里。
   */
  if (view === 'explore' && event.key === 'b' && !event.shiftKey) {
    event.preventDefault()
    store.closeExplore()
    return
  }
  const action = resolveReaderKey(event.key, event.shiftKey)
  if (action === 'none') return

  /**
   * 按键时刻解析滚动容器 —— **不读渲染期捕获的值**。
   *
   * 为什么必须现取：这个监听器挂在 document 上、生命周期跨很多次重渲染，而它的依赖数组
   * 只在 root/store 变化时重跑。此前容器存在 state 里被闭包捕获，进详情页不会重新注册监听，
   * 闭包读到的永远是 null ⇒ 空格 / n / p 全部静默 no-op（2026-10-09 用户实测）。
   * 第一版修法是 useRef 句柄，但那只解决「值变了」；现取还能覆盖容器**换了个节点**的情况。
   */
  const focusScrollBox = (view: string): HTMLElement | null => {
    const selector = scrollSelectorFor(view)
    if (selector === undefined) return null
    const container = ctx.root === null ? null : ctx.root.querySelector(selector)
    if (container === null) {
      // 不静默降级：按了键却没反应是**行为上的改变**，必须留下证据（浏览器里 console 是唯一通道）
      console.warn('[rss-reader] 找不到滚动容器 ' + selector + '（view=' + view + '）')
      return null
    }
    return isElementNode(container) ? container : null
  }

  /**
   * 非阅读视图**提前 return**（R11 01 / R8b 04）：只有 `?`（帮助）、`F`（订阅管理）、
   * `Esc`（回列表）保持可用，其余动作一律不接管。
   *
   * 也不要在这里 focusScrollBox：这两个视图的滚动容器不在 list-scroll 的视图表里，会 warn。
   */
  if (NON_READING_VIEWS.has(view) && action !== 'help' && action !== 'manageFeeds' && action !== 'back') return
  const run = (act: () => void): void => { event.preventDefault(); act() }
  switch (action) {
    case 'search':
      if (view !== 'list') return
      run(() => ctx.root?.querySelector<HTMLInputElement>('[data-rss-search-input]')?.focus())
      break
    // 正文视图里 j/k 不移动：每次移动都意味着一次抓取，误按代价太高（Esc 回列表再移动）
    // j/k 按视图分流——同一个键始终是「换条目」，语义不因视图而变：
    //   列表页 → 移动选中（不标已读，用户 2026-10-06 定）
    //   正文页 → 切上/下一条文章（B1：显示即打开，故标已读；在途防抖、边界停住）
    case 'next':
      if (view === 'article') { run(() => { store.stepArticle(1) }); break }
      if (view !== 'list') return
      run(() => store.selectRelative(1))
      break
    case 'prev':
      if (view === 'article') { run(() => { store.stepArticle(-1) }); break }
      if (view !== 'list') return
      run(() => store.selectRelative(-1))
      break
    // Google Reader 语义：o 展开/折叠 + 标已读（已读的唯一自动触发点，另有显式的 m）
    case 'expand':
      // 只在列表页有意义：正文页按 o 曾会展开「背后那个看不见的列表」里的条目，
      // 表现为按 Esc 回列表后发现某行莫名展开（既存缺陷，2026-10-06 修）
      if (view !== 'list') return
      run(() => {
        const selected = store.get().selectedId
        if (selected === undefined) return
        // 与行内 Enter / Space 同一条规则（nextExpandedOf），激活 = 选中 + 标已读。
        ctx.setExpanded(nextExpandedOf(ctx.expanded, selected))
        store.activate(selected)
      })
      break
    // n/p = 扫视：滚动视野但**不改变选中**（GR 原义）—— 列表页滚列表，详情页滚文章
    case 'scanNext':
    case 'scanPrev': {
      const direction: 1 | -1 = action === 'scanNext' ? 1 : -1
      const box = focusScrollBox(view)
      if (box === null) return
      run(() => {
        // 步长按视图算：列表用「一行条目」的高度，正文用「一行正文」的高度。
        // 此前两者共用列表行高，正文页量不到就落回硬编码 48px —— 正文行高约 29.6px，
        // 于是 n/p 在详情页成了「按一次滚一行半」（2026-10-09 修）。
        const win = ctx.root === null ? undefined : ctx.root.ownerDocument.defaultView
        const step = scanStepFor(view, {
          rowHeight: measureRowHeight(box),
          lineHeight: measureLineStep(box, win ?? undefined),
        })
        box.scrollTop = scanTop(box.scrollTop, step, box.scrollHeight - box.clientHeight, direction)
      })
      break
    }
    // 空格 / shift+空格 = 整屏；d / shift+d = 半屏。三档距离并存，长文里整屏容易跳过头
    case 'pageDown':
    case 'pageUp':
    case 'halfPageDown':
    case 'halfPageUp': {
      const forward = action === 'pageDown' || action === 'halfPageDown'
      const direction: 1 | -1 = forward ? 1 : -1
      const half = action === 'halfPageDown' || action === 'halfPageUp'
      const box = focusScrollBox(view)
      if (box === null) return
      run(() => {
        const maxTop = box.scrollHeight - box.clientHeight
        box.scrollTop = half
          ? halfPageTop(box.scrollTop, box.clientHeight, maxTop, direction)
          : pageTop(box.scrollTop, box.clientHeight, maxTop, direction)
      })
      break
    }
    // u = 左栏显隐（GR spec §3.8 第 250 行）。2026-10-10 用户拍板 A 方案：u 从「向上半页」归还
    // 给 GR 原义（旧语义是本仓库按 vim 习惯自加的），上半页改由 shift+d 接盘。
    // 只在列表页生效：左栏**只影响条目流**（过滤/选源），正文页与订阅管理页里它属于「背后的东西」。
    case 'toggleNav':
      if (view !== 'list') return
      run(() => store.toggleNav())
      break
    // shift+n / shift+p = 在左栏导航里**移动光标**（GR spec §3.8 第 209 行）。
    // 与 j/k 是两条轴：j/k 动右栏文章列表的选中项，这里动左栏那一列的光标。
    // ⚠️ 移动**不改变**右栏看到什么（那要 shift+o）—— 行序、边界夹取、退订兜底都在
    // store.moveNavCursor 里，此处只传方向，不在组件里重算一遍行表（两处各算一份迟早错位）。
    case 'navNext':
    case 'navPrev':
      if (view !== 'list') return
      // 左栏折叠时没有「导航里的位置」可动，也没有任何可见反馈（按 u 找回来再动，链路不绕）。
      if (!store.get().navVisible) return
      run(() => store.moveNavCursor(action === 'navNext' ? 1 : -1))
      break
    // shift+o = **打开**光标所在行（GR spec §3.8 第 212 行）= 等价于点击它。
    // 走到与鼠标点击**同一组动作**（虚拟视图行 → setFilter，源行 → selectNav）。
    case 'navOpen':
      if (view !== 'list') return
      // 同 navNext/navPrev：折叠态下没有「导航里的一行」可打开
      if (!store.get().navVisible) return
      run(() => store.openNavCursor())
      break
    // ? = 打开/关闭帮助浮窗（GR spec §3.8 第 255 行）。它不随视图分流：帮助在任何视图下
    // 都该看得到，而它解释的恰恰是「别的视图里还能按什么」。
    case 'help':
      run(() => ctx.setHelpOpen(!ctx.helpOpen))
      break
    case 'openExternal': run(() => store.openSelected()); break
    case 'openArticle': if (view !== 'list') return; run(() => { void store.openArticle() }); break
    // i = 展开 / 折叠**当前正文**的全部图片（R6 04，spec 决策 10）。
    //
    // 语义是「翻**基线**并清空组覆盖」，基线 = `篇级覆盖 ?? 偏好`：
    //  - 为什么翻基线而不是翻「当前是否全部展开」：有组覆盖时「部分展开」取反没有定义；
    //    翻基线让行为与「读者点过几组」无关，确定且可测（spec 决策 10 的理由）。
    //  - 为什么清空组覆盖：不清的话，读者点过的那组会逆着 `i` 的方向留在展开态，
    //    `i` 就不再是「整篇一个开关」。
    //  - 清空必须换成**新对象 / 那个空常量**，不能原地 `clear()`：`foldOf` 对组覆盖取快照，
    //    React 也靠引用判断变化，原地改会让两边同时失灵（03 的注释已写明）。
    //  - 结果是折叠时顺带关灯箱（spec 决策 24）：否则「整篇都折叠了，一张图还占满屏」。
    //  - 走 `run()` 而不是裸调用：与其他接管键同族，按键被吃掉（`preventDefault`），
    //    否则浏览器把 `i` 打进某个隐式焦点里（spec 访谈修订 19）。
    case 'toggleImages': {
      if (view !== 'article') return
      run(() => {
        // 基线 = `篇级覆盖 ?? 偏好`，**必须**调 `image-fold.ts` 的 `baselineExpandedOf`，
        // 不在这里自己写一遍这个表达式（ADR-0001：判据只有一个裁决者）。
        // 这里曾写成 `ctx.imagesExpanded ?? store.get().reading.expandImages` —— 与
        // `shouldRenderImage` 里的那半条判据是两份实现。两份当下算得一样，所以没有任何用例
        // 会红；但将来加一层覆盖（例如按源记忆）时两处会静默分家：`i` 翻的方向与渲染读到的
        // 基线不一致，症状是「按 i 偶尔没反应」，极难定位。现在一处实现、两个调用点。
        const baseline = baselineExpandedOf(store.get().reading.expandImages, ctx.imagesExpanded)
        const next = !baseline
        ctx.setImagesExpanded(next)
        ctx.setExpandedGroups(EMPTY_IMAGE_GROUPS)
        // 折叠了就关灯箱（决策 24）：折叠态正文里没有 <img>，灯箱却是同一张图的大图 ——
        // 读者会以为折叠没生效。只在「结果是折叠」时关：展开方向没有可关的东西。
        if (!next) ctx.setLightboxSrc(undefined)
      })
      break
    }
    // t = 两态循环（R7 03 / 06，D14 / 验收 14）：只在正文页。无译文时**触发翻译**
    //（首次仍走确认框）；有译文时在 原文 ↔ 对照 之间切换。视图守卫与「正文已加载」判据
    // 都在动作层（cycleTranslationMode）再挡一次 —— 键盘与按钮共用同一条外发入口。
    // 几何必须在这里现量（评审修复 A2）：否则键盘路径的首批退化成文档顺序，与点「译」翻的不是
    // 同一批段落。容器按 scrollAttr 现取（与 n/p 同一条「不闭包捕获节点」的规矩）。
    case 'cycleTranslation':
      if (view !== 'article') return
      run(() => store.cycleTranslationMode(articleTranslateGeometryOf(ctx.root)))
      break
    // r：刷新未读计数（只重取本地视图，不抓取 —— 规格不变量 1）
    case 'refreshCount': run(() => { void store.refreshCount() }); break
    case 'manageFeeds': run(() => store.toggleFeeds()); break
    // Esc：帮助浮窗 → 灯箱 → 正文 → 订阅管理 → 探索 → 设置 → 列表。列表态不拦截（不抢弹层的 Esc）
    case 'back':
      // 帮助浮窗优先：开着帮助时 Esc **只**关帮助 —— 否则在正文页按 Esc 会「浮窗与文章一起
      // 消失」，而读者只是想收掉那张挡住视线的卡片（用户拍板的三个关闭出口之一）。
      if (ctx.helpOpen) { run(() => ctx.setHelpOpen(false)); break }
      // 灯箱次之（R6 07，spec 决策 26）：帮助的遮罩是 pointer-events:none，所以「浮窗开着 +
      // 点正文里的图」是可达状态；而帮助是全局浮窗、视觉上压在灯箱之上（z-index 6 > 5），
      // 最上层先走。灯箱关掉之后读者**仍在正文里** —— 不该被一路带回列表。
      // A 的确认框是最上层的模态：它开着时 Esc 只关它，不连带关灯箱 / 退出正文。
      if (ctx.markAllConfirm) { run(() => ctx.setMarkAllConfirm(false)); break }
      if (ctx.lightboxSrc !== undefined) { run(() => ctx.setLightboxSrc(undefined)); break }
      if (view === 'article') { event.preventDefault(); store.closeArticle(); break }
      if (view === 'feeds') { event.preventDefault(); store.toggleFeeds(); break }
      // 探索与设置同级：返回固定回列表（不记来源视图，D20）。
      if (view === 'explore') { event.preventDefault(); store.closeExplore(); break }
      // 设置页与订阅管理同级：返回固定回列表，不记来源视图（D20 —— 记 prevView 会把
      // ArticleView 的重挂与正文滚动恢复牵进来，收益低于风险）。
      if (view === 'settings') { event.preventDefault(); store.closeSettings(); break }
      // 精选源（R15 08）：Esc 固定回列表，与设置 / 探索同一条收口。
      if (view === 'sourcePack') { event.preventDefault(); store.closeSourcePack(); break }
      return
    // 视图密度只在条目流上有意义（在正文页/订阅管理页按 1/2 不该改背后的列表）
    case 'expandedView': if (view === 'list') store.setLayout('expanded'); break
    case 'listView': if (view === 'list') store.setLayout('list'); break
    case 'star': run(() => { void store.toggleStar() }); break
    case 'toggleRead': run(() => { void store.toggleRead() }); break
    // A：**先开确认框**，不直接标读（2026-11-21）。确认框里的范围选择、实时条数与「0 条时禁用」
    // 都归组件；这里只负责「该不该开」。真正的标读仍在 store.markAllRead（确认按钮的 onClick）。
    case 'markAll': run(() => ctx.setMarkAllConfirm(true)); break
    default: return
  }
}
