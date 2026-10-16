# 交互接线 module（C1 键盘控制器 + C2 正文滚动收归，2026-10-15）

> **状态：已执行（2026-10-15）· 尚未提交** —— 本文件在执行中改判过一次（文件位置与测试策略）。
> §规格 是执行时遵循的判据（保持原样）；§执行形态 与 §执行记录 如实记下实际落地与改判。
> 两者不一致时**以 §执行记录 为准** —— 那部分是被实测纠正过的。

**Goal:** 把「一次按键如何变成 store 动作」从 index.tsx 组件体里搬成一个可单测的纯函数 module；把「阅读容器的滚动位置」这一整个行为收归 article-pane（删掉跨组件的 ${B}setBox${B} 桥）。

## Global Constraints

- **client bundle 不许引第三方库**（${B}tsdown.config.ts${B} 的 ${B}neverBundle${B} 之外全打进 bundle）⇒ 新 module 只能 import 仓库自有模块与 react。
- ${B}strict: true${B}；禁 ${B}as any${B} / ${B}@ts-ignore${B} / ${B}@ts-expect-error${B}。
- 测试跑 ${B}lib/${B} 产物 ⇒ 改完 client 必须 ${B}npm run build:client${B}，否则 ${B}client-bundle.test.mjs:265${B} 的「产物不能过期」判据会让测试假红。
- **本轮不动 client-bundle 的假 React 夹具**（那是 C4 的活）。
- ${B}expanded${B} / ${B}helpOpen${B} 留在 index.tsx 的组件 state，**不进 store**（裁决 Q2）。
- **搬运必须逐字**：原实现的注释里写着判据（「为什么量 p 而不是容器」等）。抄了字没抄注释，测试照样全绿 —— 本轮实测发生三次（见 §执行记录）。
- 注释与 commit message 写中文、写「为什么」；每条结论标证据等级。
- 本仓库**禁自动 commit**：提交步骤留给你确认。

## Review Focus

规格与既有测试都沉默、但使用者（键盘是唯一高频交互面）会撞上的输入类：

1. **面板不在前台时按 j/k**：宿主可能把非当前主栏面板保活（${B}ui-layout${B} 的 retainMainPanels）⇒ 必须用 ${B}getClientRects().length === 0${B} 挡住，否则在对话里按 j 会动一个看不见的列表。
2. **输入框与弹层里的按键**：${B}isTypingTarget${B} 挡住输入框 / 可编辑区 / ${B}[role="dialog"]${B} 弹层（监听挂在 document 上，作用域比面板根宽）。
3. **帮助浮窗开着时按 Esc**：只关帮助，不连带关文章（用户拍板的三个关闭出口之一）。
4. **左栏折叠时按 shift+n/p**：没有「导航里的位置」可动 ⇒ 必须**静默不响应**（按 u 找回来再动，链路不绕）。
5. **修饰键组合**（meta/ctrl/alt）与 ${B}event.defaultPrevented${B}：一律不响应（不抢宿主快捷键）。
6. **正文视图里按 o/u**：曾会展开/收起「背后那个看不见的列表」（2026-10-06 实测缺陷）⇒ 必须被视图守卫挡住。
7. **换文章后 scrollTop 归零**：React 复用 DOM 节点，不归零就会从半截开始（2026-10-09 修）。

---

## 规格（执行时遵循的判据）

**两层键盘栈的分工**：
- 第 1 层「键 → 动作名」= ${B}src/keys.ts${B} 的 ${B}resolveReaderKey${B}（领域词汇，帮助浮窗也读它）—— **本轮不动**。
- 第 2 层「动作名 + 当前视图 ⇒ 做什么、该不该拦」= ${B}routeKey${B} —— 此前住在组件体内、不可单测，是本轮要搬的。

**${B}KeyRoutingCtx${B} 的形状**（裁决 Q2/Q3）：

${B}${B}${B}ts
export interface KeyRoutingCtx {
  readonly root: HTMLDivElement | null   // 面板可见性判定 + querySelector 取容器（不给裸全局，pitfalls §3.2）
  readonly store: ReaderStore
  readonly expanded: string | undefined  // 组件局部 state，不进 store
  readonly setExpanded: (next: string | undefined) => void
  readonly helpOpen: boolean
  readonly setHelpOpen: (next: boolean) => void
}
${B}${B}${B}

**C2 的归位**：归零 effect 从 index.tsx 搬进 article-pane，与既有的「内容长高贴底」**合并成一条**（同键 ${B}article?.itemId${B}、同一容器、同一行为的两半）。

---

## 执行形态（实际落地）

