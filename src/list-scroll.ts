/**
 * 列表「跟随选中项」的滚动计算 —— 纯函数，故可用单测钉住边界行为。
 *
 * 起因：用户实测 j/k 移到超出可视区时列表纹丝不动（原实现里根本没有滚动代码）。
 * 抽成纯函数是因为真实滚动位置依赖 DOM 尺寸，我无法在浏览器里自测；把**该滚到哪**的
 * 判断独立出来后，"上方越界 / 下方越界 / 已在视内不动"这三种情况都能被测试覆盖。
 */
export function nextScrollTop(
  currentTop: number,
  containerHeight: number,
  rowTop: number,
  rowHeight: number,
): number {
  // 已在视口内：不动（避免每次移动都抖动或把选中项顶到边缘）
  if (rowTop >= currentTop && rowTop + rowHeight <= currentTop + containerHeight) return currentTop
  // 越出上边界：把该行顶到容器顶部
  if (rowTop < currentTop) return rowTop
  // 越出下边界：把该行贴到容器底部
  return rowTop + rowHeight - containerHeight
}
/** 把滚动位置夹进合法范围（非有限值一律当 0，避免写进 NaN 让滚动条乱跳）。 */
export function clampScrollTop(value: number, maxTop: number): number {
  if (!Number.isFinite(value)) return 0
  const ceiling = Number.isFinite(maxTop) && maxTop > 0 ? maxTop : 0
  return Math.max(0, Math.min(ceiling, value))
}

/**
 * 「扫视」：按**一行**为单位滚动视野，**不改变选中**（Google Reader 的 n/p 语义：
 * scroll to the next item **without viewing it**）。
 *
 * 与 nextScrollTop 的分工：那个是「让选中项可见」（跟随光标），这个是「只看不动」
 * ——用户在决定要不要打开某一项之前，需要先把视野推下去看看有什么。
 */
export function scanTop(currentTop: number, step: number, maxTop: number, direction: 1 | -1): number {
  // 步长由调用方按视图决定（见 scanStepFor）。量不到步长时**不动**，
  // 而不是回落到一个「看起来能动」的常数 —— 详情页那个 48 就是这么变成「按一次滚一行半」的。
  const safeStep = Number.isFinite(step) && step > 0 ? step : 0
  return clampScrollTop(currentTop + direction * safeStep, maxTop)
}

/** 列表行高量不到时的兜底步长（改动前就是这个值，保持列表行为不变）。 */
export const LIST_ROW_STEP_FALLBACK = 48

/** 正文行高量不到时的兜底：正文样式是 16px × 1.85 ≈ 29.6，取整 30。 */
export const ARTICLE_LINE_STEP_FALLBACK = 30

/**
 * 滚动容器的标记属性。
 *
 * 为什么用属性而不是把 DOM 节点存进 state：节点存进 state 就会被长驻的 keydown 监听器
 * 闭包捕获，而依赖数组不会因为「某个 state 在别处被赋值」而重跑 ⇒ 监听器里那个值恒为旧值。
 * 详情页空格 / n / p 全部静默失效就是这么来的（2026-10-09 用户实测）。按键时按属性现取，
 * 闭包里就不存在会变的值。属性名与取值都在这里，客户端不许再自己拼字符串。
 */
export const SCROLL_ATTR = 'data-rss-scroll'

/**
 * 视图 → 滚动容器的选择器。
 *
 * `undefined` 表示**该视图本来就没有滚动容器**（订阅管理页），调用方应静默返回；
 * 返回了选择器却查不到节点才是异常，必须留下可见证据。两者必须分开：
 * 否则订阅管理页按空格也会刷警告，警告成为噪音之后就没人再看它了。
 */
export function scrollSelectorFor(view: string): string | undefined {
  if (view === 'list') return '[' + SCROLL_ATTR + '="list"]'
  if (view === 'article') return '[' + SCROLL_ATTR + '="article"]'
  return undefined
}

