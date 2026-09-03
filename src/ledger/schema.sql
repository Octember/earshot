-- earshot ledger schema v1 — the public contract (see README).
-- Entity fields follow SPEC §4.1; state values follow SPEC §6.1.
-- All timestamps are ISO-8601 UTC strings. All JSON columns hold objects, never scalars.

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

-- events: inbound occurrences; dedup via unique index
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  dedup_key    TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('addressed_message','observed_message','timer_fired','external_signal','operator_action')),
  identity_id  TEXT NOT NULL,
  venue_id     TEXT NOT NULL,
  thread_root_id TEXT,
  principal_id TEXT,
  payload      TEXT NOT NULL DEFAULT '{}',   -- JSON
  received_at  TEXT NOT NULL
);

-- tasks: ledger atom; home anchor = (home_venue_id, home_thread_root_id)
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,             -- e.g. 'T-42'
  identity_id  TEXT NOT NULL,
  title        TEXT NOT NULL,
  spec         TEXT NOT NULL,                -- goal; amendments append via steering
  status       TEXT NOT NULL CHECK (status IN
                 ('open','active','waiting','parked','done','failed','cancelled')),
  waiting_on   TEXT CHECK (waiting_on IN ('human','timer','external')),
  sponsor_id   TEXT NOT NULL,
  home_venue_id TEXT NOT NULL,
  home_thread_root_id TEXT,
  origin_event_id TEXT NOT NULL REFERENCES events(id),
  wake_at      TEXT,
  pending_confirmation TEXT,                 -- JSON: {action, requested_at, resolution?}
  recurrence   TEXT,
  tier         TEXT NOT NULL DEFAULT 'high' CHECK (tier IN ('low','medium','high')), -- worker smartness
  artifacts    TEXT NOT NULL DEFAULT '[]',   -- JSON array of links/refs
  terminal_report TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  opened_at    TEXT NOT NULL,                -- refreshed on every re-entry to 'open'
  consecutive_interruptions INTEGER NOT NULL DEFAULT 0, -- crash-loop bound
  CHECK ((status = 'waiting') = (waiting_on IS NOT NULL)),
  CHECK (wake_at IS NULL OR status = 'waiting')
);

CREATE INDEX IF NOT EXISTS tasks_dispatch ON tasks (identity_id, status, opened_at);

-- done/failed require terminal_report (cancelled exempt)
CREATE TRIGGER IF NOT EXISTS tasks_terminal_report_required_update
BEFORE UPDATE OF status, terminal_report ON tasks
WHEN NEW.status IN ('done','failed') AND (NEW.terminal_report IS NULL OR trim(NEW.terminal_report) = '')
BEGIN SELECT RAISE(ABORT, 'a terminal task must carry a terminal_report (SPEC §6.1)'); END;

CREATE TRIGGER IF NOT EXISTS tasks_terminal_report_required_insert
BEFORE INSERT ON tasks
WHEN NEW.status IN ('done','failed') AND (NEW.terminal_report IS NULL OR trim(NEW.terminal_report) = '')
BEGIN SELECT RAISE(ABORT, 'a terminal task must carry a terminal_report (SPEC §6.1)'); END;

-- the task state machine (SPEC §6.1); transition() is the only writer, the trigger is the guarantee
CREATE TRIGGER IF NOT EXISTS tasks_transition_legal
BEFORE UPDATE OF status ON tasks
WHEN OLD.status <> NEW.status AND NOT (
     (OLD.status = 'open'    AND NEW.status IN ('active','parked','cancelled'))
  OR (OLD.status = 'active'  AND NEW.status IN ('waiting','open','parked','done','failed','cancelled'))
  OR (OLD.status = 'waiting' AND NEW.status IN ('open','parked','cancelled'))
  OR (OLD.status = 'parked'  AND NEW.status IN ('open','cancelled')))
BEGIN SELECT RAISE(ABORT, 'illegal task transition (SPEC §6.1)'); END;

-- executions: one background attempt; at most one live per task
CREATE TABLE IF NOT EXISTS executions (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  attempt      INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN
                 ('running','yielded','succeeded','failed','cancelled','interrupted')),
  started_at   TEXT NOT NULL,
  ended_at     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS one_live_execution_per_task
  ON executions (task_id) WHERE status = 'running';

-- steering: task-addressed queue; consumed at turn boundaries
CREATE TABLE IF NOT EXISTS steering (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  kind         TEXT NOT NULL CHECK (kind IN ('guidance','cancel','pause','resume','confirm')),
  payload      TEXT NOT NULL DEFAULT '{}',   -- JSON; confirm: {action_ref, approve, principal_id}
  source_event_id TEXT NOT NULL REFERENCES events(id),
  created_at   TEXT NOT NULL,
  consumed_at  TEXT
);

