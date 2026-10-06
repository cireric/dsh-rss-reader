/**
 * 阅读器键盘映射 —— **纯函数**，刻意放在宿主也会编译的目录里。
 *
 * 为什么不让客户端自己写一个 switch：实测踩过「界面标签写 R、实现只认 shift+R」这类不一致
 * （用户按小写 r 毫无反应，而按钮正常）。映射抽出来之后，宿主侧单测能直接钉住每个键的语义，
 * 标签与实现不再各说各话。
 */

/** 键盘动作：与具体按键解耦，客户端只负责把动作落到 store 上。 */
export type ReaderKeyAction =
  | 'next' | 'prev' | 'expand' | 'openExternal' | 'openArticle'
  | 'toggleRender' | 'back' | 'star' | 'toggleRead' | 'markAll' | 'manageFeeds' | 'none'

/**
 * 键值 → 动作。`event.key` 大小写敏感：字母键按 shift 会变成大写，
 * 所以「同一动作接受两种写法」必须在这里显式写出，不能靠调用方猜测。
 */
export function resolveReaderKey(key: string): ReaderKeyAction {
  switch (key) {
    case 'j': return 'next'
    case 'k': return 'prev'
    case 'o': return 'expand'
    // v 开外部浏览器、V（shift+v）在阅读器内读正文：这是刻意区分的一对
    case 'v': return 'openExternal'
    case 'V': return 'openArticle'
    // r 与 R 都接受：界面标签写的是「（R）」，不写 shift 就不该要求 shift
    case 'r':
    case 'R': return 'toggleRender'
    case 'Escape': return 'back'
    // f：订阅管理（GR 里 f 是全屏，但本插件没有全屏概念，用作 manage 更实用）
    case 'f': return 'manageFeeds'
    case 's': return 'star'
    case 'm': return 'toggleRead'
    // Google Reader 里「全部已读」就是 shift+a，故只认大写
    case 'A': return 'markAll'
    default: return 'none'
  }
}