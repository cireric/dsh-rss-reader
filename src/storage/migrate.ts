/**
 * 一次性迁移：存储域文件 → 自持存储（Task 4，cutover 的单向门）。
 *
 * **为什么必须有它**：自持之后插件不再读 `storages/rss_reader.json`（域模型整份进内存、
 * 每次写整份重写，200 源 × 500 条下一次批量标已读 6.4 s —— 见 spec §1.3）。而用户已有的
 * 订阅、已读态、星标、去重窗口全都躺在那个文件里，切换入口的前提就是先把它们搬进新落点。
 *
 * **老文件只读**（Global Constraints「迁移只读它，原样留存」）。这里全程只有一次
 * `readFileSync`，没有任何 write/rename/unlink —— 用户的备份脚本读的就是这个路径
 * （spec §9.2），动它等于让备份拿到一份迁移中途的半截数据。
 *
 * 三条不能破的保证，各自的理由都不在「代码好不好看」上：
 *
 * ① **认不出就响亮失败，绝不回落成空库**。这是本任务最容易犯且最难发现的错：把一个读不出来的
 *    文件当成「没有老文件」，于是静静建出一个空库 —— 用户看到的是「我的订阅全没了」，而
 *    所有断言都绿。所以「文件不存在」（ENOENT）与「读不出来」（EISDIR / 越过 512 MiB 墙 /
 *    JSON 损坏 / 别人的域文件）走**两条**完全不同的路：前者是首次安装，后者抛错。
 *
 * ② **重入幂等，且判据不只看 items 张数**。中断可能发生在两处：库那份提交了、config.json 那份
 *    还没写（此时只补配置，不重放条目）；或迁移早已完成、用户又清理过条目（此时 items 回到 0 行，
 *    只按 items 判会把用户删掉的条目、退订的源全部复活成未读）。所以闸门是
 *    「config.json 已经在了 ⇒ 这是迁移后的世界，一律不碰」＋「items 非空 ⇒ 条目已落地，只补配置」。
 *
 * ③ **老正文形态必须先折成 blocks**（`normalizeLegacyArticle`）。库里没有存 paragraphs 的列，
 *    原样搬进去会被 store-sqlite 当场拒绝（它宁可拒绝也不静默丢正文）；而「拒绝」若被绕过成
 *    「当没有正文」，用户在详情页看到的就是正文凭空消失。转换口径只有 domain.ts 那一处，
 *    这里不另抄一份 —— 迁移期间漏了这一步会当场炸，正是我们想要的失败方式。
 *
 * 写入顺序：**先库、后 config.json**。两者落在不同介质上（SQLite vs 文件），中间失败没有共同
 * 回滚 —— 所以顺序本身就是正确性：库先落地时最坏是「有数据没订阅」，重入走 ② 的第一条修好；
 * 反过来最坏是「有订阅没数据」，那在用户眼里就是订阅列表全是空的。
 */
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import {
  cursorRecordSchema,
  feedRecordSchema,
  itemRecordSchema,
  normalizeLegacyArticle,
  type CursorRecord,
  type FeedRecord,
  type ItemRecord,
} from '../domain.js'
import { writeConfigFile, type ReaderConfigFile } from './config-file.js'
import { createSqliteStore } from '../store-sqlite.js'

/** 老文件的域身份：域名与版本都必须逐字对上，认不出就不猜。 */
const DOMAIN_NAME = 'rss_reader'
const DOMAIN_VERSION = 1

/** 迁移结果。`skipped` 为真时三个计数都是 0（没有一行被这次调用写入）。 */
export interface MigrationResult {
  feeds: number
  items: number
  cursors: number
  skipped: boolean
}

export interface MigrateOptions {
  /** 老域文件的路径（`<DSH_HOME>/storages/rss_reader.json`）。**只读**。 */
  domainPath: string
  /** 已 `openDatabase` + `migrateSchema` 过的库。 */
  db: DatabaseSync
  /** `config.json` 的落点。 */
  configPath: string
  /** 留痕用。首装跳过 / 中断修复都要在这里说话（禁止静默）。 */
  log: (message: string) => void
}

