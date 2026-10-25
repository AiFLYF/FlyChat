import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'

const require = createRequire(import.meta.url)

/**
 * 服务端持久化（SQLite）。
 *
 * 为什么用 node:sqlite 而不是 better-sqlite3：
 * 后者是原生模块，装它需要编译工具链，换机器/换 Node 版本就废；
 * node:sqlite 是 Node 22 内置的，零依赖、零编译，适合「下载即用」的产品。
 *
 * 拿不到 SQLite 时（Node 版本太老）不伪造一个假的存储层：
 * 直接把 driver 标成 off，会话接口返回 503 并说明原因，聊天功能照常可用。
 */

let db = null
let driver = 'off'
let initError = null

const SCHEMA_VERSION = 9

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL DEFAULT '',
  pinned        INTEGER NOT NULL DEFAULT 0,
  sort_index    REAL,
  using_context INTEGER NOT NULL DEFAULT 1,
  assistant_id  TEXT,
  model         TEXT,
  user_id       TEXT,
  folder_id     TEXT,
  tags          TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);

-- —— 会话文件夹（个人整理用） ——
CREATE TABLE IF NOT EXISTS folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  icon       TEXT,
  sort_index REAL,
  user_id    TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- —— 多用户 ——
-- 默认单用户模式（不建任何用户、不拦请求）。开启 MULTI_USER 后才有意义。
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  disabled      INTEGER NOT NULL DEFAULT 0,
  api_token_hash TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

-- 只存会话令牌的 sha256，数据库泄露也拿不到可用的 token
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL DEFAULT '',
  reasoning       TEXT,
  model           TEXT,
  status          TEXT,
  error           INTEGER NOT NULL DEFAULT 0,
  citations       TEXT,
  attachments     TEXT,
  group_id        TEXT,
  parent_id       TEXT,
  usage_prompt    INTEGER,
  usage_completion INTEGER,
  usage_total     INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, seq);

CREATE TABLE IF NOT EXISTS usage_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT,
  provider        TEXT,
  model           TEXT,
  prompt          INTEGER NOT NULL DEFAULT 0,
  completion      INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0,
  latency_ms      INTEGER,
  status          TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_events(provider, model);

