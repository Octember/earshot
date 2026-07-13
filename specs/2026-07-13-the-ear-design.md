# The Ear

**Date:** 2026-07-13 · **Status:** proposed, rev 2 after adversarial review (operator review;
SPEC §5.1 + §11 amendments follow approval)
**Extends:** the collapse (one resident mind). Adds a second organ: a small, always-on,
voiceless attention pass that decides WHEN the mind wakes — never what it sees, never what
it says.

## The problem, from the tape

Live failures on collapse day, all one class: the mind is structurally a **participant**.
Woken BY a message, holding the mic, in a thread stacked with its own replies, it cannot also
be the judge of whose turn it is. It ruled on a permission question that was the operator's
call; it whiffed a direct ask into silence and one-shot delivery made the whiff permanent;
told to stfu, nothing kept that silence standing. The soul kept instructing the participant
to behave like an observer. Stance comes from position in the frame, not from instructions.

The volume says where the fix has to live: 167 inbox messages → 123 mind wakes → 32 posts.
74% of wakes exist to conclude "nothing here is mine." The hot path is attention, not speech,
and today attention costs a full mind wake at sol prices with participant bias.

## What the research says (Tag docs + turn-taking literature)

- **Tag has no per-message gate.** It splits by surface: DMs and threads-it's-in are answered
  always (participant stance is CORRECT there); only top-level channel traffic gets judgment,
  and that judgment crystallizes into standing per-channel state (self-quieting, re-armed by
  mention). Judged occasionally, cached durably, never re-litigated per message.
- **Every serious system separates a cheap judge from the expensive speaker** (GroupGPT: 4B
  judge, six-way verdict incl. stay-silent, ~33% of messages reach the big model). Asking the
  big model "should you reply?" per message is the documented failure mode.
- **Addressee recognition is a distinct sub-problem** LLMs do badly when blended into
  generation; reply-structure and recency carry as much signal as content.

## The one rule that makes it safe

**The ear gates waking, never delivery.** The mind's inbox, cursor, and verbatim-delivery
semantics are untouched: every message still reaches the resident thread, in order, exactly
as today. A "hold" verdict only means *no wake right now* — held chatter stays pending and
rides the next wake whenever one happens (a mention, a promotion, a worker outcome), so the
mind keeps its working memory of the room's register and running context. Nothing is ever
dropped, summarized-instead-of-delivered, or reachable only through the ear's gloss. This is
what keeps §11 "deliver, don't compose" true and makes fail-open trivial: a dead ear just
means wakes fire on today's schedule.

## The loop, amended

```
message arrives:
  DM, or explicit @mention, or reply in a thread she's ENGAGED in,
  or a worker outcome                      →  wake the mind now (unchanged, no judge in path)
  everything else (channel chatter,
  replies in threads she stepped back of)  →  stays pending; the ear will judge on debounce

the ear (models.low, fresh codex thread per pass, read-only tools, NO voice):
  one pass per debounced batch, reading forward from ITS OWN cursor (ear_cursor — a second
  per-identity scalar; the mind's cursor is never touched by the ear)
  the same pass answers both questions:
    for observed traffic:   wake now?  →  verdict per conversation: hold | wake (+ one
                            room-safe why-line) | open_ask (hers and owed → attention item)
    for addressed traffic:  bookkeeping only, never gating — a direct ask of her opens an
                            attention item; it saw the mind was woken, it judges nothing
  every verdict (including hold) is one audit row: message ref + verdict + why

the mind (unchanged):
  a wake delivers ALL pending messages verbatim, held chatter included, exactly as today;
  ear-promoted wakes append the ear's why-line as an annotation, never a replacement
  open attention items ride as a short standing section (capped, see below)
  it speaks, works, reacts, steps back, or does nothing — every word is still its own
```

Concurrency: the ear writes only `ear_cursor`, attention items, and wake requests. A mention
arriving mid-ear-pass just wakes the mind, which delivers everything pending regardless of
the in-flight judgment; an ear "wake" verdict for content already delivered collapses into
the existing rerun path (a wake with an empty inbox is a no-op). No shared cursor, no lock.

## Standing engagement state (Tag's self-quieting, generalized)

