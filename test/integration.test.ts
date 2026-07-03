// End-to-end wiring proof: FakeAdapter (inbound) -> router -> turn admission -> the M4 toolset
// running against a FakeAgentRuntimeSession -> outbound delivery. Not a substitute for the live
// Slack round-trip (which needs real credentials) — this proves the pieces compose correctly.
import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { getTask } from "../src/ledger/tasks";
import { routeMessage, type Event } from "../src/adapter/router";
import { TurnAdmission, type AnchorKey } from "../src/adapter/turn-admission";
import { deliverPost } from "../src/adapter/outbound";
import { buildToolset } from "../src/turn-runner/toolset";
import { FakeAdapter } from "./fakes/fake-adapter";
import { FakeAgentRuntimeSession } from "./fakes/fake-runtime-session";
import type { AgentRuntimeSession } from "../src/turn-runner/types";
import type { IdentityConfig } from "../src/policy/schema";
import type { Policy } from "../src/policy/schema";
import type { Clock } from "../src/ledger/clock";

function freshDb() {
  return openLedger(":memory:");
}

function fakeClock(start = "2026-07-02T00:00:00Z"): Clock {
  return () => start;
}

function identity(overrides: Partial<IdentityConfig> = {}): IdentityConfig {
  return {
    id: "eng",
    persona: null,
    venueIds: ["C1"],
    learningSources: [],
    grants: [],
    budget: { monthlyCap: 100, perTaskCap: null },
    ambient: { enabledVenues: [], tickIntervalMs: 1800000, dailyPostCap: 5, followupQuietMs: 3600000, eventDebounceMs: 0 },
    ...overrides,
  };
}

function policyWith(id: IdentityConfig): Policy {
  return {
    surface: { kind: "slack", credentials: {} },
    operatorPrincipals: ["U_OPERATOR"],
    trustedBotPrincipals: [],
    defaultDmIdentity: null,
    identities: [id],
    turns: { ackTimeoutMs: 5000, interactiveTimeoutMs: 120000, interactiveTokenCeiling: 100000, historyWindow: 50, maxConcurrentInteractive: 4, maxRetries: 2 },
    executions: { maxConcurrentPerIdentity: 2, maxConcurrentGlobal: 4, progressMaxSilenceMs: 300000, maxTurns: 40, stallTimeoutMs: 300000, maxAttempts: 3, backoffMs: 30000 },
    tasks: { nudgeAfterMs: 86400000, parkAfterMs: 172800000 },
    memory: { distillationCadenceMs: 86400000, maxItemsPerIdentity: null, backfillWindowMs: null },
    budget: { unit: "USD", timezone: "UTC", globalMonthlyCap: 1000, reserve: 0, spendConfirmThreshold: 0 },
    retention: { auditRetentionMs: null, rawEventRetentionMs: null },
  };
}

describe("end-to-end: adapter -> router -> turn admission -> toolset -> outbound", () => {
  test("a mention creates a task and the model's reply is posted back to the triggering anchor", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const adapter = new FakeAdapter();
    const policy = policyWith(identity());

    let handledEvents: Event[] = [];
    const admission = new TurnAdmission({
      maxConcurrentInteractive: 4,
      ackTimeoutMs: 5000,
      ackIfSlow: () => {},
      runInteractiveTurn: async (identityId, anchor: AnchorKey, events: Event[]) => {
        handledEvents = events;
        const event = events[0]!;
        const effects: unknown[] = [];
        const tools = buildToolset({
          db,
          clock,
          identity: policy.identities.find((i) => i.id === identityId)!,
          turnKind: "interactive",
          catalog: {},
          anchor: { venueId: anchor.venueId, threadRootId: anchor.threadRootId },
          principal: { id: event.principalId ?? "unknown", isGuest: false, isOperator: false },
          originEventId: event.id,
          nudgeAfterMs: policy.tasks.nudgeAfterMs,
          postMessage: async (a, text) => deliverPost(() => adapter.postMessage(a.venueId, a.threadRootId, text), { maxAttempts: 3, backoffMs: 1, sleep: () => Promise.resolve() }) as Promise<{ messageId: string }>,
          effects,
        });
        const session: AgentRuntimeSession = new FakeAgentRuntimeSession(tools, async (_n, t) => {
          await t.get("task_create")!.run({ title: "dig in", spec: `handle: ${event.text}` });
          await t.get("reply")!.run({ text: "on it — created T-1" });
        });
        await session.start("/tmp");
        const threadId = await session.startThread("/tmp");
        await session.runTurn(threadId, "/tmp", "prompt", "title");
      },
    });

    adapter.onMessage((msg) => {
      const result = routeMessage(db, clock, msg, { botPrincipalId: "BOT1", policy, newEventId: () => `e${Math.random()}` });
      if (result.kind === "addressed") {
        admission.enqueue(result.event.identityId, { venueId: result.event.venueId, threadRootId: result.event.threadRootId }, result.event);
      }
    });

    adapter.emit({
      venueId: "C1",
      venueKind: "channel",
      principalId: "U1",
      isBot: false,
      text: "<@BOT1> why is the dashboard slow",
      ts: "1.0",
      threadRootTs: null,
      mentionsBotId: true,
      deliveryId: "1.0",
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(handledEvents).toHaveLength(1);
    expect(getTask(db, "T-1")?.status).toBe("open");
    expect(getTask(db, "T-1")?.spec).toContain("why is the dashboard slow");
    expect(adapter.posts).toEqual([{ venueId: "C1", threadRootTs: null, text: "on it — created T-1" }]);
  });

  test("a duplicate delivery of the same message produces no second turn and no second task", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const adapter = new FakeAdapter();
    const policy = policyWith(identity());

    let turnCount = 0;
    const admission = new TurnAdmission({
      maxConcurrentInteractive: 4,
      ackTimeoutMs: 5000,
      ackIfSlow: () => {},
      runInteractiveTurn: async () => {
        turnCount++;
      },
    });

    adapter.onMessage((msg) => {
      const result = routeMessage(db, clock, msg, { botPrincipalId: "BOT1", policy, newEventId: () => `e${Math.random()}` });
      if (result.kind === "addressed") {
        admission.enqueue(result.event.identityId, { venueId: result.event.venueId, threadRootId: result.event.threadRootId }, result.event);
      }
    });

    const raw = {
      venueId: "C1",
      venueKind: "channel" as const,
      principalId: "U1",
      isBot: false,
      text: "<@BOT1> hello",
      ts: "1.0",
      threadRootTs: null,
      mentionsBotId: true,
      deliveryId: "1.0",
    };
    adapter.emit(raw);
    adapter.emit(raw); // redelivered

    await new Promise((r) => setTimeout(r, 20));
    expect(turnCount).toBe(1);
  });
});

