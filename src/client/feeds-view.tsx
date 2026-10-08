/**
 * 订阅管理面板（2026-10-07 从 index.tsx 拆出）：OPML 导入导出、加源、退订。
 * 纯展示 —— 动作全部由入口的 store 通过 props 传进来。
 */
import { useState, type ReactNode } from 'react'
import type { FeedView, OpmlExportResult, OpmlImportResult } from '../shared.js'

/**
 * 订阅管理视图：导入 OPML（逐源校验、坏源逐条列出）、导出、加源、退订。
 *
 * 设计取舍：**坏源报告必须逐条可读**（§3.1 要求「坏源单独标注」），而不是只报「3 个失败」——
 * 用户需要知道具体是哪个源、为什么失败，才能决定改 URL 还是放弃。
 */
export function FeedsView({ feeds, busy, report, notice, onImport, onExport, onAdd, onRemove, onBack }: {
  feeds: FeedView[]
  busy: boolean
  report: OpmlImportResult | undefined
  notice: string | undefined
  onImport: (text: string) => void
  onExport: () => void
  onAdd: (url: string) => void
  onRemove: (url: string) => void
  onBack: () => void
}): ReactNode {
  const [draft, setDraft] = useState('')
  const [fileError, setFileError] = useState<string | undefined>(undefined)

  const pickFile = (event: { target: { files?: ArrayLike<File> | null; value?: string } }): void => {
    const file = event.target.files?.[0]
    if (file === undefined || file === null) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : ''
      if (text.trim() === '') { setFileError('文件是空的'); return }
      setFileError(undefined)
      onImport(text)
    }
    reader.onerror = () => { setFileError('读取文件失败：' + String(reader.error ?? '未知原因')) }
    reader.readAsText(file)
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 22px 24px', fontSize: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" onClick={onBack}>← 返回列表（Esc）</button>
        <strong style={{ fontSize: 15 }}>订阅管理</strong>
        <span style={{ opacity: 0.6, fontSize: 12 }}>{feeds.length} 个源</span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <label className="dsh-rss-btn" style={{ cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.55 : 1 }}>
          导入 OPML…
          <input type="file" accept=".opml,.xml,text/xml,text/x-opml" disabled={busy}
            style={{ display: 'none' }} onChange={pickFile} />
        </label>
        <button type="button" className="dsh-rss-btn" disabled={busy || feeds.length === 0} onClick={onExport}>导出 OPML</button>
        <span style={{ flex: 1 }} />
        <input value={draft} placeholder="或直接粘贴 feed 地址后回车" disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // 本插件的全局快捷键挂在 document 上，输入框里的键不该被它截走；
            // 这里的 stopPropagation 是**双保险**（守卫已按 target 判断，但回车提交不该外泄）
            if (event.key === 'Enter' && draft.trim() !== '') {
              event.stopPropagation()
              onAdd(draft.trim())
              setDraft('')
            }
          }}
          style={{ flex: '0 1 320px', fontSize: 13, padding: '4px 8px' }} />
      </div>

      {busy && <div style={{ opacity: 0.75, marginBottom: 8 }}>正在逐源抓取校验…（并发受限，源多时需要一会儿）</div>}
      {fileError !== undefined && <div style={{ color: '#c0392b', marginBottom: 8 }}>{fileError}</div>}
      {notice !== undefined && <div style={{ opacity: 0.85, marginBottom: 8 }}>{notice}</div>}

      {report !== undefined && (
        <div style={{ marginBottom: 14, padding: '10px 12px', background: 'color-mix(in srgb, currentColor 6%, transparent)', borderRadius: 6 }}>
          <div style={{ marginBottom: 6 }}>
            导入结果：新增 <strong>{report.added}</strong> 个，已存在 {report.existed} 个，
            校验失败 <strong style={{ color: report.failed.length > 0 ? '#c0392b' : 'inherit' }}>{report.failed.length}</strong> 个，
            文件内跳过 {report.skipped.length} 项
          </div>
          {report.failed.length > 0 && (
            <div style={{ fontSize: 12, color: '#c0392b' }}>
              <div style={{ marginBottom: 2 }}>以下源校验失败（未加入订阅，其余不受影响）：</div>
              {report.failed.map((row) => (
                <div key={row.url} style={{ wordBreak: 'break-all' }}>· {row.url} —— {row.reason}</div>
              ))}
            </div>
          )}
          {report.skipped.length > 0 && (
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
              <div style={{ marginBottom: 2 }}>文件里被跳过的条目：</div>
              {report.skipped.map((row, index) => (
                <div key={index}>· {row.title ?? '(无标题)'} —— {row.reason}</div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ borderTop: '1px solid color-mix(in srgb, currentColor 12%, transparent)' }}>
        {feeds.length === 0 && <div style={{ padding: '12px 0', opacity: 0.7 }}>还没有订阅源。可以用上面的「导入 OPML…」。</div>}
        {feeds.map((feed) => (
          <div key={feed.id} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
            borderBottom: '1px solid color-mix(in srgb, currentColor 8%, transparent)',
          }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block' }}>{feed.title ?? feed.id}</span>
              <span style={{ display: 'block', fontSize: 11, opacity: 0.6, wordBreak: 'break-all' }}>
                {feed.id}{feed.lastFailure !== undefined ? ' · 上次失败：' + feed.lastFailure : ''}
              </span>
            </span>
            <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
              title="退订并删除该源的全部条目（不可撤销）"
              onClick={() => {
                if (window.confirm('退订该源并删除它的全部条目？\n\n' + feed.id + '\n\n此操作不可撤销。')) onRemove(feed.id)
              }}>退订</button>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 阅读器内的正文视图（D 方案）：段落由宿主抽取后回传，这里只做排版。 */
/**
 * 段落判定：含换行的段落来自 <pre>（宿主抽取时保留内部换行）⇒ 按代码块渲染。
 * 这是为了解决「代码全变样」——等宽字体 + 保留缩进 + 横向可滚动，而不是当普通文字折行。
 */