const SKIP: MigrationResult = { feeds: 0, items: 0, cursors: 0, skipped: true }

const errnoOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''

/**
 * 把老域文件里的订阅 / 条目 / 去重窗口搬进自持存储。可反复调用。
 *
 * @throws 老文件存在但读不出来、不是合法 JSON、域名或版本对不上、任一条记录不合 schema 时。
 *   这些情况下**不写任何东西**：老文件原样、库原样、config.json 不生成。
 */
export async function migrateFromDomainFile(options: MigrateOptions): Promise<MigrationResult> {
  const { domainPath, db, configPath, log } = options

  // 闸门一：config.json 已经在了 ⇒ 这是迁移之后的世界。它同时是「订阅的唯一可备份副本」，
  // 是当前真相；再拿老文件覆盖一遍，会把用户退订的源、删掉的条目、新加的源全部回退。
  //
  // 闸门二：items 非空、但 config.json 不在 ⇒ 上次迁移「库提交了、配置没写成」就中断了。
  // 条目已经是事实，只补配置；重放条目只会得到重复行（Review Focus 3）。
  const existingItems = countItems(db)
  if (configPresent(configPath)) {
    log('迁移跳过：' + configPath + ' 已存在（订阅以它为准，不重放老文件）')
    return SKIP
  }
  if (existingItems > 0) {
    log('迁移补写：库已有 ' + existingItems + ' 条条目，但 ' + configPath + ' 缺失，按老文件补写订阅映射')
    const interrupted = readLegacy(domainPath)
    if (interrupted === undefined) {
      // 库里有条目、老文件又没了：配置那一半已经无法重建。静默继续会让插件带着「没有订阅」
      // 的库跑下去（用户看到订阅列表空白），必须响亮说出这件事，把处置权交回用户。
      throw new Error(
        '库里有 ' + existingItems + ' 条条目，但 ' + domainPath + ' 不存在，订阅映射无从重建：' +
          '请从备份恢复 config.json 或老文件。不静默继续 —— 那会让用户看到一份空订阅列表。',
      )
    }
    writeConfig(configPath, interrupted.feeds, interrupted.viewPreferences)
    return SKIP
  }

  const legacy = readLegacy(domainPath)
  if (legacy === undefined) {
    log('迁移跳过：' + domainPath + ' 不存在（首次安装；未生成空订阅，交给 Config.feeds 做种子）')
    return SKIP
  }

  // 老正文形态在这里折成 blocks（保证 ③）。fold 是纯函数、对新形态返回同一个引用。
  const items: Array<[string, ItemRecord]> = legacy.itemEntries.map(([id, record]) => [
    id,
    normalizeLegacyArticle(record),
  ])

  // 单事务（brief 的硬要求）：几万行途中断在中间会留下「导入了一半的库」，
  // 而重入判据是「items 非空就跳过」—— 半份数据看起来与完整迁移一模一样。
  const store = createSqliteStore(db, configPath)
  await runInTransaction(db, async () => {
    for (const [itemId, record] of items) await store.saveItem(itemId, record)
    for (const [feedId, record] of legacy.cursorEntries) await store.saveCursor(feedId, record)
  })

  // 库成功之后才写配置（顺序即正确性，见文件头）。
  writeConfig(configPath, legacy.feeds, legacy.viewPreferences)
  const feeds = Object.keys(legacy.feeds).length
  log(
    '迁移完成：' + feeds + ' 个订阅源、' + items.length +
      ' 条条目、' + legacy.cursorEntries.length + ' 个去重窗口（老文件原样保留）',
  )
  return { feeds, items: items.length, cursors: legacy.cursorEntries.length, skipped: false }
}

/**
 * 分得清「没有这个文件」与「有但读不出来」——后者是 Review Focus 1 的缺陷本体：
 * 把一次读取失败当成「还没迁移过」，迁移就会去覆盖一份自己都读不出的文件。
 */
