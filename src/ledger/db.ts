import { readFileSync } from "node:fs";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export type Ledger = BunSQLiteDatabase<typeof schema>;

const orms = new WeakMap<Database, Ledger>();

export function orm(db: Database): Ledger {
  let cached = orms.get(db);
  if (!cached) {
    cached = drizzle(db, { schema });
    orms.set(db, cached);
  }
  return cached;
}

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

const SCHEMA_VERSION = 17;

// N-1 → N; schema.sql is the fresh-install shape.
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
  // Keep earliest pending tick; unique index makes re-arm idempotent.
  5: `DELETE FROM timers WHERE fired_at IS NULL AND kind IN ('ambient_tick','distillation')
    AND EXISTS (SELECT 1 FROM timers t2 WHERE t2.kind = timers.kind AND t2.identity_id = timers.identity_id
                AND t2.fired_at IS NULL
                AND (t2.due_at < timers.due_at OR (t2.due_at = timers.due_at AND t2.id < timers.id)));
  CREATE UNIQUE INDEX IF NOT EXISTS timers_singleton_pending ON timers (kind, identity_id)
    WHERE fired_at IS NULL AND kind IN ('ambient_tick','distillation');`,
  6: "ALTER TABLE conversation_threads ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0",
  // Memory tiers + FTS; backfill existing rows.
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
  // Rebuild memory_items for 'recent' tier CHECK; FTS rowids follow.
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
  // Add resident turn kind + per-identity delivery cursor.
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
  10: "ALTER TABLE tasks ADD COLUMN tier TEXT NOT NULL DEFAULT 'high'",
  // Attention turns, judged cursor, attention items, step-back.
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
  // Per-conversation watermarks; seed from global cursors.
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
  // Stance/acts/drafts; judged may trail delivered.
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
  // Durable outward-call idempotency.
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
  // done/failed require terminal_report.
  15: `CREATE TRIGGER IF NOT EXISTS tasks_terminal_report_required_update
  BEFORE UPDATE OF status, terminal_report ON tasks
  WHEN NEW.status IN ('done','failed') AND (NEW.terminal_report IS NULL OR trim(NEW.terminal_report) = '')
  BEGIN SELECT RAISE(ABORT, 'a terminal task must carry a terminal_report (SPEC §6.1)'); END;
  CREATE TRIGGER IF NOT EXISTS tasks_terminal_report_required_insert
  BEFORE INSERT ON tasks
  WHEN NEW.status IN ('done','failed') AND (NEW.terminal_report IS NULL OR trim(NEW.terminal_report) = '')
  BEGIN SELECT RAISE(ABORT, 'a terminal task must carry a terminal_report (SPEC §6.1)'); END;`,
  // events.venue_id NOT NULL: every event lives in a venue.
  16: `PRAGMA foreign_keys=OFF;
  DELETE FROM events WHERE venue_id IS NULL;
  CREATE TABLE events_v16 (
    id           TEXT PRIMARY KEY,
    dedup_key    TEXT NOT NULL UNIQUE,
    kind         TEXT NOT NULL CHECK (kind IN
                   ('addressed_message','observed_message','timer_fired','external_signal','operator_action')),
    identity_id  TEXT NOT NULL,
    venue_id     TEXT NOT NULL,
    thread_root_id TEXT,
    principal_id TEXT,
    payload      TEXT NOT NULL DEFAULT '{}',
    received_at  TEXT NOT NULL
  );
  INSERT INTO events_v16 (rowid, id, dedup_key, kind, identity_id, venue_id, thread_root_id, principal_id, payload, received_at)
    SELECT rowid, id, dedup_key, kind, identity_id, venue_id, thread_root_id, principal_id, payload, received_at FROM events;
  DROP TABLE events;
  ALTER TABLE events_v16 RENAME TO events;
  CREATE INDEX IF NOT EXISTS events_conversation ON events (identity_id, venue_id, thread_root_id);
  CREATE INDEX IF NOT EXISTS events_root_ts ON events (venue_id, json_extract(payload, '$.ts')) WHERE thread_root_id IS NULL;
  CREATE TRIGGER IF NOT EXISTS events_fts_insert AFTER INSERT ON events BEGIN
    INSERT INTO events_fts (rowid, text) VALUES (new.rowid, coalesce(json_extract(new.payload, '$.text'), ''));
  END;
  INSERT INTO events_fts(events_fts) VALUES('delete-all');
  INSERT INTO events_fts (rowid, text) SELECT rowid, coalesce(json_extract(payload, '$.text'), '') FROM events;
  PRAGMA foreign_keys=ON;`,
  // Invariants into the schema: task transition legality + waiting consistency, turns/acts/timers/attention shape.
  17: `PRAGMA foreign_keys=OFF;
  UPDATE tasks SET wake_at = NULL WHERE status <> 'waiting';
  UPDATE turns SET ended_at = started_at WHERE ended_at IS NULL;
  UPDATE acts SET text = '' WHERE text IS NULL;
  CREATE TABLE tasks_v17 (
    id           TEXT PRIMARY KEY,
    identity_id  TEXT NOT NULL,
    title        TEXT NOT NULL,
    spec         TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN
                   ('open','active','waiting','parked','done','failed','cancelled')),
    waiting_on   TEXT CHECK (waiting_on IN ('human','timer','external')),
    sponsor_id   TEXT NOT NULL,
    home_venue_id TEXT NOT NULL,
    home_thread_root_id TEXT,
    origin_event_id TEXT NOT NULL REFERENCES events(id),
    wake_at      TEXT,
    pending_confirmation TEXT,
    recurrence   TEXT,
    tier         TEXT NOT NULL DEFAULT 'high' CHECK (tier IN ('low','medium','high')),
    artifacts    TEXT NOT NULL DEFAULT '[]',
    terminal_report TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    opened_at    TEXT NOT NULL,
    consecutive_interruptions INTEGER NOT NULL DEFAULT 0,
    CHECK ((status = 'waiting') = (waiting_on IS NOT NULL)),
    CHECK (wake_at IS NULL OR status = 'waiting')
  );
  INSERT INTO tasks_v17 (rowid, id, identity_id, title, spec, status, waiting_on, sponsor_id, home_venue_id, home_thread_root_id, origin_event_id, wake_at, pending_confirmation, recurrence, tier, artifacts, terminal_report, created_at, updated_at, opened_at, consecutive_interruptions)
    SELECT rowid, id, identity_id, title, spec, status, waiting_on, sponsor_id, home_venue_id, home_thread_root_id, origin_event_id, wake_at, pending_confirmation, recurrence, tier, artifacts, terminal_report, created_at, updated_at, opened_at, consecutive_interruptions FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_v17 RENAME TO tasks;
  CREATE INDEX IF NOT EXISTS tasks_dispatch ON tasks (identity_id, status, opened_at);
  CREATE TRIGGER IF NOT EXISTS tasks_terminal_report_required_update
  BEFORE UPDATE OF status, terminal_report ON tasks
  WHEN NEW.status IN ('done','failed') AND (NEW.terminal_report IS NULL OR trim(NEW.terminal_report) = '')
  BEGIN SELECT RAISE(ABORT, 'a terminal task must carry a terminal_report (SPEC §6.1)'); END;
  CREATE TRIGGER IF NOT EXISTS tasks_terminal_report_required_insert
  BEFORE INSERT ON tasks
  WHEN NEW.status IN ('done','failed') AND (NEW.terminal_report IS NULL OR trim(NEW.terminal_report) = '')
  BEGIN SELECT RAISE(ABORT, 'a terminal task must carry a terminal_report (SPEC §6.1)'); END;
  CREATE TRIGGER IF NOT EXISTS tasks_transition_legal
  BEFORE UPDATE OF status ON tasks
  WHEN NOT (
       (OLD.status = 'open'    AND NEW.status IN ('active','parked','cancelled'))
    OR (OLD.status = 'active'  AND NEW.status IN ('waiting','open','parked','done','failed','cancelled'))
    OR (OLD.status = 'waiting' AND NEW.status IN ('waiting','open','parked','cancelled'))
    OR (OLD.status = 'parked'  AND NEW.status IN ('open','cancelled')))
  BEGIN SELECT RAISE(ABORT, 'illegal task transition (SPEC §6.1)'); END;
  CREATE TABLE turns_v17 (
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
    ended_at     TEXT NOT NULL,
    CHECK (kind <> 'execution_step' OR execution_id IS NOT NULL)
  );
  INSERT INTO turns_v17 (rowid, id, identity_id, kind, execution_id, venue_id, thread_root_id, status, effects, spend_amount, started_at, ended_at)
    SELECT rowid, id, identity_id, kind, execution_id, venue_id, thread_root_id, status, effects, spend_amount, started_at, ended_at FROM turns;
  DROP TABLE turns;
  ALTER TABLE turns_v17 RENAME TO turns;
  CREATE INDEX IF NOT EXISTS turns_spend ON turns (identity_id, started_at);
  CREATE TABLE acts_v17 (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    wake_id        TEXT NOT NULL,
    act_key        TEXT NOT NULL,
    identity_id    TEXT NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('posted','reacted')),
    venue_id       TEXT NOT NULL,
    thread_root_id TEXT,
    ts             TEXT,
    text           TEXT NOT NULL,
    at             TEXT NOT NULL,
    UNIQUE (wake_id, act_key),
    CHECK (kind <> 'reacted' OR ts IS NOT NULL)
  );
  INSERT INTO acts_v17 (id, wake_id, act_key, identity_id, kind, venue_id, thread_root_id, ts, text, at)
    SELECT id, wake_id, act_key, identity_id, kind, venue_id, thread_root_id, ts, text, at FROM acts;
  DROP TABLE acts;
  ALTER TABLE acts_v17 RENAME TO acts;
  CREATE INDEX IF NOT EXISTS acts_conversation ON acts (identity_id, venue_id, thread_root_id, at);
  CREATE TABLE timers_v17 (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN
                   ('task_wake','nudge','park','ambient_tick','distillation','recurrence')),
    identity_id  TEXT NOT NULL,
    subject_id   TEXT,
    due_at       TEXT NOT NULL,
    fired_at     TEXT,
    CHECK (kind NOT IN ('task_wake','nudge','park') OR subject_id IS NOT NULL)
  );
  INSERT INTO timers_v17 (rowid, id, kind, identity_id, subject_id, due_at, fired_at)
    SELECT rowid, id, kind, identity_id, subject_id, due_at, fired_at FROM timers;
  DROP TABLE timers;
  ALTER TABLE timers_v17 RENAME TO timers;
  CREATE INDEX IF NOT EXISTS timers_due ON timers (due_at) WHERE fired_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS timers_singleton_pending ON timers (kind, identity_id)
    WHERE fired_at IS NULL AND kind IN ('ambient_tick','distillation');
  CREATE TABLE attention_items_v17 (
    id             TEXT PRIMARY KEY,
    identity_id    TEXT NOT NULL,
    venue_id       TEXT NOT NULL,
    thread_root_id TEXT,
    ask_ts         TEXT,
    what           TEXT NOT NULL,
    opened_at      TEXT NOT NULL,
    closed_at      TEXT,
    closed_cause   TEXT,
    CHECK ((closed_at IS NULL) = (closed_cause IS NULL))
  );
  INSERT INTO attention_items_v17 (rowid, id, identity_id, venue_id, thread_root_id, ask_ts, what, opened_at, closed_at, closed_cause)
    SELECT rowid, id, identity_id, venue_id, thread_root_id, ask_ts, what, opened_at, closed_at, closed_cause FROM attention_items;
  DROP TABLE attention_items;
  ALTER TABLE attention_items_v17 RENAME TO attention_items;
  CREATE INDEX IF NOT EXISTS attention_open ON attention_items (identity_id, closed_at);
  PRAGMA foreign_keys=ON;`,
};

