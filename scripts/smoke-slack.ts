// M6 "Real Integration Profile" smoke run: mention -> ack -> task_create -> progress -> terminal
// report, over a REAL Slack Socket Mode connection, driving a REAL codex app-server session.
// Not a `bun test` — needs SLACK_BOT_TOKEN / SLACK_APP_TOKEN / SLACK_BOT_USER_ID in .env, and a
// human to send one mention in a channel the bot has joined, within the listen window.
//   bun run scripts/smoke-slack.ts
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openLedger } from "../src/ledger/db";
import { systemClock } from "../src/ledger/clock";
import { getTask } from "../src/ledger/tasks";
import { routeMessage } from "../src/adapter/router";
import { TurnAdmission, type AnchorKey } from "../src/adapter/turn-admission";
import { deliverPost } from "../src/adapter/outbound";
import { buildToolset } from "../src/turn-runner/toolset";
import { runExecution } from "../src/turn-runner/execution-loop";
import { runTurn } from "../src/turn-runner/turn";
import { AppServerSession } from "@bevyl-ai/agent-tools";
import { DEFAULT_CODEX_CONFIG } from "../src/turn-runner/types";
import { SlackAdapter } from "../src/adapter/slack";
import type { IdentityConfig } from "../src/policy/schema";
import type { Policy } from "../src/policy/schema";
import type { Event } from "../src/adapter/router";

const botToken = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;
const botUserId = process.env.SLACK_BOT_USER_ID;
if (!botToken || !appToken || !botUserId) {
  console.error("[smoke-slack] missing SLACK_BOT_TOKEN / SLACK_APP_TOKEN / SLACK_BOT_USER_ID in .env");
  process.exit(1);
}

