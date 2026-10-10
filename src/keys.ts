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
  | 'refreshCount' | 'back' | 'star' | 'toggleRead' | 'markAll' | 'manageFeeds'
  | 'scanNext' | 'scanPrev' | 'pageDown' | 'pageUp' | 'halfPageDown' | 'halfPageUp'
  | 'expandedView' | 'listView'
  // 左栏导航（GR spec §3.8）：导航内移动选中 / 打开导航选中项 / 左栏显隐。
  // 与 j/k 是两条不同的轴：j/k 动的是右栏文章列表的选中项，navNext/navPrev 动的是左栏那一列。
  | 'navNext' | 'navPrev' | 'navOpen' | 'toggleNav'
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
    // shift+n / shift+p = 在**左栏导航**里移动选中（GR spec §3.8 第 209 行 navigation down/up）。
    // 2026-10-10 用户拍板 A 方案：本仓库此前刻意不绑定大写 N/P，本轮按 GR 原义补上。
    // 只认大写：小写 n/p 是「扫视」（滚动视野但不改选中），两者是正交的两条轴，不能互相顶掉。
    // 注意浏览器给的是大写字母本身（shift+n ⇒ 'N'），所以这里写的是大写 case，与上面 r/R、f/F 同理。
    case 'N': return 'navNext'
    case 'P': return 'navPrev'
    // shift+o = 打开导航中选中的订阅/文件夹（GR spec §3.8 第 212 行）。小写 o 仍是「展开选中条目」。
    case 'O': return 'navOpen'
    // d/u = 翻半页（vim 的 Ctrl-d / Ctrl-u 去掉 ctrl）。
    // 为什么另立一档而不是复用空格的整屏：整屏在长文里会跳过头，读者常常只想「再往下看一段」。
    // 2026-10-10 用户拍板 A 方案：u **归还 GR 原义**「订阅列表显隐」（§3.8 第 250 行，本插件的左栏），
    // 原本由 u 承担的上半页改由 shift+d 接盘。旧语义是本仓库自加的（vim 习惯），GR 史料里 u 就是显隐。
    // 上/下半页共用 d 一条 case：上半页必须看 shift 标志（与空格那一对同一处理，空格也不分大小写）。
    // 同时**必须**认大写 'D'：真实浏览器里 shift+d 给的 event.key 就是 'D'，只看小写 + shift 标志
    // 会让真机上的 shift+d 静默无反应 —— 正是本文件开头记着的那类缺陷（标签写着 R、实现只认 shift+R）。
    // 不带 shift 的 'D' 只可能来自 CapsLock，仍不做事（沿用本条原有的误触约定）。
    case 'd': return shift === true ? 'halfPageUp' : 'halfPageDown'
    case 'D': return shift === true ? 'halfPageUp' : 'none'
    case 'u': return 'toggleNav'
    case 'o': return 'expand'
    // 1/2 = 视图密度（GR 原键位）：1 = expanded view「含条目描述/正文摘录」、2 = list view「只有标题行」
    case '1': return 'expandedView'
    case '2': return 'listView'
    // v 开外部浏览器、V（shift+v）在阅读器内读正文：这是刻意区分的一对
    case 'v': return 'openExternal'
    case 'V': return 'openArticle'
    // r = 刷新未读计数（规格 §5 不变量 8：计数刷新有独立快捷键 r）。
    // 注意它**不抓取外部站点** —— 不变量 1 明写「Refresh ≠ 重新抓取」，所以这个动作只重取本地视图。
    case 'r':
    case 'R': return 'refreshCount'
    // w/W 于 2026-10-08 空出：原站视图（iframe）整条路径已删除。键位留空而不是随手改派 ——
    // 空着的键是明确的「没绑」，改派需要一个真实需求。
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