function configPresent(path: string): boolean {
  try {
    readFileSync(path, 'utf8')
    return true
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return false
    // EISDIR / EACCES：按「已存在」处理，让 store 在读它时响亮失败（它自己的语义就是那样）
    return true
  }
}

function countItems(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM items').get()
  const value = row?.n
  if (typeof value !== 'number') {
    throw new Error('读不出订阅库的条目数（返回 ' + JSON.stringify(row) + '）：库被外部改动过？')
  }
  return value
}

/** 从老文件里读出来、校验过的那一份；`undefined` 表示文件不存在（首次安装）。 */
interface LegacyData {
  feeds: Record<string, FeedRecord>
  itemEntries: Array<[string, ItemRecord]>
  cursorEntries: Array<[string, CursorRecord]>
  /** 域的 global 槽原值；null 是「从未写过」的哨兵，与「缺键」一样落成 config 里无此键。 */
  viewPreferences: unknown
}

/**
 * 整份读 + 校验。**只有 ENOENT 返回 undefined**，其余一切异常都带路径抛出去。
 *
 * 逐表逐记录过 zod schema（与域设施用的是同一份）：形状不对的记录原样搬进新库，
 * 等于把「打不开的域」换成了「能打开但读得出一堆垃圾的库」，问题只会更晚被发现。
 */
function readLegacy(domainPath: string): LegacyData | undefined {
  let text: string
  try {
    text = readFileSync(domainPath, 'utf8')
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return undefined
    // EISDIR / EACCES / ERR_STRING_TOO_LONG（越过 512 MiB 字符串墙，spec §8）
    // 走到这里若被当成「首次安装」，用户的数据就没了 —— 必须响亮
    throw new Error(
      '读取老订阅文件 ' + domainPath + ' 失败（已保留原文件，未做任何写入）：' + String(error),
      { cause: error },
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(
      '老订阅文件 ' + domainPath + ' 不是合法 JSON（已保留原文件，未做任何写入）：' + String(error),
      { cause: error },
    )
  }

  const root = asRecord(parsed, domainPath, '顶层')
  const unit = asRecord(root.unit, domainPath, 'unit')
  if (unit.name !== DOMAIN_NAME) {
    throw new Error(
      '老订阅文件 ' + domainPath + ' 的 unit.name 是 ' + JSON.stringify(unit.name) + '，不是 ' +
        JSON.stringify(DOMAIN_NAME) +
        '：按本插件的形状解释别人的域文件只会把无关字段搬进来，拒绝迁移。',
    )
  }
  if (unit.version !== DOMAIN_VERSION) {
    throw new Error(
      '老订阅文件 ' + domainPath + ' 的 unit.version 是 ' + JSON.stringify(unit.version) +
        '，本版只认 ' + DOMAIN_VERSION +
        '：不硬按 v1 的形状解释它（那会丢掉这个版本不认识的字段）。请升级插件，或从备份恢复。',
    )
  }

  const tables = asRecord(root.tables, domainPath, 'tables')
  const feeds = table(tables.feeds, domainPath, 'feeds')
  const items = table(tables.items, domainPath, 'items')
  const cursors = table(tables.cursors, domainPath, 'cursors')

  const validFeeds: Record<string, FeedRecord> = {}
  for (const [feedId, raw] of Object.entries(feeds)) {
    const result = feedRecordSchema.safeParse(raw)
    if (!result.success) {
      throw new Error(
        '老订阅文件 ' + domainPath + ' 里的源 ' + feedId + ' 不合 FeedRecord：' + result.error.message,
        { cause: result.error },
      )
    }
    validFeeds[feedId] = result.data
  }

  const itemEntries: Array<[string, ItemRecord]> = []
  for (const [itemId, raw] of Object.entries(items)) {
    const result = itemRecordSchema.safeParse(raw)
    if (!result.success) {
      throw new Error(
        '老订阅文件 ' + domainPath + ' 里的条目 ' + itemId + ' 不合 ItemRecord：' + result.error.message,
        { cause: result.error },
      )
    }
    itemEntries.push([itemId, result.data])
  }

  const cursorEntries: Array<[string, CursorRecord]> = []
  for (const [feedId, raw] of Object.entries(cursors)) {
    const result = cursorRecordSchema.safeParse(raw)
    if (!result.success) {
      throw new Error(
        '老订阅文件 ' + domainPath + ' 里的游标 ' + feedId + ' 不合 CursorRecord：' + result.error.message,
        { cause: result.error },
      )
    }
    cursorEntries.push([feedId, result.data])
  }

  // global 为 null（「从未写过」的哨兵）或缺键都落成 undefined ⇒ config.json 不写 viewPreferences。
  // 这里的值**不预先归一**：它是「用户当前记着的东西」，读侧（store.viewPreferences）会归一；
  // 在迁移里归一等于替用户丢掉他还没被新版认出来的记忆。
  const global = root.global
  return { feeds: validFeeds, itemEntries, cursorEntries, viewPreferences: global === null ? undefined : global }
}

/** `{ version: 1, feeds, viewPreferences? }`；viewPreferences 缺席时**不落键**（与 store 同一约定）。 */
function writeConfig(configPath: string, feeds: Record<string, FeedRecord>, viewPreferences: unknown): void {
  const value: ReaderConfigFile = { version: 1, feeds }
  if (viewPreferences !== undefined) value.viewPreferences = viewPreferences
  writeConfigFile(configPath, value)
}

function asRecord(value: unknown, path: string, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('老订阅文件 ' + path + ' 的 ' + what + ' 不是对象（读到 ' + typeof value + '）：拒绝迁移。')
  }
  return value as Record<string, unknown>
}

