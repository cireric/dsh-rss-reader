/**
 * 顶栏时间范围档位的**客户端唯一归属**（R1-03）。
 *
 * 这个模块只做两件客户端的事：
 *   1. 把档位 + 现在换算成 wire 载荷（`from` / `to` + 每个档位都有的 `todayFrom`）；
 *   2. 把档位换成界面文案（下拉选项、顶栏未读计数、空态里的档位名）。
 *
 * 边界算术**不在这里**：它归 `src/display-window.ts`（宿主与浏览器半共用的唯一裁决者）。
 * 本模块不读 store、不碰 DOM —— 载荷由调用方把当前档位与 `deps.now` 传进来。
 *
 * **为什么载荷构造器只能有一个**（spec 决策 15 / 28）：列表取数（overview / refresh）、续页、
 * 五个带账写端点必须带同一份 `from` / `to`；任何一处手写这两个字段，都会在跨零点或后续加
 * `todayFrom` 时漂成第二套边界。账目镜像拿到的也是这个函数，它只负责在发请求前把返回值并进
 * 动作自己的载荷（见 src/client/account-mirror.ts）。
 */
import { displayWindowBoundsOf, startOfLocalDay, type DisplayWindowRange } from '../display-window.js'
import type { UnreadSplit } from '../unread.js'

/**
 * 窗口载荷的 wire 形状：`from` / `to` 只在窗口档位出现（全部档位不带窗口，旧请求形状不变），
 * 而 `todayFrom` **每个档位都带** —— 「全部」档位也要靠它拿未读三联拆分。
 *
 * 刻意写成显式的三个字段而不是 `Record<string, string>`：后者把「只有一半的窗口」
 * （只带 `from` 或只带 `to`）也当成合法载荷，而宿主已经把那种形状判成坏入参 ——
 * 类型不该比它守的契约更宽。
 */
export type DisplayWindowPayload = Readonly<{ todayFrom: string; from?: string; to?: string }>

export interface DisplayWindowOption {
  readonly value: DisplayWindowRange
  /** 下拉里显示的名字：全部档位带「时间」后缀，三档是自然日名。 */
  readonly label: string
  /** 顶栏计数、空态与下拉之外的界面文案用的短名（「全部」在顶栏仍写作既有「全局」）。 */
  readonly shortLabel: string
}

/**
 * 档位表的**唯一一份**：`value` 顺序 = 下拉顺序。名字（长 / 短）与档位在这里一起定义，
 * 不在 `displayWindowNameOf` 里再维护一条 switch —— 两份映射迟早会在加档位时只说一半。
 *
 * 用 `Record<DisplayWindowRange, …>` 而不是数组：少写一个档位是编译错误，而不是运行时空白项。
 * 对象的字符串键按插入序枚举，所以 `Object.values` 出来的顺序就是下拉顺序。
 */
const DISPLAY_WINDOW_TABLE: Record<DisplayWindowRange, DisplayWindowOption> = {
  all: { value: 'all', label: '全部时间', shortLabel: '全部' },
  today: { value: 'today', label: '今天', shortLabel: '今天' },
  '3d': { value: '3d', label: '近 3 天', shortLabel: '近 3 天' },
  '7d': { value: '7d', label: '近 7 天', shortLabel: '近 7 天' },
}

/** 下拉的四个档位与顺序：原生 select 的 options 直接映射这里，别在 JSX 里再抄一份。 */
export const DISPLAY_WINDOW_OPTIONS: readonly DisplayWindowOption[] = Object.values(DISPLAY_WINDOW_TABLE)

/** 档位的短名：顶栏计数与空态共用（全部档位的顶栏文案仍沿用既有的「全局」）。 */
export function displayWindowNameOf(range: DisplayWindowRange): string {
  return DISPLAY_WINDOW_TABLE[range].shortLabel
}

/**
 * **唯一的窗口载荷构造器**（spec 决策 15 / 28；R1 04 加 `todayFrom`）。
 *
 * 「全部」档位不带 `from` / `to`（宿主走全量），但**仍带 `todayFrom`**：顶栏「全部」的三联
 * 拆分只有给了这个阈值宿主才会算。三个日期分量都从同一处 `now` 派生，边界算术全部委托给
 * `displayWindow.ts`，这里不做任何日期计算。
 */
export function displayWindowPayloadOf(range: DisplayWindowRange, now: Date): DisplayWindowPayload {
  const todayFrom = startOfLocalDay(now).toISOString()
  const bounds = displayWindowBoundsOf(range, now)
  return bounds === undefined
    ? { todayFrom }
    : { from: bounds.from, to: bounds.to, todayFrom }
}

/**
 * 发请求那一刻的档位与它对应的 wire 字段，**成对取出**。
 *
 * 为什么不能只拿 payload：账目回包落地时要判断「这份账属于哪个档位」（R1 评审 P1）。
 * 若调用方先取 payload、等回包到了再读 `state.displayWindow`，中途切过档就会把旧档的账
 * 挂到新档名下；反过来先记档位、发请求时再算 payload 也会漏掉「两端之间切过一次」。
 * 一次取出、原样传下去，取数与标记才是同一个时刻。
 */
export interface DisplayWindowRequest {
  readonly window: DisplayWindowRange
  readonly payload: DisplayWindowPayload
}

export function displayWindowRequestOf(range: DisplayWindowRange, now: Date): DisplayWindowRequest {
  return { window: range, payload: displayWindowPayloadOf(range, now) }
}

/** 顶栏计数前缀：全部档位保持既有的「全局」，其余档位用档位名（今天 / 近 3 天 / 近 7 天）。 */
export function displayWindowCountLabelOf(range: DisplayWindowRange): string {
  return range === 'all' ? '全局' : displayWindowNameOf(range)
}

/**
 * 顶栏未读计数文案（spec 决策 25，R1 04）。
 *
 * 数字**全部来自宿主回包**：`account.unread` 与 `account.unreadSplit`，客户端不数 items、
 * 不做增量。两种档位两套文案：
 *   - 全部：`共 X 条未读 · 今天 N · 更早 M · 无日期 K`；N = 0 省「今天 0」，K = 0 省「无日期 0」
 *     （M 没有省零规则 —— 文案基线只规定这两项）。split 缺席（旧宿主）回落 `全局 X 条未读`。
 *   - 窗口档位：`<档位名> X 条未读`；`K > 0` 时追加「另有 K 条未读没有发布日期，未计入」。
 *     K 与窗口无关（描述全部未读），所以带窗请求回的同一份 split 直接可用。
 */
export function unreadCountTextOf(
  range: DisplayWindowRange,
  account: { readonly unread: number; readonly unreadSplit?: UnreadSplit },
): string {
  const split = account.unreadSplit
  if (range !== 'all') {
    const base = displayWindowCountLabelOf(range) + ' ' + account.unread + ' 条未读'
    return split !== undefined && split.noDate > 0
      ? base + ' · 另有 ' + split.noDate + ' 条未读没有发布日期，未计入'
      : base
  }
  if (split === undefined) return '全局 ' + account.unread + ' 条未读'
  const today = split.today === 0 ? '' : ' · 今天 ' + split.today
  const noDate = split.noDate === 0 ? '' : ' · 无日期 ' + split.noDate
  return '共 ' + account.unread + ' 条未读' + today + ' · 更早 ' + split.earlier + noDate
}
