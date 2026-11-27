/**
 * 探索视图（R8b 04）：路由目录的浏览、筛选、参数表单与连续订阅。
 *
 * 纯展示：动作全部由 store 的 explore 域通过 props 传进来 —— 组件不直调 RPC、不拼地址。
 * 参数表单的字段来自 `parsePathTemplate`（与宿主同一份实现），预填来自 `prefillValues`；
 * 组件本身不解释模板语法，也不校验 constraint（D5）。
 *
 * 布局跟着主栏走：主栏可能很窄，所以搜索 / 分类 / 每行 / 表单都用可换行的纵向结构，
 * 参数输入不设固定宽度（宽度交给 CSS 的 100% 上限）。
 */
import { useState, type ReactNode } from 'react'
import type { ExploreRouteView } from '../shared.js'
import { parsePathTemplate } from '../explore-template.js'
import type { ExploreState } from './store.js'

/** 布尔事实徽标的文案与渲染顺序；false 一律不渲染（「一堆否」是噪音，spec §4.4）。 */
const FEATURE_LABELS: ReadonlyArray<
  readonly [Exclude<keyof ExploreRouteView['features'], 'requireConfig' | 'nsfw'>, string]
> = [
  ['antiCrawler', '反爬'],
  ['requirePuppeteer', '需浏览器'],
  ['supportPodcast', '播客'],
]

/**
 * 一行的事实徽标：`requireConfig` 是三态，必须把「必填 / 可选」分开显示（A9）；
 * `none` 与布尔 false 一样不渲染。`nsfw` 不在本票渲染（隐藏 / 开关归 06）。
 */
function featureBadgesOf(features: ExploreRouteView['features']): Array<{ key: string; label: string }> {
  const badges: Array<{ key: string; label: string }> = []
  if (features.requireConfig === 'required') badges.push({ key: 'requireConfig', label: '需配置（必填）' })
  if (features.requireConfig === 'optional') badges.push({ key: 'requireConfig', label: '需配置（可选）' })
  for (const [key, label] of FEATURE_LABELS) {
    if (features[key]) badges.push({ key, label })
  }
  return badges
}

/**
 * 周测徽标文案（R15 05）：只有「通过 / 失败」两种事实；未参加（`undefined`）什么都不显示。
 * 它是上游周测结论，不是质量评分 —— 文案不许写成「优质 / 推荐」（spec §4.2.2）。
 */
const WEEKLY_TEST_LABELS: Readonly<Record<'passed' | 'failed', string>> = {
  passed: '周测通过',
  failed: '周测失败',
}

export interface ExploreViewProps {
  readonly state: ExploreState
  readonly onQuery: (patch: Partial<Pick<ExploreState, 'q' | 'category' | 'namespace'>>) => void
  readonly onLoadMore: () => void
  readonly onSelectRoute: (route: ExploreRouteView) => void
  readonly onDraftValue: (name: string, value: string) => void
  readonly onBuild: () => void
  readonly onAdd: () => void
  readonly onBack: () => void
}

/** 参数段按模板顺序去重：同一参数名在模板里出现两次时只画一个输入框（值本来就只有一个）。 */
function paramSegmentsOf(route: ExploreRouteView): Array<{ name: string; optional: boolean }> {
  const seen = new Set<string>()
  const result: Array<{ name: string; optional: boolean }> = []
  for (const segment of parsePathTemplate(route.path).segments) {
    if (segment.kind !== 'param' || seen.has(segment.name)) continue
    seen.add(segment.name)
    result.push({ name: segment.name, optional: segment.optional })
  }
  return result
}

/**
 * 一条路由的参数表单。**渲染在被点中的那一行内部**（2026-11-24 真机反馈）：
 * 原先它挂在整张列表之后，搜出几十行时点完行标题要滚到页面底部才看得见表单，
 * 界面上等于「点了没反应」。放进行内之后「选中 → 填 → 拼 → 添加」在同一处闭环。
 */
