/**
 * 订阅管理面板（2026-10-07 从 index.tsx 拆出；M2 03 加文件夹管理）：
 * OPML 导入导出、加源、退订，以及文件夹的创建/改名/删除与订阅移动。
 * 纯展示 —— 动作全部由入口的 store 通过 props 传进来。
 */
import { useRef, useState, type ReactNode } from 'react'
import { feedHealthOf, type DiscoveryResult, type FeedView, type FolderView, type OpmlExportResult, type OpmlImportResult, type TagView } from '../shared.js'
import { relativeTime } from './store.js'

/** 文件夹管理里一次改名草稿。 */
interface RenameDraft {
  name: string
  draft: string
}
interface TagRenameDraft {
  id: string
  draft: string
}

/** 健康状态的三个人话标签（判据在 shared.ts 的 feedHealthOf，这里只负责措辞）。 */
function feedHealthLabel(feed: FeedView): string {
  const health = feedHealthOf(feed)
  return health === 'ok' ? '正常' : health === 'warn' ? '有告警' : '从未成功'
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
  feeds, folders, busy, report, notice, discovery,
  onImport, onExport, onAdd, onRemove, onDiscover, onClearDiscovery,
  onCreateFolder, onRenameFolder, onDeleteFolder, onMoveFeed, onMoveOrder,
  tags, onCreateTag, onRenameTag, onDeleteTag, onBack,
}: {
  feeds: FeedView[]
  folders: FolderView[]
  busy: boolean
  report: OpmlImportResult | undefined
  notice: string | undefined
  /** 发现结果（undefined = 没在挑选）。只展示候选，落库要等用户点「添加」走 onAdd。 */
  discovery: DiscoveryResult | undefined
  onImport: (text: string) => void
  onExport: () => void
  onAdd: (url: string) => void
  /** 只发现、不订阅：候选交给用户挑（宿主侧零写入） */
  onDiscover: (url: string) => void
  onClearDiscovery: () => void
  onRemove: (url: string) => void
  onCreateFolder: (name: string) => void
  onRenameFolder: (from: string, to: string) => void
  onDeleteFolder: (name: string) => void
  onMoveFeed: (feedId: string, folder: string | undefined) => void
  /** 上 / 下挪一格（R3-03）。只发意图，行序等宿主回包后的 reload。 */
  onMoveOrder: (feedId: string, direction: -1 | 1) => void
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
        <input data-rss-add-input="" value={draft} placeholder="粘贴 feed 地址或站点首页（会自动发现 feed）后回车" disabled={busy}
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
        {/* 「发现」与回车「直接添加」并存：回车保持既有语义（粘贴 feed 地址一步到位），
            发现是显式的第二条路 —— 站点首页常常有多个声明，挑哪个只有用户知道。 */}
        <button type="button" className="dsh-rss-btn" data-rss-discover=""
          disabled={busy || draft.trim() === ''}
          onClick={() => { onDiscover(draft.trim()) }}>发现候选</button>
      </div>

      {/* 说明文案提前讲清边界（R3-4）：排序只是显示先后，OPML 标准没有顺序字段，别把它当备份。 */}
      <div data-rss-feed-order-hint="" style={{ fontSize: 12, opacity: 0.65, marginBottom: 10 }}>
        ↑ / ↓ 调整顺序，只影响显示先后；OPML 不记录顺序，导出再导入不保证原顺序。
      </div>

      {discovery !== undefined && (
        <section data-rss-discovery="" aria-label="发现的订阅候选"
          style={{ marginBottom: 16, padding: '10px 12px', background: 'color-mix(in srgb, currentColor 6%, transparent)', borderRadius: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <strong style={{ fontSize: 13 }}>订阅候选</strong>
            <span style={{ opacity: 0.6, fontSize: 12, wordBreak: 'break-all' }}>
              {discovery.candidates.length} 个已验证 · {discovery.url}
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-discovery-cancel=""
              disabled={busy} onClick={onClearDiscovery}>取消</button>
          </div>
          {discovery.candidates.length === 0 && (
            <div data-rss-discovery-empty="" style={{ fontSize: 12, opacity: 0.8 }}>
              没有发现可订阅的源。可以继续用上面的输入框手动添加 feed 地址。
            </div>
          )}
          {discovery.candidates.map((candidate) => {
            // 两类候选混排（spec D9）：来源徽标 + 第二行措辞不同。Radar 候选**没有抓取校验**
            // （ADR-0010），所以只写「站点名 · 未验证」而不编造 format / 条数；真正的校验在
            // 「添加」时由 addFeed 做。页面候选仍显示原有的「地址 · 格式 · N 条」。
            const isRadar = candidate.source === 'rsshub'
            return (
              <div key={candidate.url} data-rss-candidate={candidate.url} title={candidate.url}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid color-mix(in srgb, currentColor 8%, transparent)' }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block' }}>
                    {candidate.title !== undefined && candidate.title !== '' ? candidate.title : candidate.url}
                    <span data-rss-candidate-source={candidate.source ?? 'page'}
                      style={{
                        marginLeft: 6, padding: '0 5px', borderRadius: 3, border: '1px solid currentColor',
                        fontSize: 10, opacity: 0.65, whiteSpace: 'nowrap',
                      }}>{isRadar ? 'RSSHub' : '页面声明'}</span>
                  </span>
                  <span style={{ display: 'block', fontSize: 11, opacity: 0.6, wordBreak: 'break-all' }}>
                    {isRadar ? (
                      <>
                        {candidate.siteName !== undefined && candidate.siteName !== '' ? candidate.siteName + ' · ' : ''}未验证
                      </>
                    ) : (
                      <>
                        {candidate.url}
                        {candidate.format !== undefined ? ' · ' + candidate.format : ''}
                        {candidate.itemCount !== undefined ? ' · ' + candidate.itemCount + ' 条' : ''}
                      </>
                    )}
                  </span>
                </span>
                <button type="button" className="dsh-rss-btn" data-rss-candidate-add={candidate.url}
                  disabled={busy} onClick={() => { onAdd(candidate.url) }}>添加</button>
              </div>
            )
          })}
          {discovery.warnings.length > 0 && (
            <div style={{ fontSize: 12, color: '#c0392b', marginTop: 4 }}>
              {discovery.warnings.map((warning, index) => (
                <div key={index} data-rss-discovery-warning="" style={{ wordBreak: 'break-all' }}>
                  · {warning.url ?? discovery.url} —— {warning.reason}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

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
        {feeds.map((feed, index) => (
          <div key={feed.id} data-rss-feed-row={feed.id} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
            borderBottom: '1px solid color-mix(in srgb, currentColor 8%, transparent)',
          }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block' }}>{feed.title ?? feed.id}</span>
              <span style={{ display: 'block', fontSize: 11, opacity: 0.6, wordBreak: 'break-all' }}>
                {feed.id}{feed.folder !== undefined ? ' · 文件夹：' + feed.folder : ' · 未分类'}
              </span>
              {/* 健康信息（M4 02）：状态 / 连败次数 / 最近尝试 / 上次成功 / 最近错误。
                  连败次数缺失时写「次数未知」而不是 0 —— 老记录从来没记过计数（见 domain.ts 的三态）。 */}
              <span data-rss-feed-health={feed.id} style={{ display: 'block', fontSize: 11, opacity: 0.75, wordBreak: 'break-all' }}>
                {'健康：' + feedHealthLabel(feed)}
                {' · 连续失败：' + (feed.failureCount === undefined ? '次数未知' : feed.failureCount + ' 次')}
                {' · 最近尝试：' + (feed.lastAttemptedAt === undefined ? '从未' : relativeTime(feed.lastAttemptedAt))}
                {' · 上次成功：' + (feed.lastFetchedAt === undefined ? '从未' : relativeTime(feed.lastFetchedAt))}
                {feed.lastFailure !== undefined ? ' · 最近错误：' + feed.lastFailure : ''}
              </span>
            </span>
            {/* 原生按钮即可满足「可聚焦、回车触发」；**不承诺空格**（空格是全局翻页键）。
                首行 ↑ / 末行 ↓ 置灰；busy（导入/加源在途）时全灰——两个写手不能同时改同一份订阅文件。 */}
            <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
              data-rss-feed-order-up={feed.id}
              aria-label={'上移「' + (feed.title ?? feed.id) + '」'}
              title="上移一位"
              disabled={busy || index === 0}
              onClick={() => onMoveOrder(feed.id, -1)}>↑</button>
            <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
              data-rss-feed-order-down={feed.id}
              aria-label={'下移「' + (feed.title ?? feed.id) + '」'}
              title="下移一位"
              disabled={busy || index === feeds.length - 1}
              onClick={() => onMoveOrder(feed.id, 1)}>↓</button>
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
              移动到
              <select data-rss-feed-folder={feed.id} value={feed.folder ?? ''} disabled={busy}
                onChange={(event) => onMoveFeed(feed.id, event.target.value === '' ? undefined : event.target.value)}>
                <option value="">未分类</option>
                {folders.map((folder) => <option key={folder.name} value={folder.name}>{folder.name}</option>)}
              </select>
            </label>
            <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
              title="退订并删除该源的全部条目（含星标，不可撤销）"
              onClick={() => {
                if (window.confirm('退订该源并删除它的全部条目？\n\n' + feed.id +
                  '\n\n全部条目（包括你星标的）会被永久删除，此操作不可撤销。')) onRemove(feed.id)
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
