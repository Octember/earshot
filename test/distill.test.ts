import { describe, expect, test } from "bun:test";
import { openLedger, one } from "../src/ledger/db";
import {
  writeMemory,
  queryMemory,
  setMemoryTier,
  correctMemory,
} from "../src/ledger/memory";
import {
  archiveAllRecent,
  distillationTimerId,
  maybeArmDistillation,
  recentCharTotal,
} from "../src/ledger/memory-distill";
import { scheduleTimer } from "../src/ledger/timers";
import { PolicyStore } from "../src/policy/load";
import { Service } from "../src/service";
import { FakeAdapter } from "./fakes/fake-adapter";
import { FakeAgentRuntimeSession } from "./fakes/fake-runtime-session";
import { fakeClock } from "./helpers";
import { buildToolset, type ToolsetContext } from "../src/turn-runner/toolset";
import type { IdentityConfig } from "../src/policy/schema";
import type { DynamicTool } from "../src/turn-runner/types";

function freshDb() {
  return openLedger(":memory:");
}

function identity(overrides: Partial<IdentityConfig> = {}): IdentityConfig {
  return {
    id: "eng",
    persona: null,
    venueIds: ["C1"],
    learningSources: [],
    grants: [],
    budget: { monthlyCap: 100, perTaskCap: null },
    ambient: { eventDebounceMs: 0 },
    venueInstructions: {},
    ...overrides,
  };
}