CREATE TABLE IF NOT EXISTS shares (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT,
  user_id         TEXT,
  title           TEXT NOT NULL DEFAULT '',
  payload         TEXT NOT NULL,
  password_hash   TEXT,
  views           INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shares_conv ON shares(conversation_id);

-- —— 成本预算 ——
CREATE TABLE IF NOT EXISTS budgets (
  scope       TEXT PRIMARY KEY,
  daily_usd   REAL NOT NULL DEFAULT 0,
  monthly_usd REAL NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

-- —— 预设（模型 + 参数 + 提示 + 知识库 + 工具/MCP 组合） ——
CREATE TABLE IF NOT EXISTS presets (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  icon          TEXT,
  provider      TEXT,
  model         TEXT,
  system_prompt TEXT,
  params        TEXT,
  workspace_id  TEXT,
  mcp_servers   TEXT,
  sort_index    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- —— 知识库（RAG） ——
CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  mime        TEXT,
  size        INTEGER NOT NULL DEFAULT 0,
  chars       INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending',
  stage       TEXT,
  progress    INTEGER NOT NULL DEFAULT 0,
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  hash        TEXT,
  source_url  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_ws ON documents(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chunks (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  seq         INTEGER NOT NULL DEFAULT 0,
  heading     TEXT,
  text        TEXT NOT NULL,
  dim         INTEGER NOT NULL DEFAULT 0,
  embedding   BLOB,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunk_ws ON chunks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_chunk_doc ON chunks(document_id);
`

/**
 * 轻量迁移：`CREATE TABLE IF NOT EXISTS` 不会给已存在的表补列，
 * 所以新增字段必须在这里显式 ALTER。只做加列，不做改类型/删列（安全、可回滚）。
 *
 * 导出是为了让 `migration.test.js` 能拿一个「老结构的库」直接验证——
 * 这个坑已经踩过两次（索引建在未迁移的列上、documents 少了四列），
 * 必须有测试守着，不能靠人工记得。
 */
export function migrateSchema(database) {
  const tableExists = (table) =>
    !!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)

  const ensureColumn = (table, column, definition) => {
    // 表还没建出来（更老的库，或单测里只造了部分表）就跳过，
    // 反正 SCHEMA 里的 CREATE TABLE IF NOT EXISTS 会把它建成最新结构
    if (!tableExists(table)) return
    const cols = database.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    if (!cols.includes(column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  const ensureIndex = (sql, table) => {
    if (table && !tableExists(table)) return
    database.exec(sql)
  }
  ensureColumn('conversations', 'summary', 'TEXT')
  ensureColumn('conversations', 'leaf_message_id', 'TEXT')
  ensureColumn('conversations', 'user_id', 'TEXT')
  ensureColumn('messages', 'parent_id', 'TEXT')

  // 文档入库改成异步流水线时新增的四列。
  // 漏了这几行的后果很隐蔽：老库上「上传文档」会直接 SQL 报错，
  // 而不是任何看得懂的提示——所以每个新增列都必须在这里出现一次。
  ensureColumn('documents', 'status', "TEXT NOT NULL DEFAULT 'ready'")
  ensureColumn('documents', 'stage', 'TEXT')
  ensureColumn('documents', 'progress', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('documents', 'attempts', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('documents', 'source_url', 'TEXT')
  ensureColumn('conversations', 'folder_id', 'TEXT')
  ensureColumn('conversations', 'tags', 'TEXT')
  ensureColumn('users', 'api_token_hash', 'TEXT')
  // 分享归属：多用户模式下普通用户只能管理自己创建的分享
  ensureColumn('shares', 'user_id', 'TEXT')

  // 索引放在迁移之后建：老库如果索引建在一个尚未添加的列上，SQLite 会直接报错
  ensureIndex('CREATE INDEX IF NOT EXISTS idx_msg_parent ON messages(parent_id)', 'messages')
  ensureIndex('CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at DESC)', 'conversations')
  ensureIndex('CREATE INDEX IF NOT EXISTS idx_conv_folder ON conversations(folder_id)', 'conversations')
  ensureIndex('CREATE INDEX IF NOT EXISTS idx_folder_user ON folders(user_id)', 'folders')
}

export function initStorage() {
  if (driver !== 'off' && db) return { driver, file: config.storage.file }

  if (config.storage.driver === 'off') {
    logger.warn('已通过 FLYCHAT_STORAGE=off 关闭服务端持久化')
    driver = 'off'
    return { driver }
  }

  try {
    // 动态 require：老版本 Node 上这里会抛，被 catch 住后降级
    const { DatabaseSync } = require('node:sqlite')
    fs.mkdirSync(path.dirname(config.storage.file), { recursive: true })
    db = new DatabaseSync(config.storage.file)
    // WAL：读写不互相阻塞；busy_timeout 避免并发写直接报 SQLITE_BUSY
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(SCHEMA)
    migrateSchema(db)

    // 默认知识库：任何入口都可能直接往 default 里传文档，必须在初始化时就存在
    db.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      'default',
      '默认知识库',
      Date.now(),
      Date.now()
    )

    // MCP server 配置表：由 routes/mcp.js 使用
    db.exec(
      `CREATE TABLE IF NOT EXISTS mcp_servers (
         id            TEXT PRIMARY KEY,
         name          TEXT NOT NULL,
         transport     TEXT NOT NULL,
         command       TEXT,
         args          TEXT,
         env           TEXT,
         base_url      TEXT,
         headers       TEXT,
         enabled       INTEGER NOT NULL DEFAULT 0,
         trusted       INTEGER NOT NULL DEFAULT 0,
         disabled_tools TEXT,
         last_error    TEXT,
         tool_count    INTEGER NOT NULL DEFAULT 0,
         created_at    INTEGER NOT NULL,
         updated_at    INTEGER NOT NULL
       )`
    )

    // 摘要缓存表：由 lib/compact.js 在压缩上下文时使用，放这里保证表一定存在
    db.exec(
      `CREATE TABLE IF NOT EXISTS context_summaries (
         prefix_key     TEXT PRIMARY KEY,
         summary        TEXT NOT NULL,
         message_count  INTEGER NOT NULL DEFAULT 0,
         tokens         INTEGER NOT NULL DEFAULT 0,
         model          TEXT,
         created_at     INTEGER NOT NULL
       )`
    )

    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
    if (!row) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
    } else if (Number(row.value) !== SCHEMA_VERSION) {
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version')
    }
    driver = 'sqlite'
    logger.info('服务端持久化已就绪', { driver, file: config.storage.file })
  } catch (err) {
    initError = err?.message || String(err)
    driver = 'off'
    db = null
    logger.warn('SQLite 不可用，服务端会话持久化已关闭（聊天功能不受影响）', {
      reason: initError,
      hint: '需要 Node 22.5+；或用 FLYCHAT_STORAGE=off 显式关闭',
    })
  }
  return { driver, file: config.storage.file }
}

export function getDb() {
  if (!db) throw Object.assign(new Error('服务端持久化不可用'), { status: 503, code: 'storage_unavailable' })
  return db
}

export function storageStatus() {
  return {
    driver,
    file: driver === 'sqlite' ? config.storage.file : null,
    error: initError,
    available: driver === 'sqlite',
  }
}

/** 事务包装：回调里抛错自动回滚 */
export function transaction(fn) {
  const database = getDb()
  database.exec('BEGIN')
  try {
    const result = fn(database)
    database.exec('COMMIT')
    return result
  } catch (err) {
    try {
      database.exec('ROLLBACK')
    } catch {
      /* 事务可能已被 SQLite 自动回滚 */
    }
    throw err
  }
}

export function closeStorage() {
  try {
    db?.close()
  } catch {
    /* ignore */
  }
  db = null
  driver = 'off'
}

/** 测试用：重置模块状态，指向新的数据库文件 */
export function resetStorageForTest() {
  closeStorage()
  initError = null
}
