-- earshot ledger schema v1 — the public contract (see README).
-- Entity fields follow SPEC §4.1; state values follow SPEC §6.1.
-- All timestamps are ISO-8601 UTC strings. All JSON columns hold objects, never scalars.

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

-- SPEC §4.1.5 — normalized inbound occurrences. Dedup is the unique index, nothing else.
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  dedup_key    TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('addressed_message','observed_message','timer_fired','external_signal','operator_action')),
  identity_id  TEXT NOT NULL,
  venue_id     TEXT,
  thread_root_id TEXT,
  principal_id TEXT,
  payload      TEXT NOT NULL DEFAULT '{}',   -- JSON
  received_at  TEXT NOT NULL
);

-- SPEC §5.1 — "a thread where the agent has previously posted or been mentioned": one row per
-- (venue, thread) the agent participates in, written on the FIRST addressed message or outbound
-- post in that thread. v3.
CREATE TABLE IF NOT EXISTS thread_participation (
  venue_id       TEXT NOT NULL,
  thread_root_id TEXT NOT NULL,
  identity_id    TEXT NOT NULL,
  first_at       TEXT NOT NULL,
  PRIMARY KEY (venue_id, thread_root_id)
);

-- SPEC §5 — interactive continuity. One durable codex thread (rollout) per anchor, so successive
-- turns in the same Slack thread/DM RESUME the same conversation instead of cold-starting. Keyed by
-- the anchor a turn is already scoped to; thread_root_id is normalized to '' when the anchor has no
-- thread root (DM / top-level channel message). v4.
CREATE TABLE IF NOT EXISTS conversation_threads (
  identity_id     TEXT NOT NULL,
  venue_id        TEXT NOT NULL,
  thread_root_id  TEXT NOT NULL,
  codex_thread_id TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (identity_id, venue_id, thread_root_id)
);

-- SPEC §4.1.7 — the atom of the ledger. home anchor = (home_venue_id, home_thread_root_id).
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,             -- human-readable, e.g. 'T-42'
  identity_id  TEXT NOT NULL,
  title        TEXT NOT NULL,
  spec         TEXT NOT NULL,                -- goal as understood; amendments append via steering
  status       TEXT NOT NULL CHECK (status IN
                 ('open','active','waiting','parked','done','failed','cancelled')),
  waiting_on   TEXT CHECK (waiting_on IN ('human','timer','external')),
  sponsor_id   TEXT NOT NULL,
  home_venue_id TEXT NOT NULL,
  home_thread_root_id TEXT,
  origin_event_id TEXT NOT NULL REFERENCES events(id),
  wake_at      TEXT,
  pending_confirmation TEXT,                 -- JSON: {action, requested_at, resolution?} (SPEC §10.2)
  recurrence   TEXT,                         -- standing tasks only (SPEC §6.5)
  artifacts    TEXT NOT NULL DEFAULT '[]',   -- JSON array of links/refs
  terminal_report TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  opened_at    TEXT NOT NULL,                -- time entered 'open'; refreshed on every re-entry (SPEC §6.2)
  consecutive_interruptions INTEGER NOT NULL DEFAULT 0  -- crash-loop bound (SPEC §14.2); v2
);

CREATE INDEX IF NOT EXISTS tasks_dispatch ON tasks (identity_id, status, opened_at);

-- SPEC §4.1.8 — one background attempt at a task. At most one live per task (partial unique index).
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

-- SPEC §6.4 — task-addressed steering queue; consumed at turn boundaries.
CREATE TABLE IF NOT EXISTS steering (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  kind         TEXT NOT NULL CHECK (kind IN ('guidance','cancel','pause','resume','confirm')),
  payload      TEXT NOT NULL DEFAULT '{}',   -- JSON; for confirm: {action_ref, approve, principal_id}
  source_event_id TEXT NOT NULL REFERENCES events(id),
  created_at   TEXT NOT NULL,
  consumed_at  TEXT
);

-- SPEC §4.1.6 — every agent invocation, with spend and explicit effects for audit.
CREATE TABLE IF NOT EXISTS turns (
  id           TEXT PRIMARY KEY,
  identity_id  TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('interactive','execution_step','ambient','distillation')),
  execution_id TEXT REFERENCES executions(id),
  venue_id     TEXT,
  thread_root_id TEXT,
  status       TEXT NOT NULL CHECK (status IN ('succeeded','failed','timed_out','budget_denied')),
  effects      TEXT NOT NULL DEFAULT '[]',   -- JSON array of ledger/memory mutations
  spend_amount REAL NOT NULL DEFAULT 0,      -- in budget.unit (SPEC §10.3)
  started_at   TEXT NOT NULL,
  ended_at     TEXT
);

CREATE INDEX IF NOT EXISTS turns_spend ON turns (identity_id, started_at);

-- SPEC §4.1.9 — distilled facts, identity-scoped. Isolation = every query filters identity_id.
CREATE TABLE IF NOT EXISTS memory_items (
  id           TEXT PRIMARY KEY,
  identity_id  TEXT NOT NULL,
  content      TEXT NOT NULL,
  provenance   TEXT NOT NULL DEFAULT '[]',   -- JSON array of event/anchor refs
  status       TEXT NOT NULL CHECK (status IN ('active','retracted')),
  superseded_by TEXT REFERENCES memory_items(id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_confirmed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS memory_active ON memory_items (identity_id, status);

-- SPEC §13 — durable timers; firing is idempotent via fired_at + subject state checks.
CREATE TABLE IF NOT EXISTS timers (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('task_wake','nudge','park','ambient_tick','distillation','recurrence')),
  identity_id  TEXT NOT NULL,
  subject_id   TEXT,                         -- task id for task-scoped kinds
  due_at       TEXT NOT NULL,
  fired_at     TEXT
);

CREATE INDEX IF NOT EXISTS timers_due ON timers (due_at) WHERE fired_at IS NULL;

-- §9.1/§8.2 — the per-identity ambient/distillation cadence is ONE pending tick, not a stack:
-- restart re-arming + fire-time re-arming must collapse to a single chain (scheduleTimer's
-- INSERT OR IGNORE turns a duplicate pending tick into a no-op against this index).
CREATE UNIQUE INDEX IF NOT EXISTS timers_singleton_pending ON timers (kind, identity_id)
  WHERE fired_at IS NULL AND kind IN ('ambient_tick','distillation');

-- SPEC §4.1.12 — append-only. No UPDATE or DELETE path exists in code; enforced by triggers.
CREATE TABLE IF NOT EXISTS audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  identity_id  TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('event_received','turn_started','turn_ended','task_created','task_transitioned',
                  'tool_invoked','confirmation_requested','confirmation_resolved','ambient_posted',
                  'budget_denied','memory_written','memory_retracted')),
  payload      TEXT NOT NULL DEFAULT '{}'    -- JSON
);

CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
