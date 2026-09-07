# Earshot Service Specification

Status: v2 (2026-09-07). Supersedes the v1 draft, which specified budgets, grants, an audit trail,
a message archive, and a memory store that were built and then deleted. This document describes
the system that runs.

The key words MUST, MUST NOT, SHOULD, and MAY are to be read as in RFC 2119.

## 1. What it is

Earshot embeds one agent in a Slack workspace, as one bot user. Members address it by
mention or DM; it listens to everything else it can see. It is a persistent
colleague: it answers, it delegates work to background workers and reports back, it remembers,
and it mostly stays quiet.

Three boundaries define the design:

- **A thread is not a task.** Conversation is the interface. Delegated work lives in a small
  durable ledger with a state machine and outlives any thread.
- **The harness never speaks.** Everything the room hears is the model's own reply or reaction
  on its own turn. Nothing mechanical is posted: no echoed reports, no canned nudges, no status
  lines.
- **Slack is the message store, the workspace is the memory.** The harness keeps no copy of
  messages and no memory table. It persists only what nothing else can hold: tasks, pending
  conversations, and muted threads.

## 2. Components

1. **Inbound.** The socket-mode client delivers message events. Nothing is copied: per
   conversation (channel + thread root) the ledger holds a pointer to where the new part starts,
   whether a direct message is in it, and what the ear said. The wake reads the messages from
   Slack. Inbound decides direct address, and schedules the resident (direct) or the ear
   (everything else).
2. **Ear.** A cheap, voiceless pass over settled non-direct traffic that decides, per
   conversation, whether it needs the agent.
3. **Resident wake.** A fresh runtime thread per wake that reads the batch, may reply, react, step
   back, or delegate, and ends.
4. **Task ledger and scheduler.** SQLite: tasks with a four-state machine and durable wake times;
   a scheduler that dispatches runnable tasks to worker sessions with bounded concurrency.
5. **Policy.** One YAML file: persona, standing instructions, timeouts, model tiers. Hot-reloaded; an invalid edit is rejected and the last-known-good stays live.

External dependencies: the Slack Web and Socket Mode APIs; Codex via the exe.dev gateway as the
agent runtime (never the Anthropic API); `bun:sqlite` with drizzle as the query layer. One
process, one database file, zero services.

## 3. Domain

- **Agent**: `persona`, `ear_debounce_ms`, `venue_instructions` (channel id → standing
  instruction). A second persona is a second process with its own bot user.
- **Principal**: a Slack user or bot id. The agent's own id is ignored entirely. Other bots'
  messages are never direct.
- **Conversation**: channel, thread root, `since` (the ts the new part starts at), `direct`
  (a DM, or a mention of the agent's own id, from a human, is in the new part), `judged` (the ear has
  seen the new part), and `wake_why`, the ear's room-safe reason for waking. A ledger row until
  the wake that renders it, so a restart loses nothing; the messages themselves stay in Slack.
- **Task**: `id` (`T-n`, internal, never spoken in chat), `title`, `spec`
  (append-only via steering), `status` (§5), `waiting_on`, `waiting_why`, `wake_at`, `outcome`,
  `report`, `seen_at`, home channel and thread, `tier` (`low` | `medium` | `high`, maps to a model
  in policy), `interruptions`, timestamps.
- **Muted thread**: (channel, thread_ts, why). The one durable fact about a
  conversation.
- **Memory**: `MEMORY.md` in the agent's runtime workspace. Distilled, dated facts, never
  transcripts or secrets. Loaded verbatim into standing instructions before every fresh thread;
  edited by the agent with its own file tools. "Remember X" is an edit; "forget that" is an edit
  that MUST land within the handling turn.

## 4. Conversation

### 4.1 Addressing and admission

