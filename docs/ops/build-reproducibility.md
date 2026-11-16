# 可复现构建（依赖盘点与干净目录复现）

> 适用范围：本仓库的 host 半（`src/` → `lib/`）、client 半（`src/client/` → `lib/client.js`）与四条门槛。
> 结论先说：**构建不依赖 npm 安装，依赖的是本机的一份 DSH 源码 checkout**。所以「锁定版本」在本仓库
> 目前等价于「锁定 checkout 的那个 tag」——没有锁文件，也没有任何一行 npm install。
> 本文记录**现状**与**可复现命令**；锁文件与 CI 的方案在 §7，全部**未落地**（等拍板）。

## 1. 依赖从哪来

`scripts/build.sh` 每次构建都从 checkout **现链**：往 `node_modules/` 里建软链，指向 checkout 内的目录。
它自己探测 checkout（`$DSH_CHECKOUT` → `~/dsh-harness` → `~/dsh` → `~/.dsh/dsh-harness` → `~/deepseek-harness`），
找不到就 `exit 1`。

| 包 | 来源（相对 checkout） | 用途 |
|---|---|---|
| `fast-xml-parser` | `.pnpm/fast-xml-parser@5.11.1` | **运行期**（`src/opml.ts` 解析 OPML） |
| `zod` | 顶层的 `node_modules/zod`（→ `.pnpm/zod@4.6.6`） | **运行期**（端点参数校验） |
| `schemastery` | `vendor/schemastery` | **运行期**（`Config` 的 schema 本体） |
| `@deepseek-ai/dsh-home-paths` | `packages/util/home-paths` | **运行期**（`$DSH_HOME` 解析） |
| `@deepseek-ai/dsh-storage-domain` | `packages/storage/storage-domain` | **运行期**（`src/domain.ts` 的 `defineDomain`，见 §6 的注） |
| `cordis` / `@deepseek-ai/cordis` | `vendor/cordis` | 类型（`Context`）；两个名字都要链，socket 增强按带 scope 的名字写 |
| `@deepseek-ai/dsh-tools` | `packages/core/tools` | 类型（`ToolDefinition`） |
| `@deepseek-ai/dsh-client-connection` / `-host-webserver` | `packages/client/connection` / `packages/host/webserver` | 类型（`import type {}` 的模块增强） |
| `@deepseek-ai/dsh-client-ui-slots` | `packages/client/ui-slots` | 类型（`SlotRegistry` 等） |
| `@deepseek-ai/dsh-client-ui-renderer` / `-ui-layout` / `-ui-sidebar` | `packages/client/*` | **邻接类型依赖**：本仓库不 import，但 `ui-slots` 的声明合并要靠它们进编译图 |
| `@deepseek-ai/dsh-llm` / `-system-prompt` | `packages/llm/llm` / `packages/core/system-prompt` | 同上（邻接类型依赖） |
| `cosmokit` | `vendor/cosmokit` | 同上（cordis 的伴生类型） |
| `@types/node` | checkout 的 `node_modules/@types/node`（**22.20.1**） | 编译期类型 |
| `@types/react` | checkout 的 `.pnpm/@types+react@18.3.31` | 编译期类型（客户端半） |

运行时依赖 `zod` 走 checkout **顶层的中间层链接**（`node_modules/zod` → `.pnpm/zod@<ver>`），不直接把
`.pnpm/zod@<ver>` 钉进本仓库：顶层链接是 `pnpm install` 每次都会重写的，宿主升级换版本后仍然有效。
直接钉版本目录会在升级把旧版本从 store 删掉后变成悬空链接，装载期才炸（2026-11-16 事故，判据见
`docs/pitfalls.md` §1.6）。

**工具链**（不在 link 列表里，必须自己在 PATH 上）：

| 工具 | 位置 | 版本（本轮实测） |
|---|---|---|
| `tsc`（构建用） | `$CHECKOUT/node_modules/.bin/tsc` | **6.0.3** |
| `tsc`（另一编译器，用来验证类型边界） | nvm 全局 | **7.0.2** |
| `tsdown`（客户端打包） | `$CHECKOUT/node_modules/.bin/tsdown` | 0.22.2（**没有**被 `build.sh` link，见 pitfalls §1.12） |
| Node.js | 系统 | v26.13.0（`node:sqlite` 要求 ≥ 22.5；dsh 0.2.2 起要求 ≥ 24.9） |

本轮盘点的 checkout：`dsh-v0.2.2-rc.3`（HEAD `38a6a5c9`）。

## 2. 硬依赖与失败形态（都实测过）

| 情形 | 结果 |
|---|---|
| `$DSH_CHECKOUT` 未设、HOME 下也没有 checkout | `npm run build` **exit 1**，消息 `build: cannot locate the dsh checkout (set DSH_CHECKOUT)` |
| checkout 存在但缺某个 link 目标 | `build: dependency target missing: <path>`（`exit 1`） |
| 链接建好但解析不到（悬空链接） | `build: 链接后解析不到 node_modules/<pkg>/package.json（悬空链接？target=…）`（`exit 1`） |
| `build:client` 的 PATH 里没有 tsdown | `sh: tsdown: command not found`（`exit 127`）—— 见 pitfalls §1.12 |
| 在**本机**的干净目录里构建（不设 `DSH_CHECKOUT`） | **exit 0**：`build.sh` 会自动探到 `~/.dsh/dsh-harness` ⇒ 「干净目录」不等于「干净环境」，要验证检出依赖必须同时换 HOME（见 §3 的表） |