function tool(
  tools: ReturnType<typeof buildToolset>,
  name: string,
): { run: (args: unknown) => Promise<{ success: boolean; output: string }> } {
  const found = tools.find((t) => t.spec.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

const DISTILL_POLICY = `
surface:
  kind: slack
  credentials:
    bot_token: $BOT
operator_principals:
  - U_OPERATOR
memory:
  core_char_budget: 8000
  recent_char_budget: 10
identities:
  - id: eng
    venue_ids: [C1]
    budget: { monthly_cap: 1000 }
budget:
  global_monthly_cap: 100000
models:
  low: { model: test-luna }
  medium: { model: test-terra }
`;

describe("recent-budget distillation arming (§8.6)", () => {
  test("maybeArmDistillation arms only when recent chars >= budget", () => {
    const db = freshDb();
    const clock = fakeClock();
    writeMemory(db, clock, { id: "r1", identityId: "eng", content: "abc", tier: "recent" });
    expect(recentCharTotal(db, "eng")).toBe(3);
    expect(maybeArmDistillation(db, clock, "eng", 10)).toBe(false);
    expect(
      one<{ c: number }>(
        db,
        "SELECT count(*) c FROM timers WHERE kind = 'distillation' AND fired_at IS NULL",
      )?.c,
    ).toBe(0);

    writeMemory(db, clock, {
      id: "r2",
      identityId: "eng",
      content: "0123456789",
      tier: "recent",
    });
    expect(maybeArmDistillation(db, clock, "eng", 10)).toBe(true);
    expect(
      one<{ id: string }>(
        db,
        "SELECT id FROM timers WHERE kind = 'distillation' AND fired_at IS NULL",
      )?.id,
    ).toBe(distillationTimerId("eng"));

    // Singleton: second arm keeps one pending row
    expect(maybeArmDistillation(db, clock, "eng", 10)).toBe(true);
    expect(
      one<{ c: number }>(
        db,
        "SELECT count(*) c FROM timers WHERE kind = 'distillation' AND fired_at IS NULL",
      )?.c,
    ).toBe(1);
  });

  test("memory_write with recentCharBudget arms when full", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx: ToolsetContext = {
      db,
      clock,
      identity: identity(),
      turnKind: "resident",
      catalog: {},
      anchor: null,
      nudgeAfterMs: 0,
      postMessage: async () => ({ messageId: "m" }),
      effects: [],
      recentCharBudget: 5,
    };
    const tools = buildToolset(ctx);
    await tool(tools, "memory_write").run({ content: "12345" });
    expect(
      one<{ id: string }>(
        db,
        "SELECT id FROM timers WHERE kind = 'distillation' AND fired_at IS NULL",
      )?.id,
    ).toBe(distillationTimerId("eng"));
  });

  test("archiveAllRecent demotes remaining recent without deleting", () => {
    const db = freshDb();
    const clock = fakeClock();
    writeMemory(db, clock, { id: "r1", identityId: "eng", content: "a", tier: "recent" });
    writeMemory(db, clock, { id: "c1", identityId: "eng", content: "law", tier: "core" });
    const archived = archiveAllRecent(db, clock, "eng");
    expect(archived).toEqual(["r1"]);
    expect(queryMemory(db, "eng", { tier: "recent" })).toEqual([]);
    expect(queryMemory(db, "eng", { tier: "archive" }).map((m) => m.id)).toEqual(["r1"]);
    expect(queryMemory(db, "eng", { tier: "core" }).map((m) => m.id)).toEqual(["c1"]);
  });

  test("writeMemory omitted tier is recent; correctMemory keeps prior tier", () => {
    const db = freshDb();
    const clock = fakeClock();
    const item = writeMemory(db, clock, { id: "m1", identityId: "eng", content: "x" });
    expect(item.tier).toBe("recent");
    setMemoryTier(db, clock, "m1", "core");
    const { created } = correctMemory(db, clock, {
      oldId: "m1",
      newId: "m2",
      newContent: "y",
    });
    expect(created.tier).toBe("core");
  });
});

describe("Service distillation pass", () => {
  test("tick runs distill; success archives remaining recent", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const cwd = mkdtempSync(join(tmpdir(), "earshot-distill-"));
    const db = openLedger(":memory:");
    const clock = fakeClock();
    writeMemory(db, clock, {
      id: "r1",
      identityId: "eng",
      content: "0123456789",
      tier: "recent",
    });
    writeMemory(db, clock, {
      id: "r2",
      identityId: "eng",
      content: "keep me as core later",
      tier: "recent",
    });
    scheduleTimer(db, {
      id: distillationTimerId("eng"),
      kind: "distillation",
      identityId: "eng",
      dueAt: clock(),
    });

    let seq = 0;
    const service = new Service({
      db,
      clock,
      policyStore: new PolicyStore(() => DISTILL_POLICY, {
        knownTools: new Set(),
        envAvailable: () => true,
      }),
      adapter: new FakeAdapter(),
      botPrincipalId: "BOT1",
      cwd,
      newId: () => `id-${++seq}`,
      sessionFactory: (tools: DynamicTool[]) =>
        new FakeAgentRuntimeSession(tools, async (_turn, toolMap) => {
          await toolMap.get("memory_write")!.run({
            content: "standing: keep me as core later",
            tier: "core",
          });
        }),
    });
    await service.start();
    await service.tick();
    await service.idle();

    expect(queryMemory(db, "eng", { tier: "recent" })).toEqual([]);
    expect(
      queryMemory(db, "eng", { tier: "core" }).some((m) => m.content.includes("standing")),
    ).toBe(true);
    expect(queryMemory(db, "eng", { tier: "archive" }).length).toBeGreaterThan(0);
    await service.stop();
  });

  test("distill failure leaves recent and re-arms timer", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const cwd = mkdtempSync(join(tmpdir(), "earshot-distill-fail-"));
    const db = openLedger(":memory:");
    const clock = fakeClock();
    writeMemory(db, clock, {
      id: "r1",
      identityId: "eng",
      content: "0123456789AB",
      tier: "recent",
    });
    scheduleTimer(db, {
      id: distillationTimerId("eng"),
      kind: "distillation",
      identityId: "eng",
      dueAt: clock(),
    });

    let seq = 0;
    const service = new Service({
      db,
      clock,
      policyStore: new PolicyStore(() => DISTILL_POLICY, {
        knownTools: new Set(),
        envAvailable: () => true,
      }),
      adapter: new FakeAdapter(),
      botPrincipalId: "BOT1",
      cwd,
      newId: () => `id-${++seq}`,
      sessionFactory: () =>
        new FakeAgentRuntimeSession([], async () => {
          throw new Error("distill boom");
        }),
    });
    await service.start();
    await service.tick();
    await service.idle();

    expect(queryMemory(db, "eng", { tier: "recent" }).map((m) => m.id)).toEqual(["r1"]);
    expect(
      one<{ id: string }>(
        db,
        "SELECT id FROM timers WHERE kind = 'distillation' AND fired_at IS NULL",
      )?.id,
    ).toBe(distillationTimerId("eng"));
    await service.stop();
  });
});
