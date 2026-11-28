/**
 * 「精选源」视图（R15 08，spec §4.3.1 / §4.3.2 / §6 A13）。
 *
 * 纯展示：动作全部由 store 的 sourcePack 域通过 props 传进来 —— 组件不直调 RPC、不归一化 URL、
 * 也不判断「这条是不是订阅」。
 *
 * 布局跟着主栏走（主栏可能很窄）：搜索 / 分类 / 列表 / 加源表单都是可换行的纵向结构。
 * 数据标记用 `data-rss-pack-*`：测试与真机排查都按标记取节点，不靠文案 / 序号。
 */
import type { ReactNode } from 'react'
import type { CuratedSourceEntry } from '../shared.js'
import { SOURCE_PACK_IMPORT_LIMIT, type SourcePackDraft, type SourcePackProbe, type SourcePackState } from './source-pack-actions.js'

export interface SourcePackViewProps {
  readonly state: SourcePackState
  readonly onQuery: (q: string) => void
  readonly onCategory: (category: string | undefined) => void
  readonly onOpenForm: () => void
  readonly onCloseForm: () => void
  readonly onDraft: (patch: Partial<SourcePackDraft>) => void
  readonly onProbe: () => void
  readonly onSave: (force?: boolean) => void
  readonly onRemove: (url: string) => void
  /** 行内编辑（spec §4.3.1：可改分类与备注）。 */
  readonly onEdit: (url: string) => void
  readonly onEditDraft: (patch: Partial<{ category: string; note: string }>) => void
  readonly onEditSave: () => void
  readonly onEditCancel: () => void
  readonly onToggleSelect: (url: string) => void
  readonly onImport: () => void
  readonly onRestoreSeed: () => void
  readonly onBack: () => void
}

/** 分类筛选项：全部分类 + 每个分类的条数（按清单里第一次出现的顺序）。 */
function categoriesOf(entries: ReadonlyArray<CuratedSourceEntry>): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const name = entry.category ?? '未分类'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count }))
}

/** 搜索（标题 / URL 子串）+ 分类筛选。空搜索词与 undefined 分类 = 不筛。 */
function visibleEntriesOf(state: SourcePackState): CuratedSourceEntry[] {
  const needle = state.q.trim().toLocaleLowerCase()
  return state.entries.filter((entry) => {
    if (state.category !== undefined && (entry.category ?? '未分类') !== state.category) return false
    if (needle === '') return true
    return (entry.title ?? '').toLocaleLowerCase().includes(needle)
      || entry.url.toLocaleLowerCase().includes(needle)
  })
}

/**
 * 校验结论的一行文案。
 *
 * `targetUrl` 是**此刻要保存的地址**：粘站点首页时 `probe.url` 是页面声明的 feed 地址，
 * 两者不同就必须当场说清「验的不是你要存的那条」，否则用户会在保存后才发现备注写着「未验证」。
 */
function probeTextOf(probe: SourcePackProbe, targetUrl: string): string {
  if (!probe.ok) return '校验失败：' + probe.reason
  const parts = ['已验证']
  if (probe.format !== undefined) parts.push('格式 ' + probe.format)
  if (probe.itemCount !== undefined) parts.push(probe.itemCount + ' 条')
  if (probe.title !== undefined) parts.push('标题「' + probe.title + '」')
  const text = parts.join(' · ')
  if (probe.url === targetUrl) return text
  // 结论属于另一个地址：说清是哪一个，并把后果讲明（保存后会标成未验证）。
  return text + '（校验的是 ' + probe.url + '，不是上面这个地址；直接保存会标为未验证）'
}

