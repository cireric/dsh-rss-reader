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
 * 刻意不用 `{ from?: string; to?: string }`：那允许「只有一半」这种宿主已经判为坏入参的形状。
 * `Record<string, string>` 让各档位的合法形态都能被展开进任意动作载荷。
 */
export type DisplayWindowPayload = Readonly<Record<string, string>>

export interface DisplayWindowOption {
  readonly value: DisplayWindowRange
  /** 下拉里显示的名字：全部档位带「时间」后缀，三档是自然日名。 */
  readonly label: string
}

/** 下拉的四个档位与顺序：原生 select 的 options 直接映射这里，别在 JSX 里再抄一份。 */
export const DISPLAY_WINDOW_OPTIONS: readonly DisplayWindowOption[] = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: '3d', label: '近 3 天' },
  { value: '7d', label: '近 7 天' },
]

/** 档位的短名：顶栏计数与空态共用（全部档位的顶栏文案仍沿用既有的「全局」）。 */
export function displayWindowNameOf(range: DisplayWindowRange): string {
  switch (range) {
    case 'today': return '今天'
    case '3d': return '近 3 天'
    case '7d': return '近 7 天'
    default: return '全部'
  }
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
