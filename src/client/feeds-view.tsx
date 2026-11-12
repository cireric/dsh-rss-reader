/**
 * 订阅管理面板（2026-10-07 从 index.tsx 拆出；M2 03 加文件夹管理）：
 * OPML 导入导出、加源、退订，以及文件夹的创建/改名/删除与订阅移动。
 * 纯展示 —— 动作全部由入口的 store 通过 props 传进来。
 */
import { useRef, useState, type ReactNode } from 'react'
import type { FeedView, FolderView, OpmlExportResult, OpmlImportResult, TagView } from '../shared.js'

/** 文件夹管理里一次改名草稿。 */
interface RenameDraft {
  name: string
  draft: string
}
interface TagRenameDraft {
  id: string
  draft: string
}

/**
 * 订阅管理视图：导入 OPML（逐源校验、坏源逐条列出）、导出、加源、退订、文件夹管理。
 *
 * 设计取舍：
 *  - **坏源报告必须逐条可读**（§3.1 要求「坏源单独标注」），而不是只报「3 个失败」。
 *  - **删除确认用行内确认条，而不是 window.confirm**：取消后要把焦点还给触发删除的按钮；
 *    原生 confirm 的焦点行为不可控，也无法在真实 DOM 测试里钉住（M2 03 的验收项）。
 *  - 输入框里的 Enter/Esc 自己处理并 stopPropagation：全局快捷键挂在 document 上，不能截走输入。
 */
