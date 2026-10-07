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
export function scanTop(currentTop: number, rowHeight: number, maxTop: number, direction: 1 | -1): number {
  const step = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 48
  return clampScrollTop(currentTop + direction * step, maxTop)
}

/** 「翻页」：按**一屏**为单位滚动视野（空格 / shift+空格）。 */
export function pageTop(currentTop: number, viewportHeight: number, maxTop: number, direction: 1 | -1): number {
  const step = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 1
  return clampScrollTop(currentTop + direction * step, maxTop)
}
