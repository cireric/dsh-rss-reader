# DECISIONS —— 历史决策与账目

> **用途**：只记**已经拍板的决定**与**版本 / 文档账目**。未来要做什么看 [PLAN.md](PLAN.md)；功能现状与源码落点看 [feature-status.md](feature-status.md)。
> **为什么单独一份**：这些是历史事实，不会随计划推进而变；混在 PLAN.md 里会让「待办」被历史淹没。
> **新增决策**：阶段收尾时追加一行，写清「结论」而不是过程（过程在 spec 的 D 系列里）。

## 拍板记录

| 日期 | 事项 | 结论 |
|---|---|---|
| 2026-11-28 | R15 收尾 | 合入 main（fast-forward）；不打 tag，等发版时统一处理；`.scratch/endpoints-split/` 与 `optimization-backlog` 分别承载重构票与优化候选 |
| 2026-11-25 | R7 一键翻译 | 译文纯内存不落盘（不建表、不升 schema）；分块 ≤12 块且 ≤2000 字符、视口优先、单块 2000/6000 三档；5 语言 + 原文 / 对照两态（2026-11-26 收成一枚切换按钮）；模型路由两层（`settings.json` > 会话默认）且服务全走 `ctx.get()` 可选获取；失败 `translate-failed` + 四类 reason 按批重试（spec D1–D20） |
| 2026-11-24 | R8b 路由表探索 | 独立 `view:'explore'`；单级扁平+站点钻取；缓存 12h 硬编码（**推翻原「可配置」**）；拉表 60s/16MiB 专用预算；constraint 不校验；分类仅路由级；三筛 AND；未配置实例入口不可见；下发行裁剪（spec D1–D15） |
| 2026-11-23 | R9 归档页回溯 | 一次一页；日期三级来源、月级不补；同文键忽略协议（ADR-0011）；未读；headroom 预检；同步 + 120s；N=尝试数；归档页可信 / 文章页不可信（spec D1–D10） |
| 2026-11-23 | R8a 默认实例 | 空 = 关闭，不写死公共实例（`rsshub.app` 实测 403）；Radar 候选不做取回校验（ADR-0010） |
| 2026-11-22 | RSSHub 实例 | 只用公共实例，不自建；不开口子网 SSRF 例外 |
| 2026-11-22 | 设置页入口 | B：独立 `view: 'settings'` 视图 |
| 2026-11-22 | R12 基线 | R12 已完成，作为 v0.2.0 基线 |
| 2026-11-21 | R6 图片默认值 | `expandImages` 默认 `true`，`i` 键切换整篇 |
| 2026-11-21 | R1 时间范围默认值 | 默认「全部」，不改变打开面板第一屏 |

## 版本账目

- **v0.1.0** / **v0.2.0**：`v0.2.0` tag 在 `516a79b`（2026-11-22），该 tag 的 `package.json` 仍是 `0.1.0`。历史 tag 内容不可改写。
- **v0.3.0**：`package.json` 已抬到 `0.3.0`，`CHANGELOG.md` 有 `0.3.0 — 2026-11-27` 小节；本地 tag 已创建、已 push。含 R1–R7、R8a/R8b、R9、R11、R12、R14。
- **R15**：已合入 `main`（`d945430`，2026-11-28），`CHANGELOG.md` 记在「未发布」段；`package.json` 仍是 `0.3.0`，**未打 tag**。
- **R9 / R14**：评审修复 `e317e73` 与 `6153927` 已合入 `main` `a59baf4`，随 `0.3.0` 发布。真机与真实站点证据在 `.scratch/r9-archive/issues/04-real-device.md` 与 `.scratch/r14-feed-scope/issues/01-feed-scope.md`。

## 已知不一致

- **v0.2.0 tag 与版本号不符**（见上）：tag 指向的 `package.json` 是 `0.1.0`。不改写历史 tag，仅记录。
- 其余文档面（`CHANGELOG.md` / `feature-status.md` / 各 spec 头部状态）已逐轮校正，无已知漂移。

## 历史索引

阶段详情不再在本文件或 PLAN.md 维护，按需查：

- **功能现状 + 源码落点 + 测试与遗留** → [feature-status.md](feature-status.md)
- **各阶段的行为规范、验收、变异归属** → `.scratch/<slug>/spec.md`（14 个阶段全部在盘）
- **R15 及更早的评审记录** → `git show 18cea09:docs/PLAN.md`（清空前的完整版本）
