/**
 * 自持数据库的打开序列与物理布局版本（host 半）。
 *
 * **为什么自己上 SQLite 而不是继续用存储域**：域是「整份进内存 + 每次写整份重写」的模型，
 * 200 源 × 500 条（10 万行）下一次批量标已读要 4.1 s（实测，见 spec §9.3）。
 * 详见 docs/superpowers/specs/2026-10-11-large-scale-storage.md §1.3、§4.2。
 *
 * 打开序列与权限做法照 `@deepseek-ai/dsh-storage-sqlite/src/schema.ts:36-107` 的先例
 * （`open(path,'wx',0o600)` 预建 + `user_version` 拒绝），但那是个独立包、有自己的库身份，
 * 这里只借做法不引依赖。
 */
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { linkKeyOf } from '../duplicates.js'

/**
 * 物理布局版本，存在 `PRAGMA user_version`。
 *
 * 与「条目/订阅的记录形状」无关，只描述**表结构本身**。任何破坏性改动都必须升它，
 * 而升它就必须同时想清楚老库怎么办 —— 本模块只会**拒绝**不认识的版本，不做原地迁移。
 */
export const SCHEMA_VERSION = 4

/**
 * 本版**能打开并升级**的旧版本。
 *
 * - v1 = M2 05 之前的真实表形状（tests/fixtures/rss-storage-v1.sql）；
 * - v2 = 加了 tags/item_tags 却没有 reading_progress 的形状（M5 02 之前的库）。
 *
 * 两条升级都**只加表**，不改 items/texts/cursors 的任何一行。
 */
const UPGRADABLE_VERSIONS = new Set([1, 2, 3])

/** 出错时的消息尾巴：把「去找什么」写清楚，比只报 errno 有用。 */
const errnoOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''

/**
 * 打开（必要时创建）订阅数据库。
 *
 * 顺序上**先预建文件**再 `new DatabaseSync`：实测（Node v24.19）`new DatabaseSync(path)`
 * 建出的文件是 **0644**（受 umask 支配），而库里放的是用户的订阅与已读态，必须 0600。
 * 预建之后 `-wal` / `-shm` 边车随主库继承 0600（实测）。**已存在的文件保留原权限**，
 * 与官方实现同一条规矩（那份注释写的是 "Existing files retain their modes"）。
 *
 * 版本不认识就**响亮抛错**：静默降级或重建库等于把用户的已读态、星标连同桌面上的订阅一起丢掉。
 *
 * @param path 库文件路径，或 `:memory:`（测试用）。
 * @throws 库的 `user_version` 既不是 0（全新）、可升级的 1，也不是 {@link SCHEMA_VERSION} 时，消息含路径。
 */
export function openDatabase(path: string): DatabaseSync {
  const isMemory = path === ':memory:'
  const actual = isMemory ? path : resolve(path)
  if (!isMemory) createDatabaseFile(actual)
  const db = new DatabaseSync(actual)
  try {
    configureDatabase(db, actual)
    return db
  } catch (error) {
    // 打开失败的句柄必须关掉，否则迁移重试会把「已经被自己占着」误判成并发占用
    db.close()
    throw error
  }
}

/**
 * 独占创建库文件，权限 0600。文件已存在就原样留着（`EEXIST` 是正常路径，不是错误）。
 */
function createDatabaseFile(path: string): void {
  // 父目录 0700：库里是用户数据，目录可被他人列举本身就已经是泄漏面
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new Error(
      `无法创建订阅数据库的父目录 ${dirname(path)}：${errnoOf(error)} ${String(error)}`,
      { cause: error },
    )
  }
  try {
    closeSync(openSync(path, 'wx', 0o600))
  } catch (error) {
    if (errnoOf(error) !== 'EEXIST') {
      throw new Error(`无法创建订阅数据库文件 ${path}：${String(error)}`, { cause: error })
    }
  }
}

