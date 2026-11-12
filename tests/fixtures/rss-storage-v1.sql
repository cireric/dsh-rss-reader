-- 取自搜索加入前的 8f852d2，固定 v1 格式，避免当前建表代码同时改变兼容性夹具。
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
    recency         TEXT NOT NULL GENERATED ALWAYS AS (COALESCE(published_at, fetched_at)) VIRTUAL
  );

  -- 每源列表与每源未读计数
  CREATE INDEX i1 ON items(feed_id, recency DESC);
  -- 跨源 top-N 与 keyset 分页（spec §10 的排序键）
  CREATE INDEX i2 ON items(recency DESC, id ASC);

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
PRAGMA user_version = 1;
