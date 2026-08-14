# One room, one row — the conversation as the unit of everything

**Status: PROPOSAL. Not normative until the operator blesses it and SPEC.md is amended.**
Derived 2026-08-10 by a 21-agent first-principles workflow (5 ground-truth readers, 4
independent architects on divergent theses, 12 adversarial judge passes replaying the full
incident catalog against each design). This doc records the synthesis: what survived the
judges, what was killed and why, and the migration path. The raw designs and verdicts are in
the session transcript; the incident catalog is in the operator's memory notes.

## The bankruptcy verdict

Twelve live incidents since 2026-07-09 are one bug wearing twelve costumes: **a fact one
decision-maker held was invisible to the next one.** The system oscillated between persistent
model context (rots, races) and fresh model context (blind) because in both regimes the
render was partial — "what she knows" is smeared across a dead codex session, two global
cursors, a posts digest, thread tails (ear-only for eleven days), attention items, step-back
bits, two RAM maps that die on restart, and hold verdicts that are discarded at the moment
they're made. Each incident bought one more hand-maintained reconstruction slot, each with
its own omission bug. Five prompt-side guards in four weeks is an epicycle count.

All four independent architects, given only the failure catalog and the state inventory,
converged on the same spine. That convergence — not any single design — is the finding.

## The three principles

1. **The conversation is the unit.** One ledger row per (identity, venue, thread root) owns
   that conversation's delivery watermark, judgment watermark, stance, and hold history.
   Nothing about a conversation is global, and nothing about it lives anywhere else.
2. **Judgment is co-located with delivery.** A hold is a row on the conversation, not a
   discarded verdict; a wake structurally cannot receive a conversation's messages without
   the judgment that was made about them. (This is the one mechanism that survived every
   adversarial attack in every design.)
3. **One renderer, both readers, her words included.** A single projection function renders
   a conversation — participants, stance + why, hold history, verbatim transcript with her
   own posts interleaved in place — and it is the ONLY way conversation context enters any
   prompt (ear or mind). Context asymmetry between readers becomes unrepresentable instead
   of repeatedly patched.

## Schema (sketch — final DDL at implementation, invariants in-schema per house rule)

```sql
-- Replaces: resident_cursor, ear_cursor, thread_participation. Root semantics UNCHANGED
-- from today's router: a reply's thread_root_id, a top-level message's own ts. (The
-- judges killed '__channel__' collapsed keying: it splits a top-level message from its
-- own thread at Slack's most common transition.)
CREATE TABLE conversations (
  identity_id     TEXT NOT NULL,
  venue_id        TEXT NOT NULL,
  thread_root_id  TEXT NOT NULL,
  first_at        TEXT NOT NULL,
  stance          TEXT NOT NULL DEFAULT 'none' CHECK (stance IN ('none','engaged','out')),
  stance_why      TEXT,            -- her recorded reason when stance='out'
  stance_at       TEXT,
  delivered_rowid INTEGER NOT NULL DEFAULT 0,   -- last events.rowid rendered into a wake
  judged_rowid    INTEGER NOT NULL DEFAULT 0,   -- last events.rowid the listener judged
  holds           INTEGER NOT NULL DEFAULT 0,   -- holds since last delivery
  hold_whys       TEXT NOT NULL DEFAULT '[]',   -- bounded history (last 4), never a single
                                                -- latest-wins column (judge: stale single
                                                -- why renders as live fact)
  CHECK (judged_rowid >= delivered_rowid),      -- retires the cursor-skew class outright
  PRIMARY KEY (identity_id, venue_id, thread_root_id)
);

-- Her own voice enters the event stream, written in the SAME transaction as the outbound
-- effect. Interleaving with the room is rowid order — free, exact, restart-durable.
-- §10.5 self-ignore holds: kind='self_message' never wakes, never delivers as input; it
-- exists so the renderer reads one stream. Deletes outboundEffectsSince + both digests.
--   events.kind gains 'self_message'

-- Outward idempotency as a constraint, not a closure Set. Independent of loop topology;
-- graft-worthy even standalone (judges' unanimous salvage).
CREATE TABLE acts (
  wake_id  TEXT NOT NULL,
  act_key  TEXT NOT NULL,        -- hash(tool, canonical_args)
  kind     TEXT NOT NULL,        -- posted | reacted | stepped_back | outward_call
  venue_id TEXT, thread_root_id TEXT,
  payload  TEXT NOT NULL DEFAULT '{}',
  at       TEXT NOT NULL,
  UNIQUE (wake_id, act_key)
);

-- Withheld replies stop dying in RAM.
CREATE TABLE drafts (
  identity_id TEXT NOT NULL, venue_id TEXT NOT NULL, thread_root_id TEXT,
  text TEXT NOT NULL, drafted_at TEXT NOT NULL, consumed_at TEXT
);
```

Also: `wakes` / `wake_reasons` rows replace the debounce/running/rerun RAM maps and record
what woke her and which conversations rendered (the rendered-set is what the reply bounce
below checks — durable, so it holds across retry attempts and restarts by construction,
retiring the per-attempt `makeTools()` dance).

## The loop

1. **Deterministic SQL pre-gate** on event arrival, no model in the loop: a direct address
   (mention/DM) wakes now; a message in an `engaged` conversation schedules the debounced
   wake (delivery is never model-gated for engaged threads — the 07-30 lesson stands:
   the cheap tier gates *waking of held rooms*, never *delivery to hers*); a message in a
   `none`/`out` conversation goes to the listener. Task updates stop riding the shared
   inbox as wake triggers (the single biggest wake-count lever the measurement found).
