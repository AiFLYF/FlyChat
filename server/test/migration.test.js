import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { prepareEnv } from './helpers/setup.js'

prepareEnv()

const { migrateSchema } = await import('../store/db.js')

/**
 * 老版本的库结构（schema v1 时期）。
 * 这些测试守着一个已经踩过两次的坑：
 * `CREATE TABLE IF NOT EXISTS` 不会给已存在的表补列，
 * 新列必须在 migrate 里显式 ALTER，否则老用户升级上来直接 SQL 报错。
 */
function oldSchemaDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta (key, value) VALUES ('schema_version', '1');

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      sort_index REAL,
      using_context INTEGER NOT NULL DEFAULT 1,
      assistant_id TEXT,
      model TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      reasoning TEXT,
      model TEXT,
      status TEXT,
      error TEXT,
      citations TEXT,
      attachments TEXT,
      group_id TEXT,
      usage_prompt INTEGER,
      usage_completion INTEGER,
      usage_total INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      mime TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      chars INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1', '老会话', 1, 1);
    INSERT INTO messages (id, conversation_id, seq, role, content, created_at)
      VALUES ('m1', 'c1', 0, 'user', '老消息', 1);
    INSERT INTO documents (id, workspace_id, name, chunk_count, created_at, updated_at)
      VALUES ('d1', 'default', '老文档', 3, 1, 1);
  `)
  return db
}

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)

test('老库迁移：conversations / messages 的新列都补上', () => {
  const db = oldSchemaDb()
  migrateSchema(db)

  const conv = columns(db, 'conversations')
  for (const col of ['summary', 'leaf_message_id', 'user_id', 'folder_id', 'tags']) {
    assert.ok(conv.includes(col), `conversations 缺列 ${col}：${conv.join(',')}`)
  }
  assert.ok(columns(db, 'messages').includes('parent_id'))
})

test('老库迁移：documents 的流水线列都补上（漏一列上传就报 SQL 错）', () => {
  const db = oldSchemaDb()
  migrateSchema(db)

  const cols = columns(db, 'documents')
  for (const col of ['status', 'stage', 'progress', 'attempts', 'source_url']) {
    assert.ok(cols.includes(col), `documents 缺列 ${col}：${cols.join(',')}`)
  }

  // 老数据本来就已经入库完成，默认值必须是 ready 而不是 pending，
  // 否则升级之后这些文档会永远显示「排队中」且无法检索
  const row = db.prepare('SELECT status, progress FROM documents WHERE id = ?').get('d1')
  assert.equal(row.status, 'ready')
  assert.equal(row.progress, 0)
})

test('老库迁移：索引建在补列之后，不会因为「列不存在」而失败', () => {
  const db = oldSchemaDb()
  // 这里如果顺序写反（先建索引再补列），会抛 no such column
  assert.doesNotThrow(() => migrateSchema(db))

  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index'")
    .all()
    .map((r) => r.name)
  assert.ok(indexes.includes('idx_msg_parent'))
  assert.ok(indexes.includes('idx_conv_user'))
})

test('老库迁移：原有数据一条不丢', () => {
  const db = oldSchemaDb()
  migrateSchema(db)

  assert.equal(db.prepare('SELECT COUNT(*) c FROM conversations').get().c, 1)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM messages').get().c, 1)
  assert.equal(db.prepare('SELECT title FROM conversations WHERE id = ?').get('c1').title, '老会话')
  assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get('m1').content, '老消息')
  assert.equal(db.prepare('SELECT chunk_count FROM documents WHERE id = ?').get('d1').chunk_count, 3)
})

test('重复迁移是幂等的（每次启动都会跑一次）', () => {
  const db = oldSchemaDb()
  migrateSchema(db)
  assert.doesNotThrow(() => migrateSchema(db))
  assert.doesNotThrow(() => migrateSchema(db))
  assert.equal(db.prepare('SELECT COUNT(*) c FROM conversations').get().c, 1)
})

test('v7 库升级：folders 表已存在时补上索引，会话表补 folder_id / tags', () => {
  const db = oldSchemaDb()
  // 模拟 v7 的库：folders 表已经有了，但 conversations 还没有 folder_id
  db.exec(`
    CREATE TABLE folders (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, sort_index REAL,
      user_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `)
  assert.doesNotThrow(() => migrateSchema(db))

  assert.ok(columns(db, 'conversations').includes('folder_id'))
  assert.ok(columns(db, 'conversations').includes('tags'))
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index'")
    .all()
    .map((r) => r.name)
  assert.ok(indexes.includes('idx_folder_user'))
  assert.ok(indexes.includes('idx_conv_folder'))
})

test('v9 库升级：shares 表已存在时补上 user_id（分享按用户隔离）', () => {
  const db = oldSchemaDb()
  // 模拟 v9 的库：shares 表是加 user_id 之前建的
  db.exec(`
    CREATE TABLE shares (
      id TEXT PRIMARY KEY, conversation_id TEXT, title TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL, password_hash TEXT, views INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, expires_at INTEGER
    );
    INSERT INTO shares (id, conversation_id, title, payload, views, created_at)
    VALUES ('s1', NULL, '老分享', '{}', 0, 1);
  `)
  assert.doesNotThrow(() => migrateSchema(db))
  assert.ok(columns(db, 'shares').includes('user_id'), 'shares 必须补上 user_id 列')
  // 老分享归属为 NULL（无主），不能弄丢
  assert.equal(db.prepare('SELECT COUNT(*) c FROM shares').get().c, 1)
})

test('极老的库（只有 conversations）也能安全迁移，不因缺表而崩', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0,
      sort_index REAL, using_context INTEGER NOT NULL DEFAULT 1, assistant_id TEXT, model TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `)
  assert.doesNotThrow(() => migrateSchema(db))
  assert.ok(columns(db, 'conversations').includes('folder_id'))
})
