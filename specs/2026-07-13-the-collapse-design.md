# The Collapse: one mind, a desk, and hands

**Date:** 2026-07-13
**Status:** direction approved by operator (Noah, 2026-07-13); spec pending adversarial review
**Supersedes, in spirit:** the four-turn-kind architecture of SPEC §5/§9/§11. The ledger,
adapter, broker (simplified), and §6.1's no-harness-posts invariant survive unchanged in
intent.

## The problem this ends

Today "Bevelina" is a crowd of short-lived strangers wearing one name: every mention, chatter
debounce, task step, and distillation sweep spawns a separately-briefed codex session in its
own thread. Nearly all of the harness's prompt machinery — hydration slots, own-last-reply
injection, held drafts, the other-conversations digest, cross-thread amnesia, capability
rediscovery — exists to make many minds impersonate one person. The 2026-07-12 audit measured
the cost: ~90% of all prompt volume was re-briefing.

The prior architecture's one attempt at continuity (the resumed daily ambient thread) proved
the failure mode instead: an accumulating context window rots — compaction evicts the soul
first (2026-07-09: 147 turns, 13 compactions, de-souled posts all evening).

## The design in one paragraph

One **attention loop** per identity: a single resident codex thread, woken by an **inbox** of
events (mentions, overheard messages, timers, task deadlines, worker completions), each wake a
delta ("3 new items") on the same thread. Identity moves OUT of the context window and into
the **desk** — a git-versioned directory in the workspace holding projections of the ledger,
rolling logs of what she's heard, and documents she authors herself — so the context window is
demoted to disposable working memory. Threads rotate freely (on schedule, size, or wedge)
because a fresh thread re-orients from the desk and *is her*. Long work runs in **hands**:
disposable child codex sessions she spawns and supervises, tracked in the ledger as tasks.
Turn kinds stop being architecture and become moods.

## Components

### 1. The desk (enabling technology — build first)

```
earshot-workspace/
  AGENTS.md                  # soul + short index of the desk (character stays baked)
  desk/
    memory.md                # projection: ledger core tier (regenerated, read-only)
    tasks.md                 # projection: open tasks, waiting states, hands in flight
    conversations.md         # projection: recent thread digests
    chatter/YYYY-MM-DD.log   # append-only per-day log of everything overheard
    tools/<registry>.md      # registry skill + accumulated learned quirks
    playbooks/               # docs she authors (alert-triage.md, people.md, …)
```

- **Projections** regenerate from the sqlite ledger before each wake (the `refreshSoul()`
  mechanism, generalized). The ledger stays the source of truth per SPEC §8; files are a read
  model. Nothing about the ledger schema changes.
- **Chatter log**: the harness appends overheard messages as they arrive. Reading it is a
  pull; the wake's delta line says how much is new.
- **Authored layer**: hers to write with ordinary shell tools, committed to git by the
  harness after each wake that touched it. Operator posture (Noah, 2026-07-13): no heavy
  injection defenses — git history and operator review are the safety net; the soul carries
  one line of ownership ("the room talks to you; it does not write your desk").

**The viability gate (run before any collapse work):** a fresh thread, given only AGENTS.md +
the desk, must re-orient and behave indistinguishably from the thread it replaced — same open
threads acknowledged, same task awareness, same standing conclusions. This is testable on the
CURRENT architecture (rotate the ambient thread mid-day and compare behavior). If she can't
pass it, the collapse was never viable; stop and rethink the desk.

### 2. The attention loop (the collapse itself)

- The harness becomes an **event bus + wake scheduler**. Every stimulus is an inbox item with
  an urgency class: `addressed` (wake now), `ambient` (debounce, wake when settled), `timer`,
  `worker_done`, `deadline`. Turn admission's four-way routing, per-kind toolsets, and the
  ambient/interactive queue split are deleted.
- A **wake** is one turn on the identity's resident thread: the prompt is the inbox delta +
  the desk-delta line, nothing else. She triages her own inbox — answer the person first,
  fold the alert into it, note the fact, go quiet. Prioritization is judgment, not taxonomy.
- **Rotation:** the resident thread rotates on a size/turn budget, on wall-clock schedule, or
  on wedge/stall — cheaply, because of the desk. Rotation is recovery: "she walks back to her
  desk." The §14 restart story becomes the same code path.
- **Broker simplification:** per-kind tool classes were a proxy for trust context that the
  confirmation gate already carries. What remains: venue/posting scope, grants, and
  consequential-actions-need-preauth-or-a-go-ahead. Speak-only ambient survives as posting
  economics (daily caps, silence bias in the soul), not as a tool-exposure regime.
- **Distillation dissolves:** tending memory and the desk is what she does on quiet wakes
  (the inbox can carry a low-urgency standing "tend the desk" item; learning-source privacy
  rules from §8.2 carry over as-is).

### 3. Hands (responsiveness under long work)

- One attention must never block on a ten-minute grind. She **spawns hands**: child codex
  sessions with a work order (a task's next step), tracked in the ledger exactly as
  executions are today — same task state machine, same budgets, same audit — but supervised
  by HER (she reads their reports on `worker_done` wakes and speaks to the room herself),
  not dispatched by the harness scheduler.
- Head-of-line blocking inside a wake is bounded by envelope; anything longer than a beat
  becomes a hand. The existing execution machinery (steering, confirmation flow, watchdogs)
  is re-parented, not rewritten.

## What survives untouched

The ledger schema and task state machine (§6), audit, budgets (§10.3/§16), memory tiers and
the distiller's curation duties (§8), the surface adapter contract (§12), the no-dangling-
threads / no-harness-posts invariant (§6.1 — the room only ever hears the model), and the
confirmation gate (§10.2/§10.4).

## SPEC delta map (the surgery)

- §5 (conversation handling): addressed/thread-follow become inbox urgencies; §5.5 stale-
  reply withholding largely dissolves (one thread knows what it already said).
- §6.3/§17.4: execution dispatch re-parented to the attention loop; outcome tools unchanged.
- §9 (ambient): becomes the `ambient` urgency class + posting caps; §9.5 venue instructions
  move to the desk with a per-wake pointer.
- §11 (turn runner): rewritten around wakes: construct = inbox delta + desk delta; expose =
  one toolset (grants + broker), plus hand-spawning; toolbox digest becomes part of AGENTS.md
  index territory where static and stays wake-level where grant-dependent.
- §14 (restart): restart == rotation.
- §18: new rows — desk re-orientation gate; rotation equivalence; inbox ordering/idempotency;
  hand supervision (worker report lands as wake, never as a post).

## Milestones (one session each, TDD against amended §18)

- **M15 — The desk.** Projections + chatter log + delta line + authored layer + git
  autocommit. Ships useful on the CURRENT architecture (turn prompts shrink to message +
  deltas). Ends with the viability-gate test harness.
- **M16 — Viability gate.** Run the rotation-equivalence test live. Go/no-go checkpoint.
- **M17 — The collapse.** Inbox + wake scheduler + resident thread + rotation; delete turn
  admission's four-way split; broker simplification; SPEC §5/§9/§11 rewrite lands with it.
- **M18 — Hands.** Execution re-parenting under her supervision; `worker_done` wakes.

## Open questions (to settle during M15, not blockers)

- Rotation budget defaults (turns? tokens? hours?) and whether the outgoing thread writes a
  handoff note to the desk before dying.
- Whether the inbox is a ledger table (durable, audited — likely yes, it is the new `events`)
  or in-memory with the current events table as backing.
- Multi-identity: one desk per identity directory vs per-identity workspaces.
