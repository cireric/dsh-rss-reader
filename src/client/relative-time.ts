/**
 * 相对时间：列表里最需要一眼看懂的就是「多久以前」。
 *
 * 2026-11-16 从 store.ts 抽出（票据 06c）：load 的刷新提示要用它，而 load 搬进 list-actions 之后
 * 从 store.ts import 会形成 store ↔ list-actions 的循环依赖。它是纯函数，独立成模块最省事；
 * store.ts 仍再导出同名符号 —— index.tsx / feeds-view.tsx 的 import 一个字都没变。
 */
export function relativeTime(iso: string | undefined): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const minutes = Math.round((Date.now() - then) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return minutes + ' 分钟前'
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours + ' 小时前'
  const days = Math.round(hours / 24)
  if (days < 30) return days + ' 天前'
  return new Date(then).toISOString().slice(0, 10)
}