function AddForm(props: {
  readonly state: SourcePackState
  readonly onDraft: (patch: Partial<SourcePackDraft>) => void
  readonly onProbe: () => void
  readonly onSave: (force?: boolean) => void
  readonly onClose: () => void
}): ReactNode {
  const { state, onDraft, onProbe, onSave, onClose } = props
  const probe = state.probe
  // 先抓一次再保存：没校验过就不给「保存」，只给「抓取校验」——避免用户以为已经验证过。
  // 校验结论只对**它验证过的那个地址**有效：地址不同 ⇒ 只能走「仍然保存（未验证）」。
  const targetUrl = state.draft.url.trim()
  const sameTarget = probe !== undefined && probe.url === targetUrl
  const canSave = sameTarget && probe.ok
  const canForce = probe !== undefined && (sameTarget ? !probe.ok : true)
  return (
    <form className="dsh-rss-pack-form" data-rss-pack-form=""
      onSubmit={(event) => { event.preventDefault(); if (canSave) onSave() }}>
      <div className="dsh-rss-pack-form-title">加一条自己的源</div>
      <label className="dsh-rss-pack-field">
        <span className="dsh-rss-pack-field-label">地址（http / https）</span>
        <input className="dsh-rss-pack-input" data-rss-pack-url="" required
          value={state.draft.url} placeholder="https://example.com/feed"
          onChange={(event) => { onDraft({ url: event.target.value }) }} />
      </label>
      <div className="dsh-rss-pack-form-actions">
        <button type="button" className="dsh-rss-btn" data-rss-pack-probe=""
          disabled={state.probing} onClick={onProbe}>
          {state.probing ? '校验中…' : '抓取校验'}
        </button>
        {canSave && (
          <button type="submit" className="dsh-rss-btn dsh-rss-btn--primary" data-rss-pack-save=""
            disabled={state.saving}>{state.saving ? '保存中…' : '保存'}</button>
        )}
        {canForce && (
          <button type="button" className="dsh-rss-btn" data-rss-pack-save-unverified=""
            disabled={state.saving} onClick={() => { onSave(true) }}>
            {state.saving ? '保存中…' : '仍然保存（未验证）'}
          </button>
        )}
        <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-pack-cancel=""
          onClick={onClose}>取消</button>
      </div>
      {probe !== undefined && (
        <div className={probe.ok ? 'dsh-rss-pack-probe' : 'dsh-rss-settings-error'}
          role={probe.ok ? 'status' : 'alert'} data-rss-pack-probe-result={probe.ok ? 'ok' : 'failed'}>
          {probeTextOf(probe, targetUrl)}
          {/* 只要不是「同一个地址且验证通过」，都只能走「仍然保存（未验证）」——
              两个原因（验的另一条 / 验失败）对用户是同一件事，不必分两句说。 */}
          {(probe.ok ? !sameTarget : true) && '（仍可「仍然保存」，会标为未验证并保留原因）'}
        </div>
      )}
      {probe !== undefined && (
        <>
          <label className="dsh-rss-pack-field">
            <span className="dsh-rss-pack-field-label">标题（可选）</span>
            <input className="dsh-rss-pack-input" data-rss-pack-title=""
              value={state.draft.title}
              onChange={(event) => { onDraft({ title: event.target.value }) }} />
          </label>
          <label className="dsh-rss-pack-field">
            <span className="dsh-rss-pack-field-label">分类（可选）</span>
            <input className="dsh-rss-pack-input" data-rss-pack-category-input=""
              value={state.draft.category}
              onChange={(event) => { onDraft({ category: event.target.value }) }} />
          </label>
          <label className="dsh-rss-pack-field">
            <span className="dsh-rss-pack-field-label">备注（可选）</span>
            <input className="dsh-rss-pack-input" data-rss-pack-note=""
              value={state.draft.note}
              onChange={(event) => { onDraft({ note: event.target.value }) }} />
          </label>
        </>
      )}
    </form>
  )
}

/**
 * 导入结果（spec §4.3.2 / A14）：新增 / 已存在是汇总，失败与跳过**逐条**带原因。
 * 结果块本身不判断「哪条算成功」—— 宿主回包说什么是什么，界面不二次加工。
 */
