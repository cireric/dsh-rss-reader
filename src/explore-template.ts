/**
 * R8b 04：路径模板解析与 example 反推预填 —— **纯函数、零 node 内建、零网络**。
 *
 * 为什么从 explore-catalog.ts 搬出来：那份文件 import 了 node:crypto（游标栅栏的 hash），
 * 而客户端要的正是「模板字段 / 必填性 / 贪婪段 / 预填对齐」这几条判据（docs/pitfalls.md §1.7b：
 * 浏览器 bundle 引 node 内建要到运行期才炸）。搬成独立模块后宿主与客户端读同一份实现；
 * explore-catalog.ts 保留 re-export，R8b 01/03 既有的 import 路径不用改。
 *
 * 本文件不 import 任何宿主模块（连 shared 的类型也不引）：模板语法与预填对齐只在这里定义一次。
 */
/** 路径模板的一段：字面量，或一个参数（`:name` / `:name?` / `:name{constraint}`）。 */
export type PathTemplateSegment =
  | { readonly kind: 'literal'; readonly value: string }
  | {
    readonly kind: 'param'
    readonly name: string
    readonly optional: boolean
    /** `{.+}` / `{.*}`：吃剩余所有段（含 `/`）；其余 constraint 只吃一段（D5，不校验正则）。 */
    readonly greedy: boolean
  }

/** 解析后的路径模板。`unsupported` 为真时拼地址必须分型失败，不许猜。 */
export interface PathTemplate {
  readonly path: string
  readonly segments: readonly PathTemplateSegment[]
  readonly unsupported: boolean
}

/**
 * 参数段语法：`:name` / `:name?` / `:name{constraint}` / `:name{constraint}?`。
 *
 * constraint 用 `(.*)` 整段吃下、**不解释内容**：实测 126 条带 constraint 的路径里 118 条是
 * `.+` / `.*`，其余 6 条才是真正则。实现正则引擎既超出 D5 的范围，也会让「填错形状」在宿主
 * 这一层被误判成「这个路由不可用」。
 */
const PARAM_SEGMENT = /^:([A-Za-z0-9_]+)(?:\{(.*)\})?(\?)?$/

/**
 * 路径 → 段数组：只剥**首尾**斜杠，不合并中间的空段。
 *
 * 中段空段（`//`）不是合法路由，保留它会让拼接产生空段；这里不悄悄丢掉它，而是让后续的
 * 字面量比对失败 —— 形状怪异时宁可判「不可拼装 / 不预填」，也不产出一个看起来对的地址。
 */
function splitPathSegments(path: string): string[] {
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '')
  return trimmed === '' ? [] : trimmed.split('/')
}

/**
 * 解析路径模板。
 *
 * 两件事必须分开：**能认出参数**（`:name` 等）与**能不能安全拼装**。`*`、残留的 `{` / `}`
 * 以及畸形参数段（如 `:id{.+` 少了右括号）都归 `unsupported` —— 它们要么是 RSSHub 的通配 /
 * 正则语法，要么说明模板形状漂移；任何「试着填一下」都会拼出指向别的路由的地址（spec §4.5）。
 */
export function parsePathTemplate(path: string): PathTemplate {
  const segments: PathTemplateSegment[] = []
  let unsupported = false
  for (const segment of splitPathSegments(path)) {
    const match = PARAM_SEGMENT.exec(segment)
    if (match !== null) {
      const constraint = match[2]
      segments.push({
        kind: 'param',
        name: match[1],
        optional: match[3] === '?',
        // 只把恰好 `.+` / `.*` 当贪婪；`{newbook.*}` 之类真正则按单段处理（实测只有 6 条）
        greedy: constraint === '.+' || constraint === '.*',
      })
      continue
    }
    if (segment.startsWith(':') || segment.includes('*') || segment.includes('{') || segment.includes('}')) {
      unsupported = true
    }
    segments.push({ kind: 'literal', value: segment })
  }
  // 贪婪参数必须是最后一段（`{.+}` 的语义就是「吃剩余全部」）。实测 0 例例外；真出现时
  // 它后面的字面量无从对齐，拼出来的地址会悄悄少段 —— 归 unsupported，不猜。
  if (segments.some((segment, index) => segment.kind === 'param' && segment.greedy && index !== segments.length - 1)) {
    unsupported = true
  }
  return { path, segments: Object.freeze(segments), unsupported }
}

