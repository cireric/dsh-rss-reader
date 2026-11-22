# 备份与恢复（本地数据）

> 适用范围：`$DSH_HOME/storages/rss-reader/` 下的**自持存储**。
> 校验器：`scripts/verify-backup.mjs`（只读，退出码 0 = 可恢复 / 2 = 拒绝）。
> 本文只写「怎么做、凭什么判断做对了」，不记录某台机器的路径与容量。

## 1. 备份的是什么

| 文件 | 内容 | 丢了会怎样 |
|---|---|---|
| `rss.db` | 条目、正文缓存、去重窗口、标签、阅读进度 | 全部文章、已读/星标/保持未读、进度 |
| `config.json` | 订阅（含 etag/lastModified 等条件请求字段）、文件夹目录、视图偏好 | **订阅清单本身**（条目还在，但没有源去更新它们） |

**不在备份里**：`reader-YYYY-MM-DD.log`（刷新日志，可再生）。
**OPML 不是备份**：见 §7。

## 2. 为什么不能直接 `cp` 一个正在写的库

库跑在 WAL 模式：新数据先落 `rss.db-wal`，checkpoint 才并回主文件。**写的时候直接拷主文件，
拷到的是「某一刻的主文件 + 缺失的 WAL」—— 恢复出来可能少最后一批写，甚至字节级撕裂。**
所以要么**停写**、要么用 SQLite 自己的快照机制。

## 3. 取得一致快照的两条路

### 3.1 停写窗口 + 离线复制（最稳，适合定期手动备份）

```bash
# 1) 停写，两条路选一条：
#    a) 只卸插件（最轻，宿主与界面都还在）：dev_uninject_plugin match=@dsh-external/dsh-rss-reader
#    b) 停整个 DSH 宿主（最彻底：所有插件、后台任务、定时器一起停，**注入器的 watch 也一起停** ——
#       否则它在备份窗口里可能把插件自动装回去，写到一半）。它就是一个 node 进程，
#       没有注册成系统服务，所以停法是「到你启动它的那个终端里 Ctrl-C」，或对监听端口的进程发 SIGTERM：
#         lsof -nP -iTCP:<Web GUI 端口> -sTCP:LISTEN    # 先确认是哪个 PID
#         kill <PID>                                    # 发 SIGTERM，等它自己退
#       ⚠️ 这一步会连同正在用 DSH 的 agent 会话一起停掉 —— **只能由人操作，不要交给 agent**。
# 2) 复制。停写之后 WAL 已被 checkpoint（实测会变成 0 字节或直接消失），只拷主文件就是完整的；
#    -wal / -shm 若还在也一并拷上（多拷不亏，少拷可能少数据）
DEST=~/rss-backup-$(date -u +%F)
mkdir -p "$DEST"
cp -p "$DSH_HOME/storages/rss-reader/rss.db"      "$DEST"/
cp -p "$DSH_HOME/storages/rss-reader/config.json" "$DEST"/
cp -p "$DSH_HOME/storages/rss-reader/rss.db-wal"  "$DEST"/ 2>/dev/null || true
cp -p "$DSH_HOME/storages/rss-reader/rss.db-shm"  "$DEST"/ 2>/dev/null || true
# 3) 恢复服务：dev_inject_plugin dir=<插件目录>，或重启 DSH
# 4) 校验（见 §4）——备份完立刻验一次，别等到要恢复的时候才发现拷坏了
```

> **同一个停写窗口里取两样东西**：`rss.db` 与 `config.json` 必须来自同一个窗口。
> 先停写再拷，两样才是同一时刻的状态；分两次拷会出现「库里有 7 个源的条目、配置里只有 6 个源」。

### 3.2 在线 `VACUUM INTO`（不停写，适合「现在就要一份」）

```bash
DEST=~/rss-backup-$(date -u +%F); mkdir -p "$DEST"
node -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.env.DSH_HOME + "/storages/rss-reader/rss.db");
  db.exec("PRAGMA busy_timeout = 5000");           // 撞上正在写的刷新就等，不直接失败
  db.exec("VACUUM INTO \"" + process.argv[1] + "/rss.db\"");
  db.close();
' "$DEST"
# config.json 是普通文件、每次都是原子重写 ⇒ 单次 cp 拿到的一定是完整的一份
cp -p "$DSH_HOME/storages/rss-reader/config.json" "$DEST"/
```

产出是**单文件**（不含 WAL）、**一致**（SQLite 自己做的快照）、通常比主库小（无空闲页）。
代价：拷的过程中库被锁一小会儿（读不受影响，写会等）。