function RouteForm(props: {
  readonly route: ExploreRouteView
  readonly params: Array<{ name: string; optional: boolean }>
  readonly state: ExploreState
  readonly onDraftValue: (name: string, value: string) => void
  readonly onBuild: () => void
  readonly onAdd: () => void
}): ReactNode {
  const { route, params, state, onDraftValue, onBuild, onAdd } = props
  return (
    <form className="dsh-rss-explore-form" data-rss-explore-form=""
      onSubmit={(event) => {
        event.preventDefault()
        onBuild()
      }}>
      <div className="dsh-rss-explore-form-title">
        参数 · {route.siteName} / {route.name}
      </div>
      <code className="dsh-rss-explore-path" data-rss-explore-form-path="">{route.path}</code>
      {params.length === 0 && (
        <div className="dsh-rss-explore-detail">这条路由没有参数，直接拼地址即可。</div>
      )}
      {/* spec §4.5：example 缺省或段数对不上 ⇒ 不预填，字段留空并明说「按官方文档填写」。
          不给这句话时，一排空 input 看起来像界面没加载出实例已有的示例。 */}
      {params.length > 0 && !state.prefilled && (
        <div className="dsh-rss-explore-detail" data-rss-explore-prefill-hint="">
          按官方文档填写（无官方 example）
        </div>
      )}
      {params.map((param) => (
        <label key={param.name} className="dsh-rss-explore-field" data-rss-explore-field={param.name}>
          <span className="dsh-rss-explore-field-label">
            {route.parameters[param.name] ?? param.name}
            {param.optional ? '（可选）' : ''}
          </span>
          <input className="dsh-rss-explore-input" data-rss-explore-param={param.name}
            value={state.draft[param.name] ?? ''}
            placeholder={param.optional ? '留空则从地址中省略' : ''}
            onChange={(event) => { onDraftValue(param.name, event.target.value) }} />
        </label>
      ))}
      {state.missing.length > 0 && (
        <div className="dsh-rss-settings-error" role="alert" data-rss-explore-missing="">
          缺少必填参数：{state.missing.join('、')}
        </div>
      )}
      <div className="dsh-rss-explore-form-actions">
        <button type="submit" className="dsh-rss-btn" data-rss-explore-build=""
          disabled={state.building}>{state.building ? '拼地址中…' : '拼地址'}</button>
        {state.builtUrl !== undefined && (
          <>
            <code className="dsh-rss-explore-url" data-rss-explore-url="">{state.builtUrl}</code>
            <button type="button" className="dsh-rss-btn dsh-rss-btn--primary" data-rss-explore-add=""
              disabled={state.adding} onClick={onAdd}>{state.adding ? '添加中…' : '添加'}</button>
          </>
        )}
        {state.receipt !== undefined && (
          <span className="dsh-rss-settings-saved" role="status" data-rss-explore-added="">{state.receipt}</span>
        )}
      </div>
    </form>
  )
}