function ImportReportBlock(props: { readonly report: NonNullable<SourcePackState['importReport']> }): ReactNode {
  const { report } = props
  return (
    <div className="dsh-rss-pack-import-report" role="status" data-rss-pack-import-report="">
      <div data-rss-pack-import-summary="">
        导入结果：新增 <strong>{report.added}</strong> 条，已存在 {report.existed} 条，
        校验失败 <strong>{report.failed.length}</strong> 条，文件内跳过 {report.skipped.length} 项
      </div>
      {report.accepted.map((row) => (
        <div key={row.url} className="dsh-rss-pack-import-line" data-rss-pack-import-accepted={row.url}>
          · 已入库 {row.title ?? row.url}{row.folder === undefined ? '' : '（分组：' + row.folder + '）'}
        </div>
      ))}
      {report.failed.length > 0 && (
        <div className="dsh-rss-pack-import-failed" data-rss-pack-import-failed="">
          <div>以下源校验失败（未加入订阅，其余不受影响）：</div>
          {report.failed.map((row) => (
            <div key={row.url} className="dsh-rss-pack-import-line" data-rss-pack-import-failed-row={row.url}>
              · {row.url} —— {row.reason}
            </div>
          ))}
        </div>
      )}
      {report.skipped.length > 0 && (
        <div className="dsh-rss-pack-import-line" data-rss-pack-import-skipped="">
          <div>文件里被跳过的条目：</div>
          {report.skipped.map((row, index) => (
            <div key={index}>· {row.title ?? '(无标题)'} —— {row.reason}</div>
          ))}
        </div>
      )}
    </div>
  )
}

