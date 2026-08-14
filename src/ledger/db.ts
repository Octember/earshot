import { Database, type SQLQueryBindings } from "bun:sqlite";

// T is the row shape — bun:sqlite cannot infer it from the SQL string.
/* oxlint-disable typescript/no-unnecessary-type-parameters */
export function one<T>(db: Database, sql: string, ...params: SQLQueryBindings[]): T | null {
  const stmt = db.query<T, SQLQueryBindings[]>(sql);
  return stmt.get(...params);
}

export function many<T>(db: Database, sql: string, ...params: SQLQueryBindings[]): T[] {
  const stmt = db.query<T, SQLQueryBindings[]>(sql);
  return stmt.all(...params);
}
/* oxlint-enable typescript/no-unnecessary-type-parameters */

const SCHEMA_VERSION = 14;

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
  // The Collapse (Phase 4, specs/2026-07-13-the-collapse-design.md): resident wakes are turns —
  // widen the turns.kind CHECK (sqlite requires a table rebuild) — and the per-identity inbox
  // cursor makes delivery restart-durable (events past the cursor re-deliver on boot).
  9: `CREATE TABLE IF NOT EXISTS turns (
    id           TEXT PRIMARY KEY,
    identity_id  TEXT NOT NULL,
    kind         TEXT NOT NULL,
    execution_id TEXT,
    venue_id     TEXT,
    thread_root_id TEXT,
    status       TEXT NOT NULL,
    effects      TEXT NOT NULL DEFAULT '[]',
    spend_amount REAL NOT NULL DEFAULT 0,
    started_at   TEXT NOT NULL,
    ended_at     TEXT
  );
  CREATE TABLE turns_v9 (
    id           TEXT PRIMARY KEY,
    identity_id  TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('interactive','execution_step','ambient','distillation','resident')),
    execution_id TEXT,
    venue_id     TEXT,
    thread_root_id TEXT,
    status       TEXT NOT NULL CHECK (status IN ('succeeded','failed','timed_out','budget_denied')),
    effects      TEXT NOT NULL DEFAULT '[]',
    spend_amount REAL NOT NULL DEFAULT 0,
    started_at   TEXT NOT NULL,
    ended_at     TEXT
  );
  INSERT INTO turns_v9 SELECT * FROM turns;
  DROP TABLE turns;
  ALTER TABLE turns_v9 RENAME TO turns;
  CREATE INDEX IF NOT EXISTS turns_spend ON turns (identity_id, started_at);
  CREATE TABLE IF NOT EXISTS resident_cursor (
    identity_id     TEXT PRIMARY KEY,
    delivered_rowid INTEGER NOT NULL
  );
  INSERT INTO resident_cursor (identity_id, delivered_rowid)
    SELECT identity_id, MAX(rowid) FROM events GROUP BY identity_id;`,
  // Task tiers: how hard the worker thinks. Maps to a model+effort in policy.models.
  10: "ALTER TABLE tasks ADD COLUMN tier TEXT NOT NULL DEFAULT 'high'",
  // The Ear (specs/2026-07-13-the-ear-design.md): attention turns, the ear's own judged-cursor
  // (seeded at the delivery watermark so history stays judged), attention items, and per-thread
  // step-back state. The ear gates waking, never delivery — resident_cursor is untouched.
  11: `CREATE TABLE turns_v11 (
    id           TEXT PRIMARY KEY,
    identity_id  TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('interactive','execution_step','ambient','distillation','resident','attention')),
    execution_id TEXT,
    venue_id     TEXT,
    thread_root_id TEXT,
    status       TEXT NOT NULL CHECK (status IN ('succeeded','failed','timed_out','budget_denied')),
    effects      TEXT NOT NULL DEFAULT '[]',
    spend_amount REAL NOT NULL DEFAULT 0,
    started_at   TEXT NOT NULL,
    ended_at     TEXT
  );
  INSERT INTO turns_v11 SELECT * FROM turns;
  DROP TABLE turns;
  ALTER TABLE turns_v11 RENAME TO turns;
  CREATE INDEX IF NOT EXISTS turns_spend ON turns (identity_id, started_at);
  CREATE TABLE IF NOT EXISTS ear_cursor (
    identity_id  TEXT PRIMARY KEY,
    judged_rowid INTEGER NOT NULL
  );
  INSERT INTO ear_cursor (identity_id, judged_rowid)
    SELECT identity_id, delivered_rowid FROM resident_cursor;
  CREATE TABLE IF NOT EXISTS attention_items (
    id             TEXT PRIMARY KEY,
    identity_id    TEXT NOT NULL,
    venue_id       TEXT NOT NULL,
    thread_root_id TEXT,
    ask_ts         TEXT,
    what           TEXT NOT NULL,
    opened_at      TEXT NOT NULL,
    closed_at      TEXT,
    closed_cause   TEXT
  );
  CREATE INDEX IF NOT EXISTS attention_open ON attention_items (identity_id, closed_at);
  ALTER TABLE thread_participation ADD COLUMN stepped_back_at TEXT;
  ALTER TABLE thread_participation ADD COLUMN stepped_back_why TEXT;`,
  // One room, one row (specs/2026-08-10-one-room-redesign.md, P1): the conversation as the
  // ledger unit — per-conversation watermarks and DURABLE ear judgment (holds/wake-why as rows
  // that delivery consumes with the messages, never discarded verdicts). Seeded at the global
  // cursors so nothing re-delivers on upgrade; CHECK makes cursor skew unrepresentable.
  12: `CREATE TABLE IF NOT EXISTS conversations (
    identity_id     TEXT NOT NULL,
    venue_id        TEXT NOT NULL,
    thread_root_id  TEXT NOT NULL,
    first_at        TEXT NOT NULL,
    delivered_rowid INTEGER NOT NULL DEFAULT 0,
    judged_rowid    INTEGER NOT NULL DEFAULT 0,
    holds           INTEGER NOT NULL DEFAULT 0,
    hold_whys       TEXT NOT NULL DEFAULT '[]',
    wake_why        TEXT,
    CHECK (judged_rowid >= delivered_rowid),
    PRIMARY KEY (identity_id, venue_id, thread_root_id)
  );
  INSERT INTO conversations (identity_id, venue_id, thread_root_id, first_at, delivered_rowid, judged_rowid)
    SELECT e.identity_id, e.venue_id, ifnull(e.thread_root_id, ''), MIN(e.received_at),
           ifnull((SELECT rc.delivered_rowid FROM resident_cursor rc WHERE rc.identity_id = e.identity_id), 0),
           max(ifnull((SELECT ec.judged_rowid FROM ear_cursor ec WHERE ec.identity_id = e.identity_id), 0),
               ifnull((SELECT rc.delivered_rowid FROM resident_cursor rc WHERE rc.identity_id = e.identity_id), 0))
      FROM events e WHERE e.venue_id IS NOT NULL
     GROUP BY e.identity_id, e.venue_id, ifnull(e.thread_root_id, '')
    ON CONFLICT DO NOTHING;`,
  // The overhaul (specs/2026-08-10-one-room-redesign.md, landed whole): the conversation row
  // becomes the ONLY unit of delivery, judgment, and standing. The table is REBUILT (v12's
  // CHECK dies — the ear's judged watermark legitimately trails delivery for after-the-fact
  // bookkeeping; v12 itself ships untouched, per the never-edit-a-shipped-migration rule);
  // stance absorbs thread_participation (step-back included); acts is her own outward voice
  // (posts/reactions, idempotent per wake); drafts replaces the RAM unsent-drafts map. The
  // global cursors and the participation/continuity tables — the mechanisms every
  // 07/09–08/10 incident routed through — are dropped, not deprecated.
  13: `CREATE TABLE conversations_v13 (
    identity_id     TEXT NOT NULL,
    venue_id        TEXT NOT NULL,
    thread_root_id  TEXT NOT NULL,
    first_at        TEXT NOT NULL,
    delivered_rowid INTEGER NOT NULL DEFAULT 0,
    judged_rowid    INTEGER NOT NULL DEFAULT 0,
    holds           INTEGER NOT NULL DEFAULT 0,
    hold_whys       TEXT NOT NULL DEFAULT '[]',
    wake_why        TEXT,
    stance          TEXT NOT NULL DEFAULT 'none' CHECK (stance IN ('none','engaged','out')),
    stance_why      TEXT,
    stance_at       TEXT,
    PRIMARY KEY (identity_id, venue_id, thread_root_id)
  );
  INSERT INTO conversations_v13 (identity_id, venue_id, thread_root_id, first_at, delivered_rowid, judged_rowid, holds, hold_whys, wake_why)
    SELECT identity_id, venue_id, thread_root_id, first_at, delivered_rowid, judged_rowid, holds, hold_whys, wake_why FROM conversations;
  DROP TABLE conversations;
  ALTER TABLE conversations_v13 RENAME TO conversations;
  INSERT INTO conversations (identity_id, venue_id, thread_root_id, first_at)
    SELECT identity_id, venue_id, thread_root_id, first_at FROM thread_participation WHERE true
    ON CONFLICT DO NOTHING;
  UPDATE conversations SET
    stance     = CASE WHEN tp.stepped_back_at IS NULL THEN 'engaged' ELSE 'out' END,
    stance_why = tp.stepped_back_why,
    stance_at  = coalesce(tp.stepped_back_at, tp.first_at)
    FROM thread_participation tp
    WHERE conversations.identity_id = tp.identity_id AND conversations.venue_id = tp.venue_id
      AND conversations.thread_root_id = tp.thread_root_id;
  CREATE TABLE IF NOT EXISTS acts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    wake_id        TEXT NOT NULL,
    act_key        TEXT NOT NULL,
    identity_id    TEXT NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('posted','reacted')),
    venue_id       TEXT NOT NULL,
    thread_root_id TEXT,
    ts             TEXT,
    text           TEXT,
    at             TEXT NOT NULL,
    UNIQUE (wake_id, act_key)
  );
  CREATE INDEX IF NOT EXISTS acts_conversation ON acts (identity_id, venue_id, thread_root_id, at);
  CREATE TABLE IF NOT EXISTS drafts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_id    TEXT NOT NULL,
    venue_id       TEXT NOT NULL,
    thread_root_id TEXT,
    text           TEXT NOT NULL,
    drafted_at     TEXT NOT NULL,
    consumed_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS events_conversation ON events (identity_id, venue_id, thread_root_id);
  CREATE INDEX IF NOT EXISTS events_root_ts ON events (venue_id, json_extract(payload, '$.ts')) WHERE thread_root_id IS NULL;
  DROP TABLE IF EXISTS thread_participation;
  DROP TABLE IF EXISTS conversation_threads;
  DROP TABLE IF EXISTS resident_cursor;
  DROP TABLE IF EXISTS ear_cursor;`,
  // Ladder audit: outward-call idempotency becomes durable. The RAM dedupe set died with the
  // process (and, post per-attempt-toolset, with every retry attempt) while external writes
  // record no turn effects — so a worker that wrote to Linear and crashed re-wrote on resume.
  // UNIQUE(scope_id, tool, args_hash) makes the duplicate a constraint fact instead.
  14: `CREATE TABLE IF NOT EXISTS outward_calls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_id TEXT NOT NULL,
    scope_id    TEXT NOT NULL,
    tool        TEXT NOT NULL,
    args_hash   TEXT NOT NULL,
    at          TEXT NOT NULL,
    confirmed   INTEGER NOT NULL DEFAULT 0,
    UNIQUE (scope_id, tool, args_hash)
  );`,
};

export function openLedger(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // The ladder must run BEFORE schema.sql on an existing database: schema.sql declares the
  // current shape (indexes included), and a migration may need to repair data (e.g. v5's timer
  // dedupe) before that shape can be enforced.
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = one<{ version: number }>(db, "SELECT version FROM schema_version");
  if (row !== null && row.version > SCHEMA_VERSION) {
    throw new Error(`ledger schema version ${row.version} is newer than this build supports (${SCHEMA_VERSION})`);
  }
  if (row !== null && row.version < SCHEMA_VERSION) {
    for (let v = row.version + 1; v <= SCHEMA_VERSION; v++) {
      const migration = MIGRATIONS[v];
      if (!migration) throw new Error(`no migration defined to reach schema version ${v}`);
      // One step, one transaction, one version bump: a crash mid-ladder resumes at the failed
      // step on the next boot instead of wedging on non-idempotent DDL.
      db.transaction(() => {
        db.exec(migration);
        db.query("UPDATE schema_version SET version = ?").run(v);
      })();
    }
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
