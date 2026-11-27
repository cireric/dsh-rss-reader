/**
 * 正文视口几何的测量助手（R7 04 / 评审修复 A2）。
 *
 * 为什么单独成文件：按钮路径（article-pane）与 `t` 键路径（keyboard-routing）必须喂给
 * `pickBatch` 同一份几何。此前 `translateGeometryOf` 住在 article-pane 里，键盘路径拿不到它，
 * `t` 的首批就退化成文档顺序 —— 同一个「译」在鼠标与键盘下翻的不是同一批段落（spec §4.3:80）。
 *
 * 本文件**不 import React**：只做 DOM 测量并把最小值投影成 translate-blocks 的纯数据，
 * 选批判定仍在 translate-blocks 的 `pickBatch`。DOM 节点不许进纯函数（jsdom 之外无法单测）。
 */
import { scrollSelectorFor } from '../list-scroll.js'
import type { TranslateBlockRect, TranslateGeometry, TranslateRect } from '../translate-blocks.js'

/** `getBoundingClientRect()` → 纯函数认的四个数（DOMRect 不进 translate-blocks）。 */
export function translateRectOf(element: Element): TranslateRect {
  const rect = element.getBoundingClientRect()
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
}

/**
 * 量一个滚动容器内的正文几何（spec §4.3）：容器矩形 + 每个块的矩形。
 *
 * 块锚点是渲染层打的 `data-rss-block={块下标}`。用锚点而不是把 ref 数组抬到 React 里：
 * 块下标本来就是渲染的唯一身份，锚点让「DOM 顺序 === displayBlocks 下标」成为可核对的事实；
 * 图片折叠只让成员返回 null，剩下的锚点仍带着原下标。
 */
export function translateGeometryOf(container: HTMLElement): TranslateGeometry {
  const blocks: TranslateBlockRect[] = []
  for (const node of container.querySelectorAll<HTMLElement>('[data-rss-block]')) {
    const raw = node.getAttribute('data-rss-block')
    if (raw === null) continue
    const index = Number(raw)
    if (!Number.isInteger(index) || index < 0) continue
    blocks.push({ index, rect: translateRectOf(node) })
  }
  return { container: translateRectOf(container), blocks }
}

/**
 * 按键时刻从面板根节点现取正文滚动容器再量几何。
 *
 * 为什么现取而不是把节点存进 state：长驻的 keydown 监听器会闭包捕获旧值（2026-10-09 的
 * 键盘事故同族，见 keyboard-routing 的 focusScrollBox）。量不到容器时返回 undefined ——
 * 调用方按「可见集为空」退化，不编一个假视口。
 */
export function articleTranslateGeometryOf(root: HTMLElement | null): TranslateGeometry | undefined {
  const selector = scrollSelectorFor('article')
  if (root === null || selector === undefined) return undefined
  const container = root.querySelector<HTMLElement>(selector)
  if (container === null) return undefined
  return translateGeometryOf(container)
}
