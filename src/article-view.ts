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

/**
 * 挑默认视图。**只有用户当次的选择能改变它**，默认一律抽取版。
 *
 * 2026-10-08 起去掉了「可嵌站点默认开原站视图」这条（原为 frameable === true ? 'original' : 'reading'）。
 * 根因是实测出来的：原站视图的 iframe 沙箱刻意不给 allow-same-origin（安全决定，见 article-pane.tsx），
 * 于是框架内的文档是**不透明源** —— 现代站点的脚本在启动早期就因 storage 访问被拒而抛错，而它的样式
 * 由脚本注入，结果只剩服务端渲染出的裸 HTML（实测 sspai.com：巨大 logo + 裸链接，整页错乱）。
 *
 * 抽取版零依赖、任何站点都能读，所以它才是该当默认的那个；原站视图保留为**手动**选择，留给那些在
 * 沙箱里也渲染正常的站点。frameable 仍然有用（决定切换按钮是否可用，见 nextRender 与界面），
 * 只是不再决定默认值。
 */
export function pickInitialRender(explicit?: ArticleRender): ArticleRender {
  return explicit ?? 'reading'
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
