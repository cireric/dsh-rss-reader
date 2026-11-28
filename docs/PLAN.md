# PLAN —— 接下来的工作

> **只放未来**：这里只记「接下来要做什么」，按动作排，不记已完成的历史。
> 已完成阶段的验收、遗留与版本账目 → [feature-status.md](feature-status.md)；有独立论证的决定 → [docs/adr/](adr/)。
> **状态词**：`待拍板` / `待开工` / `进行中` / `已排期` / `暂缓`。
> **完成定义**：按 [AGENTS.md](../AGENTS.md) 的四道门槛 + 真机三步。本文件不抄门槛。

## 当前

**收口待发版。** R15 与 R15-04 / R15-05 均已合入 `main`（2026-11-28）；`package.json` 仍是 `0.3.0`，本地 annotated tag `v0.3.0` 未 push、远端只有 `v0.1.0` / `v0.2.0`。发版动作待授权。

## 候选（按建议顺序）

| # | 动作 | 规模 | 状态 | 入口 |
|---|---|---|---|---|
| 1 | 发版：定版本号（R15 是 0.3.1 还是 0.4.0）→ CHANGELOG「未发布」段转正 → tag → 推 tag → 发布前真机三步 | 一轮 | 待拍板 | `CHANGELOG.md` 的「未发布」段 |
| 2 | 重构：拆 `src/endpoints.ts`（1859 行 → ≤900），三张票 | 3 次提交，各跑一遍完成定义 | 待开工（无阻塞，可随时插） | [endpoints-split/spec.md](../.scratch/endpoints-split/spec.md) |
| 3 | 列表加「今天到此为止」分界线（全部视图，纯客户端） | 约 20 行 + 1 条 DOM 用例 | **已拍板做**（2026-11-28，FR-01 先于 FR-02） | [draft.md §4d](../.scratch/optimization-backlog/draft.md) 的 FR-01 |
| 4 | 翻译用量可见（每批 / 整篇 token 与耗时；宿主流的 `usage` 块现在被丢弃） | 小（读 `usage` + 工具栏一行） | **已拍板做**（2026-11-28，TR-01/02/04/05 冻结） | [draft.md §3](../.scratch/optimization-backlog/draft.md) 的 TR-03 |
| 5 | CI L1：push / PR 跑 `bash scripts/gate.sh`（公开仓库，Actions 免费；mutation 不上 CI） | 一个 workflow | **已拍板做**（2026-11-28） | [draft.md §4](../.scratch/optimization-backlog/draft.md) 的 EN-01 |
| 6 | 单源刷新：失败源行内「立刻重试」（改刷新链路，需独立评审） | 中（端点 + lifecycle + 客户端） | **已拍板做，单独立项**（2026-11-28，排在 FR-01 之后） | [draft.md §4d](../.scratch/optimization-backlog/draft.md) 的 FR-02 |

**已裁定的「不做 / 等触发」**（2026-11-28）：TR-01（译文持久化，与「译文是阅读期投影」的领域定义冲突）、TR-02（内联语义，成本最高）、TR-04（标题/表格/alt）、TR-05（AI 摘要）——全部冻结，等真实痛点；R15-01 / R15-02 / R15-03 维持「谁先碰谁顺带」；EN-02（大库压测）、EN-03（大文件拆分，除 `endpoints.ts` 那张票）、EN-04（发布脚本）维持待观察。

## 暂缓 / 不做

| 项 | 状态 | 理由 |
|---|---|---|
| R10 右侧边栏单栏 | 暂缓 | 第二套 UI 的维护成本；主面板左栏已有 `u` 收起 |
| R13 `/rss` 命令 | 暂缓 | 4 个 Agent 工具已覆盖 |
| 后台定时刷新 | 已跳过 | 2026-11-13 已决定不设常驻定时器 |
| 源改名 / 元数据编辑 | 暂缓 | 无真实「标题乱码必须改名」样本 |
| 抓取代理 | 暂缓 | 需重做 SSRF / DNS 策略，不顺手加 |

## 怎么用这份文件

1. **选定一项** → 状态改 `进行中`，并建 / 扩展 `.scratch/<slug>/spec.md` 与 `issues/`。
2. **做完一项** → 从本文件删掉该行（历史在 `feature-status.md` 与 spec 里）；决定若值得独立论证就写 ADR，否则留在 spec 的 D 系列。
3. **新想法** → 先进 `.scratch/optimization-backlog/draft.md` 当候选，不直接写进本文件；拍板后再列到这里。
4. 本文件保持在**一屏可读**；超了就说明该把某项开成 spec 了。