describe("ambient dismissal feedback (SPEC §9.3) — composed from existing machinery, no new harness code", () => {
  test("a member's un-mentioned reply in an ambient flag's thread is addressed, letting the model record the dismissal to memory", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const adapter = new FakeAdapter();
    const policy = policyWith(identity());

    // 1. The ambient turn posts a flag (SPEC §9.2) — no member involved yet. This is the ONLY
    //    ambient effect: posting establishes thread participation via toolset.ts's reply tool.
    const ambientEffects: unknown[] = [];
    const ambientCtx = {
      db,
      clock,
      identity: policy.identities[0]!,
      turnKind: "ambient" as const,
      catalog: {},
      anchor: null,
      ambientEnabledVenues: ["C1"],
      ambientDailyPostCap: 5,
      nudgeAfterMs: policy.tasks.nudgeAfterMs,
      postMessage: (a: { venueId: string; threadRootId: string | null }, text: string) => adapter.postMessage(a.venueId, a.threadRootId, text),
      effects: ambientEffects,
    };
    const ambientTools = buildToolset(ambientCtx);
    const flagResult = await ambientTools.find((t) => t.spec.name === "reply")!.run({ text: "heads up: deploy X looks stalled", venueId: "C1" });
    expect(flagResult.success).toBe(true);
    const flagTs = adapter.posts[0]!;
    expect(flagTs.venueId).toBe("C1");

    // 2. A member replies dismissively in that thread WITHOUT mentioning the bot. Per SPEC §5.1
    //    this must still be addressed, because the agent posted there (not just because it was
    //    mentioned) — the fix this session made to router.ts's thread-participation tracking.
    let handledEvents: Event[] = [];
    const admission = new TurnAdmission({
      maxConcurrentInteractive: 4,
      ackTimeoutMs: 5000,
      ackIfSlow: () => {},
      runInteractiveTurn: async (identityId, anchor, events) => {
        handledEvents = events;
        const event = events[0]!;
        const effects: unknown[] = [];
        const tools = buildToolset({
          db,
          clock,
          identity: policy.identities.find((i) => i.id === identityId)!,
          turnKind: "interactive",
          catalog: {},
          anchor: { venueId: anchor.venueId, threadRootId: anchor.threadRootId },
          principal: { id: event.principalId ?? "unknown", isGuest: false, isOperator: false },
          originEventId: event.id,
          nudgeAfterMs: policy.tasks.nudgeAfterMs,
          postMessage: async (a, text) => adapter.postMessage(a.venueId, a.threadRootId, text),
          effects,
        });
        // Simulating the model's own interpretation of "not useful" — the harness never string-
        // matches for this; it's the model that decides to call memory_write.
        await tools.find((t) => t.spec.name === "memory_write")!.run({ content: "eng team found the deploy-stalled flags noisy; suppress similar in future" });
      },
    });

    adapter.onMessage((msg) => {
      const result = routeMessage(db, clock, msg, { botPrincipalId: "BOT1", policy, newEventId: () => `e${Math.random()}` });
      if (result.kind === "addressed") {
        admission.enqueue(result.event.identityId, { venueId: result.event.venueId, threadRootId: result.event.threadRootId }, result.event);
      }
    });

    // The reply is threaded on the flag's own returned message id (FakeAdapter's first
    // postMessage call returns messageId "1").
    adapter.emit({
      venueId: "C1",
      venueKind: "channel",
      principalId: "U1",
      isBot: false,
      text: "eh, not really useful",
      ts: "101.0",
      threadRootTs: "1", // FakeAdapter's first postMessage call returns messageId "1"
      mentionsBotId: false,
      deliveryId: "101.0",
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(handledEvents).toHaveLength(1);
    expect(handledEvents[0]?.kind).toBe("addressed_message");

    const { queryMemory } = await import("../src/ledger/memory");
    const items = queryMemory(db, "eng");
    expect(items.some((i) => i.content.includes("suppress similar"))).toBe(true);
  });
});
