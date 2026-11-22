/**
 * 作者名的**唯一**归一化口径（R12 决策 3）。
 *
 * 为什么单独一个零依赖叶子：refresh 入口、store 的读侧映射、搜索 worker 三处必须共用同一条
 * 规则（否则库里会同时存在 NULL、'' 与纯空白三种「没有作者」）。搜索 worker 是独立线程，
 * 不能把 zod / @deepseek-ai/dsh-storage-domain 拖进去 —— 与 article-text.ts 同一先例。
 *
 * 规则只有一条：trim() 后为空 ⇒ undefined；否则返回 trim 后的值。
 * 不做大小写变换、不剥邮箱、不拆分姓名、不截断 —— 作者是 feed 给的原始字段（ADR-0009），
 * 截断是显示层的决定，不是数据层的改写。
 */
export function normalizeAuthor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
