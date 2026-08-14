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
  recurrence   TEXT,
  tier         TEXT NOT NULL DEFAULT 'high' CHECK (tier IN ('low','medium','high')), -- v10: worker smartness                         -- standing tasks only (SPEC §6.5)
  artifacts    TEXT NOT NULL DEFAULT '[]',   -- JSON array of links/refs
  terminal_report TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  opened_at    TEXT NOT NULL,                -- time entered 'open'; refreshed on every re-entry (SPEC §6.2)
  consecutive_interruptions INTEGER NOT NULL DEFAULT 0  -- crash-loop bound (SPEC §14.2); v2
);

CREATE INDEX IF NOT EXISTS tasks_dispatch ON tasks (identity_id, status, opened_at);

-- SPEC §6.1 "no dangling threads" as schema (v15): a task cannot reach done/failed without its
-- terminal report — the invariant lives in the ledger, not in whichever code path transitions.
-- (cancelled is exempt: a cancel is the sponsor's own act; its report is optional context.)
CREATE TRIGGER IF NOT EXISTS tasks_terminal_report_required_update
BEFORE UPDATE OF status, terminal_report ON tasks
WHEN NEW.status IN ('done','failed') AND (NEW.terminal_report IS NULL OR trim(NEW.terminal_report) = '')
BEGIN SELECT RAISE(ABORT, 'a terminal task must carry a terminal_report (SPEC §6.1)'); END;

CREATE TRIGGER IF NOT EXISTS tasks_terminal_report_required_insert
BEFORE INSERT ON tasks
WHEN NEW.status IN ('done','failed') AND (NEW.terminal_report IS NULL OR trim(NEW.terminal_report) = '')
BEGIN SELECT RAISE(ABORT, 'a terminal task must carry a terminal_report (SPEC §6.1)'); END;

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
  kind         TEXT NOT NULL CHECK (kind IN ('interactive','execution_step','ambient','distillation','resident','attention')),
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
  tier         TEXT NOT NULL DEFAULT 'core' CHECK (tier IN ('core','recent','archive')), -- SPEC §8.6 (v7; 'recent' v8)
  status       TEXT NOT NULL CHECK (status IN ('active','retracted')),
  superseded_by TEXT REFERENCES memory_items(id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_confirmed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS memory_active ON memory_items (identity_id, status);

-- SPEC §8.7 — the searchable floor (v7): contentless FTS5 indexes over everything an identity has
-- heard (events) and remembers (memory_items), kept in sync by triggers so the invariant lives in
-- the schema, not in application code. Contentless (content='') stores no second copy of the
-- text; hits join back to the source row by rowid for live fields (status, tier, venue, ...).
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text, content='');
CREATE TRIGGER IF NOT EXISTS events_fts_insert AFTER INSERT ON events BEGIN
  INSERT INTO events_fts (rowid, text) VALUES (new.rowid, coalesce(json_extract(new.payload, '$.text'), ''));
END;
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, content='');
CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory_items BEGIN
  INSERT INTO memory_fts (rowid, content) VALUES (new.rowid, new.content);
END;

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
                  'budget_denied','memory_written','memory_retracted','memory_tier_changed')),
  payload      TEXT NOT NULL DEFAULT '{}'    -- JSON
);

CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;

-- The Ear (v11): what she owes. Opened by ear verdicts; optimistically closed by her own
-- in-thread reply/react (same transaction as the post); reopened only by ear verdicts. Open
-- items ride the wake prompt (capped; max-age items are flagged to the mind's own judgment).
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

-- One room, one row (specs/2026-08-10-one-room-redesign.md, v12+v13): the conversation as THE
-- ledger unit — delivery watermark, judgment watermark, ear judgment (holds/wake-why, consumed
-- WITH the messages so a wake structurally cannot take one without the other), and standing
-- (stance absorbs SPEC §5.1 participation and the ear design's step-back: 'engaged' follows,
-- 'out' is her recorded choice to leave — its observed chatter waits, undelivered, until a
-- mention or her own post re-engages). thread_root_id '' is the venue's top-level surface.
-- judged_rowid may TRAIL delivered_rowid: the ear bookkeeps addressed traffic after the fact.
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

-- v13: her own outward voice — posts and reactions, written in the same breath as the adapter
-- call. The renderer interleaves these with events so she (and the ear) read one conversation,
-- her words in place. UNIQUE(wake_id, act_key) makes a retry attempt's duplicate outward call a
-- no-op instead of a double post.
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

-- v13: delivery/judgment/tail reads walk (identity, venue, thread, rowid); the partial
-- expression index serves rehomeThreadRoot's root lookup on the hot inbound path.
CREATE INDEX IF NOT EXISTS events_conversation ON events (identity_id, venue_id, thread_root_id);
CREATE INDEX IF NOT EXISTS events_root_ts ON events (venue_id, json_extract(payload, '$.ts')) WHERE thread_root_id IS NULL;

-- v14: outward-call idempotency, durable. scope_id = the execution's task (cross-restart) or
-- the wake id (cross-attempt); args_hash = broker.canonicalJson. A repeated consequential
-- external call inside one scope violates the unique index instead of re-running the write.
CREATE TABLE IF NOT EXISTS outward_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_id TEXT NOT NULL,
  scope_id    TEXT NOT NULL,
  tool        TEXT NOT NULL,
  args_hash   TEXT NOT NULL,
  at          TEXT NOT NULL,
  confirmed   INTEGER NOT NULL DEFAULT 0, -- 1 = impl returned success; 0 = in flight or died ambiguous
  UNIQUE (scope_id, tool, args_hash)
);

-- v13: §5.5 withheld replies, durable. Replaces the RAM unsent-drafts map that died on restart.
CREATE TABLE IF NOT EXISTS drafts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_id    TEXT NOT NULL,
  venue_id       TEXT NOT NULL,
  thread_root_id TEXT,
  text           TEXT NOT NULL,
  drafted_at     TEXT NOT NULL,
  consumed_at    TEXT
);