const LISTEN_MS = 90_000;

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), "earshot-smoke-slack-"));
  const db = openLedger(":memory:");
  const clock = systemClock;

  const identity: IdentityConfig = {
    id: "eng",
    persona: null,
    venueIds: [], // bound dynamically to whichever channel the test message arrives in
    learningSources: [],
    grants: [],
    budget: { monthlyCap: 100, perTaskCap: null },
    ambient: { enabledVenues: [], tickIntervalMs: 1_800_000, dailyPostCap: 5, followupQuietMs: 3_600_000, eventDebounceMs: 0 },
  };

  const adapter = new SlackAdapter({ botToken, appToken, botUserId }, (line) => console.log(`[slack] ${line}`));
  await adapter.start();
  console.log("[smoke-slack] connected via Socket Mode. Send a message mentioning the bot in a channel it has joined, within 90s.");
  console.log(`[smoke-slack] e.g.: @<bot> please dig into why the dashboard is slow, then call task_complete`);

  let settled = false;
  const done = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (!settled) {
        console.error("[smoke-slack] TIMED OUT waiting for a message.");
        resolve();
      }
    }, LISTEN_MS);

    adapter.onMessage((msg) => {
      if (settled) return;
      // Bind whichever venue the message arrived in — test scaffolding only, not real venue
      // binding (which normally comes from operator-authored policy).
      identity.venueIds = [msg.venueId];
      const policy: Policy = {
        surface: { kind: "slack", credentials: {} },
        operatorPrincipals: [],
        trustedBotPrincipals: [],
        defaultDmIdentity: null,
        identities: [identity],
        turns: { ackTimeoutMs: 5000, interactiveTimeoutMs: 120_000, interactiveTokenCeiling: 100_000, historyWindow: 50, maxConcurrentInteractive: 4, maxRetries: 2 },
        executions: { maxConcurrentPerIdentity: 2, maxConcurrentGlobal: 4, progressMaxSilenceMs: 300_000, maxTurns: 10, stallTimeoutMs: 300_000, maxAttempts: 3, backoffMs: 30_000 },
        tasks: { nudgeAfterMs: 86_400_000, parkAfterMs: 172_800_000 },
        memory: { distillationCadenceMs: 86_400_000, maxItemsPerIdentity: null, backfillWindowMs: null },
        budget: { unit: "USD", timezone: "UTC", globalMonthlyCap: 1000, reserve: 0, spendConfirmThreshold: 0 },
        retention: { auditRetentionMs: null, rawEventRetentionMs: null },
      };

      const result = routeMessage(db, clock, msg, { botPrincipalId: botUserId, policy, newEventId: () => `e${Math.random().toString(36).slice(2)}` });
      console.log(`[smoke-slack] routed: ${result.kind}`);
      if (result.kind !== "addressed") return;

      settled = true;
      clearTimeout(timeout);

      const admission = new TurnAdmission({
        maxConcurrentInteractive: 4,
        ackTimeoutMs: 5000,
        ackIfSlow: (_id, anchor: AnchorKey) => {
          void adapter.addReaction(anchor.venueId, result.event.id, "eyes").catch(() => {});
        },
        runInteractiveTurn: async (identityId, anchor: AnchorKey, events: Event[]) => {
          const event = events[0]!;
          console.log(`[smoke-slack] running interactive turn for: "${event.text}"`);
          const effects: unknown[] = [];
          const tools = buildToolset({
            db,
            clock,
            identity,
            turnKind: "interactive",
            catalog: {},
            anchor: { venueId: anchor.venueId, threadRootId: anchor.threadRootId },
            principal: { id: event.principalId ?? "unknown", isGuest: false, isOperator: false },
            originEventId: event.id,
            nudgeAfterMs: policy.tasks.nudgeAfterMs,
            postMessage: (a, text) => deliverPost(() => adapter.postMessage(a.venueId, a.threadRootId, text), { maxAttempts: 3, backoffMs: 500 }) as Promise<{ messageId: string }>,
            effects,
          });
          const session = new AppServerSession(DEFAULT_CODEX_CONFIG, tools, (e) => {
            if (e.log) console.log(`[codex] ${e.log}`);
          });
          await session.start(cwd);
          const threadId = await session.startThread(cwd);
          try {
            await runTurn({
              session,
              threadId,
              cwd,
              prompt: `${event.text}\n\nIf this looks like real delegated work, use task_create, then work it via the ledger tools available to you.`,
              title: "interactive",
              db,
              clock,
              turnId: `turn-${Math.random().toString(36).slice(2)}`,
              identityId,
              kind: "interactive",
              effects,
              tokensUsed: () => 0,
              spendAmount: () => 0,
              envelope: { timeoutMs: 120_000, tokenCeiling: 200_000 },
            });
          } finally {
            session.stop();
          }

          // If a task was created, drive it to completion via the real execution loop.
          const created = effects.find((e): e is { kind: string; taskId: string } => (e as any)?.kind === "task_created");
          if (created) {
            console.log(`[smoke-slack] created ${created.taskId}; running its execution to completion...`);
            const { transition } = await import("../src/ledger/tasks");
            transition(db, clock, created.taskId, "active", { type: "dispatch", executionId: "x1" });
            const outcome = await runExecution({
              db,
              clock,
              taskId: created.taskId,
              executionId: "x1",
              identity,
              catalog: {},
              cwd,
              nudgeAfterMs: policy.tasks.nudgeAfterMs,
              maxTurns: 5,
              maxConsecutiveInterruptions: 2,
              stallTimeoutMs: 120_000,
              postMessage: (a, text) => deliverPost(() => adapter.postMessage(a.venueId, a.threadRootId, text), { maxAttempts: 3, backoffMs: 500 }) as Promise<{ messageId: string }>,
              buildPrompt: (turnNumber, guidance) =>
                turnNumber === 1
                  ? "Work this task. When genuinely done, call task_complete with a short honest report."
                  : `Continuation, turn ${turnNumber}. ${guidance.join("\n")}`,
              newTurnId: () => `turn-${Math.random().toString(36).slice(2)}`,
              sessionFactory: (toolset) => new AppServerSession(DEFAULT_CODEX_CONFIG, toolset, (e) => e.log && console.log(`[codex] ${e.log}`)),
            });
            console.log(`[smoke-slack] execution outcome: ${outcome.outcome}, turnsRun: ${outcome.turnsRun}`);
            console.log(`[smoke-slack] final task status: ${getTask(db, created.taskId)?.status}`);
            console.log(`[smoke-slack] terminal report: ${getTask(db, created.taskId)?.terminalReport}`);
          } else {
            console.log("[smoke-slack] no task created — treated as in-envelope conversation.");
          }

          resolve();
        },
      });

      admission.enqueue(result.event.identityId, { venueId: msg.venueId, threadRootId: msg.threadRootTs }, result.event);
    });
  });

  await done;
  adapter.stop();
  rmSync(cwd, { recursive: true, force: true });
  console.log(settled ? "[smoke-slack] PASSED" : "[smoke-slack] FAILED (no message received)");
  process.exit(settled ? 0 : 1);
}

main().catch((e) => {
  console.error("[smoke-slack] error:", e);
  process.exit(1);
});