export function ExploreView(props: ExploreViewProps): ReactNode {
  const { state, onQuery, onLoadMore, onSelectRoute, onDraftValue, onBuild, onAdd, onBack } = props
  /**
   * 搜索框的文字是**组件局部草稿**：进 store 的 q 只在提交时更新。
   * 若每个字符都写 q，store 的「q 变化 ⇒ 清空行 + 重取第一页」会让输入过程变成一串请求。
   */
  const [queryText, setQueryText] = useState(state.q)
  const hasFilters = state.q !== '' || state.category !== undefined || state.namespace !== undefined

  const clearFilters = (): void => {
    setQueryText('')
    onQuery({ q: '', category: undefined, namespace: undefined })
  }

  const selected = state.selected
  const params = selected === undefined ? [] : paramSegmentsOf(selected)

  return (
    <div className="dsh-rss-explore-page" data-rss-explore-view="">
      <div className="dsh-rss-explore-head">
        <button type="button" className="dsh-rss-btn" data-rss-explore-back="" onClick={onBack}>
          ← 返回列表（Esc）
        </button>
        <strong className="dsh-rss-explore-title">路由探索</strong>
        {state.siteTotal !== undefined && state.routeTotal !== undefined && (
          <span className="dsh-rss-meta" data-rss-explore-counts="">
            共 {state.siteTotal} 个站点 · {state.routeTotal} 条路由
            {state.matched !== undefined ? ' · 命中 ' + state.matched + ' 条' : ''}
          </span>
        )}
      </div>

      <form className="dsh-rss-explore-search" data-rss-explore-search-form=""
        onSubmit={(event) => {
          event.preventDefault()
          onQuery({ q: queryText.trim() })
        }}>
        <input className="dsh-rss-explore-input" data-rss-explore-search="" type="search"
          value={queryText} placeholder="搜站点名 / 路由名 / 路径片段"
          aria-label="搜索路由" onChange={(event) => setQueryText(event.target.value)} />
        <button type="submit" className="dsh-rss-btn">搜索</button>
        <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" data-rss-explore-clear=""
          disabled={!hasFilters} onClick={clearFilters}>清除筛选</button>
      </form>

      {state.categories.length > 0 && (
        <div className="dsh-rss-explore-categories" role="group" aria-label="按分类筛选">
          {state.categories.map((category) => (
            <button key={category} type="button" className="dsh-rss-explore-category"
              data-rss-explore-category={category}
              aria-pressed={state.category === category}
              onClick={() => {
                // D10：单选；再点同类 = 清除。
                onQuery({ category: state.category === category ? undefined : category })
              }}>{category}</button>
          ))}
        </div>
      )}

      {state.namespace !== undefined && (
        <div className="dsh-rss-explore-active" data-rss-explore-namespace={state.namespace}>
          站点：{state.namespace}
        </div>
      )}

      {state.error !== undefined && (
        <div className="dsh-rss-status dsh-rss-status--error dsh-rss-explore-error" role="alert"
          data-rss-explore-error="">{state.error}</div>
      )}

      {state.loading && (
        <div className="dsh-rss-explore-note" data-rss-explore-loading="">正在加载路由目录…</div>
      )}

      {!state.loading && state.error === undefined && state.items.length === 0 && (
        <div className="dsh-rss-explore-note" data-rss-explore-empty="">
          {hasFilters ? '没有匹配的路由，试试清除筛选。' : '该实例的路由目录为空。'}
        </div>
      )}

      {state.items.length > 0 && (
        <ul className="dsh-rss-explore-list">
          {state.items.map((route) => {
            const paramsText = Object.entries(route.parameters)
              .map(([name, description]) => name + '：' + description)
              .join('；')
            return (
              <li key={route.namespace + '|' + route.path} className="dsh-rss-explore-row"
                data-rss-explore-row="" data-rss-explore-path={route.path}>
                <div className="dsh-rss-explore-row-head">
                  <button type="button" className="dsh-rss-explore-site" data-rss-explore-site={route.namespace}
                    title="只看这个站点" onClick={() => { onQuery({ namespace: route.namespace }) }}>
                    {route.siteName}
                  </button>
                  <button type="button" className="dsh-rss-explore-route" data-rss-explore-route={route.path}
                    onClick={() => { onSelectRoute(route) }}>{route.name}</button>
                  {/* 行标题长得像纯文本（无边框、只有 hover 变色），真机上没人看出来能点。
                      给一个看得见的落点：按钮本身就是入口，行标题的点击保留不变。 */}
                  <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost dsh-rss-explore-pick"
                    data-rss-explore-pick={route.path}
                    onClick={() => { onSelectRoute(route) }}>订阅…</button>
                </div>
                <code className="dsh-rss-explore-path" data-rss-explore-path-text="">{route.path}</code>
                {paramsText !== '' && (
                  <div className="dsh-rss-explore-detail" data-rss-explore-parameters="">参数：{paramsText}</div>
                )}
                {route.example !== undefined && route.example !== '' && (
                  <div className="dsh-rss-explore-detail" data-rss-explore-example="">示例：{route.example}</div>
                )}
                <div className="dsh-rss-explore-features">
                  {featureBadgesOf(route.features).map(({ key, label }) => (
                    <span key={key} className="dsh-rss-explore-badge" data-rss-explore-feature={key}>{label}</span>
                  ))}
                  {/* 周测与 features 是两类事实：单独的 data 属性，避免「周测」被当成实例声明的能力。 */}
                  {route.weeklyTest !== undefined && (
                    <span className="dsh-rss-explore-badge" data-rss-explore-weekly={route.weeklyTest}>
                      {WEEKLY_TEST_LABELS[route.weeklyTest]}
                    </span>
                  )}
                </div>
                {selected !== undefined && selected.namespace === route.namespace && selected.path === route.path && (
                  <RouteForm route={route} params={paramSegmentsOf(route)} state={state}
                    onDraftValue={onDraftValue} onBuild={onBuild} onAdd={onAdd} />
                )}
              </li>
            )
          })}
        </ul>
      )}

      {state.nextCursor !== undefined && (
        <div className="dsh-rss-explore-more">
          <button type="button" className="dsh-rss-btn" data-rss-explore-more=""
            disabled={state.loadingMore} onClick={onLoadMore}>
            {state.loadingMore ? '加载中…' : '加载更多'}
          </button>
        </div>
      )}

    </div>
  )
}
