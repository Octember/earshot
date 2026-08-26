# Claudeslop Burndown Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip Claude-session residue (essay headers, anthropomorphic code comments, stale agent rules, theatrical process fossils) without changing product behavior or the intentional agent persona in soul prompts.

**Architecture:** Four waves, smallest risk first. Wave 0 fixes lying instructions. Wave 1–2 are comment/prose only (no logic). Wave 3 is ops + claim honesty. Behavior changes are out of scope unless a comment rewrite reveals dead code — then stop and surface it.

**Tech Stack:** Bun, TypeScript, existing `bun run check` gate. No new dependencies.

## Global Constraints

- Do **not** rewrite strings inside `SOUL` / `EAR_SOUL` template literals (`src/turn-runner/soul.ts`, `src/turn-runner/ear-soul.ts`) — that is product voice.
- Do **not** remove SPEC section names from **test titles** (`test/**`) — CONTRIBUTING requires tests to name the § they enforce.
- Do **not** change runtime behavior, schemas, migrations, or tool contracts in this burndown.
- Prefer deleting comment text over rewriting it into a second essay.
- After each task: `bun run check` must stay green.
- Keep commits small: one task per commit unless the user batches.

---

### Task 0: Sync agent instructions with reality

**Files:**
- Modify: `CLAUDE.md:15-16` (ORM ban)
- Modify: `CONTRIBUTING.md:7-9` if it still implies zero deps / no ORM
- Modify: `README.md:33` (“Readable in an afternoon” / near-zero deps)

**Interfaces:**
- Consumes: current `package.json` deps (`drizzle-orm`, `@bevyl-ai/agent-tools`)
- Produces: docs that match the tree

- [x] **Step 1: Fix CLAUDE.md non-negotiable #2**

Replace the ORM ban with language that matches the ledger:

```md
2. **One process, one `bun:sqlite` .db file, zero external services.** No Postgres, Redis,
   queues, or workers. Drizzle is allowed only as the typed query layer over `bun:sqlite`
   (`src/ledger/db.ts`); do not add another database or ORM. If a design needs another
   service, the design is wrong.
```

- [x] **Step 2: Align CONTRIBUTING + README claims**

- CONTRIBUTING: “Zero-ish dependencies” may stay, but mention drizzle as the one justified typed-SQL layer.
- README: drop or soften “Readable in an afternoon”; keep “one process, one sqlite file.”

- [x] **Step 3: Verify**

Run: `rg -n 'No Postgres|ORM|afternoon|near-zero' CLAUDE.md CONTRIBUTING.md README.md`
Expected: no claim that forbids drizzle; no “afternoon” boast.

- [x] **Step 4: Commit**

```bash
git add CLAUDE.md CONTRIBUTING.md README.md
git commit -m "$(cat <<'EOF'
docs: align agent rules with drizzle and drop the afternoon boast

CLAUDE.md still banned ORMs after the ledger cutover; that instruction was lying.
EOF
)"
```

---

### Task 1: Collapse file-header essays to one line

**Files (headers ≥5 `//` lines today):**
- Modify: `src/ledger/conversations.ts` (15)
- Modify: `src/adapter/reply-stream.ts` (14)
- Modify: `src/tools/catalog.ts` (10)
- Modify: `src/service.ts` (9)
- Modify: `src/turn-runner/soul.ts` (9) — keep wiring note; cut taste essay to ≤3 lines max above `SOUL`
- Modify: `src/adapter/outbound.ts` (7)
- Modify: `src/tools/slack.ts` (7)
- Modify: `src/turn-runner/types.ts` (7)
- Modify: `src/turn-runner/ear-soul.ts` (6) — same rule as soul
- Modify: `src/turn-runner/execution-loop.ts` (6)
- Modify: `src/ledger/attention.ts` (5)
- Modify: `src/turn-runner/toolset.ts` (5)

**Interfaces:**
- Consumes: existing exports unchanged
- Produces: ≤2-line file purpose comments (SPEC cite optional, one § max)

