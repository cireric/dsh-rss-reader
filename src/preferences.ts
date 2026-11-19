/**
 * 视图与阅读偏好：面板重开后要恢复的那几项，以及**读侧唯一归一化点**。
 *
 * 为什么单独成模块（2026-11-18 shared.ts 规则归位）：`sanitizeViewPreferences` 是「存坏的值一律
 * 回落默认」这条规则的唯一裁决者，同时被客户端 store（读回）、存储适配器（读写两端）与
 * `saveViewPreferences` 端点调用；它和 wire 形状挤在 shared.ts 里时，改一次归一化规则要在
 * 42 个导出里找位置。本模块是纯函数 + 常量，**host 与 client 都可直接 import**（无 node 依赖）。
 */

/**
 * 视图记忆：面板重开后要恢复起来的那几项（两列布局任务 7 + R2-01）。
 *
 * 这几份状态刻意**只列被记忆的**：navSelection（虚拟视图 / 某个源）、filter、navVisible、
 * 正文排版 reading，以及 R2-01 的阅读位置 lastItemId（上次选中的那一行）与 R2-02 的
 * lastListScrollTop（列表滚到哪儿）。
 * 特别**不含 navCursor**（键盘光标）—— 理由见客户端 store 的恢复注释：光标是「焦点在哪」，
 * 是瞬时的指向，而这里记的是「上次看到哪儿」；恢复时按既有规则把它落到生效的那一行即可。
 */
export interface ViewPreferences {
  /**
   * 可落盘的导航选中。**四种 kind 与 NavSelection 一一对应**（2026-11-14 收口）：
   * 此前只有三种，tag 被一条手写三元静默投影成 virtual —— 按标签筛选生效、落盘却写成「全部」，
   * 还顺手覆盖掉上次记住的源/文件夹。类型缺一种 kind 时编译器不会提醒（else 是合法值），
   * 所以现在由一处**穷尽映射**负责投影（见 src/client/store.ts 的 memorableSelectionOf）。
   */
  navSelection:
    | { kind: 'virtual' }
    | { kind: 'feed'; feedId: string }
    | { kind: 'folder'; folder: string }
    | { kind: 'tag'; tagId: string }
  filter: 'all' | 'unread' | 'starred'
  navVisible: boolean
  /** 正文排版（M5 01）。旧配置没有这个键 ⇒ 归一化时补默认值，不许因为缺字段就回落整份记忆。 */
  reading: ReadingPreferences
  /**
   * 上次选中的条目 id（R2-01 阅读位置）。
   *
   * **可选**：旧配置没有这个键，首次安装的默认偏好也不必带它 —— 「没有」就是没有，
   * 不要用一个空串或 undefined 占位（那会让「从没记过」与「记了一个空值」不可区分）。
   * 它只描述「上次停在哪儿」，不携带读态、也不是打开动作；条目已被清理时由客户端按当前页校验后丢弃。
   */
  lastItemId?: string
  /**
   * 列表滚动容器上次的 scrollTop（R2-02 阅读位置）。
   *
   * 与 lastItemId 一样**可选**：没有就是没有，不用 undefined 占位。只接受有限且 ≥ 0 的数
   * —— 0 是「停在顶部」的真实位置，必须与「没记过」区分开；负值 / NaN / 字符串一律丢弃。
   * 像素坐标会随列表长度变化，恢复时由客户端用 clampScrollTop 夹进当前可滚范围。
   */
  lastListScrollTop?: number
}

/**
 * 正文排版偏好（M5 01）：**只决定正文面怎么排**，不碰任何数据、排序或阅读状态。
 *
 * 为什么并进 viewPreferences 而不是另开一个存储槽：它是同一族界面记忆（「上次看到哪儿」），
 * 已经有读侧唯一判定点（sanitizeViewPreferences）与独立的读写端点。再开一套只会让「恢复」
 * 多一条路径，而本仓库为「同一条不变式两处各算一遍」付过的学费已经够多。
 *
 * 取值域刻意是**离散档位**而不是区间：界面就是几个 <option>，「归一化」只需要判「在不在档位里」，
 * 不必再写一套夹边界的逻辑，界面能选的值与能存下的值也不会各说各话。
 */