-- turns: agent invocations with spend and effects
CREATE TABLE IF NOT EXISTS turns (
  id           TEXT PRIMARY KEY,
  identity_id  TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('interactive','execution_step','ambient','distillation','resident','attention')),
  execution_id TEXT REFERENCES executions(id),
  venue_id     TEXT,
  thread_root_id TEXT,
  status       TEXT NOT NULL CHECK (status IN ('succeeded','failed','timed_out','budget_denied')),
  effects      TEXT NOT NULL DEFAULT '[]',   -- JSON array
  spend_amount REAL NOT NULL DEFAULT 0,
  started_at   TEXT NOT NULL,
  ended_at     TEXT NOT NULL,
  CHECK (kind <> 'execution_step' OR execution_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS turns_spend ON turns (identity_id, started_at);

-- memory_items: identity-scoped curated facts
CREATE TABLE IF NOT EXISTS memory_items (
  id           TEXT PRIMARY KEY,
  identity_id  TEXT NOT NULL,
  content      TEXT NOT NULL,
  provenance   TEXT NOT NULL DEFAULT '[]',   -- JSON array
  tier         TEXT NOT NULL DEFAULT 'core' CHECK (tier IN ('core','recent','archive')),
  status       TEXT NOT NULL CHECK (status IN ('active','retracted')),
  superseded_by TEXT REFERENCES memory_items(id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_confirmed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS memory_active ON memory_items (identity_id, status);

-- FTS5 contentless indexes over events + memory_items (synced by triggers)
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text, content='');
CREATE TRIGGER IF NOT EXISTS events_fts_insert AFTER INSERT ON events BEGIN
  INSERT INTO events_fts (rowid, text) VALUES (new.rowid, coalesce(json_extract(new.payload, '$.text'), ''));
END;
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, content='');
CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory_items BEGIN
  INSERT INTO memory_fts (rowid, content) VALUES (new.rowid, new.content);
END;

-- timers: durable; firing idempotent via fired_at + subject state checks
CREATE TABLE IF NOT EXISTS timers (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('task_wake','nudge','park','ambient_tick','distillation','recurrence')),
  identity_id  TEXT NOT NULL,
  subject_id   TEXT,                         -- task id for task-scoped kinds
  due_at       TEXT NOT NULL,
  fired_at     TEXT,
  CHECK (kind NOT IN ('task_wake','nudge','park') OR subject_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS timers_due ON timers (due_at) WHERE fired_at IS NULL;

-- one pending ambient_tick/distillation per identity
CREATE UNIQUE INDEX IF NOT EXISTS timers_singleton_pending ON timers (kind, identity_id)
  WHERE fired_at IS NULL AND kind IN ('ambient_tick','distillation');

-- audit: append-only
CREATE TABLE IF NOT EXISTS audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  identity_id  TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('event_received','turn_started','turn_ended','task_created','task_transitioned',
                  'tool_invoked','confirmation_requested','confirmation_resolved','ambient_posted',
                  'budget_denied','memory_written','memory_retracted','memory_tier_changed')),
  payload      TEXT NOT NULL DEFAULT '{}'    -- JSON
);

CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;

-- attention_items: open obligations from attention-pass verdicts
CREATE TABLE IF NOT EXISTS attention_items (
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
CREATE INDEX IF NOT EXISTS attention_open ON attention_items (identity_id, closed_at);

-- conversations: per-thread watermarks, judgment, and stance
CREATE TABLE IF NOT EXISTS conversations (
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

-- acts: outbound posts/reactions; UNIQUE(wake_id, act_key) for retry idempotency
CREATE TABLE IF NOT EXISTS acts (
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
CREATE INDEX IF NOT EXISTS acts_conversation ON acts (identity_id, venue_id, thread_root_id, at);

CREATE INDEX IF NOT EXISTS events_conversation ON events (identity_id, venue_id, thread_root_id);
CREATE INDEX IF NOT EXISTS events_root_ts ON events (venue_id, json_extract(payload, '$.ts')) WHERE thread_root_id IS NULL;

-- outward_calls: durable consequential-call idempotency
CREATE TABLE IF NOT EXISTS outward_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_id TEXT NOT NULL,
  scope_id    TEXT NOT NULL,
  tool        TEXT NOT NULL,
  args_hash   TEXT NOT NULL,
  at          TEXT NOT NULL,
  confirmed   INTEGER NOT NULL DEFAULT 0, -- 1 = success; 0 = in flight / ambiguous
  UNIQUE (scope_id, tool, args_hash)
);

-- drafts: withheld replies (§5.5)
CREATE TABLE IF NOT EXISTS drafts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_id    TEXT NOT NULL,
  venue_id       TEXT NOT NULL,
  thread_root_id TEXT,
  text           TEXT NOT NULL,
  drafted_at     TEXT NOT NULL,
  consumed_at    TEXT
);
