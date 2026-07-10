import { Database } from "bun:sqlite";

const SCHEMA_VERSION = 8;

// Each entry migrates a fresh install from version N-1 to N. schema.sql always reflects the
// current shape (for fresh databases); this ladder steps an existing on-disk database forward.
const MIGRATIONS: Record<number, string> = {
  2: "ALTER TABLE tasks ADD COLUMN consecutive_interruptions INTEGER NOT NULL DEFAULT 0",
  3: `CREATE TABLE IF NOT EXISTS thread_participation (
    venue_id       TEXT NOT NULL,
    thread_root_id TEXT NOT NULL,
    identity_id    TEXT NOT NULL,
    first_at       TEXT NOT NULL,
    PRIMARY KEY (venue_id, thread_root_id)
  )`,
  4: `CREATE TABLE IF NOT EXISTS conversation_threads (
    identity_id     TEXT NOT NULL,
    venue_id        TEXT NOT NULL,
    thread_root_id  TEXT NOT NULL,
    codex_thread_id TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (identity_id, venue_id, thread_root_id)
  )`,
  // §9.1/§8.2: ONE pending tick per identity. Every restart armed a fresh ambient/distillation
  // tick alongside the surviving pending one, and each fired tick re-arms itself — so N restarts
  // left N self-perpetuating chains. Keep the earliest pending tick, drop the rest, then let the
  // partial unique index make re-arming idempotent forever.
  5: `DELETE FROM timers WHERE fired_at IS NULL AND kind IN ('ambient_tick','distillation')
    AND EXISTS (SELECT 1 FROM timers t2 WHERE t2.kind = timers.kind AND t2.identity_id = timers.identity_id
                AND t2.fired_at IS NULL
                AND (t2.due_at < timers.due_at OR (t2.due_at = timers.due_at AND t2.id < timers.id)));
  CREATE UNIQUE INDEX IF NOT EXISTS timers_singleton_pending ON timers (kind, identity_id)
    WHERE fired_at IS NULL AND kind IN ('ambient_tick','distillation');`,
  // A codex thread that outgrows its context window compacts away its OLDEST history first —
  // AGENTS.md, the soul. Counting turns per thread lets the service rotate before that happens.
  6: "ALTER TABLE conversation_threads ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0",
  // SPEC §8.6/§8.7 — memory tiers + the searchable floor. The FTS tables/triggers also live in
  // schema.sql (IF NOT EXISTS) for fresh installs; the migration creates them here too because
  // the backfill must run in the same step, before any new rows arrive.
  7: `ALTER TABLE memory_items ADD COLUMN tier TEXT NOT NULL DEFAULT 'core' CHECK (tier IN ('core','archive'));
  CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text, content='');
  CREATE TRIGGER IF NOT EXISTS events_fts_insert AFTER INSERT ON events BEGIN
    INSERT INTO events_fts (rowid, text) VALUES (new.rowid, coalesce(json_extract(new.payload, '$.text'), ''));
  END;
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, content='');
  CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory_items BEGIN
    INSERT INTO memory_fts (rowid, content) VALUES (new.rowid, new.content);
  END;
  INSERT INTO events_fts (rowid, text) SELECT rowid, coalesce(json_extract(payload, '$.text'), '') FROM events;
  INSERT INTO memory_fts (rowid, content) SELECT rowid, content FROM memory_items;
  CREATE TABLE audit_v7 (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    at           TEXT NOT NULL,
    identity_id  TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN
                   ('event_received','turn_started','turn_ended','task_created','task_transitioned',
                    'tool_invoked','confirmation_requested','confirmation_resolved','ambient_posted',
                    'budget_denied','memory_written','memory_retracted','memory_tier_changed')),
    payload      TEXT NOT NULL DEFAULT '{}'
  );
  INSERT INTO audit_v7 (id, at, identity_id, kind, payload) SELECT id, at, identity_id, kind, payload FROM audit;
  DROP TABLE audit;
  ALTER TABLE audit_v7 RENAME TO audit;`,
  // SPEC §8.6 v8 — the 'recent' tier. SQLite can't alter a CHECK, so memory_items is rebuilt
  // (explicit column list: v7-migrated tables have `tier` appended last, fresh installs have it
  // mid-table). The rebuild reassigns rowids, so the contentless FTS index is rebuilt with it.
  8: `PRAGMA foreign_keys=OFF;
  CREATE TABLE memory_items_v8 (
    id           TEXT PRIMARY KEY,
    identity_id  TEXT NOT NULL,
    content      TEXT NOT NULL,
    provenance   TEXT NOT NULL DEFAULT '[]',
    tier         TEXT NOT NULL DEFAULT 'core' CHECK (tier IN ('core','recent','archive')),
    status       TEXT NOT NULL CHECK (status IN ('active','retracted')),
    superseded_by TEXT REFERENCES memory_items(id),
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    last_confirmed_at TEXT NOT NULL
  );
  INSERT INTO memory_items_v8 (id, identity_id, content, provenance, tier, status, superseded_by, created_at, updated_at, last_confirmed_at)
    SELECT id, identity_id, content, provenance, tier, status, superseded_by, created_at, updated_at, last_confirmed_at FROM memory_items;
  DROP TABLE memory_items;
  ALTER TABLE memory_items_v8 RENAME TO memory_items;
  CREATE INDEX IF NOT EXISTS memory_active ON memory_items (identity_id, status);
  CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory_items BEGIN
    INSERT INTO memory_fts (rowid, content) VALUES (new.rowid, new.content);
  END;
  INSERT INTO memory_fts(memory_fts) VALUES('delete-all');
  INSERT INTO memory_fts (rowid, content) SELECT rowid, content FROM memory_items;
  PRAGMA foreign_keys=ON;`,
};

export function openLedger(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // The ladder must run BEFORE schema.sql on an existing database: schema.sql declares the
  // current shape (indexes included), and a migration may need to repair data (e.g. v5's timer
  // dedupe) before that shape can be enforced.
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.query("SELECT version FROM schema_version").get() as { version: number } | null;
  if (row !== null && row.version > SCHEMA_VERSION) {
    throw new Error(`ledger schema version ${row.version} is newer than this build supports (${SCHEMA_VERSION})`);
  }
  if (row !== null && row.version < SCHEMA_VERSION) {
    for (let v = row.version + 1; v <= SCHEMA_VERSION; v++) {
      const migration = MIGRATIONS[v];
      if (!migration) throw new Error(`no migration defined to reach schema version ${v}`);
      db.exec(migration);
    }
    db.query("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
  }

  db.exec(schemaSql());
  if (row === null) db.query("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  return db;
}

function schemaSql(): string {
  const url = new URL("./schema.sql", import.meta.url);
  return require("fs").readFileSync(url, "utf8");
}

// M9: a database under WAL for weeks accumulates a growing -wal file if it's never checkpointed
// (the service is a long-lived single writer, so auto-checkpoint on connection close never fires).
// TRUNCATE folds the WAL back into the main db and shrinks the -wal file. Safe to call
// periodically on a low-frequency timer; a no-op on :memory: databases.
export function checkpointWal(db: Database): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}