## 3. 干净目录复现

```bash
# 0) 复制一份不含产物与依赖的工作副本（src/tests/scripts/配置即可，docs 与 .scratch 不影响构建）
rsync -a --exclude node_modules --exclude lib --exclude .git \
      --exclude .codegraph --exclude .worktrees --exclude .superpowers --exclude .scratch \
      <本仓库>/ /tmp/clean/
cd /tmp/clean

# 1) host 构建：链接依赖 + tsc → lib/
DSH_CHECKOUT=<checkout> npm run build                       # 期望 exit 0
# 2) client 构建：PATH 必须带 checkout 的 .bin（本仓库没有 tsdown）
PATH=<checkout>/node_modules/.bin:$PATH npm run build:client # 期望 exit 0
# 3) 类型检查（两个工程；两个编译器各跑一遍）
PATH=<checkout>/node_modules/.bin:$PATH npm run typecheck    # 期望 exit 0
# 4) 测试
PATH=<checkout>/node_modules/.bin:$PATH npm test             # 期望 exit 0
# 5) 变异门槛（隔离副本由脚本自己建；本机内存 < 6 GB 时 --workers 1 + 分 3 批）
PATH=<checkout>/node_modules/.bin:$PATH npm run mutation -- --workers 1
```

**本轮实测（`/tmp/m5-05-clean`，从一个空目录开始）**：

| 步骤 | 退出码 | 耗时 | 说明 |
|---|---|---|---|
| `npm run build`（`DSH_CHECKOUT` 指向 checkout） | **0** | 2.0 s | 生成 36 个 `lib/*.js` |
| `npm run build`（HOME 指向空目录，无 checkout） | **1** | — | `cannot locate the dsh checkout` |
| `npm run build:client`（PATH += checkout/.bin） | **0** | 0.3 s | `lib/client.js` 202.75 kB |
| `npm run typecheck` | **0** | 1.3 s | 两个工程 |
| `npm test` | **0** | 15.6 s | 537 通过 / 0 失败 |
| `npm run mutation`（第 1 批 76 条，`--workers 1`） | **0** | 336 s | 76/76 被抓到、幸存 0、基线仍绿（2026-11-15 提速前口径；现行全量 240 条约 2.5 min，见 §5.5） |

## 4. 构建的确定性（实测）

从干净目录构建出的 `lib/*.js` 与本仓库现有的 `lib/*.js`：**36 个共同文件逐字节一致**（同 sha256）。
差异只在文件**数量**：本仓库的 `lib/` 多出 3 个陈年残留（`article-view.js`、`client/store.js`、`keyboard-routing.js`），
它们对应的 `src/` 文件早已不存在 —— 干净构建不会产出它们。这条也是 `docs/pitfalls.md` §1.1
「host 侧 `lib/*.js` 没有产物新鲜度守卫」的现实注脚：仓库里的旧产物不会被自动清理。

## 5. 现状缺口（盘点结论）

1. **没有锁文件**（`package.json` 只有 `^` 区间）：真正钉住版本的是 checkout 的 tag。
2. **`package.json` 的声明与实际链接不同源**：`@types/node` 声明 `^24.13.3`，实际链的是 checkout 的 **22.20.1**；
   `tsdown` 声明在 devDependencies，但构建时用的是 checkout 的 `tsdown`（本仓库没有 `node_modules/tsdown`）。
3. **`scripts/build.sh` 探测路径写死四个候选**：换个 checkout 位置就必须显式传 `DSH_CHECKOUT`。
4. **两个 tsc 版本并存**（6.0.3 构建 / 7.0.2 复检）：这是刻意的类型边界检查（pitfalls §1.11），但也意味着
   「构建通过的编译器版本」只有一个 —— CI 里必须固定用 checkout 的那个。
