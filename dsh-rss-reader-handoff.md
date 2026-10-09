# dsh-rss-reader 交接简报

> **临时件**：不被其它文档引用，可整份重写（本版 2026-10-08 重写）。
> 上一版是 M0–M4 的全过程施工记录（673 行），在 git 历史里：`git show 7b462aa:dsh-rss-reader-handoff.md`。
> 这一版只写「接手的人现在需要知道的」，不写流水账。

## 1. 这是什么

一个 DSH 插件：在 DSH Web GUI 里读 RSS/Atom。目标形态是 Google Reader 式阅读流 ——
**订阅源列表 + 跨源条目流 + 未读态 + 键盘流**，不是「每日 digest 注入提示词」那一类。
规格史料在 `docs/google-reader-feature-spec.md`（§5 不变量 / §6 落点决定取舍）。

## 2. 现状（能做什么）

- 侧栏图标 → 主栏阅读器；条目流按时间倒序、未读计数徽标常驻。
- 键盘：`j/k` 移动（列表）/ 换文章（正文页）、`n/p` 扫视、空格翻页、`o` 展开并已读、
  `v` 开原站、`V` 在阅读器内读正文、`w/W` 切原站视图、`1/2` 切展开/紧凑密度、`s` 星标、
  `m` 切换已读、`A` 全部已读（可按头部范围限定为早于 1 天/1 周/1 月，**5 秒**撤销窗口，
  保持未读的条目会跳过）、`r` 刷新未读计数（只重取本地视图、**不抓取**）、`f`/`F` 订阅管理。
- 正文：按需抓原站 + 抽取结构化块（段落/标题/代码/图片/列表/引用）；站点允许时切「原站视图」
  （iframe 带沙箱）。
- 订阅管理：OPML 导入导出（保存前逐源抓取校验、坏源逐条列原因）、加源、退订。
- 保留策略：按源裁剪（星标永不自动删）、正文缓存按源限量、显式清理旧条目。
- 抓取：条件请求（ETag/Last-Modified）、有界并发、单源失败就地降级。
- 安全：出网地址策略（协议白名单 + 内网拦截 + 域名解析层拦截 + 重定向每跳复核）、iframe 沙箱、
  实体解码越界守卫。

## 3. 怎么跑起来

```bash
DSH_CHECKOUT=<dsh 源码 checkout> npm run build     # host：链接依赖 + tsc → lib/
DSH_CHECKOUT=<...> npm run build:client            # client：tsdown → lib/client.js
npm run typecheck                                 # 两个工程：host + client
npm test                                          # 137 条
npm run mutation                                  # 19 条变异，全中才退 0
```

三个会绊人的点：

- **`npm run build` 不含客户端**：改了 `src/client/**` 必须另跑 `build:client`，否则
  `lib/client.js` 是旧的（只有「产物不能过期」那一条测试会报警）。
- **构建依赖来自 checkout 的符号链接**（`scripts/build.sh` 现链，不联网安装）；仓库**没有锁文件**，
  所以这个包不能独立安装，也**进不了 CI**。
- **改完要真机确认**（见 §5），别只看测试绿。

## 4. 架构（文件 → 职责）

| 文件 | 职责 |
|---|---|
| `src/config.ts` | 配置面（Schemastery 接口 + schema，必须挨着放） |
| `src/index.ts` | 插件入口：apply、日志、域生命周期、refreshNow、HTTP 路由注册 |
| `src/endpoints.ts` | 11 个端点；闭包依赖显式收进 `EndpointDeps` |
| `src/refresh.ts` / `src/feed/*` | 刷新编排 / 条件请求 / 三格式解析 / 日期 / 条目 id（含候选身份表） |
| `src/identity-repair.ts` | 存量重复条目合并（打开域时跑，幂等） |
| `src/article.ts` + `src/html-text.ts` | 正文抓取与抽取 / 纯 HTML→文本（后者可被浏览器半共用） |
| `src/domain.ts` / `src/store.ts` | 存储域 schema / 域 → 窄接口适配器 |
| `src/opml.ts` `src/subscribe.ts` `src/retention.ts` `src/concurrency.ts` `src/xml-node.ts` | 见名 |
| `src/client/index.tsx` | 浏览器半入口：常量、图标、条目流、键盘接线、apply |
| `src/client/store.ts` | 浏览器半状态与数据通道（无 JSX） |
| `src/client/article-pane.tsx` / `feeds-view.tsx` | 正文面 / 订阅管理面板 |

## 5. 验证体系（三层，覆盖的东西不一样）

| 层 | 是什么 | 能发现什么 | **发现不了什么** |
|---|---|---|---|
| 单元/集成（137 条） | 纯函数 + 桩 store + 本地 HTTP 服务器 + 客户端 bundle 契约测试 | 逻辑错误、回归 | 真实宿主里的装载、路由、宿主给的 config |
| 变异门槛（19 条） | 把关键判定逐个改坏，看套件是否见红 | 「测试有没有牙」 | 同上 |
| **真机（手动）** | dev_plugin_status + 插件日志 + 端点探测 | 装载失败、路由残留、配置未解析、域打不开 | —— |