export function FeedsView({
  feeds, folders, busy, report, notice,
  onImport, onExport, onAdd, onRemove,
  onCreateFolder, onRenameFolder, onDeleteFolder, onMoveFeed, tags, onCreateTag, onRenameTag, onDeleteTag, onBack,
}: {
  feeds: FeedView[]
  folders: FolderView[]
  busy: boolean
  report: OpmlImportResult | undefined
  notice: string | undefined
  onImport: (text: string) => void
  onExport: () => void
  onAdd: (url: string) => void
  onRemove: (url: string) => void
  onCreateFolder: (name: string) => void
  onRenameFolder: (from: string, to: string) => void
  onDeleteFolder: (name: string) => void
  onMoveFeed: (feedId: string, folder: string | undefined) => void
  tags: TagView[]
  onCreateTag: (name: string) => void
  onRenameTag: (id: string, name: string) => void
  onDeleteTag: (id: string) => void
  onBack: () => void
}): ReactNode {
  const [draft, setDraft] = useState('')
  const [fileError, setFileError] = useState<string | undefined>(undefined)
  const [folderDraft, setFolderDraft] = useState('')
  const [renaming, setRenaming] = useState<RenameDraft | undefined>(undefined)
  const [confirmingDelete, setConfirmingDelete] = useState<string | undefined>(undefined)
  const [tagDraft, setTagDraft] = useState('')
  const [tagRenaming, setTagRenaming] = useState<TagRenameDraft | undefined>(undefined)
  const [tagConfirmingDelete, setTagConfirmingDelete] = useState<string | undefined>(undefined)
  const renameButtons = useRef(new Map<string, HTMLButtonElement | null>())
  const deleteButtons = useRef(new Map<string, HTMLButtonElement | null>())
  const tagRenameButtons = useRef(new Map<string, HTMLButtonElement | null>())

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

  const commitRename = (): void => {
    const target = renaming
    if (target === undefined) return
    const name = target.draft.trim()
    if (name === '') return
    setRenaming(undefined)
    onRenameFolder(target.name, name)
    // 重命名按钮始终在 DOM 里（草稿输入在它下方），所以这里能同步把焦点还给它；
    // 若等 React 重渲染再 focus，jsdom/真机上都会有一帧读到旧节点。
    renameButtons.current.get(target.name)?.focus()
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 22px 24px', fontSize: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" onClick={onBack}>← 返回列表（Esc）</button>
        <strong style={{ fontSize: 15 }}>订阅管理</strong>
        <span style={{ opacity: 0.6, fontSize: 12 }}>{feeds.length} 个源 · {folders.length} 个文件夹</span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <label className="dsh-rss-btn" style={{ cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.55 : 1 }}>
          导入 OPML…
          <input type="file" accept=".opml,.xml,text/xml,text/x-opml" disabled={busy}
            style={{ display: 'none' }} onChange={pickFile} />
        </label>
        <button type="button" className="dsh-rss-btn" disabled={busy || feeds.length === 0} onClick={onExport}>导出 OPML</button>
        <span style={{ flex: 1 }} />
        <input value={draft} placeholder="粘贴 feed 地址或站点首页（会自动发现 feed）后回车" disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // 本插件的全局快捷键挂在 document 上，输入框里的键不该被它截走；
            // 这里的 stopPropagation 是**双保险**（守卫已按 target 判断，但回车提交不该外泄）
            if (event.key === 'Enter' && draft.trim() !== '') {
              event.stopPropagation()
              onAdd(draft.trim())
              setDraft('')
            }
            if (event.key === 'Escape') {
              event.stopPropagation()
              setDraft('')
            }
          }}
          style={{ flex: '0 1 320px', fontSize: 13, padding: '4px 8px' }} />
      </div>

      <section style={{ marginBottom: 16 }} aria-label="文件夹管理">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <strong style={{ fontSize: 13 }}>文件夹</strong>
          <span style={{ opacity: 0.6, fontSize: 12 }}>空文件夹也会保留</span>
        </div>
        <form data-rss-folder-create="" style={{ display: 'flex', gap: 6, marginBottom: 8 }}
          onSubmit={(event) => {
            event.preventDefault()
            const name = folderDraft.trim()
            if (name === '') return
            onCreateFolder(name)
            setFolderDraft('')
          }}>
          <input data-rss-folder-new="" value={folderDraft} disabled={busy}
            placeholder="新建文件夹名称（1–80 个字符）"
            onChange={(event) => setFolderDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.stopPropagation(); setFolderDraft('') }
            }}
            style={{ flex: '0 1 260px', fontSize: 13, padding: '4px 8px' }} />
          <button type="submit" className="dsh-rss-btn" disabled={busy || folderDraft.trim() === ''}>新建文件夹</button>
        </form>

        {folders.length === 0 && <div style={{ padding: '4px 0', opacity: 0.7, fontSize: 12 }}>还没有文件夹。</div>}
        {folders.map((folder) => (
          <div key={folder.name} data-rss-folder-manage={folder.name} style={{ padding: '6px 0', borderTop: '1px solid color-mix(in srgb, currentColor 8%, transparent)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block' }}>{folder.name}</span>
                <span style={{ display: 'block', fontSize: 11, opacity: 0.6 }}>{folder.feedIds.length} 个订阅</span>
              </span>
              <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
                data-rss-folder-rename={folder.name}
                ref={(node) => { renameButtons.current.set(folder.name, node) }}
                disabled={busy}
                onClick={() => setRenaming({ name: folder.name, draft: folder.name })}>重命名</button>
              <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
                data-rss-folder-delete={folder.name}
                ref={(node) => { deleteButtons.current.set(folder.name, node) }}
                disabled={busy}
                onClick={() => setConfirmingDelete(folder.name)}>删除</button>
            </div>

            {renaming?.name === folder.name && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <input data-rss-folder-rename-input={folder.name} value={renaming.draft} autoFocus
                  onChange={(event) => setRenaming({ name: folder.name, draft: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); commitRename() }
                    if (event.key === 'Escape') {
                      event.preventDefault(); event.stopPropagation(); setRenaming(undefined)
                      renameButtons.current.get(folder.name)?.focus()
                    }
                  }}
                  style={{ flex: '0 1 240px', fontSize: 13, padding: '4px 8px' }} />
                <button type="button" className="dsh-rss-btn" data-rss-folder-rename-save={folder.name}
                  disabled={busy || renaming.draft.trim() === ''} onClick={commitRename}>保存</button>
                <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-folder-rename-cancel={folder.name}
                  onClick={() => {
                    setRenaming(undefined)
                    renameButtons.current.get(folder.name)?.focus()
                  }}>取消</button>
              </div>
            )}

            {confirmingDelete === folder.name && (
              <div role="alertdialog" aria-label={'删除文件夹 ' + folder.name} data-rss-folder-confirm={folder.name}
                onKeyDown={(event) => {
                  // 确认条里的 Esc = 取消，并把焦点还给触发删除的按钮（与输入框的 Esc 同一约定）。
                  if (event.key === 'Escape') {
                    event.preventDefault(); event.stopPropagation(); setConfirmingDelete(undefined)
                    deleteButtons.current.get(folder.name)?.focus()
                  }
                }}
                style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 6, padding: '6px 8px', background: 'color-mix(in srgb, currentColor 6%, transparent)', borderRadius: 6 }}>
                <span style={{ flex: '1 1 260px', fontSize: 12 }}>
                  删除「{folder.name}」？成员会变为未分类；不会退订，也不会删除文章。
                </span>
                <button type="button" className="dsh-rss-btn" data-rss-folder-confirm-yes={folder.name}
                  autoFocus disabled={busy}
                  onClick={() => { setConfirmingDelete(undefined); onDeleteFolder(folder.name) }}>确认删除</button>
                <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-folder-confirm-no={folder.name}
                  onClick={() => {
                    setConfirmingDelete(undefined)
                    deleteButtons.current.get(folder.name)?.focus()
                  }}>取消</button>
              </div>
            )}
          </div>
        ))}
      </section>

      <section style={{ marginBottom: 16 }} aria-label="标签管理">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <strong style={{ fontSize: 13 }}>标签</strong>
          <span style={{ opacity: 0.6, fontSize: 12 }}>只分类；删除标签不会删除文章</span>
        </div>
        <form data-rss-tag-create="" style={{ display: 'flex', gap: 6, marginBottom: 8 }}
          onSubmit={(event) => {
            event.preventDefault()
            const name = tagDraft.trim()
            if (name === '') return
            onCreateTag(name)
            setTagDraft('')
          }}>
          <input data-rss-tag-new="" value={tagDraft} disabled={busy}
            placeholder="新建标签名称（1–80 个字符）"
            onChange={(event) => setTagDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.stopPropagation(); setTagDraft('') }
            }}
            style={{ flex: '0 1 260px', fontSize: 13, padding: '4px 8px' }} />
          <button type="submit" className="dsh-rss-btn" disabled={busy || tagDraft.trim() === ''}>新建标签</button>
        </form>

        {tags.length === 0 && <div style={{ padding: '4px 0', opacity: 0.7, fontSize: 12 }}>还没有标签。</div>}
        {tags.map((tag) => (
          <div key={tag.id} data-rss-tag-manage={tag.id} style={{ padding: '6px 0', borderTop: '1px solid color-mix(in srgb, currentColor 8%, transparent)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block' }}># {tag.name}</span>
                <span style={{ display: 'block', fontSize: 11, opacity: 0.6 }}>{tag.itemCount ?? 0} 篇文章</span>
              </span>
              <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
                data-rss-tag-rename={tag.id}
                ref={(node) => { tagRenameButtons.current.set(tag.id, node) }}
                disabled={busy}
                onClick={() => setTagRenaming({ id: tag.id, draft: tag.name })}>重命名</button>
              <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
                data-rss-tag-delete={tag.id} disabled={busy}
                onClick={() => setTagConfirmingDelete(tag.id)}>删除</button>
            </div>
            {tagRenaming?.id === tag.id && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <input data-rss-tag-rename-input={tag.id} value={tagRenaming.draft} autoFocus
                  onChange={(event) => setTagRenaming({ id: tag.id, draft: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault(); event.stopPropagation()
                      const name = tagRenaming.draft.trim()
                      if (name !== '') { onRenameTag(tag.id, name); setTagRenaming(undefined); tagRenameButtons.current.get(tag.id)?.focus() }
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault(); event.stopPropagation(); setTagRenaming(undefined)
                      tagRenameButtons.current.get(tag.id)?.focus()
                    }
                  }}
                  style={{ flex: '0 1 240px', fontSize: 13, padding: '4px 8px' }} />
                <button type="button" className="dsh-rss-btn" data-rss-tag-rename-save={tag.id}
                  disabled={busy || tagRenaming.draft.trim() === ''}
                  onClick={() => {
                    const name = tagRenaming.draft.trim()
                    if (name === '') return
                    onRenameTag(tag.id, name); setTagRenaming(undefined); tagRenameButtons.current.get(tag.id)?.focus()
                  }}>保存</button>
                <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-tag-rename-cancel={tag.id}
                  onClick={() => { setTagRenaming(undefined); tagRenameButtons.current.get(tag.id)?.focus() }}>取消</button>
              </div>
            )}
            {tagConfirmingDelete === tag.id && (
              <div role="alertdialog" aria-label={'删除标签 ' + tag.name} data-rss-tag-confirm={tag.id}
                style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 6, padding: '6px 8px', background: 'color-mix(in srgb, currentColor 6%, transparent)', borderRadius: 6 }}>
                <span style={{ flex: '1 1 260px', fontSize: 12 }}>删除标签「{tag.name}」？只清除文章关联，不删除文章。</span>
                <button type="button" className="dsh-rss-btn" data-rss-tag-confirm-yes={tag.id}
                  disabled={busy} onClick={() => { setTagConfirmingDelete(undefined); onDeleteTag(tag.id) }}>确认删除</button>
                <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-tag-confirm-no={tag.id}
                  onClick={() => setTagConfirmingDelete(undefined)}>取消</button>
              </div>
            )}
          </div>
        ))}
      </section>

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
                {feed.id}{feed.folder !== undefined ? ' · 文件夹：' + feed.folder : ' · 未分类'}
                {feed.lastFailure !== undefined ? ' · 上次失败：' + feed.lastFailure : ''}
              </span>
            </span>
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
              移动到
              <select data-rss-feed-folder={feed.id} value={feed.folder ?? ''} disabled={busy}
                onChange={(event) => onMoveFeed(feed.id, event.target.value === '' ? undefined : event.target.value)}>
                <option value="">未分类</option>
                {folders.map((folder) => <option key={folder.name} value={folder.name}>{folder.name}</option>)}
              </select>
            </label>
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
