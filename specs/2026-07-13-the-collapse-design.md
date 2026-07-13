# The Collapse

**Date:** 2026-07-13 · **Status:** implemented (hard cutover per operator — no flag, no classic mode)
**Replaces:** the four-turn-kind architecture for conversation (§5/§9 interactive+ambient+
distillation). Tasks/executions keep today's machinery until hands are needed.

## The loop

```
while alive:
  wait for messages (addressed → wake now; otherwise let them settle)
  deliver them to the ONE resident codex thread, verbatim:
      [<#C0981QXKAV9> ts=123.45] <@U096…>: the export thing is back
  she does whatever she does (reply, react, tool, take notes, nothing)
  when the thread gets fat (or wedges), rotate:
      a fresh thread reads AGENTS.md + her workspace notes and IS her
```

The harness delivers messages, gates consequential tools, and rotates. That's all it does.

## What carries her across rotations

Her own notes. The workspace is hers (shell access already exists); AGENTS.md carries the
soul + core memory and says the workspace is her desk. Continuity is only as good as her
notes — that's not solved by architecture, it's solved by character, and by rotating early
and often so bad notes surface fast. (Rotate her mid-day and see: that's the whole test.)

## The three survivors (load-bearing, not ceremony)

1. **The broker** — consequential actions still need preauth or a go-ahead; resident wakes
   get interactive-grade gating (a non-preauthorized write is denied into task_create).
2. **Tasks + timers** — commitments that must outlive any thread. Executions dispatch exactly
   as today; she creates and steers them from the resident thread. (Since 2026-07-13: executions never post; their outcomes wake her and she voices them. Each task
   carries a tier — low/medium/high — mapping to a model+effort in policy.models.)
3. **Audit + budgets** — every wake is a recorded turn (`kind: resident`), metered as ever.

## Mechanics (the few that exist)

- **Inbox = the events table** (it already is one: deduped, identity-scoped, durable). A
  per-identity cursor marks what's been delivered; restart re-delivers everything past the
  cursor. Addressed events wake immediately (ack shimmer per §5.2); observed events settle
  behind a debounce and batch into the next wake.
- **Resident thread** = one `conversation_threads` row (venue `__resident__`). Rotation at a
  turn cap or on context exhaustion; a fresh thread's opening wake carries the toolbox digest
  and a two-line orientation, nothing else. `refreshSoul()` runs before every fresh thread.
- **Posting scope**: a resident wake may post to any venue its identity serves (`venue_ids`,
  wildcard honored). Reactions target messages by venue+ts from the delivered lines.
- **No flag** (operator call, 2026-07-13): hard cutover. Interactive dispatch, ambient
  sweeps, and distillation are deleted — tending memory and notes is what she does on quiet
  wakes.

## Milestones

- **M15 — build the loop behind the flag** (this change).
- **M16 — live-fire**: flip the flag on the VM, rotate her mid-day on purpose, judge whether
  she's still herself. Her notes pass or they don't.