- [x] **Step 1: Rewrite each header**

Pattern:

```ts
// Conversation row: delivery, judgment, and standing for one (identity, venue, thread).
```

Not:

```ts
// One room, one row … THE unit … one bug twelve ways … classes die structurally …
```

For `soul.ts` / `ear-soul.ts`: keep a short “written to AGENTS.md / ear cwd” wiring note; delete meta taste lectures.

- [x] **Step 2: Verify no logic drift**

Run: `bun run check`
Expected: PASS

- [x] **Step 3: Commit**

```bash
git add src/
git commit -m "$(cat <<'EOF'
chore: collapse module header essays to one-line purpose

Comments were carrying design-doc narration; behavior is unchanged.
EOF
)"
```

---

### Task 2: De-anthropomorphize code comments (not prompts)

**Files (anthropomorphic `//` comment hits, high first):**
- Modify: `src/service.ts` (~48)
- Modify: `src/ledger/conversations.ts` (~31)
- Modify: `src/turn-runner/toolset.ts` (~13)
- Modify: `src/ledger/attention.ts` (~6)
- Modify: `src/ledger/db.ts` (~5)
- Modify: remaining src files with ≤4 hits (`turns`, `schema`, `broker`, `inbox`, `router`, `slack`, `replay`)

**Keep unchanged:**
- String bodies of `SOUL` and `EAR_SOUL`
- User-facing copy / skill text meant for the model

**Rewrite dictionary (comment-only):**

| Burn | Prefer |
|------|--------|
| she / her / hers | the resident agent / this identity / omit |
| the mind | resident turn / wake |
| the ear | attention pass / ear turn |
| the soul | standing instructions / AGENTS.md |
| the room | the venue / channel |
| the harness | this process / the service |

- [x] **Step 1: Pass service.ts + conversations.ts + toolset.ts**

Delete comments that only restage the design story. Keep comments that explain a non-obvious invariant (dedupe window, transaction boundary, ref-only addressing).

- [x] **Step 2: Pass the long tail**

Same rules for remaining files.

- [x] **Step 3: Gate**

Run:

```bash
rg -n '\b(she|her|hers|the mind|the ear|the soul)\b' src --type ts -g '!**/soul.ts' -g '!**/ear-soul.ts'
```

Expected: hits only inside intentional prompt/skill strings (or zero). If a hit is a `//` comment, fix it.

Run: `bun run check`

- [x] **Step 4: Commit**

```bash
git add src/
git commit -m "$(cat <<'EOF'
chore: strip anthropomorphic voice from code comments

Persona stays in soul prompts; implementation comments describe mechanics.
EOF
)"
```

---

### Task 3: Thin SPEC citation theater in implementation comments

**Files (high `§` density in `//` comments):**
- Modify: `src/service.ts` (~36)
- Modify: `src/turn-runner/toolset.ts` (~23)
- Modify: `src/ledger/memory.ts` (~12)
- Modify: `src/adapter/router.ts` (~10)
- Modify: `src/policy/broker.ts` (~10)
- Modify: `src/ledger/tasks.ts`, `src/policy/schema.ts`, `src/ledger/conversations.ts`, `src/turn-runner/execution-loop.ts`, `src/ledger/scheduler.ts`

**Policy:**
- Keep a SPEC cite when it points at a subtle MUST and there is no nearby named test.
- Remove laundry-list headers (`SPEC §3.1, §13/§17.3, §14.2, §16.2 — …`).
- Do not touch `test/**` titles.

- [x] **Step 1: Strip laundry lists; keep rare precision cites**

Target: cut implementation `§` comment density roughly in half without losing the one-liners that prevent foot-guns.

- [x] **Step 2: Verify**

Run: `bun run check`
Run: `rg -c '§' src --type ts | sort -t: -k2 -nr | head`

- [x] **Step 3: Commit**

```bash
git add src/
git commit -m "$(cat <<'EOF'
chore: thin SPEC section laundry lists from implementation comments

Contract binding stays in tests; code comments keep only the sharp cites.
EOF
)"
```