/** 打开即应用的连接级设置；任何一项失败都让整个打开失败（宁可打不开，不可半配）。 */
function configureDatabase(db: DatabaseSync, path: string): void {
  try {
    // WAL：读写不互相阻塞，长抓取期间用户标已读不会被卡住
    db.exec('PRAGMA journal_mode = WAL')
    // 并发写排队而不是立刻 SQLITE_BUSY（多实例/迁移脚本与插件同时开着库时）
    db.exec('PRAGMA busy_timeout = 5000')
    // 实测 node:sqlite 的默认值已是 1（与 sqlite3 CLI 的 0 不同），仍显式写死：
    // texts 的 ON DELETE CASCADE 靠它生效，不把正确性押在某个版本的默认值上
    db.exec('PRAGMA foreign_keys = ON')
  } catch (error) {
    throw new Error(`配置订阅数据库 ${path} 失败：${String(error)}`, { cause: error })
  }
  const row = db.prepare('PRAGMA user_version').get()
  const onDisk = row?.user_version
  if (typeof onDisk !== 'number') {
    // 认不出就不猜：把「读不出来」当 0 会让下面的拒绝逻辑失效
    throw new Error(`读不出订阅数据库 ${path} 的格式版本（返回 ${JSON.stringify(row)}）`)
  }
  if (onDisk !== 0 && onDisk !== SCHEMA_VERSION && !UPGRADABLE_VERSIONS.has(onDisk)) {
    throw new Error(
      `订阅数据库 ${path} 的格式版本是 ${onDisk}，本版只能读 ${SCHEMA_VERSION}（或从 v1 升级）：` +
        '不会降级或重建（那会丢掉已读态与星标）。请升级插件，或从备份恢复后重试。',
    )
  }
}

/**
 * 在**一个事务**里执行 DDL 并盖版本章。失败必须把版本号与所有新建对象一起回滚 ——
 * 「表建了一半、版本却盖了」会让下一次启动误以为库已完整，是最坏的半成品形态。
 */
function applyDdl(db: DatabaseSync, label: string, ddl: string, after?: (db: DatabaseSync) => void): void {
  db.exec('BEGIN')
  try {
    db.exec(ddl)
    // 数据回填必须与 DDL 在**同一个事务**里。先盖章再回填的话，中途崩掉会留下一个
    // 「版本已是新版本、列却全空」的库 —— 功能静默失效，而版本闸放行，没有任何报错。
    after?.(db)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch (rollbackError) {
      // 回滚失败会让库停在半建状态，必须与原始错误一起暴露；吞掉它等于留下一个说不清的坏库
      throw new Error(
        `${label}失败且回滚也失败：${String(error)}；回滚错误：${String(rollbackError)}`,
        { cause: error },
      )
    }
    throw new Error(`${label}失败（已回滚，版本号未变，可安全重试）：${String(error)}`, { cause: error })
  }
}

/**
 * v4 给 items 加一列 `link_key`（原文链接的归一化键，M5 03 的跨源重复提示按它批量查）。
 *
 * - **为什么是列而不是每次现算**：提示要按「可见条目」批量查候选，而候选在别的页、别的源
 *   （票据要求跨页也能找到）。现算只能把整张 items 表的 link 搬进 JS 扫一遍 —— 票据明令禁止。
 *   列 + 索引把这件事变成一次 IN 查询。
 * - 值由 `duplicates.ts` 的 linkKeyOf 算（同一处规则），写入路径在 store-sqlite 的 writeItem。
 * - 老库升级必须**回填**，且回填与 DDL 同一事务（见 applyDdl 的注释）。
 */
const LINK_KEY_DDL = `
  ALTER TABLE items ADD COLUMN link_key TEXT;
  CREATE INDEX i3 ON items(link_key);
`

/** 给已有行补 link_key。解析不出的链接写空串（与 linkKeyOf 的「不参与判定」同义）。 */
function backfillLinkKeys(db: DatabaseSync): void {
  const rows = db.prepare('SELECT id, link FROM items').all()
  const update = db.prepare('UPDATE items SET link_key = ? WHERE id = ?')
  for (const row of rows) {
    const id = row.id
    const link = row.link
    if (typeof id !== 'string' || typeof link !== 'string') {
      throw new Error('items 行形状异常：id/link 不是字符串（' + JSON.stringify(row) + '）')
    }
    update.run(linkKeyOf(link), id)
  }
}

/** v1 的库必须真的具备三张基础表；否则宁可拒绝升级，也不把空壳盖成 v2。 */
function assertV1Schema(db: DatabaseSync): void {
  const names = new Set<string>()
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    if (typeof row.name === 'string') names.add(row.name)
  }
  const missing = ['items', 'texts', 'cursors'].filter((name) => !names.has(name))
  if (missing.length > 0) {
    throw new Error(
      '订阅数据库自称是 v1，但缺少表 ' + missing.join(', ') + '：拒绝升级（不拿空壳盖版本章）。',
    )
  }
}