- **文件位置**：${B}src/client/keyboard-routing.ts${B}（266 行）。**不在** ${B}src/${B} 根。计划初稿曾放根下，理由是「${B}src/${B} 根会被 host 的 tsc 编译成 ${B}lib/*.js${B}、.mjs 测试可直接 import」（${B}tests/keys.test.mjs:8${B} 即此例）。**该理由被实测否证**：host 的 tsconfig 是 ${B}lib: ["ES2023"]${B}（**无 DOM**），而 ${B}routeKey${B} 必须碰 ${B}scrollTop${B} / ${B}getClientRects()${B} ⇒ 放根下编译不过（实测 TS2812：Property 'scrollTop' does not exist on type 'HTMLElement'）。${B}src/${B} 根下三个先例（keys / list-scroll / html-text）能过 host 编译，正是因为它们**刻意不碰 DOM**（list-scroll 的签名全是 number，只留 SCROLL_ATTR 这个字符串常量）。用户裁决方案 A。
- **测试怎么拿 routeKey**：client 半只出**单文件** bundle（tsdown ${B}codeSplitting: false${B}、tsconfig.client ${B}noEmit${B}），${B}.mjs${B} 无法 import ${B}src/client/${B} 下的模块 ⇒ 测试照 ${B}tests/scroll-dom.test.mjs:182-192${B} 的做法，用 ${B}vm${B} 加载 ${B}lib/client.js${B}、从 ${B}module.exports.routeKey${B} 取。为此 ${B}index.tsx:34${B} 有一行**仅供测试的 re-export**（注释写明「删掉它，键盘功能照常，只是那组守卫失去单测」）。
- **${B}ArticleView${B} props：9 → 8**（删 ${B}setBox${B}；${B}scrollAttr${B} **保留** —— 键盘仍靠它现取容器）。
- **${B}index.tsx${B}：754 → 553 行**；keyboard effect 依赖数组 ${B}[root, store, helpOpen]${B} → ${B}[root, store, expanded, helpOpen]${B}（${B}expanded${B} 必须进：o 键要读它决定折叠哪一行；两个 setter **不进** —— 调用点全是函数式更新，routeKey 永远读到最新值）。
- **变异重锚**：本轮搬走 141 行 ⇒ 5 条 client 变异（可见性守卫 / 容器现取 / ? 不接浮窗 / Esc 不先关浮窗 / helpOpen 依赖）的 ${B}from${B} 锚串全部失配（gate 报「未应用」＝这 5 条根本没跑）。逐条按产物真实形状重锚：${B}root${B} → ${B}ctx.root${B}、${B}helpOpen${B} → ${B}ctx.helpOpen${B}、依赖数组多一项 ${B}expanded${B} 且 tsdown 展开成多行 tab 形态。

## 执行记录（改判与失误，如实留痕）

- **Task 2 与 Task 3 合并**：原计划把「建表」与「搬 handler」分两步；实现时发现搬进来的必须是**逐字**原函数（否则静默改行为），拆两步更难保证等价，合并为一次改动。
- **三处「顺手简化」被自查抓回**（全部不会让任何测试变红，但都会在真机上改变行为）：
  ① ${B}isTypingTarget${B} 简化版漏了**弹层守卫**（${B}closest('[role="dialog"], [aria-modal="true"], dialog')${B}）与 **try/catch 留痕**（原实现判定失败时 console.warn 并按「非输入框」放行）；
  ② ${B}measureRowHeight${B} 改用 ${B}getBoundingClientRect().height${B}，原实现是 ${B}offsetHeight${B}；
  ③ ${B}measureLineStep${B} 漏了「量 ${B}box.querySelector('p') ?? box${B} 而不是容器」—— 容器上只有 flex/overflow 样式、字号行高从面板根继承（21.7px），正文内层块才是 29.6px，量错对象得到**看起来有值但不正确**的小一号步长，正是 2026-10-09「按一次滚一行半」的成因。
  三处均已逐字改回。**这三条里没有一条有对应变异** ⇒ gate 全绿也照样漏。
- **测试自身的三处错**：① 首版用延迟 import + 空转包装 ⇒ **8 条假绿**（pitfalls §2.7 的形态）；② ${B}metaKey${B} / ${B}target${B} 是**事件**字段，我塞进了 ctx（守卫因此失效）；③ ${B}Shift+o${B} 在浏览器里给的是大写 ${B}'O'${B}（导航键），小写 ${B}'o'${B} 是 ${B}expand${B} 且**不受 navVisible 约束**（原实现也不约束 —— 探针实证：折叠态下 N/P/O 什么都不调，小写 o 照常 markRead）。
- **一次自造事故**：用 python heredoc 改 ${B}scripts/mutation-test.mjs${B}，${B}chr(10).join(lines)${B} 的换行被 shell 吃掉 ⇒ **142 条变异被写成 0 行**。已 ${B}git checkout --${B} 从 HEAD 恢复（1460 行 / 142 条），用 edit 工具重做全部 5 条重锚。教训：改这个文件不要走 shell heredoc。

## 验收（Definition of Done）

- 四条门槛：${B}npm run build${B} ✓ · ${B}npm run build:client${B} ✓ · ${B}npm run typecheck${B} host+client 0 错误 · ${B}npm test${B} → **402/402**
- ${B}npm run mutation${B}（gate）→ **应用 142/142 · 幸存 0 · 恢复后基线仍然绿**
- 真机三步：${B}dev_reload_package${B} 前后 ${B}[active]${B} · ${B}curl${B} → 401 · 今日日志「装载失败」0 条
- **反事实验证**：面板可见守卫 / 输入框守卫 / Esc 优先关浮窗 / 折叠态拦导航 / 修饰键守卫 / 归零 effect —— 六条逐条取反都有对应用例翻红，恢复后全绿
- 键盘手动验：用户 2026-10-15 已实测通过（j/k · o · u · Esc 三出口 · 空格 · n/p · 换文章归零 · 折叠态 shift+n/p）

## 证据等级

- **实测**：上表全部数值（含 TS2812 的否证、六条反事实翻转、测试自身三处错的探针实证、变异清空事故）。
- **源码核对（file:line）**：${B}tsconfig.json:19-20${B} · ${B}tsdown.config.ts:14,32${B} · ${B}tests/keys.test.mjs:8${B} · ${B}src/list-scroll.ts:8-20${B}。