## 4. 恢复前必须先校验

```bash
node scripts/verify-backup.mjs <备份目录>
```

它查四件事，任何一条不合格就 ⛔ **退出码 2 并拒绝恢复**：

1. `rss.db` / `config.json` 都在（缺文件是最常见的「备份压根没成功」）；
2. 库**打得开**且 `PRAGMA integrity_check` = `ok`（截断的拷贝会在这里现形）；
3. 库版本 ∈ `1..当前物理版本`（比当前**新**的库是别的插件版本写的，本版读不了，不许覆盖）；
4. **库里有条目、配置里却没有订阅** ⇒ 拒绝（与装载路径的 `assertSubscriptionsNotLost` 同一条判据：
   「返回空订阅」在用户眼里就是「我的订阅全没了」）。

它是**只读**的：不合格时你手上的原数据一个字节都不会被改动。

## 5. 恢复步骤

```bash
# 0) 停写（同 §3.1 的 a/b 两条路 —— 恢复期间同样不能有写入者；b 只能由人操作）
# 1) 校验要恢复的那份
node scripts/verify-backup.mjs <备份目录>            # 必须 EXIT=0
# 2) 把**现在**的目录挪走（mv，不是 rm —— 回滚就靠它）
mv "$DSH_HOME/storages/rss-reader" "$DSH_HOME/storages/rss-reader.before-restore-$(date -u +%F-%H%M)"
# 3) 拷回去（权限照抄：目录 0700、文件 0600）
mkdir -p "$DSH_HOME/storages/rss-reader" && chmod 700 "$DSH_HOME/storages/rss-reader"
cp -p <备份目录>/rss.db <备份目录>/config.json "$DSH_HOME/storages/rss-reader/"
# 4) 再校验一次**恢复后的目录**（防「拷到一半」）
node scripts/verify-backup.mjs "$DSH_HOME/storages/rss-reader"   # 必须 EXIT=0
# 5) 启动，并确认它真的起来了（见下）
```

启动后的三条判据（缺一条就当失败）：
1. 插件状态 `[active]`；
2. 当天 `$DSH_HOME/storages/rss-reader/reader-$(date -u +%F).log` 里**没有**「装载失败」；
3. 路由活着：`curl -X POST http://127.0.0.1:3080/rss-reader-api -d '{"endpoint":"overview","payload":{}}'` 回 **401**（不是 404）。

> 较老的库（v1/v2/v3/v4）会在**启动时自动升级**到当前版本 —— 升级只加表/加列；v1–v3 的 `link_key` 会回填，`author` 只加列、不回填，不改旧行。
> 升级是单向的：升级后的库**旧版插件打不开**，回滚只有「把第 2 步挪走的目录挪回来」这一条路。

## 6. 显式失败的四类副本（都不许「先试试看」）

| 情形 | 现象 | 处置 |
|---|---|---|
| 缺文件 | `rss.db` 或 `config.json` 不在 | 换一份备份；**不要**只恢复一半（只有库没有配置 = 订阅全丢） |
| 损坏副本 | 查询中抛错 / `integrity_check` 不是 `ok` | 换一份备份；坏副本除了当证据没有别的用途 |
| 未知版本 | `格式版本是 N，本版支持 1..M` | 用与那份备份**同代**的插件版本来恢复，再按需升级 |
| 订阅丢了 | `库里有 N 条条目，但配置里一条订阅都没有` | 那份 `config.json` 不对（常见：拷的是首次安装前的空配置）；换一份 |

原则：**任何一条不合格都不覆盖现有目录**。现网那份再旧，也比一份坏副本强。

## 7. OPML 的导出范围

| 含 | 不含 |
|---|---|
| 订阅的 **URL、标题、分组（文件夹）** | 文章、正文缓存、已读/星标/保持未读、阅读进度、标签与标签关联、视图偏好 |

也就是说：**OPML 是「订阅清单」的交换格式，不是备份**。拿 OPML 恢复会得到「源都回来了，
但一篇旧文章、一条已读记录都没有」—— 要连文章一起回来，必须用 §1 的 `rss.db` + `config.json`。
导入 OPML 时每个源都会被重新抓一遍，旧条目按新的抓取时间重新入库。

## 8. 演练记录

隔离目录演练（真库副本、只读、不动 `$DSH_HOME`）的结论写在
`.scratch/rss-reader-m5/issues/04-backup-restore.md` 的「证据」一节：正例、三种坏副本、
以及「只拷 db + config.json 不带 wal/shm 也能恢复」都实测过。