/**
 * 建表/升级并盖版本章。幂等：已经盖过章就直接返回（插件每次装载都会走一遍）。
 *
 * 升级路径有两条，都是**只加表**：v1 → v3（M2 05 的 tags/item_tags + M5 02 的 reading_progress）、
 * v2 → v3（只加 reading_progress）。items/texts/cursors 一行都不改，所以旧条目、正文缓存、
 * 订阅归属与阅读状态在升级中保持原样；升级后的库不再能被旧版插件打开（旧版的版本闸只认
 * 自己那一版），回滚路径是从备份恢复 rss.db。
 */
export function migrateSchema(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get()
  const onDisk = row?.user_version
  if (onDisk === SCHEMA_VERSION) return
  if (typeof onDisk !== 'number') {
    throw new Error(`读不出订阅数据库的格式版本（返回 ${JSON.stringify(row)}）`)
  }
  if (onDisk === 0) {
    applyDdl(db, '建表', SCHEMA_DDL)
    return
  }
  if (onDisk === 1) {
    assertV1Schema(db)
    // v1 直接补到当前版本：所有 DDL 在**同一个事务**里，避免「盖了版本章却少一张表」
    applyDdl(db, 'v1→v4 升级', TAGS_DDL + PROGRESS_DDL + LINK_KEY_DDL, backfillLinkKeys)
    return
  }
  if (onDisk === 2) {
    applyDdl(db, 'v2→v4 升级', PROGRESS_DDL + LINK_KEY_DDL, backfillLinkKeys)
    return
  }
  if (onDisk === 3) {
    applyDdl(db, 'v3→v4 升级', LINK_KEY_DDL, backfillLinkKeys)
    return
  }
  throw new Error(
    `订阅数据库的格式版本是 ${onDisk}，不是空库（0）、可升级的 v1/v2/v3 或当前版本 ${SCHEMA_VERSION}：` +
      '拒绝建表/升级，以免把不认识的库覆盖成半成品。',
  )
}

/**
 * 表结构（spec §11.2 的参考 schema，逐字采用）。
 *
 * - `items.recency` 是**生成列**而不是写入口：排序键必须是 `COALESCE(published_at, fetched_at)`
 *   （spec §10）。缺发布时间的条目若落进 SQL 的 NULL 段，列表顺序就与迁移前不一致 ——
 *   生成列让「写入方漏填」这件事根本不可能发生。
 * - `summary` 留在 items 行内、正文另表：SQLite 没有「整份文件必须读进一个字符串」的墙，
 *   行是按需读的（spec §10.2）。
 * - `texts.revision` / `frameable` / `title` 同为 articleRecordSchema 的字段，
 *   `revision` 是「缓存是否过期」的判据，缺了整张表就退化成不可判（spec §11.2 的注释）。
 * - **`texts.fetched_at` 是 Task 3 加的一列**（原参考 schema 没有它）：`articleRecordSchema.fetchedAt`
 *   是**必填**字段，而 `refresh.ts:118` 的 `record.article?.fetchedAt` 是正文缓存淘汰的排序键 ——
 *   没有它，「正文缓存超限从最旧清起」退化成整表不可判（全部 fetchedAt 相同）。
 *   与 spec 保留 revision/frameable/title 是同一条理由。
 * - **`texts.fetched_at` 是 `NOT NULL`**（2026-10-11 终检修复轮：原 DDL 漏了约束）。
 *   读侧三处（item() / listItems() / allItems()）都走 `requiredText(row.article_fetched_at, ...)`，
 *   而 DDL 原先允许 NULL ⇒ 一条 NULL 行会让这三处**全都抛**。本版自己的写入口写不出它
 *   （`articleRecordSchema.fetchedAt` 是必填），但「本版不可达」不是「不可能」——
 *   库里是用户数据，手工改库、别的写者、以后的迁移代码都能造出那一行，而报错发生在读路径上。
 *   改的是建表语句，不是已建库的迁移：本版尚未发布，没有任何库需要回填（迁移也未开始）。
 * - `cursors.seen` 存 id 窗口的 JSON 文本：窗口是每源 5000 个 id 的定长列表，
 *   没有按单个 id 查询的需求，拆成行只会换来百万行表（spec §2 的漏项表）。
 */
