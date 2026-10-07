/**
 * 「按 V 打开条目时默认用哪个视图」的决策 —— **纯函数**。
 *
 * 用户要求（2026-10-06）：站点支持被嵌入就直接看原站原样页面，不支持才回落到抽取后的阅读视图。
 * 抽出来是因为这是一个**有分支的可见行为**，而客户端在浏览器里我无法自测；纯函数可以用
 * 真值表逐格钉住。
 *
 * 注意这不是"多一次网络请求"：抓取与可嵌性判定（响应头）本来就是同一次请求里一起拿到的。
 */

/** 阅读器内的两种正文呈现方式。 */
export type ArticleRender = 'reading' | 'original'

/** 按优先级挑默认视图：用户当次的选择 > 能嵌就用原站 > 否则阅读视图。 */
export function pickInitialRender(
  frameable: boolean | undefined,
  explicit?: ArticleRender,
): ArticleRender {
  // 用户当次明确切过视图：尊重它，别用「默认值」覆盖用户意图
  if (explicit !== undefined) return explicit
  return frameable === true ? 'original' : 'reading'
}

/**
 * 切换后的下一个视图。
 *
 * 不可嵌时**保持原样返回**（而不是切到 original）：否则会进入一个永远白屏的 iframe。
 * 界面上的按钮此时本来也是禁用的，这里是第二道防线。
 */
export function nextRender(current: ArticleRender, frameable: boolean): ArticleRender {
  if (!frameable) return current
  return current === 'original' ? 'reading' : 'original'
}
