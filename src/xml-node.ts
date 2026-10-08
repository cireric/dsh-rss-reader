/**
 * fast-xml-parser 的节点小工具。
 *
 * 它家的输出是「单个对象或对象数组」二选一：同名子节点只出现一次时是对象，出现多次时是数组。
 * 于是每个解析器都得写一遍「统一成数组」——原先 feed/parse.ts 与 opml.ts 各有一份逐字相同的
 * 实现（2026-10-07 收敛到这里）。
 */

/** 统一成数组：undefined/null 归空数组，非数组包成单元素数组。 */
export function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}
