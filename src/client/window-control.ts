/**
 * 顶栏时间范围档位的**客户端唯一归属**（R1-03）。
 *
 * 这个模块只做两件客户端的事：
 *   1. 把档位 + 现在换算成 wire 载荷（`from` / `to`，全部档位 = 空对象）；
 *   2. 把档位换成界面文案（下拉选项、顶栏计数前缀、空态里的档位名）。
 *
 * 边界算术**不在这里**：它归 `src/display-window.ts`（宿主与浏览器半共用的唯一裁决者）。
 * 本模块不读 store、不碰 DOM —— 载荷由调用方把当前档位与 `deps.now` 传进来。
 *
 * **为什么载荷构造器只能有一个**（spec 决策 15 / 28）：列表取数（overview / refresh）、续页、
 * 五个带账写端点必须带同一份 `from` / `to`；任何一处手写这两个字段，都会在跨零点或后续加
 * `todayFrom` 时漂成第二套边界。账目镜像拿到的也是这个函数，它只负责在发请求前把返回值并进
 * 动作自己的载荷（见 src/client/account-mirror.ts）。
 */
import { displayWindowBoundsOf, type DisplayWindowRange } from '../display-window.js'

/**
 * 窗口载荷的 wire 形状：全部档位是空对象（旧请求形状逐字不变），其余档位是半开区间。
 *
 * 刻意不用 `{ from?: string; to?: string }`：那允许「只有一半」这种宿主已经判为坏入参的形状。
 * `Record<string, string>` 让 empty 与成对两种合法形态都能被展开进任意动作载荷。
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
 * **唯一的窗口载荷构造器**（spec 决策 15 / 28）。
 *
 * 「全部」回空对象：调用方一律展开它，于是旧请求不带 `from` / `to`，宿主走全量。
 * 其余档位把 `now` 所在**本地自然日**换算成 ISO 半开区间；边界算术全部委托给
 * `displayWindowBoundsOf`，这里不做任何日期计算。
 */
export function displayWindowPayloadOf(range: DisplayWindowRange, now: Date): DisplayWindowPayload {
  const bounds = displayWindowBoundsOf(range, now)
  return bounds === undefined ? {} : { from: bounds.from, to: bounds.to }
}

/** 顶栏计数前缀：全部档位保持既有的「全局」，其余档位用档位名（今天 / 近 3 天 / 近 7 天）。 */
export function displayWindowCountLabelOf(range: DisplayWindowRange): string {
  return range === 'all' ? '全局' : displayWindowNameOf(range)
}