---

### Task 4: Comment-density pass on the three fattest files

**Files:**
- Modify: `src/service.ts` (today ~23% `//` lines)
- Modify: `src/policy/broker.ts` (~25%)
- Modify: `src/turn-runner/toolset.ts` (~15%)

**Target:** ≤10% `//` comment lines per file, measured as:

```bash
python3 - <<'PY'
import pathlib, re
for p in ["src/service.ts","src/policy/broker.ts","src/turn-runner/toolset.ts"]:
    lines=pathlib.Path(p).read_text().splitlines()
    c=sum(1 for L in lines if L.lstrip().startswith("//"))
    print(f"{100*c/len(lines):.1f}% {c}/{len(lines)} {p}")
PY
```

- [x] **Step 1: Delete restating comments** next to obvious control flow
- [x] **Step 2: Re-measure to ≤10%**
- [x] **Step 3: `bun run check`**
- [x] **Step 4: Commit**

```bash
git add src/service.ts src/policy/broker.ts src/turn-runner/toolset.ts
git commit -m "$(cat <<'EOF'
chore: cut comment density in service, broker, and toolset

Left the invariants; removed the play-by-play.
EOF
)"
```

---

### Task 5: Archive superseded design specs (pointer, don’t delete history)

**Files:**
- Modify: `ROADMAP.md` (add a short “Historical design notes” section with links)
- Move (optional, only if still referenced nowhere as normative):
  - `specs/2026-07-13-the-collapse-design.md`
  - `specs/2026-07-13-the-ear-design.md`
  - `specs/2026-07-12-tool-capability-prompt-design.md`
  - `specs/2026-08-10-one-room-redesign.md`
  - `specs/2026-08-11-enforcement-ladder.md`

**Rule:** `SPEC.md` remains normative. Design notes become historical. Prefer leaving files in `specs/` with a one-line banner at the top:

```md
> **Historical.** Superseded by SPEC.md + code. Kept for incident archaeology; do not treat as contract.
```

Do **not** move if something still imports paths as living docs without that banner.

- [x] **Step 1: Banner each specs/*.md file**
- [x] **Step 2: Add ROADMAP pointer list**
- [x] **Step 3: Commit**

```bash
git add specs/ ROADMAP.md
git commit -m "$(cat <<'EOF'
docs: mark design-proposal specs as historical

Stops agents from treating bankruptcy essays as the live contract.
EOF
)"
```

---

### Task 6: Prune merged `claude/*` branches (ops)

**Scope:** local + remote refs fully contained in current `HEAD`. Baseline from 2026-08-26 inventory: ~44 merged local `claude/*`, ~5 not merged — **do not delete unmerged**.

- [x] **Step 1: List delete candidates**

```bash
git for-each-ref --format='%(refname:short)' refs/heads/claude |
  while read b; do
    git merge-base --is-ancestor "$b" HEAD && echo "$b"
  done
```

- [x] **Step 2: Delete local merged branches**

```bash
# only after reviewing the list
git for-each-ref --format='%(refname:short)' refs/heads/claude |
  while read b; do
    git merge-base --is-ancestor "$b" HEAD && git branch -d "$b"
  done
```

- [x] **Step 3: Delete matching remotes if present** (only with user OK for network)

```bash
git push origin --delete <branch>   # per merged remote twin
```

- [x] **Step 4: Leave the unmerged five alone** and list them in the PR body.

---

## Out of scope (explicit non-goals)

- Refactors of `Service`, ledger schema, or tool broker behavior
- Rewriting soul/ear character text for “less slop”
- Deleting `SPEC.md` or collapsing the §18 test matrix
- Force-push / history rewrite of `claude/*` commits already on main

## Done when

- [x] Tasks 0–5 merged (or stacked PRs) with `bun run check` green
- [x] Task 6 completed or explicitly deferred with the unmerged branch list
- [x] Spot-check: opening `src/service.ts` / `src/ledger/conversations.ts` no longer reads like a design memoir