真机三步（发布前的固定动作，进不了 CI —— 因为没有可用的 checkout）：

1. `dev_reload_package {packageName:'dsh-rss-reader'}` → `before/after` 都应是 `[active]`
2. `tail $DSH_HOME/state/dsh-rss-reader/reader.log` → 不应出现「装载失败」
3. `curl -X POST http://127.0.0.1:3080/rss-reader-api -d '{"endpoint":"overview","payload":{}}'` → 401 即路由活着

> 这一层的价值是实测出来的：本会话里 137 条测试全绿、构建全过，而插件在 DSH 里是坏的
> （热重载残留路由 + 入口漏导 `Config` 导致配置全字段 undefined）。

## 6. 已知边界（不是待办）

- **DNS rebinding 的 TOCTOU**：解析层拦了「域名解析到内网」，但解析与连接之间有时间差。要彻底封死
  得给 fetch 传自定义 dispatcher（引入 undici 依赖），评估后不做。
- **内网自建 RSS 源**：可用（`trustedTarget`），但**只对第一个请求**生效；重定向目标一律按
  不可信处理。
- **`articleRecordSchema.paragraphs`**：schema 仍声明它（只为兼容读）。删不掉的两条路都实测过：
  版本号在 single layout 下是硬相等（升版直接打不开域）、`backup-and-skip` 会连带丢掉用户的
  已读态。真要删得换 per-record layout，或写一次性数据脚本。
- 排序 `localeCompare`、OPML 嵌套上限这两条早前**被推翻**（不是问题），别再列进来。

## 7. 还没做的（需决策）

- **8 条规格债**（规格 §6 的路线图）：kept-unread 语义、不变量 2 的重复 id/URL 兜底、expanded/list
  两视图与 `1`/`2` 键、auto-discovery、mark-all 时间阈值、未读计数可隐藏 + `r` 刷新计数、
  不变量 1 与规格对齐、正文面补验收清单。都属**新功能**，建议从 kept-unread 起（要动 domain schema，
  越早做迁移成本越低）。
- **独立安装（锁文件）与 CI**：同一件事 —— 没有锁文件就没有 CI。

## 8. 还会再踩的坑（只留这些）

- **入口必须导出 `Config`**（schema 本体）：宿主/注入器靠它给 config 补默认值。漏了它，注入
  路径下配置全字段 undefined —— 抓取在 `AbortSignal.timeout(undefined)` 上抛错、正文缓存闸门把
  缓存整份清空、清理端点抛 RangeError。插件现在也会在 apply 首行自己解析一次并留诊断日志，但那是
  兜底，不该被当成理由。
- **热重载可能留下上一代的 HTTP 路由**，新一代注册撞 `duplicate prefix route` 后插件直接不可用。
  webServer 没有「列出/注销路由」的公开 API，插件无法自救。恢复：
  `dev_clear_routes {prefix:'/rss-reader-api'}` → `dev_inject_plugin`（或重启 DSH）。
- **存储域热重载会撞 `already-open`**：已有有界接管（`openDomainWithRetry` + 孤儿句柄回收），
  日志里会写「上一代 fiber 遗留域句柄（无持有者），接管并关闭」。
- **条目身份会「分叉」，且分叉是写进存储的**（2026-10-09 修，用户实测「同一篇文章两条」）：id 按
  「源 id → 链接 → 标题签名」派生，但**依据本身会变**（爱范儿的 guid 从 `?p=123` 换成永久链接、
  云风换 entry id 写法、链接增删 utm）。修法三处缺一不可：候选身份表（item-id.ts 的
  `itemIdCandidates`）、落库前认回（`resolveItemIds` 的 known 索引 + `corroborates` 旁证）、
  存量合并（identity-repair.ts）。**别把「撞车退级」改回用源给的 id**——退完还用同一个 id 等于
  原地踏步，两条不同文章仍会塌成一条（既有单测抓这条）。
- **改 `lib/` 产物要在 isolates 里跑变异门槛**：注入器的 watch 会按 lib 指纹自动重载，而
  `npm run mutation` 会**临时把 lib 改坏再还原**（含 SSRF 拦截那几条）——在源目录直接跑，
  等于把带变异的代码热载进正在运行的插件。做法：把仓库复制到 /tmp（软链 node_modules）再跑。
  另外这条脚本硬杀会留下带变异的 lib（本次实测踩到：隔离副本里残留了上一次的变异，基线直接红），
  隔离副本重跑前务必从源目录**重新拷 lib**。
- **改文件前必须用 read 工具读过它**；批量改写要用**锚点唯一**的替换，别用会跨段吞噬的惰性正则
  （本会话有一次把客户端入口的 import 块整段删了，bundle 从 178KB 掉到 56KB）。
- **`lib/` 是构建产物**：它不在 git 里，但被 `package.json` 的 `files` 打进 tgz —— 发布前
  记得两个构建都跑。
