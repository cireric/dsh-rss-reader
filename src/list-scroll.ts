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
