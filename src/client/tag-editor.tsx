/**
 * 列表与正文共用的文章标签编辑器（M2 06）。
 *
 * 纯展示：当前文章的 tagIds 与标签目录都由 store 传入；点击芯片只切关联，**不触 markRead**。
 * 根节点拦下 Space/Enter 的 document 冒泡 —— 这两键在阅读视图里被全局快捷键接管，
 * 但标签芯片是编辑控件，不能因为焦点在按钮上就去翻页/展开文章。
 */
import type { ReactNode } from 'react'
import type { TagView } from '../shared.js'

export function TagEditor({ tags, activeIds, onToggle }: {
  tags: TagView[]
  activeIds: readonly string[]
  onToggle: (tagId: string) => void
}): ReactNode {
  return (
    <div data-rss-tag-editor="" aria-label="文章标签"
      onKeyDown={(event) => {
        if (event.key === ' ' || event.key === 'Enter') event.stopPropagation()
      }}
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5,
        padding: '5px clamp(12px, 2vw, 28px)', borderBottom: '1px solid var(--rss-line)', fontSize: 12 }}>
      <span className="dsh-rss-meta">标签：</span>
      {tags.length === 0 && <span className="dsh-rss-meta">还没有标签，可在订阅管理里创建</span>}
      {tags.map((tag) => {
        const active = activeIds.includes(tag.id)
        return (
          <button key={tag.id} type="button" data-rss-tag-toggle={tag.id} aria-pressed={active}
            className="dsh-rss-btn dsh-rss-btn--ghost"
            title={active ? '移除标签 ' + tag.name : '添加标签 ' + tag.name}
            onClick={() => onToggle(tag.id)}
            style={{ fontSize: 12, fontWeight: active ? 600 : 400 }}>
            {active ? '✓ ' : ''}{tag.name}
          </button>
        )
      })}
    </div>
  )
}
