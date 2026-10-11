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
  // ? = 快捷键帮助浮窗（GR spec §3.8 第 255 行「? | 快捷键帮助」）。它是**开关**语义，
  // 客户端按「开↔关」处理，所以只需要一个动作，不需要 up/down 两个。
  | 'help'
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
    // ? = 打开/关闭快捷键帮助（GR §3.8 第 255 行）。浏览器在 shift+/ 时给的就是字面 '?'，
    // 所以这里写字符本身，不需要看 shift 标志。
    case '?': return 'help'
    default: return 'none'
  }
}

/** 帮助浮窗里的适用视图。取值与 client 里那些 `if (view !== '...') return` 的裁决一一对应。 */
export type ReaderHelpScope = 'list' | 'listArticle' | 'any'

/**
 * 适用视图的显示文案。`any` 是空串：卡片上有一行图例说明「未标注 = 任何视图都生效」，
 * 不必为八行重复那两个字。
 */
export const READER_HELP_SCOPE_LABEL: Record<ReaderHelpScope, string> = {
  list: '仅列表',
  listArticle: '列表 / 正文',
  any: '',
}

/** 一条真实绑定：`event.key` 的字面值 + 是否带 shift，与 resolveReaderKey 的两个入参同源。 */
export interface ReaderHelpBinding {
  /** `event.key` 的字面值（大小写敏感，见本文件开头）。 */
  key: string
  /** 真实浏览器里这一条带不带 shiftKey；省略即不带。 */
  shift?: boolean
  /** 这条绑定应当解析出的动作 —— 有单测逐条反查 resolveReaderKey 的实际返回。 */
  action: Exclude<ReaderKeyAction, 'none'>
}

/** 帮助浮窗里的一行。一行可以并列多条绑定（`j / k`、`d / shift+d`、`r / R`）。 */
export interface ReaderHelpEntry {
  /**
   * 面向读者的键位写法。两条约束：① 每一条 binding 的键都要在这里出现（有单测看着）；
   * ② 不强制与键值逐字相同 —— 界面上惯写 `shift+n` 而不是 `shift+N`，「空格」也不是一个字面字符。
   */
  label: string
  summary: string
  scope: ReaderHelpScope
  bindings: ReaderHelpBinding[]
}

export interface ReaderHelpSection {
  title: string
  entries: ReaderHelpEntry[]
}

/**
 * 快捷键帮助的**唯一来源**（分组照 GR §3.8 的三段口径：Navigation / Acting on Items / Application）。
 *
 * 为什么要有这张表：头部此前挂着一行手写的键位提示，它与 resolveReaderKey 之间没有任何机制保证
 * 一致 —— 而本仓库已经为「标签与实现各说各话」付过两次学费（按钮写「（R）」而实现只认 shift+R；
 * 界面写「F」而实现只认大写）。提示行搬进浮窗后，如果文案还是手写的，那类缺陷只是换个地方藏。
 * 所以：① 浮窗逐行渲染这张表，客户端不再有自己的第二份文案；
 *       ② tests/keys.test.mjs 逐条反查 `resolveReaderKey(binding.key, binding.shift)` 是否真的返回
 *          这一行声明的动作 —— 实现偷偷改派键位、或绑定与实现脱钩，测试当场红；
 *       ③ 反向也查：keys.js 里能返回的动作，这张表必须都收进某一行。
 * 只列**本插件真实可用**的绑定：GR 里未实现的键（`/` 搜索、`g` 两段式、`-`/`=` 缩放、
 * `l`/`shift-s` 社交）一律不出现 —— 列出来就是假标签。
 */
export const READER_KEY_HELP: ReaderHelpSection[] = [
  {
    title: '导航',
    entries: [
      { label: 'j / k', summary: '列表：下/上移动选中（不标已读）；正文：切上/下一条文章（显示即已读）', scope: 'listArticle',
        bindings: [{ key: 'j', action: 'next' }, { key: 'k', action: 'prev' }] },
      { label: 'n / p', summary: '扫视：滚动视野但不改变选中', scope: 'listArticle',
        bindings: [{ key: 'n', action: 'scanNext' }, { key: 'p', action: 'scanPrev' }] },
      { label: '空格 / shift+空格', summary: '整屏翻页（下 / 上）', scope: 'listArticle',
        bindings: [{ key: ' ', action: 'pageDown' }, { key: ' ', shift: true, action: 'pageUp' }] },
      { label: 'd / shift+d', summary: '半屏翻页（下 / 上）', scope: 'listArticle',
        bindings: [{ key: 'd', action: 'halfPageDown' }, { key: 'd', shift: true, action: 'halfPageUp' }] },
      { label: 'o', summary: '展开/折叠选中条目并标已读', scope: 'list',
        bindings: [{ key: 'o', action: 'expand' }] },
      { label: 'shift+n / shift+p', summary: '在左栏导航里移动光标（不改变右栏）', scope: 'list',
        bindings: [{ key: 'N', shift: true, action: 'navNext' }, { key: 'P', shift: true, action: 'navPrev' }] },
      { label: 'shift+o', summary: '打开左栏光标所在的那一行（= 点击它）', scope: 'list',
        bindings: [{ key: 'O', shift: true, action: 'navOpen' }] },
      { label: 'u', summary: '左栏（订阅导航）显隐', scope: 'list',
        bindings: [{ key: 'u', action: 'toggleNav' }] },
      { label: '1 / 2', summary: '展开视图 / 紧凑列表', scope: 'list',
        bindings: [{ key: '1', action: 'expandedView' }, { key: '2', action: 'listView' }] },
    ],
  },
  {
    title: '条目动作',
    entries: [
      { label: 'V', summary: '在阅读器内读正文', scope: 'list',
        bindings: [{ key: 'V', shift: true, action: 'openArticle' }] },
      { label: 'v', summary: '用系统浏览器打开原站（并标已读）', scope: 'any',
        bindings: [{ key: 'v', action: 'openExternal' }] },
      { label: 's', summary: '星标 / 取消星标', scope: 'any',
        bindings: [{ key: 's', action: 'star' }] },
      { label: 'm', summary: '切换已读 / 未读', scope: 'any',
        bindings: [{ key: 'm', action: 'toggleRead' }] },
      { label: 'A', summary: '全部标为已读（范围取头部「A 键范围」）', scope: 'any',
        bindings: [{ key: 'A', shift: true, action: 'markAll' }] },
    ],
  },
  {
    title: '应用',
    entries: [
      { label: 'r / R', summary: '刷新未读计数（不重新抓取外部站点）', scope: 'any',
        bindings: [{ key: 'r', action: 'refreshCount' }, { key: 'R', shift: true, action: 'refreshCount' }] },
      { label: 'f / F', summary: '订阅管理（OPML 导入导出、加源、退订）', scope: 'any',
        bindings: [{ key: 'f', action: 'manageFeeds' }, { key: 'F', shift: true, action: 'manageFeeds' }] },
      { label: 'Esc', summary: '正文 → 列表；订阅管理 → 列表', scope: 'any',
        bindings: [{ key: 'Escape', action: 'back' }] },
      { label: '?', summary: '打开 / 关闭本帮助', scope: 'any',
        bindings: [{ key: '?', action: 'help' }] },
    ],
  },
]