- A thread is **engaged** when she's been mentioned there or has posted/reacted there
  (today's thread-participation rule, unchanged). Engaged replies wake the mind directly:
  in a conversation she's genuinely in, turn-pressure is legitimate.
- **`step_back`** — a new resident tool. Her own judgment ("this is between the humans now",
  "he told me to stop") recorded as thread state with a why, ledger-audited, never posted.
  Concretely: `addressModeOf`'s thread_follow branch checks the step-back bit and downgrades
  to observed when set; the mention check runs first and always wins, so an explicit mention
  re-engages regardless. (Without this router change the bit would be bookkept but inert.)
- No per-venue quiet state in v1. One bit covers the observed failures; venue-level
  self-quieting is a follow-up if the ear's verdicts show a channel that wants it.

## Attention items (what she owes)

A row: identity, venue, thread, the ask's ts, one line of what's owed, opened by the ear.
Closure has two hands:

- **Optimistic close (harness bookkeeping, same transaction as the post):** when the mind
  replies or reacts into an open item's thread, the item closes immediately — the mind never
  sees a "still open" flag for an ask it just answered, and never re-answers its own work.
- **The ear audits:** on later passes it can reopen an item whose "answer" didn't actually
  address the ask, or close one settled some other way (asker withdrew, went stale) — always
  a verdict with a cause.

Bounds, because luna will be wrong in both directions: the standing section carries at most
5 items (oldest drop off with an audit note, item stays queryable); an item past a max age
isn't silently trusted to luna's closure judgment — it's flagged INTO the next wake for the
mind's own call ("this has been open two days — settle it or drop it"). The harness stores,
caps, and displays; every open/close/reopen is a judgment with an audit row.

## What stays sacred

1. **The harness never speaks** — the ear has no posting tools, no react, no voice. Its
   why-lines are written room-safe (the mind may echo them) but only the mind posts.
2. **A mention always reaches the mind, immediately.** The ear sits only on traffic that
   today burns a wake to dismiss. Fail-open: a dead/timed-out ear pass schedules the wake it
   would have judged (today's exact behavior), audit-logged.
3. **The mind hears everything, eventually.** Verbatim delivery of all traffic is preserved;
   the ear only re-times it.
4. **Everything is a turn.** Ear passes record as turns (new kind), envelope-bounded, billed
   to the identity like every other invocation; every verdict is auditable.

## Mechanics

- **Routing**: addressed (mention/DM/engaged thread reply) wakes the mind as today; observed
  no longer schedules a wake — it schedules an ear pass on the existing debounce. Worker
  outcomes and timers wake the mind as today.
- **The ear's context**: its own standing doc per identity (observer instructions + identity
  summary + core memory facts — NOT the participant soul; separate cwd so codex loads the
  right AGENTS.md). Read-only thread/channel tools. Verdicts come back through one
  structured tool call, not final-text parsing; each pass reads only the delta past
  `ear_cursor` plus the live threads that delta touches.
- **Tier**: `models.low` (luna today) via the existing per-task tier machinery. If live-fire
  shows luna misjudging ownership, the dial already exists.
- **Schema v-next**: `turns.kind` gains `attention`; `attention_items` table; `ear_cursor`
  (second per-identity scalar beside `resident_cursor`); step-back bit (+ why, + at) on
  thread participation; `ear_verdict` added to the audit-kind CHECK.
- **Numbers, honestly**: total model invocations go UP (~123 → ~55 mind wakes + ~70 ear
  passes); the claim is cost and stance, not call count — sol invocations drop by roughly
  half, the dismissals move to luna, and held chatter amortizes into fewer, slightly larger
  wakes. Mention-ack latency unchanged; observed-traffic latency gains one luna pass on a
  path that was already debounced.

## What this does NOT do

- Doesn't un-collapse: no interactive/ambient/distillation resurrection. The mind is one
  resident thread and the only speaker. The ear re-times and remembers; it cannot post,
  react, create tasks, or write memory.
- Doesn't touch how the mind decides what to SAY. The kate permission-question failure is
  soul + model, and stays fixed there; architecture only removes the manufactured turns
  where a wrong answer gets composed.

## SPEC deltas required (on approval)

- §11: routing (observed → ear), the waking-not-delivery rule, ear contract, attention
  items, step_back.
- §5.1: "observed messages MUST NOT trigger turns directly except via the ambient subsystem"
  — the collapse already orphaned this clause (observed events schedule resident wakes
  today); the amendment names the ear as the successor of the exception.
- §4.1.6: turn kind `attention`.

## Live-fire checks (the tape, replayed)

- **stfu** → mind steps back → thread routes observed → ear holds → silence persists
  structurally; mention re-engages.
- **julia's ask** → mention wakes mind (unchanged) → whiff → the ear's bookkeeping opened an
  attention item → it rides the next wake: "julia's ticket ask, 13:52, still unanswered";
  when the mind answers, the optimistic close retires it in the same transaction.
- **channel coverage alerts** (observed bot traffic) → ear: hold (audited) or wake-with-why,
  at luna prices, instead of 91 sol wakes concluding "not mine" — and the alert lines still
  reach the mind's thread verbatim on its next wake.

## Milestones

- **M18 — the ear**: schema migration, ear pass + verdict tool, routing switch, step_back
  (incl. the addressModeOf change), attention items + optimistic close, prompt sections.
  Suite green; §18 rows for: ear cannot post; dead ear fails open (wake fires); mention
  bypasses and re-engages a stepped-back thread; hold leaves messages pending and they ride
  the next wake verbatim; hold writes an audit row; attention item opens on ear verdict,
  optimistically closes on the mind's in-thread reply, reopens only by ear verdict; standing
  section cap + max-age flag to the mind.
- **M19 — live-fire**: a full day. Judge: sol-wake reduction (~50%), zero missed mentions,
  stfu-persistence, whether open asks resurface and close honestly, luna's ownership calls,
  and whether held-chatter batches read fine to the mind (register, continuity).
