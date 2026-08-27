import { describe, expect, test } from "bun:test";
import { openLedger, one } from "../src/ledger/db";
import {
  writeMemory,
  queryMemory,
  maybeArmDistillation,
  archiveAllRecent,
  distillationTimerId,
} from "../src/ledger/memory";
import { scheduleTimer } from "../src/ledger/timers";
import { PolicyStore } from "../src/policy/load";
import { Service } from "../src/service";
import { FakeAdapter } from "./fakes/fake-adapter";
import { FakeAgentRuntimeSession } from "./fakes/fake-runtime-session";
import { fakeClock } from "./helpers";
import { buildToolset } from "../src/turn-runner/toolset";
import type { IdentityConfig } from "../src/policy/schema";
import type { DynamicTool } from "../src/turn-runner/types";

const POLICY = `
surface: { kind: slack, credentials: { bot_token: $BOT } }
operator_principals: [U_OPERATOR]
memory: { core_char_budget: 8000, recent_char_budget: 10 }
identities: [{ id: eng, venue_ids: [C1], budget: { monthly_cap: 1000 } }]
budget: { global_monthly_cap: 100000 }
models: { low: { model: test-luna }, medium: { model: test-terra } }
`;

function identity(): IdentityConfig {
  return {
    id: "eng",
    persona: null,
    venueIds: ["C1"],
    learningSources: [],
    grants: [],
    budget: { monthlyCap: 100, perTaskCap: null },
    ambient: { eventDebounceMs: 0 },
    venueInstructions: {},
  };
}

describe("recent-budget distillation", () => {
  test("omitted tier is recent; full recent arms timer; archive wipes recent", () => {
    const db = openLedger(":memory:");
    const clock = fakeClock();
    expect(writeMemory(db, clock, { id: "m1", identityId: "eng", content: "x" }).tier).toBe(
      "recent",
    );
    writeMemory(db, clock, { id: "r1", identityId: "eng", content: "0123456789", tier: "recent" });
    expect(maybeArmDistillation(db, clock, "eng", 10)).toBe(true);
    expect(
      one<{ id: string }>(
        db,
        "SELECT id FROM timers WHERE kind='distillation' AND fired_at IS NULL",
      )?.id,
    ).toBe(distillationTimerId("eng"));
    writeMemory(db, clock, { id: "c1", identityId: "eng", content: "law", tier: "core" });
    archiveAllRecent(db, clock, "eng");
    expect(queryMemory(db, "eng", { tier: "recent" })).toEqual([]);
    expect(queryMemory(db, "eng", { tier: "core" }).map((m) => m.id)).toEqual(["c1"]);
  });

  test("memory_write arms when recentCharBudget set", async () => {
    const db = openLedger(":memory:");
    const clock = fakeClock();
    const tools = buildToolset({
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
    });
    await tools.find((t) => t.spec.name === "memory_write")!.run({ content: "12345" });
    expect(
      one<{ id: string }>(
        db,
        "SELECT id FROM timers WHERE kind='distillation' AND fired_at IS NULL",
      )?.id,
    ).toBe(distillationTimerId("eng"));
  });

  test("tick success archives remaining recent; failure re-arms", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    async function run(script: (tools: Map<string, DynamicTool>) => Promise<void>) {
      const cwd = mkdtempSync(join(tmpdir(), "earshot-distill-"));
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
        policyStore: new PolicyStore(() => POLICY, {
          knownTools: new Set(),
          envAvailable: () => true,
        }),
        adapter: new FakeAdapter(),
        botPrincipalId: "BOT1",
        cwd,
        newId: () => `id-${++seq}`,
        sessionFactory: (tools) =>
          new FakeAgentRuntimeSession(tools, async (_n, toolMap) => script(toolMap)),
      });
      await service.start();
      await service.tick();
      await service.idle();
      await service.stop();
      return db;
    }

    const ok = await run(async (tools) => {
      await tools.get("memory_write")!.run({ content: "standing rule", tier: "core" });
    });
    expect(queryMemory(ok, "eng", { tier: "recent" })).toEqual([]);
    expect(
      queryMemory(ok, "eng", { tier: "core" }).some((m) => m.content.includes("standing")),
    ).toBe(true);

    const fail = await run(async () => {
      throw new Error("boom");
    });
    expect(queryMemory(fail, "eng", { tier: "recent" }).map((m) => m.id)).toEqual(["r1"]);
    expect(
      one<{ id: string }>(
        fail,
        "SELECT id FROM timers WHERE kind='distillation' AND fired_at IS NULL",
      )?.id,
    ).toBe(distillationTimerId("eng"));
  });
});