/** example 里的单段解码；坏百分号编码 ⇒ undefined（认证不了的样本不拿来预填）。 */
function decodeExampleSegment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}

/**
 * 单次对齐尝试：把 example 段数组当成「填好的路径」与模板逐段对齐。
 *
 * 贪婪参数必须**最后一段**且至少吃一段；非贪婪要求段数恰好相等。字面量必须逐字相等
 *（大小写敏感）—— 官方 example 与模板来自同一份声明，对不上说明这不是同一条路由的样本，
 * 猜一个值只会把用户送进错误的订阅地址。返回 undefined = 这次对齐不成立。
 */
function alignTemplate(
  template: PathTemplate,
  exampleSegments: readonly string[],
): Record<string, string> | undefined {
  const segments = template.segments
  const last = segments[segments.length - 1]
  const greedy = last !== undefined && last.kind === 'param' && last.greedy ? last : undefined
  const fixedCount = greedy === undefined ? segments.length : segments.length - 1
  if (greedy === undefined && exampleSegments.length !== fixedCount) return undefined
  if (greedy !== undefined && exampleSegments.length < fixedCount + 1) return undefined
  const values: Record<string, string> = {}
  for (let i = 0; i < fixedCount; i += 1) {
    const segment = segments[i]
    const actual = exampleSegments[i]
    if (segment === undefined || actual === undefined) return undefined
    if (segment.kind === 'literal') {
      if (segment.value !== actual) return undefined
      continue
    }
    const decoded = decodeExampleSegment(actual)
    if (decoded === undefined || decoded === '') return undefined
    values[segment.name] = decoded
  }
  if (greedy !== undefined) {
    const rest = exampleSegments.slice(fixedCount)
    const parts: string[] = []
    for (const actual of rest) {
      const decoded = decodeExampleSegment(actual)
      if (decoded === undefined || decoded === '') return undefined
      parts.push(decoded)
    }
    values[greedy.name] = parts.join('/')
  }
  return values
}

/**
 * 官方 `example` → 表单预填值；**缺省 / 段数对不上 / 对不齐 ⇒ 空对象，不猜**（spec §4.5）。
 *
 * 为什么 example 要多切一个候选：实例的 `path` 是**相对**的（实测 `/branches/:user/:repo`），
 * 而 `example` 带 namespace 前缀（实测 `/github/branches/DIYgod/RSSHub`，2922 条里 2902 条如此）。
 * 于是「example 去掉首段」与「example 原样」各是一次对齐尝试：只有一次成立才采用；**两次都成立
 * 就是歧义**（例如 `/:category{.+}?` 的 `/1lou/forum-2-1`），此时返回空对象 —— 猜错的值会
 * 悄悄换掉用户的订阅目标。调用方若知道 `namespace`（04 的列表行就有），传第三个参数即可消歧。
 */
export function prefillValues(
  template: PathTemplate,
  example: string | undefined,
  namespace?: string,
): Record<string, string> {
  if (example === undefined || example === '' || template.unsupported) return {}
  const exampleSegments = splitPathSegments(example)
  if (exampleSegments.length === 0) return {}
  if (namespace !== undefined && namespace !== '') {
    // 显式 namespace：example 确实以它为第一段才剥；不匹配就原样对齐（不猜别的剥离方式）
    const segments = exampleSegments[0] === namespace ? exampleSegments.slice(1) : exampleSegments
    return alignTemplate(template, segments) ?? {}
  }
  const direct = alignTemplate(template, exampleSegments)
  const withoutNamespace = alignTemplate(template, exampleSegments.slice(1))
  if (direct !== undefined && withoutNamespace !== undefined) return {}
  return direct ?? withoutNamespace ?? {}
}