5. **变异门槛的时长**：240 条在本机（~5 GB 可用内存）要 `--workers 1`。**2026-11-15 提速后全量实测 152 s**（judge 合计 138 s + 3 次基线），
   旧口径约 15 分钟。提速来自三处，都不改判据：① `scroll-dom` 的 212 处固定 `sleep` 换成 `waitFor`/`settle`（14.9 s → ~3 s）；
   ② `client-bundle` / `unread-accounting` 夹具不再真排程 5000 ms 撤销窗口（各 5.4 s / 5.1 s → 0.4 s / 0.1 s）；
   ③ `judgeTests`（可选）按校准出的翻红用例名过滤，`--test-name-pattern` 单条命中约 0.1–0.4 s。
   内环可用 `npm run mutation -- --changed`（只跑受影响变异，opt-in，走 `.mutation-cache.json`），全量 gate 不受影响。

   **观察口径（防「又变慢」）**：

   | 工具 | 命令 | 看什么 |
   |---|---|---|
   | 耗时报表 | `node scripts/mutation-test.mjs --workers N --timings <file>` | `slowShare`（≥1s 变异占总耗时的比例）、`slowCount`、`narrowedCount`、`etaSecondsByWorkers`、`slowest` 前 15 |
   | judge 墙钟预算 | `npm run test:perf` | `tests/perf/mutation-judge-budget.test.mjs`：scroll-dom 8s / client-bundle 2s / unread 1s / refresh 1s（当前 2.9s / 0.35s / 0.09s / 0.22s） |
   | 结构锚点 | `npm test` | `tests/mutation-runner.test.mjs`：judge 文件不得出现裸 `await sleep(`；撤销窗口必须只捕获不排程；judgeTests 必须有跑前漂移校验 |

   判读规则（`实测` 基线：240 条 / 141s，slowShare 72%，中位 103ms）：`slowShare` 上升说明时间集中在少数变异（先看它们是不是「广谱翻红」或「文件级回退」）；
   `slowCount` 上升说明新变异落进了重文件；`narrowedCount` 下降说明 `judgeTests` 漂移或新增条目没校准；中位数上升而 slowShare 不变 = 夹具层回归（sleep 回来了）。

## 6. 一个容易误删的条目

`@deepseek-ai/dsh-storage-domain` 已经**不在装载路径**上（插件自持 SQLite），但 `src/domain.ts` 的
`defineDomain/domainTable` 是**运行期** import，删掉这条 link 会让从零构建直接 `TS2307`（实测过）。
「运行路径不用」≠「可以删依赖声明」，判据是那条 import 在不在编译图里。

## 7. 方案（A 已落地 2026-11-14；B/C 未采纳）

### 7.1 锁文件与依赖获取

| 方案 | 做法 | 代价 / 风险 |
|---|---|---|
| **A. 维持现状（✅ 已落地）** | 不引入锁文件；根目录 `dsh-version.json` 记「验证过的版本 + 兼容线」，`scripts/build.sh` 在链接前断言：不同 `0.2.x` ⇒ **拒绝构建**，同一线但不同补丁/rc ⇒ 告警放行 | 仍然「换台机器要先有同版本的 DSH 源码」；但零新依赖、零新流程 |
| **B. 离线包缓存** | 把 §1 里 17 个 link 目标 `npm pack` 成 tarball 放进仓库/制品库，构建改为解包 | 仓库体积变大；tarball 与源码树的一致性要自己维护 |
| **C. 真锁文件** | 把这些包发布到可访问的 registry（或私有 registry）→ `package-lock.json` → `npm ci` | **需要新的依赖来源与凭证**，按 AGENTS.md 必须先授权；且与「从 checkout 现链」的既有机制二选一 |

**A 的落地内容**：`dsh-version.json`（`tested: 0.2.1-rc.5` / `line: 0.2`）+ `scripts/build.sh` 的版本断言。
实测三条路径：`0.3.0` ⇒ exit 1（`只在 0.2.x 上验证过`）、`0.2.9` ⇒ 告警后放行、真实 `0.2.1-rc.5` ⇒ exit 0 无告警。
B/C 都会改变「依赖从哪来」这个公共契约，**没有动**。

### 7.2 CI 分层（草案，取决于 7.1）

| 层 | 内容 | 触发 | 预算 |
|---|---|---|---|
| L1 快速 | `bash scripts/gate.sh` —— `build` + `build:client` + `typecheck`（两个编译器）+ `test`，逐条打印退出码 | 每次改动 / push | **19.2 s**（本机实测） |
| L2 门槛 | `npm run mutation -- --workers 1`（分 3 批；2026-11-15 起单批即可跑完） | 每天 / release 前 | **~2.5 min**（本机实测 152 s） |
| L3 真机 | 注入器装载 + 当天日志 + 401 | release 前，人工 | — |

L1 可以在任何有 checkout 的机器上跑；L2/L3 需要一台有内存与活体宿主的环境。
L1 已落成 `scripts/gate.sh`（不依赖任何 CI 服务）；**L2 留在文档里按批手工跑**（`--workers 1` + `--mutations` 分三批），
**没有接入任何外部 CI 服务**（GitHub Actions / 自建 runner 都算新服务，需要授权）。

## 8. 未验证 / 边界

- `未验证` 另一台机器（不同 OS / 不同 checkout 位置 / 没有 nvm 全局 tsc）上的复现：本轮全部在同一台机器上做。
- `未验证` checkout 换版本（例如 0.2.2）后的兼容性：只盘点了 `dsh-v0.2.1-rc.5`。
- `未验证` 干净目录里跑**完整** 230 条变异：只跑了第 1 批 76 条（其余两批的命令与之一致，但没有在该目录里复跑）。
- `猜测` 迁移到方案 B/C 之后 `build.sh` 的探测逻辑可以整段删除：没有验证过「解包后的目录结构是否满足类型解析」。