export interface ReadingPreferences {
  /** 正文字号（px），取值域见 READING_FONT_SIZES */
  fontSize: number
  /** 正文栏宽（px），打到 .dsh-rss-article-column 的 max-width */
  lineWidth: number
  /** auto = 完全继承宿主主题；light/dark 只覆盖正文面那一块 */
  theme: 'auto' | 'light' | 'dark'
}

/** 字号档位（px）。界面与归一化读同一份常量。 */
export const READING_FONT_SIZES: ReadonlyArray<number> = [14, 16, 18, 20]
/** 栏宽档位（px）。760 是 M5 之前的写死值，留作默认 ⇒ 老用户升上来观感不变。
 *  1080 / 1280 是给宽窗口的：max-width 只封顶，不会把小窗口撑宽，所以宽档在小屏上无害。 */
export const READING_LINE_WIDTHS: ReadonlyArray<number> = [640, 760, 900, 1080, 1280]
const READING_THEMES: ReadonlyArray<ReadingPreferences['theme']> = ['auto', 'light', 'dark']

/** 首版默认：沿用改动前的固定排版（16px / 760px），主题跟随宿主。 */
export const DEFAULT_READING_PREFERENCES: ReadingPreferences = { fontSize: 16, lineWidth: 760, theme: 'auto' }

/** 没有任何记忆时的值。同时是存储域 global 槽的 initial（首次 set 才落盘）。 */
export const DEFAULT_VIEW_PREFERENCES: ViewPreferences = {
  navSelection: { kind: 'virtual' },
  filter: 'all',
  navVisible: true,
  reading: DEFAULT_READING_PREFERENCES,
}

const FILTERS: ReadonlyArray<ViewPreferences['filter']> = ['all', 'unread', 'starred']

/**
 * 把「存储里读到的东西」归一成一份可信的视图记忆（**读侧唯一的判定点**）。
 *
 * 为什么必须逐字段独立回落而不是整份二选一：一次坏值不该把另外两项的记忆一起抹掉 ——
 * 那会让「filter 字段写坏」表现为「选中的源也丢了」，用户完全无从理解。
 *
 * @param raw - 任何来源的值（存储域 global、端点回包）。**一律当作不可信**。
 * @param isKnownFeed - 可选的「这个源还在订吗」判据。给了它，指向已退订源的选中态才回落成虚拟视图。
 *   宿主侧给（它手上有 feeds 表）；客户端恢复时也给（用刚下发的 feeds 表）。
 *   **不给则只验形状** —— 客户端在 feeds 表到手之前空手校验会把正常记忆全吃掉。
 * @param isKnownFolder - 可选的「这个文件夹还在目录里吗」判据；语义与 isKnownFeed 相同。
 * @returns 一定是新对象：校验没过的原值绝不能被引到 state 或写回存储里。
 */