2. **The listener** (cheap tier, today's ear) judges only non-engaged conversations. Its
   verdict is a WRITE to the conversation row: `holds`++ with a why pushed, or a wake.
   It reads through the same renderer as the mind. No RAM notes, no discarded reasons.
3. **A wake** renders, through the one renderer, every conversation with undelivered
   events — new lines marked, prior tail verbatim, her posts inline, stance and hold
   history on the card. It advances `delivered_rowid` ONLY for conversations it rendered.
   An unrelated wake can no longer drain a held conversation as bare lines: if it renders
   it at all, the judgment renders with it.
4. **Speaking** keeps explicit coordinates (`venueId`, `threadRootId` — the judges killed
   coordinate-free reply: the channel surface makes "one legal destination" false). ONE
   structural guard replaces the step-back bounce and generalizes it: a `reply` into a
   conversation NOT rendered in this wake's prompt returns that conversation's card
   instead of posting, once; the re-send is her informed call. `stance='out'` conversations
   don't render by default, so the same mechanism covers them with zero special cases.
   Directly-addressed turns still stream immediately (§5.5 buffering stays scoped to
   unaddressed wakes — the judges killed the universal post-queue: it breaks the
   checklist/stream UX the addressed path promises).
5. **Failure handling**: TTFB/stall watchdog (~25s/45s) split from the work envelope
   (600s) — one number was measuring "gateway blackholed" and "honest long job", which are
   opposite conditions. The `effects`-nonempty retry guard STAYS (the judges killed
   unconditional retry: two attempts never compose byte-identical replies, so args-hash
   idempotency provably double-posts).

## What dies (the bankruptcy list)

`resident_cursor`; `ear_cursor`; `thread_participation` (stance absorbs step-back);
`conversation_threads` + `src/ledger/continuity.ts` (dead since the fresh-session rule;
formally retired); `Service.earNotes` + the `[your first read of the room]` slot;
`Service.unsentDrafts` + its slot (→ `drafts`); `outboundEffectsSince()` + both
`[what you did recently]` digests (→ `self_message` rows); `threadTailBefore`/
`threadTailContext` as separate call sites (→ the renderer); the step-back reply bounce +
`stepBackBounced` Set + per-attempt toolset rebuild (→ the rendered-set bounce, durable);
`residentDebounce`/`earRunning`/etc. RAM maps (→ `wakes` rows + partial unique index);
the `answered` flag (→ query over `acts`); frozen `events.payload.addressMode` (→ derived
from live stance at render time). `attention_items` survives phase 1 but gains a
`conversations` FK; whether it folds into the row entirely is an open question below.

## Ideas the judges killed (recorded so future sessions don't relitigate)

- **Commitment/settlement ledger** (cheap model as writer-of-record of "what the room
  settled"): paraphrases outlive the transcript they lossily encode; the admission bounce
  "is a speed bump wearing a trigger's costume"; FK-timing on its triggers would have made
  her mute and the harness speak. The durable-judgment *half* survives as `hold_whys`.
- **`__channel__` conversation keying / coordinate-free reply**: breaks the top-level→thread
  transition and the channel surface. Today's root semantics are correct; keep them.
- **Universal non-posting reply with turn-end committer**: breaks addressed-turn streaming
  and checklist cards.
- **Unconditional retry under act-idempotency**: double-posts replies.
- **Tiered token-budget renderer** (water-fill, per-tier stubs): complexity spent conserving
  the cheap resource; the budget constants just relocate the ear/mind asymmetry. Render
  generously, cap simply (~40 lines/conversation), point to search for older.
- **Single latest-hold-reason column**: a 09:00 hold why rendered at 17:00 asserts a stale
  judgment as live fact; keep bounded history.
- **Cheap-tier delivery gating for engaged threads**: re-opens 07-30 as a starvation bug;
  the pre-gate keeps engaged delivery deterministic.

## Migration (each phase shippable, revertible, live-verifiable by CONTENT)

- **P0 — no schema, one afternoon**: task updates out of the wake-trigger path; TTFB/stall
  watchdog split. (Judges' finding: most of the measured wake/token cost hangs on these
  two, independent of everything else. Measure before/after; the pass-count model is an
  unproven hypothesis, not a promise.)
- **P1 — the row**: `conversations` table; per-conversation watermarks; listener writes
  stance/holds to it; renderer v1 (unify today's two tail call sites) feeding both readers;
  `self_message` rows; delete the digests.
- **P2 — the guard**: rendered-set reply bounce (retires the step-back bounce + per-attempt
  rebuild from PR #14, which stands as the stopgap until then); `drafts` table; `acts`
  UNIQUE; delete the RAM maps.
- **P3 — the sweep**: retire `attention_items` into the row (if decided), the ear's second
  workspace/soul (if decided), drop the dead tables, amend SPEC.md §5/§11 to normative.

## Open questions for the operator

1. `attention_items`: fold into the conversation row (lapse semantics on the row) or keep
   as FK'd table? Judges split.
2. One soul or two: the listener currently has its own workspace + soul doc. The one-reader
   design wanted them merged; the constraint judge saw no violation either way.
3. Channel-surface conversations (top-level chatter that never threads): keep the current
   per-message rooting, or give the venue surface its own row? Current rooting is the safe
   default; a venue row is nicer for rendering but re-opens the keying question.
