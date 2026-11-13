/**
 * 客户端侧的 DOM 类型收窄。
 *
 * 运行时判定只有一处：src/list-scroll.ts 的 isElementNode（只看节点自身的 nodeType，
 * 不依赖任何环境全局，因此跨 realm / 跨 iframe 都成立，见 docs/pitfalls.md 三、3.2）。
 * 这份文件只补一个**类型谓词**——它必须住在客户端，因为 host 工程的 tsconfig 只有 Node 类型，
 * 一写 `node is HTMLElement` 就是 TS2304（2026-11-13 实测：tsc 7.0.2 报错、tsc 6.0.3 不报）。
 */
import { isElementNode as hasElementNodeShape } from '../list-scroll.js'

/**
 * 把「是元素节点」收窄成「是 HTMLElement」，供客户端里需要 DOM 成员（offsetTop /
 * isContentEditable / closest …）的调用点使用。
 * @param node - 任意事件目标或查询结果。
 * @returns 是否为元素节点（同时完成类型收窄）。
 */
export function isElementNode(node: unknown): node is HTMLElement {
  return hasElementNodeShape(node)
}
