# The Ear

**Date:** 2026-07-13 · **Status:** proposed (operator review; SPEC §11 amendment follows approval)
**Extends:** the collapse (one resident mind). Adds a second organ: a small, always-on,
voiceless attention pass that decides what reaches the mind. The mind stays the only speaker
and the only judge of what to say.

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

## The loop, amended

```
message arrives:
  DM, or explicit @mention, or reply in a thread she's ENGAGED in,
  or a worker outcome                      →  wake the mind (unchanged, no judge in the path)
  everything else (channel chatter,
  replies in threads she stepped back of)  →  the ear (debounced, as observed batches settle)

the ear (models.low, fresh codex thread per pass, read-only tools, NO voice):
  reads the batch + the live threads it belongs to
  returns verdicts, one per conversation:
      hold        nothing here is hers
      wake        hers: answer / work — wake the mind, one room-safe line of why
      open_ask    hers and OWED: persists as an attention item until the ear sees it settled
  it also bookkeeps addressed traffic after the fact (never gating it):
      a direct ask of her opens an attention item; her reply/react/task closes it

the mind (unchanged):
  wakes carry messages verbatim + the ear's why-lines + any open attention items
  it speaks, works, reacts, steps back, or does nothing — every word is still its own
```

## Standing engagement state (Tag's self-quieting, generalized)

- A thread is **engaged** when she's been mentioned there or has posted/reacted there
  (today's thread-participation rule, unchanged). Engaged replies wake the mind directly:
  in a conversation she's genuinely in, turn-pressure is legitimate.
- **`step_back`** — a new resident tool. Her own judgment ("this is between the humans now",
  "he told me to stop") recorded as thread state with a why, ledger-audited, never posted.
  A stepped-back thread routes to the ear like any other chatter. An explicit mention
  re-engages, always — the guarantee rung survives every state.
- No per-venue quiet state in v1. One bit (per-thread step-back) covers the observed
  failures; venue-level self-quieting is a follow-up if the ear's verdicts show a channel
  that wants it.

## Attention items (what she owes, judged not mechanized)

A row: identity, venue, thread, the ask's ts, one line of what's owed, opened/closed by the
EAR's judgment only. Open items ride every wake prompt as a short standing section ("still
open: julia asked for a ticket, 13:52, unanswered"). The ear closes items when it sees the
answer land, the asker withdraw, or the thing go stale — closure is a verdict with a cause,
not a TTL. The harness stores and displays; it never decides.

This is the no-dangling-threads invariant extended to conversation: a fumbled ask resurfaces
as perception on the next wake, not as mechanical redelivery, and not never.

## What stays sacred

1. **The harness never speaks** — the ear has no posting tools, no react, no voice. Its
   why-lines are written room-safe (the mind may echo them) but only the mind posts.
2. **A mention always reaches the mind.** The ear gates only traffic the mind would today
   burn a wake dismissing. Fail-open: a dead/timed-out ear pass delivers its batch to the
   mind unjudged (today's exact behavior), audit-logged.
3. **Everything is a turn.** Ear passes record as turns (new kind), envelope-bounded, billed
   to the identity like every other invocation.

## Mechanics

- **Routing** reuses the router's existing classification: addressed (mention/DM/engaged
  thread reply) → mind, as today; observed → ear instead of mind. Worker outcomes and
  timers → mind, as today. Cursor semantics unchanged; the ear pass advances the observed
  cursor the way a wake does now.
- **The ear's context**: its own standing doc (observer instructions + identity summary +
  core memory facts — NOT the participant soul; separate cwd so codex loads the right
  AGENTS.md). Read-only thread/channel tools. Verdicts come back through one structured
  tool call, not final-text parsing.
- **Tier**: `models.low` (luna today) via the existing per-task tier machinery. If live-fire
  shows luna misjudging ownership, the dial already exists.
- **Schema v-next**: `turns.kind` gains `attention`; `attention_items` table; a step-back
  bit (+ why, + at) on thread participation.
- **Numbers**: mind wakes ~123/day → ~55 (addressed + promoted); ear passes ~70 observed
  batches + ~50 bookkeeping passes on luna. Mention-ack latency unchanged — the judged path
  is the debounced one.

## What this does NOT do

- Doesn't un-collapse: no interactive/ambient/distillation resurrection. The mind is one
  resident thread and the only speaker. The ear routes and remembers; it cannot post, react,
  create tasks, or write memory.
- Doesn't touch how the mind decides what to SAY. The kate permission-question failure is
  soul + model, and stays fixed there; architecture only removes the manufactured turns
  where a wrong answer gets composed.

## Live-fire checks (the tape, replayed)

- **stfu** → mind steps back → thread silence persists structurally; mention re-engages.
- **julia's ask** → mention wakes mind (unchanged) → whiff → ear's bookkeeping opened an
  attention item → it rides the next wake: "julia's ticket ask, 13:52, still unanswered."
- **channel coverage alerts** (observed bot traffic) → ear: hold or wake-with-why, at luna
  prices, instead of 91 sol wakes concluding "not mine."

## Milestones

- **M18 — the ear**: schema migration, ear pass + verdict tool, routing switch, step_back,
  attention items on the wake prompt. Suite green; §18 rows for: ear cannot post; dead ear
  fails open; mention bypasses; step-back routes to ear; attention item opens/closes on
  ear verdicts only.
- **M19 — live-fire**: a full day. Judge: mind-wake reduction (~50%), zero missed mentions,
  stfu-persistence, whether open asks resurface and close honestly, luna's ownership calls.
