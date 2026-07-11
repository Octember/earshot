// M4 "Done when" smoke run: drive one real codex app-server session against a scratch task,
// end-to-end through the actual execution loop (SPEC §17.4). Not a `bun test` — it spawns a real
// subprocess and makes real model calls (slow, non-deterministic, costs tokens). Run manually:
//   bun run scripts/smoke-codex.ts
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openLedger } from "../src/ledger/db";
import { systemClock } from "../src/ledger/clock";
import { createTask, transition, getTask } from "../src/ledger/tasks";
import { runExecution } from "../src/turn-runner/execution-loop";
import { AppServerSession } from "@bevyl-ai/agent-tools";
import { DEFAULT_CODEX_CONFIG } from "../src/turn-runner/types";
import type { IdentityConfig } from "../src/policy/schema";

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), "earshot-smoke-"));
  const db = openLedger(":memory:");
  const clock = systemClock;

  db.query(
    "INSERT INTO events (id, dedup_key, kind, identity_id, received_at) VALUES ('e1', 'k1', 'addressed_message', 'eng', ?)",
  ).run(clock());
  createTask(db, clock, {
    id: "T-1",
    identityId: "eng",
    title: "smoke test",
    spec: "Say hello in one short sentence, then call task_complete with report='smoke test ok'. Do not call any other tool.",
    sponsorId: "operator",
    homeAnchor: { venueId: "C1", threadRootId: null },
    originEventId: "e1",
  });
  transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });

  const identity: IdentityConfig = {
    id: "eng",
    persona: null,
    venueIds: ["C1"],
    learningSources: [],
    grants: [],
    budget: { monthlyCap: 100, perTaskCap: null },
    ambient: { enabledVenues: [], tickIntervalMs: 1_800_000, dailyPostCap: 5, followupQuietMs: 3_600_000, eventDebounceMs: 0 },
  };

  console.log(`[smoke] workspace: ${cwd}`);
  const result = await runExecution({
    db,
    clock,
    taskId: "T-1",
    executionId: "x1",
    identity,
    catalog: {},
    cwd,
    nudgeAfterMs: 24 * 60 * 60 * 1000,
    maxTurns: 5,
    maxConsecutiveInterruptions: 2,
    stallTimeoutMs: 60_000,
    postMessage: async (anchor, text) => {
      console.log(`[smoke] POST ${anchor.venueId}: ${text}`);
      return { messageId: "m1" };
    },
    buildPrompt: (turnNumber, guidance) => {
      const task = getTask(db, "T-1")!;
      const guidanceNote = guidance.length ? `\n\nGuidance since last turn:\n${guidance.join("\n")}` : "";
      return turnNumber === 1
        ? `${task.spec}${guidanceNote}`
        : `Continuation — turn ${turnNumber}. ${task.spec}${guidanceNote}`;
    },
    newTurnId: () => `turn-${Math.random().toString(36).slice(2)}`,
    sessionFactory: (tools) =>
      new AppServerSession(DEFAULT_CODEX_CONFIG, tools, (event) => {
        if (event.log) console.log(`[codex] ${event.log}`);
      }),
  });

  console.log(`[smoke] outcome: ${result.outcome}, turnsRun: ${result.turnsRun}`);
  const task = getTask(db, "T-1")!;
  console.log(`[smoke] final task status: ${task.status}`);
  console.log(`[smoke] terminal report: ${task.terminalReport}`);

  rmSync(cwd, { recursive: true, force: true });

  if (result.outcome !== "done") {
    console.error("[smoke] FAILED — expected outcome 'done'");
    process.exit(1);
  }
  console.log("[smoke] PASSED");
}

main().catch((e) => {
  console.error("[smoke] error:", e);
  process.exit(1);
});
