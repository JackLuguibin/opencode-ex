/** Tables of the knowledge database. The keyword index is created here rather than by a migration tool: it is a virtual table. */
export const statements = [
  `CREATE TABLE IF NOT EXISTS kb (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    settings TEXT NOT NULL DEFAULT '{}',
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS kb_grant (
    kb_id TEXT NOT NULL REFERENCES kb(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    PRIMARY KEY (kb_id, organization_id)
  )`,
  `CREATE INDEX IF NOT EXISTS kb_grant_organization ON kb_grant(organization_id)`,
  `CREATE TABLE IF NOT EXISTS entry (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    kb_id TEXT NOT NULL REFERENCES kb(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    aliases TEXT NOT NULL DEFAULT '[]',
    questions TEXT NOT NULL DEFAULT '[]',
    keywords TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'published',
    hash TEXT NOT NULL DEFAULT '',
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS entry_kb ON entry(kb_id, status)`,
  `CREATE INDEX IF NOT EXISTS entry_hash ON entry(kb_id, hash)`,
  // rowid is the entry's seq, so an entry is removed from the index by key instead of by scanning it.
  `CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(
    kb_id UNINDEXED, title, aliases, questions, content, keywords,
    tokenize = "unicode61 tokenchars '_'"
  )`,
  `CREATE TABLE IF NOT EXISTS entry_vec (
    entry_id TEXT PRIMARY KEY REFERENCES entry(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS import_job (
    id TEXT PRIMARY KEY,
    kb_id TEXT NOT NULL REFERENCES kb(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    total INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS platform_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS eval_case (
    id TEXT PRIMARY KEY,
    kb_id TEXT NOT NULL REFERENCES kb(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    expected_entry_id TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS eval_run (
    id TEXT PRIMARY KEY,
    kb_id TEXT NOT NULL REFERENCES kb(id) ON DELETE CASCADE,
    settings TEXT NOT NULL,
    cases INTEGER NOT NULL,
    recall_at_5 REAL NOT NULL,
    p50_ms REAL NOT NULL,
    time_created INTEGER NOT NULL
  )`,
] as const