const BASE_SCHEMA_DDL = `
  CREATE TABLE items (
    id              TEXT PRIMARY KEY,
    feed_id         TEXT NOT NULL,
    title           TEXT NOT NULL,
    link            TEXT NOT NULL,
    published_at    TEXT,
    fetched_at      TEXT NOT NULL,
    summary         TEXT,
    read_at         TEXT,
    starred         INTEGER NOT NULL DEFAULT 0,
    kept_unread     INTEGER NOT NULL DEFAULT 0,
    article_failure TEXT,
    -- 原文链接的归一化键（M5 03）：'' = 不参与重复判定。写入在 store-sqlite 的 writeItem，
    -- 规则在 duplicates.ts 的 linkKeyOf —— 这里是**派生列**，不是第二份真相。
    link_key        TEXT,
    recency         TEXT NOT NULL GENERATED ALWAYS AS (COALESCE(published_at, fetched_at)) VIRTUAL
  );

  -- 每源列表与每源未读计数
  CREATE INDEX i1 ON items(feed_id, recency DESC);
  -- 跨源 top-N 与 keyset 分页（spec §10 的排序键）
  CREATE INDEX i2 ON items(recency DESC, id ASC);
  -- 跨源重复提示的批量查（M5 03）：WHERE link_key IN (…) 走这条索引
  CREATE INDEX i3 ON items(link_key);

  CREATE TABLE texts (
    item_id    TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    revision   INTEGER,
    frameable  INTEGER,
    title      TEXT,
    -- articleRecord.fetchedAt：正文缓存淘汰的排序键（见上方注释）
    fetched_at TEXT NOT NULL
  );

  CREATE TABLE cursors (
    feed_id   TEXT PRIMARY KEY,
    seen      TEXT NOT NULL,
    cursor_at TEXT
  );
`

/**
 * v2 新增的两张表（M2 05）。**v1→v2 只执行这一段**，因此升级不会碰旧表的任何一行。
 *
 * - tags.name 的唯一约束是**精确名称**（SQLite 默认 BINARY collation）：与创建时的 trim 规则
 *   合起来，用户能预期「同名拒绝」；不做大小写折叠是首版可逆默认。
 * - item_tags 的联合主键让重复关联天然幂等；两侧外键 ON DELETE CASCADE 分别覆盖
 *   「文章被清理/退订删除」与「标签被删除」两条生命周期。
 * - item_tags_by_tag 服务「按标签筛文章」的 JOIN（标签→文章方向）。
 */
const TAGS_DDL = `
  CREATE TABLE tags (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE item_tags (
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, tag_id)
  );

  CREATE INDEX item_tags_by_tag ON item_tags(tag_id, item_id);
`

/**
 * v3 新增的阅读进度表（M5 02）。**v2→v3 只执行这一段**，因此升级不会碰旧表的任何一行。
 *
 * - 主键 = 条目 id：一条正文只记一个位置（新的覆盖旧的）。
 * - `version` 是**正文内容标识**（抽取器修订号 + 正文块摘要，见 article.ts 的 contentVersionOf）：
 *   读进度时按 (item_id, version) 匹配，版本对不上就当没进度 —— 同一修订号下正文变了也能识别。
 * - `ratio` 是 0..1 的滚动比例而不是像素：正文高度会随图片进场变化，像素位置会漂。
 *   ⚠️ 写入前一律过 shared.ts 的 clampReadingRatio（库是用户数据，不能假设写进来的都合法）。
 * - 外键 ON DELETE CASCADE 覆盖「条目被删/被裁」这一条生命周期；cache 淘汰走显式删除
 *   （capArticleCache），与 texts 的删除同一处发生。
 */
const PROGRESS_DDL = `
  CREATE TABLE reading_progress (
    item_id    TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    version    TEXT NOT NULL,
    ratio      REAL NOT NULL,
    updated_at TEXT NOT NULL
  );
`

/** 全新库一次建到当前版本；升级路径见 migrateSchema（v1/v2 都只补表）。 */
const SCHEMA_DDL = BASE_SCHEMA_DDL + TAGS_DDL + PROGRESS_DDL
