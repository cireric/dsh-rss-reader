# AGENTS.md — `@dsh-external/dsh-rss-reader`

## 硬约束

- ❌ `as any` / `@ts-ignore` / `@ts-expect-error`（`strict: true`，客户端有 bundle 契约测试）
- ❌ 空 catch。本项目有实测事故：`try { await fiber.dispose() } catch {}` 吞掉失败 ⇒ 域句柄永久泄漏
- ❌ 删测试、放宽断言来让套件变绿。测试是产出的一部分，不是障碍
- ❌ 编造数据。认不出就返回 `undefined` / 留空 / 标出原因（先例：`src/feed/date.ts` 不编造日期）
- ❌ 自动 commit。改完提示用户，等确认

## 这个仓库是什么

DSH 插件的**两半**：host 半 `src/`（Node ESM，tsc → `lib/`）；client 半 `src/client/`
（React，tsdown 打成单文件 `lib/client.js`）。入口是侧栏图标 → 主栏阅读器；
数据落**插件自持**存储（`$DSH_HOME/storages/rss-reader/`：`rss.db` 是条目库，
DDL 在 `src/storage/db.ts`；`config.json` 放订阅与视图偏好；`reader-YYYY-MM-DD.log` 是刷新日志）。
`src/domain.ts` 仍持有 zod 记录 schema（库侧与迁移共用），但**不再**声明落盘方案。
老存储域文件 `storages/rss_reader.json` 只读不写（迁移的源）。

## 完成定义

按序执行，全部过才算完：

```bash
npm run build            # 动过 src/client/** 则追加 npm run build:client
npm run typecheck        # host + client 两个工程，0 错误
npm test                 # 全绿
npm run mutation         # 每条变异都必须被抓到，0 幸存（在隔离副本里跑）
```

改了关键判定 → **同时补一条变异**。

**这四条按「轮」跑，不按每次编辑跑。** 一轮 = 一次交付单元（一次 commit 或一次交接）：
编辑过程中若要反馈，`npm run build`（改了 `src/**` 就必须）后只跑受影响的那个测试文件；
`typecheck / test / mutation` 留到本轮收尾跑一次。

**测试全绿 ≠ 插件能用。** 本仓库有过「全套测试全绿 + 两个构建全过，而插件在 DSH 里是坏的」。
发布前走真机三步：`dev_reload_package`（前后都应 `[active]`）→ 看**今天**的
`$DSH_HOME/storages/rss-reader/reader-$(date -u +%F).log` 无「装载失败」（按天分文件，
只保留 14 天；别再看 `state/dsh-rss-reader/reader.log`——自持后那个文件永远不再写）→
`curl -X POST http://127.0.0.1:3080/rss-reader-api -d '{"endpoint":"overview","payload":{}}'` 得 401（路由活着）。

## 工作约定

- **注释与 commit message 写中文，写「为什么」不写「做了什么」**。commit 结构：
  **病象 → 根因 → 修法 → 证据**，并如实写出没做的事与走过的错误方向。
- **每条结论标证据等级**：`实测`（真机 / 真实站点）、`源码核对`（带 `file:line`）、`猜测`。
  是猜测就必须写「猜测」。
- **测试钉行为与不变量**（`docs/google-reader-feature-spec.md` §5），不钉实现细节。
- **不为未经实测的样本扩规则**：需要规则却没有实测样本的，记进 `docs/pitfalls.md` 的「待验证」。
- **等价变异不入门槛**：它幸存不是测试缺口。判定方法见 `scripts/mutation-test.mjs` 里
  「正文容器收窄」那条完整推导。

## 先看 `docs/pitfalls.md`

**踩坑与开发经验全部在那一个文件里。** 动代码前先扫一遍它的标题 —— 尤其是：

- 测试跑的是 `lib/` 产物，改完不 build 等于测旧代码；`build` 不含客户端。
- 变异门槛会在源目录改坏 `lib/`，**必须在 /tmp 隔离副本里跑**。
- 长驻监听器不许捕获「会变的值」；按键路径不许依赖环境全局。
