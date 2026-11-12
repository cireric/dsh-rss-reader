# AGENTS.md — `@dsh-external/dsh-rss-reader`

## 硬约束

- ❌ `as any` / `@ts-ignore` / `@ts-expect-error`（`strict: true`，客户端有 bundle 契约测试）
- ❌ 空 catch。本项目有实测事故：`try { await fiber.dispose() } catch {}` 吞掉失败 ⇒ 域句柄永久泄漏
- ❌ 删测试、放宽断言来让套件变绿。测试是产出的一部分，不是障碍
- ❌ 编造数据。认不出就返回 `undefined` / 留空 / 标出原因（先例：`src/feed/date.ts` 不编造日期）
- ❌ 自动 commit。改完提示用户，等确认

## 这个仓库是什么

- **两半**：host 半 `src/`（Node ESM，tsc → `lib/`）；client 半 `src/client/`（React，tsdown → 单文件 `lib/client.js`）。入口是侧栏图标 → 主栏阅读器。
- **自持存储**：`$DSH_HOME/storages/rss-reader/` 下的 `rss.db` 是条目库（DDL 在 `src/storage/db.ts`），`config.json` 放订阅与视图偏好，`reader-YYYY-MM-DD.log` 是刷新日志。
- **唯一真相**：订阅在 `config.json`；`src/domain.ts` 持有库与 config 共用的 zod 记录 schema，但不声明落盘方案。
- **已下线**：存储域年代的 `storages/rss_reader.json` 与一次性迁移均已删除，代码里没有任何路径再读它。

## 完成定义

按「轮」执行，全部通过才算交付：

```bash
npm run build
npm run build:client       # 动过 src/client/** 才跑
npm run typecheck          # host + client 两个工程，0 错误
npm test                   # 全绿
npm run mutation -- --workers 2   # 本机默认；可用内存 < 6 GB 时降到 --workers 1
```

- 本机跑全量 mutation gate 时，agent 默认使用 `--workers 2`；启动前采样 `vm_stat` 的 free + inactive + speculative，低于 6 GB 时降到 `--workers 1`。并发保护由 agent 执行；`--workers` 只改变并发，不减少变异条目。
- `--mode fast` 仅用于内环建议；它退出码恒非 0，**fast 通过 ≠ gate 通过**。
- 改了关键判定 → **同时补一条变异**。
- 编辑过程中只需 `npm run build`（改了 `src/**` 就必须）后跑受影响测试；`typecheck / test / mutation` 留到本轮收尾跑一次。
- **测试全绿 ≠ 插件能用。** 发布前走真机三步：`dev_reload_package`（前后都应是 `[active]`）→ 看今天 `$DSH_HOME/storages/rss-reader/reader-$(date -u +%F).log` 无「装载失败」→ `curl -X POST http://127.0.0.1:3080/rss-reader-api -d '{"endpoint":"overview","payload":{}}'` 得 401（路由活着）。

## 工作约定

- **注释与 commit message 写中文，说明为什么，不要只列改了什么。**
- Commit 主题用 `<type>(<scope>): <一句话>`（如 `fix(store): ...`）。正文按改动性质：
  - `fix` / 数据迁移 / 并发 / 存储等高风险改动：**病象 → 根因 → 修法 → 证据**；
  - `feat`：**背景 → 方案 → 验证**；
  - `refactor`：**问题 → 调整 → 验证**；
  - `docs` / `chore` / `test`：**目的 + 验证**即可。
  长证据放 issue / PR / 交付说明，commit 只留关键结论；如实写没做和错误方向。
- **每条结论标证据等级**：`实测`（真机 / 真实站点）、`源码核对`（带 `file:line`）、`猜测`。是猜测就必须写「猜测」。
- **测试钉行为与不变量**（`docs/google-reader-feature-spec.md` §5），不钉实现细节。
- **不为未经实测的样本扩规则**：需要规则却没有实测样本的，记进 `docs/pitfalls.md` 的「待验证」。
- **等价变异不入门槛**：它幸存不是测试缺口。判定方法见 `scripts/mutation-test.mjs` 里「正文容器收窄」的完整推导。

## 开发边界

- `docs/pitfalls.md` 是唯一的踩坑记录；动代码前先扫标题。以下三条是高频事故，必须遵守：
  - 测试运行的是 `lib/` 产物：改完不 build 等于测旧代码；`npm run build` 不含客户端。
  - 变异门槛会改坏 `lib/`：必须在 `/tmp` 隔离副本里跑，绝不在源目录跑。
  - 长驻监听器不许捕获会变的值；按键路径不许依赖环境全局。

## Agent skills

### Issue tracker

Issue 以本地 markdown 跟踪，落在本仓库 `.scratch/<feature-slug>/` 下，不走远端。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个 triage 角色使用默认标签：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

single-context：根 `GLOSSARY.md` + `docs/adr/`（尚不存在，由 /domain-modeling 懒创建）。见 `docs/agents/domain.md`。