export function SourcePackView(props: SourcePackViewProps): ReactNode {
  const { state, onQuery, onCategory, onOpenForm, onCloseForm, onDraft, onProbe, onSave, onRemove, onEdit, onEditDraft, onEditSave, onEditCancel, onToggleSelect, onImport, onRestoreSeed, onBack } = props
  const categories = categoriesOf(state.entries)
  const visible = visibleEntriesOf(state)
  const hasFilters = state.q.trim() !== '' || state.category !== undefined

  return (
    <div className="dsh-rss-pack-page" data-rss-pack-page="">
      <div className="dsh-rss-pack-head">
        <span className="dsh-rss-pack-title">精选源</span>
        <span className="dsh-rss-meta" data-rss-pack-seed="">
          内置快照 {state.seed.count} 条 · 采集日 {state.seed.collectedAt || '—'}
        </span>
        <button type="button" className="dsh-rss-btn dsh-rss-btn--primary" data-rss-pack-import=""
          disabled={state.selected.length === 0 || state.importing} onClick={onImport}>
          {state.importing ? '导入中…' : '导入所选（' + state.selected.length + '/' + state.entries.length + '）'}
        </button>
        <button type="button" className="dsh-rss-btn" data-rss-pack-restore=""
          disabled={state.saving} onClick={onRestoreSeed}>恢复内置快照</button>
        <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-pack-back=""
          onClick={onBack}>返回列表</button>
      </div>

      {state.warning !== undefined && (
        <div className="dsh-rss-settings-warning" role="status" data-rss-pack-warning="">{state.warning}</div>
      )}
      {state.error !== undefined && (
        <div className="dsh-rss-settings-error" role="alert" data-rss-pack-error="">{state.error}</div>
      )}
      {state.notice !== undefined && (
        <div className="dsh-rss-pack-notice" role="status" data-rss-pack-notice="">{state.notice}</div>
      )}
      {/* 超限时提前说清楚：按钮本身仍可点，动作层会拦下并发出一条明确的错误（不发请求）。 */}
      {state.selected.length > SOURCE_PACK_IMPORT_LIMIT && (
        <div className="dsh-rss-settings-warning" role="status" data-rss-pack-import-limit="">
          一次最多导入 {SOURCE_PACK_IMPORT_LIMIT} 条（当前勾选 {state.selected.length} 条），请分批导入。
        </div>
      )}

      <div className="dsh-rss-pack-toolbar">
        <input className="dsh-rss-pack-input" data-rss-pack-search="" type="search"
          aria-label="搜索精选源" placeholder="搜索标题或地址"
          value={state.q} onChange={(event) => { onQuery(event.target.value) }} />
        <select className="dsh-rss-pack-select" data-rss-pack-filter=""
          aria-label="按分类筛选" value={state.category ?? ''}
          onChange={(event) => { onCategory(event.target.value === '' ? undefined : event.target.value) }}>
          <option value="">全部分类</option>
          {categories.map((category) => (
            <option key={category.name} value={category.name}>{category.name}（{category.count}）</option>
          ))}
        </select>
        <button type="button" className="dsh-rss-btn" data-rss-pack-add=""
          onClick={state.formOpen ? onCloseForm : onOpenForm}>
          {state.formOpen ? '收起加源' : '加一条自己的源'}
        </button>
        {hasFilters && (
          <span className="dsh-rss-meta" data-rss-pack-match="">匹配 {visible.length} / {state.entries.length} 条</span>
        )}
      </div>

      {state.formOpen && (
        <AddForm state={state} onDraft={onDraft} onProbe={onProbe} onSave={onSave} onClose={onCloseForm} />
      )}

      {state.importReport !== undefined && <ImportReportBlock report={state.importReport} />}

      {state.loading && state.entries.length === 0 && (
        <div className="dsh-rss-pack-note" role="status">正在读取精选源…</div>
      )}
      {!state.loading && state.entries.length === 0 && (
        <div className="dsh-rss-pack-note" data-rss-pack-empty="">
          清单是空的（你把内置快照删光了）。可以「恢复内置快照」只补缺失项，或加一条自己的源。
        </div>
      )}
      {!state.loading && state.entries.length > 0 && visible.length === 0 && (
        <div className="dsh-rss-pack-note">没有匹配的条目。</div>
      )}

      <ul className="dsh-rss-pack-list">
        {visible.map((entry) => {
          const editing = state.editing !== undefined && state.editing.url === entry.url
          return (
            <li key={entry.url} className="dsh-rss-pack-row" data-rss-pack-entry={entry.url}>
              <div className="dsh-rss-pack-row-head">
                <label className="dsh-rss-pack-check">
                  <input type="checkbox" data-rss-pack-select={entry.url}
                    checked={state.selected.includes(entry.url)} disabled={state.importing}
                    aria-label={'选择 ' + (entry.title ?? entry.url)}
                    onChange={() => { onToggleSelect(entry.url) }} />
                </label>
                <span className="dsh-rss-pack-name" title={entry.title ?? entry.url}>{entry.title ?? entry.url}</span>
                <span className="dsh-rss-pack-badge">{entry.category ?? '未分类'}</span>
                {/* 两个写动作放一个容器里，由容器自己 margin-left:auto 推到行尾；
                    逐个按钮写 margin-left:auto 会在两枚按钮之间也撑出一段空白。 */}
                <span className="dsh-rss-pack-actions">
                  <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-pack-edit=""
                    disabled={state.saving} onClick={() => { onEdit(entry.url) }}>编辑</button>
                  <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-pack-remove=""
                    disabled={state.saving} onClick={() => { onRemove(entry.url) }}>删除</button>
                </span>
              </div>
              <code className="dsh-rss-pack-url" data-rss-pack-url-text="">{entry.url}</code>
              {editing ? (
                <div className="dsh-rss-pack-form" data-rss-pack-edit-form="">
                  <label className="dsh-rss-pack-field">
                    <span className="dsh-rss-pack-field-label">分类（留空 = 未分类）</span>
                    <input className="dsh-rss-pack-input" data-rss-pack-edit-category=""
                      value={state.editing?.category ?? ''}
                      onChange={(event) => { onEditDraft({ category: event.target.value }) }} />
                  </label>
                  <label className="dsh-rss-pack-field">
                    <span className="dsh-rss-pack-field-label">备注（留空 = 清除备注）</span>
                    <input className="dsh-rss-pack-input" data-rss-pack-edit-note=""
                      value={state.editing?.note ?? ''}
                      onChange={(event) => { onEditDraft({ note: event.target.value }) }} />
                  </label>
                  <div className="dsh-rss-pack-form-actions">
                    <button type="button" className="dsh-rss-btn dsh-rss-btn--primary" data-rss-pack-edit-save=""
                      disabled={state.saving} onClick={onEditSave}>{state.saving ? '保存中…' : '保存'}</button>
                    <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-pack-edit-cancel=""
                      disabled={state.saving} onClick={onEditCancel}>取消</button>
                  </div>
                </div>
              ) : (
                entry.note !== undefined && <div className="dsh-rss-pack-note-line">{entry.note}</div>
              )}
            </li>
          )
        })}
      </ul>
      <p className="dsh-rss-meta dsh-rss-pack-footnote">
        这里是清单，不是订阅：删除条目不会退订；勾选条目后「导入所选」才会进订阅（失败源逐条列原因、不入库）。
      </p>
    </div>
  )
}