export function openLedger(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  // Migrations before schema.sql so data repair can precede new constraints.
  db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = one<{ version: number }>(db, "SELECT version FROM schema_version");
  if (row !== null && row.version > SCHEMA_VERSION) {
    throw new Error(
      `ledger schema version ${row.version} is newer than this build supports (${SCHEMA_VERSION})`,
    );
  }
  if (row !== null && row.version < SCHEMA_VERSION) {
    for (let version = row.version + 1; version <= SCHEMA_VERSION; version++) {
      const migration = MIGRATIONS[version];
      if (!migration) throw new Error(`no migration defined to reach schema version ${version}`);
      db.run("PRAGMA foreign_keys = OFF");
      const violationsBefore = db.query("PRAGMA foreign_key_check").all().length;
      db.transaction(() => {
        db.run(migration);
        db.query("UPDATE schema_version SET version = ?").run(version);
        if (db.query("PRAGMA foreign_key_check").all().length > violationsBefore)
          throw new Error(`migration ${version} introduced foreign key violations`);
      })();
      db.run("PRAGMA foreign_keys = ON");
    }
  }

  db.run(schemaSql());
  if (row === null) db.query("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  return db;
}

function schemaSql(): string {
  const url = new URL("./schema.sql", import.meta.url);
  return readFileSync(url, "utf8");
}

// Fold WAL into the main db (long-lived single writer never auto-checkpoints on close).
export function checkpointWal(db: Database): void {
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
}
