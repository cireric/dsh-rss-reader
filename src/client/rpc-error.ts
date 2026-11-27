/**
 * 浏览器 RPC 失败信封的 Error 投影（R7 05）。
 *
 * 为什么单独成文件（2026-11-26 评审修复）：`store.ts` 需要 `RpcError` 来构造 `browserRpc`
 * 的错误，`translate-actions.ts` 需要 `instanceof RpcError` 读 `details.reason`。类若继续住在
 * store 里，两个模块就形成运行时循环依赖；把这个叶子模块抽出来后依赖方向是单向的：
 * translate-actions → rpc-error ← store。
 *
 * `message` 仍逐字保持 `code: message`：既有调用点只依赖 `instanceof Error` 与这句文本，
 * 日志与错误提示不受影响；新的翻译编排用 `instanceof RpcError` 读 `code` / `details`。
 */
export class RpcError extends Error {
  readonly code: string
  readonly details: object

  constructor(code: string, message: string, details: object) {
    super(code + ': ' + message)
    this.name = 'RpcError'
    this.code = code
    this.details = details
  }
}