export function sanitizeViewPreferences(
  raw: unknown,
  isKnownFeed?: (feedId: string) => boolean,
  isKnownFolder?: (folder: string) => boolean,
  isKnownTag?: (tagId: string) => boolean,
): ViewPreferences {
  const source = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}

  const selectionRaw = source['navSelection']
  let navSelection: ViewPreferences['navSelection'] = DEFAULT_VIEW_PREFERENCES.navSelection
  if (typeof selectionRaw === 'object' && selectionRaw !== null && !Array.isArray(selectionRaw)) {
    const selection = selectionRaw as Record<string, unknown>
    if (selection['kind'] === 'virtual') {
      navSelection = { kind: 'virtual' }
    } else if (selection['kind'] === 'feed'
      && typeof selection['feedId'] === 'string' && selection['feedId'] !== ''
      && (isKnownFeed === undefined || isKnownFeed(selection['feedId']))) {
      navSelection = { kind: 'feed', feedId: selection['feedId'] }
    } else if (selection['kind'] === 'folder'
      && typeof selection['folder'] === 'string' && selection['folder'] !== ''
      && (isKnownFolder === undefined || isKnownFolder(selection['folder']))) {
      navSelection = { kind: 'folder', folder: selection['folder'] }
    } else if (selection['kind'] === 'tag'
      && typeof selection['tagId'] === 'string' && selection['tagId'] !== ''
      && (isKnownTag === undefined || isKnownTag(selection['tagId']))) {
      // 标签被删了就回落到虚拟视图 —— 与「已退订的源」同一条规则：面板打得开比记得住更重要。
      navSelection = { kind: 'tag', tagId: selection['tagId'] }
    }
  }

  const filterRaw = source['filter']
  const filter = FILTERS.includes(filterRaw as ViewPreferences['filter'])
    ? (filterRaw as ViewPreferences['filter'])
    : DEFAULT_VIEW_PREFERENCES.filter

  const navVisible = typeof source['navVisible'] === 'boolean'
    ? source['navVisible']
    : DEFAULT_VIEW_PREFERENCES.navVisible

  const readingRaw = source['reading']
  const readingSource = typeof readingRaw === 'object' && readingRaw !== null && !Array.isArray(readingRaw)
    ? (readingRaw as Record<string, unknown>)
    : {}
  // 三个字段各自回落 —— 与上面三项同一条规则：一次坏值只该抹掉它自己。
  // 档位之外的值（含 18.5、'18'、null）一律回落默认，不做四舍五入也不做夹取：编造一个用户没选过的字号，
  // 比回到默认更让人困惑。
  const reading: ReadingPreferences = {
    fontSize: READING_FONT_SIZES.includes(readingSource['fontSize'] as number)
      ? readingSource['fontSize'] as number
      : DEFAULT_READING_PREFERENCES.fontSize,
    lineWidth: READING_LINE_WIDTHS.includes(readingSource['lineWidth'] as number)
      ? readingSource['lineWidth'] as number
      : DEFAULT_READING_PREFERENCES.lineWidth,
    theme: READING_THEMES.includes(readingSource['theme'] as ReadingPreferences['theme'])
      ? readingSource['theme'] as ReadingPreferences['theme']
      : DEFAULT_READING_PREFERENCES.theme,
  }

  // 阅读位置（R2-01）：只接受非空字符串；认不出就当「没有」，返回对象里不出现这个键。
  // 与上面四项同一条规则 —— 一次坏值只该抹掉它自己，不许把导航/过滤/排版一起带走。
  // 「条目是否还在当前页」不在这里判：那是恢复阶段的目录判据，需要刚下发的 items（见 applyRestoredView）。
  const lastItemIdRaw = source['lastItemId']
  const lastItemId = typeof lastItemIdRaw === 'string' && lastItemIdRaw !== '' ? lastItemIdRaw : undefined

  // 列表滚动位置（R2-02）：只接受有限且 ≥ 0 的数；0 是合法值（停在顶部），
  // 负数 / NaN / Infinity / 字符串认不出就当「没有」。同样不把 undefined 写成键。
  const lastListScrollTopRaw = source['lastListScrollTop']
  const lastListScrollTop = typeof lastListScrollTopRaw === 'number' && Number.isFinite(lastListScrollTopRaw) && lastListScrollTopRaw >= 0
    ? lastListScrollTopRaw
    : undefined

  // 只搬运点名的字段：认不出的键（历史版本留下的、或被别的写入者塞进来的）一律丢掉，
  // 否则它们会被原样写回存储，攒够几版就成了没人敢删的历史包袱。
  // lastItemId / lastListScrollTop 只在真的记过时才出现 —— 「没有」不能用 undefined 占一个键，
  // 否则「从没记过」与「记了一个空值」在存储里又不可区分了（旧配置的判据就是键在不在）。
  return {
    navSelection,
    filter,
    navVisible,
    reading,
    ...(lastItemId === undefined ? {} : { lastItemId }),
    ...(lastListScrollTop === undefined ? {} : { lastListScrollTop }),
  }
}