- A direct message (DM, or mention of the agent's own id) wakes the resident immediately. The
  harness opens the surface's native agent session on the thread so the person sees a response
  is underway; that session is marked active if the wake answered there, else closed.
- Everything else settles behind `ear_debounce_ms` into an ear pass.
  Observed chatter and replies in threads the agent has acted in are alike here: most of it is people
  talking to each other, and whether it wakes the mind is the ear's judgment, never the
  harness's.
- At most one resident wake and one ear pass run at a time. Events arriving
  mid-wake stay pending and ride the next wake.
- A muted thread holds its non-direct traffic back: those events are dropped unrendered. A
  direct address, or the agent's own post there, re-engages it.

### 4.2 The ear

The ear renders the same conversation view the resident sees, in the third person, and reports
one verdict per conversation through a single tool: `hold` (nothing needed) or `wake` with a
one-line why written as if the agent may say it aloud. A wake pins the why on the conversation;
the resident reads it as its own first read. The ear has no posting tools. A failed ear pass
fails open: the batch is marked judged and the resident wakes for it.

### 4.3 The resident wake

The prompt is: a legend; each admitted conversation as a header (channel, thread root, the step-
back reason if any, the ear's why if any), an "Earlier" tail of up to eight messages before
`since` and the new lines from it on, both read from `conversations.replies`; then unseen task
updates. Every line carries its `[channel ts]` coordinates and its speaker. Attachments are saved
into the workspace as the line renders and shown by path.

Standing context (soul, persona, memory file, venue instructions) rides the runtime's
standing-instructions document, regenerated before each fresh thread. No thread survives its
wake.

The wake resolves the batch into replies, reactions, task creation or steering, a step-back, a
memory edit, or silence. Silence is the model's outcome; the harness posts nothing for it.

Tools: `reply { text, channel, thread_ts? }`, `react { emoji, channel, ts }`,
`mute_thread { why, channel, thread_ts }`, `task_create { title, spec, channel, thread_ts?, tier? }`,
`task_steer { taskId, text }`, `task_cancel { taskId, report? }`, `task_query`,
and the vendor
passthroughs (`slack_api`, `linear_graphql`, `github_api`, `notion_api`, `ops_read`, `db_read`).
Tools describe themselves once, in
their own spec; the harness renders no second catalogue.

A reply into a conversation that received a new direct message after the wake started is bounced
once with that fact; the re-send is the model's informed call.

## 5. Task ledger

```
task_create ──> open ──dispatch──> active ──┬─ wait(human | timer) ──> waiting ──wake──> open
                                            ├─ interruption ──> open
                                            └─ finish ──> done(outcome, report)
open | waiting ──finish (cancel, expiry)──> done
```

- Transitions are exactly `dispatch`, `wait`, `wake`, `finish`. One function performs them and
  rejects any edge not in the diagram; row-shape invariants (a waiting task has `waiting_on`, a
  done task has `outcome` and a non-empty `report`) are CHECK constraints.
- The scheduler dispatches `open` tasks oldest-first, bounded by `executions.max_concurrent_*`,
  wakes `waiting(timer)` tasks whose `wake_at` has passed, and expires `waiting(human)` tasks
  whose park deadline (`tasks.park_after_ms`) has passed.
- Every `finish` carries a report: what was produced, where it lives, what needs a human. No task
  ends without one.
- A worker runs one task on a fresh runtime thread with every tool the resident has except
  `reply` and `react`, plus three bound to its own task: `task_complete { outcome: done | failed,
report }`, `task_ask { question }`, `set_wake { wakeAt }`. Its prompt is the spec. Workers never post. Their outcome lands on the task row; the resident learns of
  done tasks and human-blocked tasks on its next wake (`seen_at`) and tells the room in its own
  voice. A routine timer yield is silent.
- A worker turn that fails, or a task still `active` at restart, is an interruption: the task
  reopens with `interruptions` incremented; past `executions.max_attempts` it finishes as
  `failed` with a report saying so. Past `executions.max_turns` it waits on a timer.

## 6. Isolation

- Everything the agent reads is untrusted except policy. A message can request; authority for
  outside-Slack consequences is the model's judgment about whose word counts, carried by the
  soul. Worker voicelessness is enforced by construction.
- Secrets reach the harness through the environment only. They are never logged (secret-looking
  fields are redacted), never in prompts, and never in the model's shell (secret-looking
  variables are scrubbed from the codex child's environment).

## 7. Failure and recovery

### 7.1 Turns

The runtime enforces a per-turn timeout (`turns.interactive_timeout_ms`) and a stall timeout
(`*.stall_timeout_ms`, no runtime activity; a tool call in flight counts as activity). A dead
resident wake fails into the log; its batch is gone and the next message starts a new one. A
wake is never replayed.

### 7.2 Delivery

Slack delivery is at-least-once and may reorder. A redelivered event is a second line in the same
batch; the model sees both. Outbound posts rely on the SDK's own retry; a post that still fails
is logged for the operator and reported to the model as not sent.

### 7.4 Restart

A clean stop drains in-flight wakes and ear passes first. The inbox is memory: a hard crash loses
what was pending, and Slack still has it. On boot: load and validate policy; reopen every
`active` task as an interruption; write the standing-instructions document; start the socket.
Tasks and wake times are never lost.

## 8. Policy

```yaml
turns: { interactive_timeout_ms, stall_timeout_ms }
executions: { max_concurrent, max_turns, stall_timeout_ms, max_attempts, backoff_ms }
tasks: { park_after_ms }
models: { low: { model, effort }, medium: …, high: … } # low is the ear; medium/high are worker tiers
persona: |
  …
ear_debounce_ms: 15000
venue_instructions: { C…: "…" }
```

Keys are exactly the schema's; unknown keys are ignored, wrong types are rejected. The file is
watched; a valid change applies to
future wakes and dispatches.

## 9. Storage

The ledger schema is `src/ledger/schema.ts` (drizzle). Migrations are generated from it by
`drizzle-kit generate` into `drizzle/` and applied by drizzle's migrator at boot; the migrator
keeps its own record of what it applied. A schema change is an edit, a generate, a commit, and a
deploy.
