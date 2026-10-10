/**
 * 左栏「订阅导航」（任务 3）：虚拟视图三行 + 订阅源列表 + 每源未读角标。
 *
 * 纯展示 —— 动作全部由入口的 store 通过 props 传进来（与 feeds-view.tsx 同一形状）。
 *
 * 虚拟视图三行是**顶栏那组 filter 的左栏镜像**，刻意复用同一个 `Filter` 值走 `onSelectFilter`：
 * 它是「全局过滤」这唯一一份状态的两个入口，不是两套过滤。走两条路迟早出现
 * 「顶栏显示未读、左栏显示全部」这种只能靠读源码分辨的差异。
 *
 * 行的暴露方式：每行打 `data-rss-nav-row="<kind>:<id>"`，未读角标打 `data-rss-nav-badge`
 * （隐藏计数时**整个属性消失**，而不是留一个空串 —— 「空白」和「没有」在界面上无从分辨，
 * 而规格不变量 8 要的是彻底不渲染）。
 *
 * **两个高亮标记，刻意分开**（2026-10-10 任务 6 返工，对应规格 §2.4 的「移动」与「打开」）：
 *   - `data-rss-nav-cursor`   = 键盘光标停在哪一行（shift+n/p 移动的就是它，纯的，不影响右栏）；
 *   - `data-rss-nav-selected` = 哪一行**此刻生效**（点击它不会改变右栏）。
 * 第一版只有 selected 一个标记，于是「光标」与「生效」在界面上也塌缩成一行；分开之后，读者按
 * shift+n 能看到高亮自己走、右栏纹丝不动 —— 这正是规格 §2.4 两行行为在视觉上的差别。
 * 「当前生效的是哪个视图」这条信息仍然由 selected 独立承载，没有丢。
 */
import type { ReactNode } from 'react'
import { VIRTUAL_VIEWS, type Filter } from './store.js'
import type { FeedView } from '../shared.js'

/**
 * 左栏宽度（px）。
 *
 * 由 index.tsx 的横向 flex 布局与本组件的固定宽度**共用同一个常量**：若两处各写一个数，
 * 折叠时「右栏要撑满」与「左栏占多少」就会各说各话，表现为一条 1px 的缝或右栏溢出。
 */
export const LEFT_NAV_WIDTH = 240

export function FeedNav({ feeds, perFeedUnread, filter, navSelection, navCursor, showUnread, onSelectFilter, onSelectFeed }: {
  feeds: FeedView[]
  perFeedUnread: Record<string, number>
  filter: Filter
  navSelection: { kind: 'virtual' } | { kind: 'feed'; feedId: string }
  /** 键盘光标（左栏高亮所在行）。与 navSelection 是两件事，见 store.ts 的 NavCursor。 */
  navCursor: { kind: 'filter'; filter: Filter } | { kind: 'feed'; feedId: string }
  showUnread: boolean
  onSelectFilter: (filter: Filter) => void
  onSelectFeed: (feedId: string) => void
}): ReactNode {
  // 生效态：选了具体源时，虚拟视图三行整组都不生效（两轴相乘，见 store.ts 的 NavSelection 注释）
  const selectedFeedId = navSelection.kind === 'feed' ? navSelection.feedId : undefined
  // 光标态与生效态各算各的：光标可以停在源那一行而生效的仍是虚拟视图（还没按 shift+o）
  const cursorFeedId = navCursor.kind === 'feed' ? navCursor.feedId : undefined
  const cursorFilter = navCursor.kind === 'filter' ? navCursor.filter : undefined

  return (
    <div {...{ 'data-rss-nav': '' }} style={{
      // 固定宽度而非 flex 比例：右栏是条目流，它的可用宽度不该随源名长短漂移
      width: LEFT_NAV_WIDTH, flex: '0 0 auto', minWidth: 0,
      display: 'flex', flexDirection: 'column',
      borderRight: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
      overflowY: 'auto', fontSize: 13,
    }}>
      {VIRTUAL_VIEWS.map((view) => {
        const selected = selectedFeedId === undefined && filter === view.key
        const cursor = cursorFilter === view.key
        return (
        <div key={view.key} role="button" tabIndex={0}
          {...{ 'data-rss-nav-row': 'filter:' + view.key }}
          {...(selected ? { 'data-rss-nav-selected': '' } : {})}
          {...(cursor ? { 'data-rss-nav-cursor': '' } : {})}
          onClick={() => onSelectFilter(view.key)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectFilter(view.key) }
          }}
          style={{ ...ROW_STYLE, ...(selected ? SELECTED_STYLE : {}), ...(cursor ? CURSOR_STYLE : {}) }}>
          <span style={LABEL_STYLE}>{view.label}</span>
        </div>
        )
      })}

      <div style={{ height: 1, background: 'color-mix(in srgb, currentColor 12%, transparent)', margin: '6px 0' }} />

      {feeds.map((feed) => {
        // 键域 = feeds 表：0 未读的源也有键（宿主契约，src/shared.ts:58-65），故无条件读取
        const unread = perFeedUnread[feed.id]
        return (
          <div key={feed.id} role="button" tabIndex={0}
            {...{ 'data-rss-nav-row': 'feed:' + feed.id }}
            // 隐藏计数时不渲染角标：与顶栏、侧栏徽标三者同消（规格不变量 8）
            {...(showUnread ? { 'data-rss-nav-badge': String(unread) } : {})}
            {...(selectedFeedId === feed.id ? { 'data-rss-nav-selected': '' } : {})}
            {...(cursorFeedId === feed.id ? { 'data-rss-nav-cursor': '' } : {})}
            onClick={() => onSelectFeed(feed.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectFeed(feed.id) }
            }}
            style={{
              ...ROW_STYLE,
              ...(selectedFeedId === feed.id ? SELECTED_STYLE : {}),
              ...(cursorFeedId === feed.id ? CURSOR_STYLE : {}),
            }}>
            <span style={LABEL_STYLE}>{feed.title ?? feed.id}</span>
            {showUnread && (
              <span style={{ flex: '0 0 auto', fontSize: 11, opacity: unread > 0 ? 0.75 : 0.45 }}>
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

const ROW_STYLE = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '7px 14px', cursor: 'pointer',
} as const

const SELECTED_STYLE = {
  background: 'color-mix(in srgb, currentColor 9%, transparent)',
  fontWeight: 600,
} as const

/**
 * 光标行：**必须与「生效」看得见地区分**，否则读者按 shift+n 时看到的是「高亮在动但右栏没变」，
 * 无从判断是「移动生效了」还是「按键坏了」。
 * 用左侧竖条而不是背景：背景已经是「生效」的语言（SELECTED_STYLE），两种状态叠加时不能互相盖掉。
 */
const CURSOR_STYLE = {
  boxShadow: 'inset 3px 0 0 currentColor',
} as const

const LABEL_STYLE = {
  flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
} as const
