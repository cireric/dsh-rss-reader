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
  | 'toggleRender' | 'back' | 'star' | 'toggleRead' | 'markAll' | 'manageFeeds'
  | 'scanNext' | 'scanPrev' | 'pageDown' | 'pageUp'
  | 'expandedView' | 'listView'
  | 'none'

/**
 * 键值 → 动作。`event.key` 大小写敏感：字母键按 shift 会变成大写，
 * 所以「同一动作接受两种写法」必须在这里显式写出，不能靠调用方猜测。
 */
export function resolveReaderKey(key: string, shift = false): ReaderKeyAction {
  switch (key) {
    // j/k = 移动选中（列表）/ 换文章（详情）——「换条目」这条轴
    case 'j': return 'next'
    case 'k': return 'prev'
    // n/p = 扫视：滚动视野但**不改变选中**（GR 原义；与 j/k 正交的「看」这条轴）
    case 'n': return 'scanNext'
    case 'p': return 'scanPrev'
    // 空格 = 翻页（按一屏）。空格不分大小写，所以必须看 shift 标志才能分辨方向
    case ' ': return shift === true ? 'pageUp' : 'pageDown'
    case 'o': return 'expand'
    // 1/2 = 视图密度（GR 原键位）：1 = expanded view「含条目描述/正文摘录」、2 = list view「只有标题行」
    case '1': return 'expandedView'
    case '2': return 'listView'
    // v 开外部浏览器、V（shift+v）在阅读器内读正文：这是刻意区分的一对
    case 'v': return 'openExternal'
    case 'V': return 'openArticle'
    // r 与 R 都接受：界面标签写的是「（R）」，不写 shift 就不该要求 shift
    case 'r':
    case 'R': return 'toggleRender'
    case 'Escape': return 'back'
    // f 与 F 都接受：界面标签与 README 写的都是「F」，不写 shift 就不该要求 shift
    // （与上面 r/R 同一处理；2026-10-07 修——这条是同类缺陷的复发）
    case 'f':
    case 'F': return 'manageFeeds'
    case 's': return 'star'
    case 'm': return 'toggleRead'
    // Google Reader 里「全部已读」就是 shift+a，故只认大写
    case 'A': return 'markAll'
    default: return 'none'
  }
}