function table(value: unknown, path: string, name: string): Record<string, unknown> {
  if (value === undefined) return {}
  return asRecord(value, path, 'tables.' + name)
}

/**
 * 单事务。与 store-sqlite 的 runInTransaction 同一条理由：调用方可能已经开着事务
 * （那时 BEGIN 会直接抛 "cannot start a transaction within a transaction"），
 * 所以嵌套时用 SAVEPOINT，提交权留给开事务的那个人。
 *
 * 回滚失败必须与原错误一起抛出：吞掉它等于留下一个说不清的半份库（本仓库禁空 catch）。
 *
 * **为什么里面是 `await` 而不是同步 for 循环**：`store.saveItem` 是 async（接口的既有签名），
 * 它内部的 schema 校验抛错只会变成**被拒绝的 Promise** —— 同步循环里没人接，那一行就静默丢失，
 * 而事务照样提交，留下半份数据（正是本文件要避免的形态）。await 让失败在这里现身并触发回滚。
 * await 只让出微任务：Node 会把微任务队列排空后才回到事件循环，所以事务开着的这段时间里
 * 不会有别的 I/O 回调插进来（db 又是单连接），「提交权属于开事务的人」依然成立。
 */
async function runInTransaction(db: DatabaseSync, write: () => Promise<void>): Promise<void> {
  const nested = db.isTransaction
  const savepoint = 'rss_migrate'
  if (nested) db.exec('SAVEPOINT ' + savepoint)
  else db.exec('BEGIN')
  try {
    await write()
  } catch (error) {
    try {
      if (nested) {
        db.exec('ROLLBACK TO ' + savepoint)
        db.exec('RELEASE ' + savepoint)
      } else {
        db.exec('ROLLBACK')
      }
    } catch (rollbackError) {
      throw new Error(
        '迁移失败且回滚也失败：' + String(error) + '；回滚错误：' + String(rollbackError),
        { cause: error },
      )
    }
    throw new Error(
      '迁移写入失败（已回滚，库仍是迁移前的样子，老文件未动，可重试）：' + String(error),
      { cause: error },
    )
  }
  if (nested) db.exec('RELEASE ' + savepoint)
  else db.exec('COMMIT')
}