/**
 * 判断一个节点是不是「元素节点」—— **只看手上的节点，不依赖任何环境全局**。
 *
 * 为什么不用 `instanceof HTMLElement`：那个标识符必须在 **bundle 所在 realm 的全局作用域**里
 * 存在。全局缺失时，按键处理器会在第一行抛 ReferenceError，被宿主/测试的事件派发吞掉 ——
 * 症状是「所有快捷键全哑」，而控制台什么都没有（2026-10-09 实测：删掉该全局后 prevented=false）。
 * 这与「滚动容器必须按键时刻现取」是同一条约束的两种表现：**按键路径上的判断只能依据这次
 * 事件/这次调用真正拿到的东西**，既不许捕获渲染期的值，也不许指望环境里恰好有什么。
 *
 * ⚠️ nodeType === 1 也涵盖 SVG 等非 HTML 元素；调用点只用到 Element 级成员
 * （querySelector / offsetHeight / getClientRects / scrollTop）与 HTMLElement 的
 * isContentEditable，多认一个 SVG 元素对任何调用点都没有影响。
 */
export function isElementNode(node: unknown): node is HTMLElement {
  return typeof node === 'object' && node !== null
    && (node as { nodeType?: unknown }).nodeType === 1
}

/** 解析 CSS 像素值；非正数 / 非数字一律当「量不到」。 */
export function parseCssPx(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * 由容器自身的字号与行高算出「一行」是多少像素。
 *
 * 行高写成倍数（1.85）时必须乘字号；写成 px 时直接用 —— 两种写法都要认，
 * 否则换一种写法的瞬间，逐行扫视就会退化成另一个不知道多长的步长。
 */
export function lineStepFrom(fontSize: string | undefined, lineHeight: string | undefined): number | undefined {
  const size = parseCssPx(fontSize)
  if (size === undefined || lineHeight === undefined) return undefined
  if (lineHeight.endsWith('px')) return parseCssPx(lineHeight)
  const ratio = Number.parseFloat(lineHeight)
  if (!Number.isFinite(ratio) || ratio <= 0) return undefined
  return size * ratio
}

/**
 * 逐行扫视（n/p）在该视图下的步长。
 *
 * 抽成纯函数的原因：这里正是**同一个键在两类视图下步长不同**的地方，而它此前错了 ——
 * 详情页量不到列表行高，于是落回硬编码 48px，而正文行高约 29.6px，成了「按一次滚一行半」。
 * 把「哪个视图用哪种步长、量不到时用哪个兜底」独立出来，才不会再次退化成某个常数。
 */
export function scanStepFor(view: string, measured: { rowHeight?: number; lineHeight?: number }): number {
  const pick = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  if (view === 'article') return pick(measured.lineHeight, ARTICLE_LINE_STEP_FALLBACK)
  return pick(measured.rowHeight, LIST_ROW_STEP_FALLBACK)
}

/**
 * 「半页」：按**半屏**为单位滚动视野（d / shift+d；2026-10-10 起 u 归还左栏显隐，不再参与翻页）。
 *
 * 与 pageTop 的分工：整屏翻页在长文里会跳过头 —— 读者往往只想「再往下看一段」，
 * 而不是把上一屏的最后一行挤走。整屏、半页、逐行三档并存，各管一段距离。
 */
export function halfPageTop(currentTop: number, viewportHeight: number, maxTop: number, direction: 1 | -1): number {
  const viewport = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 2
  return clampScrollTop(currentTop + direction * (viewport / 2), maxTop)
}

/**
 * 「跳到文章一端」：回顶部 / 去底部（详情页右下角那两个箭头按钮用）。
 *
 * 为什么也抽成纯函数：它和 pageTop 一样是「算该滚到哪」，而边界值最容易写错——
 * `scrollHeight - clientHeight` 在内容不足一屏时是**负数**，直接写进 scrollTop 会让
 * 浏览器把它当成 0（看似正常），但逻辑上是在依赖浏览器的容错。这里显式夹到 [0, maxTop]。
 */
export function edgeTopFor(maxTop: number, edge: 'top' | 'bottom'): number {
  const ceiling = Number.isFinite(maxTop) && maxTop > 0 ? maxTop : 0
  return edge === 'top' ? 0 : ceiling
}

/** 「翻页」：按**一屏**为单位滚动视野（空格 / shift+空格）。 */
export function pageTop(currentTop: number, viewportHeight: number, maxTop: number, direction: 1 | -1): number {
  const step = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 1
  return clampScrollTop(currentTop + direction * step, maxTop)
}
