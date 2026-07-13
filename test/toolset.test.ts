import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { queryMemory } from "../src/ledger/memory";
import { getTask, transition } from "../src/ledger/tasks";
import { buildToolset, BUILTIN_REGISTRIES, type ToolsetContext } from "../src/turn-runner/toolset";
import { buildToolbox, integrationCatalog, INTEGRATION_REGISTRIES } from "../src/tools/catalog";
import type { IdentityConfig } from "../src/policy/schema";
import type { ToolCatalog } from "../src/policy/broker";
import type { Clock } from "../src/ledger/clock";

function freshDb() {
  return openLedger(":memory:");
}

function fakeClock(start = "2026-07-02T00:00:00Z"): Clock {
  return () => start;
}

function seedEvent(db: ReturnType<typeof openLedger>, id: string, clock: Clock) {
  db.query(
    "INSERT INTO events (id, dedup_key, kind, identity_id, received_at) VALUES (?, ?, 'addressed_message', 'eng', ?)",
  ).run(id, `k-${id}`, clock());
}

function identity(overrides: Partial<IdentityConfig> = {}): IdentityConfig {
  return {
    id: "eng",
    persona: null,
    venueIds: ["C1"],
    learningSources: [],
    grants: [],
    budget: { monthlyCap: 100, perTaskCap: null },
    ambient: { enabledVenues: ["C2"], tickIntervalMs: 1800000, dailyPostCap: 5, followupQuietMs: 3600000, eventDebounceMs: 0 },
    venueInstructions: {},
    ...overrides,
  };
}

function baseCtx(db: ReturnType<typeof openLedger>, clock: Clock, overrides: Partial<ToolsetContext> = {}): ToolsetContext {
  const posts: { anchor: any; text: string }[] = [];
  return {
    db,
    clock,
    identity: identity(),
    turnKind: "resident",
    catalog: {},
    anchor: { venueId: "C1", threadRootId: null },
    principal: { id: "U1", isGuest: false, isOperator: false },
    originEventId: "e1",
    nudgeAfterMs: 24 * 60 * 60 * 1000,
    postMessage: async (anchor, text) => {
      posts.push({ anchor, text });
      return { messageId: `m${posts.length}` };
    },
    effects: [],
    ...overrides,
  };
}

function tool(tools: ReturnType<typeof buildToolset>, name: string) {
  const t = tools.find((t) => t.spec.name === name);
  if (!t) throw new Error(`no such tool: ${name}`);
  return t;
}

describe("task_create (SPEC §5.3, §11)", () => {
  test("creates a task using the turn's anchor, principal, and origin event", async () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    const ctx = baseCtx(db, clock);
    const tools = buildToolset(ctx);

    const result = await tool(tools, "task_create").run({ title: "dig in", spec: "why is it slow" });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.taskId).toBe("T-1");
    const task = getTask(db, "T-1")!;
    expect(task.sponsorId).toBe("U1");
    expect(task.homeAnchor).toEqual({ venueId: "C1", threadRootId: null });
    expect(ctx.effects).toEqual([{ kind: "task_created", taskId: "T-1" }]);
  });

  test("is not available to execution_step turns (§11 KIND_BUILTIN_CLASSES)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    const ctx = baseCtx(db, clock, { turnKind: "execution_step" });
    const tools = buildToolset(ctx);

    // §11 "expose exactly": kind restriction happens at exposure — the tool isn't registered.
    expect(tools.some((t) => t.spec.name === "task_create")).toBe(false);
  });

  test("rejects a recurrence from a non-operator principal (propagated from tasks.ts)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    const ctx = baseCtx(db, clock);
    const tools = buildToolset(ctx);

    await expect(tool(tools, "task_create").run({ title: "x", spec: "y", recurrence: "weekly" })).rejects.toThrow();
  });
});

describe("task_steer / task_cancel / task_confirm", () => {
  async function activeTask(db: ReturnType<typeof openLedger>, clock: Clock, ctx: ToolsetContext) {
    seedEvent(db, "e1", clock);
    await tool(buildToolset(ctx), "task_create").run({ title: "t", spec: "s" });
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
  }

  test("task_steer applies guidance and delivers any posts", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    await activeTask(db, clock, ctx);
    seedEvent(db, "e2", clock);
    const steerCtx = { ...ctx, originEventId: "e2" };
    const tools = buildToolset(steerCtx);

    const result = await tool(tools, "task_steer").run({ taskId: "T-1", kind: "guidance", text: "check redis too" });
    expect(result.success).toBe(true);
    expect(getTask(db, "T-1")?.spec).toContain("check redis too");
  });

  test("task_steer rejects 'cancel'/'confirm' kinds — those have their own dedicated tools", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    await activeTask(db, clock, ctx);
    seedEvent(db, "e2", clock);
    const steerCtx = { ...ctx, originEventId: "e2" };
    const tools = buildToolset(steerCtx);

    const result = await tool(tools, "task_steer").run({ taskId: "T-1", kind: "cancel" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("invalid_kind");
    expect(getTask(db, "T-1")?.status).toBe("active"); // unaffected
  });

  test("task_cancel transitions the task and records the effect", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    await activeTask(db, clock, ctx);
    seedEvent(db, "e2", clock);
    const cancelCtx = { ...ctx, originEventId: "e2", effects: [] as unknown[] };
    const result = await tool(buildToolset(cancelCtx), "task_cancel").run({ taskId: "T-1", report: "member asked to stop" });

    expect(result.success).toBe(true);
    expect(getTask(db, "T-1")?.status).toBe("cancelled");
    // The cancel report is a ledger record only — no "posted" effect, nothing sent to Slack.
    expect(cancelCtx.effects).toEqual([{ kind: "task_cancelled", taskId: "T-1", applied: true }]);
  });

  test("task_confirm resolves a pending confirmation for an eligible (non-guest) principal", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    await activeTask(db, clock, ctx);
    // put the task into a pending-confirmation state directly via the ledger
    const { requestConfirmation } = await import("../src/ledger/tasks");
    requestConfirmation(db, clock, { taskId: "T-1", actionRef: "send_email:x", description: "send it?", nudgeDeadline: "2026-07-03T00:00:00Z" });

    const confirmCtx = baseCtx(db, clock, { principal: { id: "U2", isGuest: false, isOperator: false } });
    const result = await tool(buildToolset(confirmCtx), "task_confirm").run({ taskId: "T-1", approve: true });
    expect(result.success).toBe(true);
    expect(getTask(db, "T-1")?.status).toBe("open");
  });

  test("task_confirm is denied outright for a guest principal, before ever touching the ledger", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    await activeTask(db, clock, ctx);
    const { requestConfirmation, getTask: getTask2 } = await import("../src/ledger/tasks");
    requestConfirmation(db, clock, { taskId: "T-1", actionRef: "send_email:x", description: "send it?", nudgeDeadline: "2026-07-03T00:00:00Z" });

    const guestCtx = baseCtx(db, clock, { principal: { id: "GUEST1", isGuest: true, isOperator: false } });
    const result = await tool(buildToolset(guestCtx), "task_confirm").run({ taskId: "T-1", approve: true });
    expect(result.success).toBe(false);
    expect(result.output).toContain("denied");
    expect(getTask2(db, "T-1")?.status).toBe("waiting"); // untouched — still pending
  });
});

describe("task_query returns the identity's ledger view", () => {
  test("includes an open task", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    await activeCreate(db, clock, ctx);
    const result = await tool(buildToolset(ctx), "task_query").run({});
    const parsed = JSON.parse(result.output);
    expect(parsed.open.map((t: any) => t.id)).toContain("T-1");
  });

  async function activeCreate(db: ReturnType<typeof openLedger>, clock: Clock, ctx: ToolsetContext) {
    seedEvent(db, "e1", clock);
    await tool(buildToolset(ctx), "task_create").run({ title: "t", spec: "s" });
  }
});

describe("reply posting-scope rule (SPEC §11)", () => {
  test("resident wakes may post to any venue the identity serves", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock); // identity serves C1
    const ok = await tool(buildToolset(ctx), "reply").run({ text: "hi", venueId: "C1" });
    expect(ok.success).toBe(true);
  });

  test("resident wakes may NOT post outside the identity's venues", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    const denied = await tool(buildToolset(ctx), "reply").run({ text: "flag", venueId: "C3" });
    expect(denied.success).toBe(false);
    expect(denied.output).toContain("posting_scope_violation");
  });

  test("a wildcard identity posts anywhere", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock, { identity: identity({ venueIds: ["*"] }) });
    const ok = await tool(buildToolset(ctx), "reply").run({ text: "hi", venueId: "C9" });
    expect(ok.success).toBe(true);
  });

  test("execution steps cannot post at all — workers report to the mind", () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock, { turnKind: "execution_step", anchor: { venueId: "C1", threadRootId: null }, taskId: "T-1" });
    const names = buildToolset(ctx).map((t) => t.spec.name);
    for (const posting of ["reply", "react", "checklist"]) expect(names).not.toContain(posting);
  });
});

describe("react targeting a specific message (resident wakes)", () => {
  test("a resident wake reacts to a delivered message by venue+ts, scope-checked", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const reactions: { venueId: string; ts: string; emoji: string }[] = [];
    const ctx = baseCtx(db, clock, {
      reactTo: async (venueId, ts, emoji) => {
        reactions.push({ venueId, ts, emoji });
      },
    });
    const ok = await tool(buildToolset(ctx), "react").run({ emoji: "eyes", venueId: "C1", ts: "9.9" });
    expect(ok.success).toBe(true);
    expect(reactions).toEqual([{ venueId: "C1", ts: "9.9", emoji: "eyes" }]);
    const denied = await tool(buildToolset(ctx), "react").run({ emoji: "eyes", venueId: "C3", ts: "9.9" });
    expect(denied.success).toBe(false); // outside the identity's venues
  });
});

describe("execution_step outcome tools (SPEC §6.3, §17.4)", () => {
  async function activeExecutionCtx(db: ReturnType<typeof openLedger>, clock: Clock) {
    const createCtx = baseCtx(db, clock);
    seedEvent(db, "e1", clock);
    await tool(buildToolset(createCtx), "task_create").run({ title: "t", spec: "s" });
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
    return baseCtx(db, clock, { turnKind: "execution_step", taskId: "T-1", anchor: { venueId: "C1", threadRootId: null } });
  }

  test("task_complete transitions the task to done, recording the report in the ledger without posting it", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const execCtx = await activeExecutionCtx(db, clock);
    const posted: string[] = [];
    execCtx.postMessage = async (_a, text) => {
      posted.push(text);
      return { messageId: "m1" };
    };
    const result = await tool(buildToolset(execCtx), "task_complete").run({ report: "fixed it" });
    expect(result.success).toBe(true);
    expect(getTask(db, "T-1")?.status).toBe("done");
    expect(getTask(db, "T-1")?.terminalReport).toBe("fixed it");
    expect(posted).toEqual([]); // nothing mechanical reaches Slack — the model replies itself
  });

  test("task_fail transitions the task to failed", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const execCtx = await activeExecutionCtx(db, clock);
    const result = await tool(buildToolset(execCtx), "task_fail").run({ report: "could not reach the db" });
    expect(result.success).toBe(true);
    expect(getTask(db, "T-1")?.status).toBe("failed");
  });

  test("task_ask yields to waiting(human)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const execCtx = await activeExecutionCtx(db, clock);
    const result = await tool(buildToolset(execCtx), "task_ask").run({ question: "which environment?" });
    expect(result.success).toBe(true);
    expect(getTask(db, "T-1")?.status).toBe("waiting");
    expect(getTask(db, "T-1")?.waitingOn).toBe("human");
  });

  test("set_wake yields to waiting(timer)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const execCtx = await activeExecutionCtx(db, clock);
    const result = await tool(buildToolset(execCtx), "set_wake").run({ wakeAt: "2026-07-09T00:00:00Z" });
    expect(result.success).toBe(true);
    expect(getTask(db, "T-1")?.status).toBe("waiting");
    expect(getTask(db, "T-1")?.waitingOn).toBe("timer");
  });

  test("outcome tools are unavailable outside an execution's own turn (no taskId in context)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    // §11 "expose exactly": outcome tools are execution_step-only, so an interactive turn
    // doesn't even see them.
    const ctx = baseCtx(db, clock, { turnKind: "resident" });
    expect(buildToolset(ctx).some((t) => t.spec.name === "task_complete")).toBe(false);
  });
});

describe("external tool: grant + scope + action-class confirmation flow", () => {
  const CATALOG: ToolCatalog = {
    send_email: {
      actionClasses: () => ["outward"],
      run: async (args) => ({ success: true, output: `sent: ${JSON.stringify(args)}` }),
    },
  };

  test("a granted, preauthorized external tool call runs its implementation", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock, {
      identity: identity({ grants: [{ tool: "send_email", preauthorizedActionClasses: ["outward"] }] }),
      catalog: CATALOG,
    });
    const result = await tool(buildToolset(ctx), "send_email").run({ to: "a@b.com" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("sent");
  });

  test("a non-preauthorized outward action on an execution_step turn auto-requests confirmation", async () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    const createCtx = baseCtx(db, clock);
    await tool(buildToolset(createCtx), "task_create").run({ title: "t", spec: "s" });
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });

    const execCtx = baseCtx(db, clock, {
      turnKind: "execution_step",
      taskId: "T-1",
      identity: identity({ grants: [{ tool: "send_email", preauthorizedActionClasses: [] }] }),
      catalog: CATALOG,
    });
    const result = await tool(buildToolset(execCtx), "send_email").run({ to: "a@b.com" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("requires_confirmation");

    const task = getTask(db, "T-1")!;
    expect(task.status).toBe("waiting");
    expect(task.waitingOn).toBe("human");
    expect(task.pendingConfirmation?.actionRef).toContain("send_email");
  });

  test("interactive turns are flatly denied a non-preauthorized outward action — never even offered confirmation", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock, {
      identity: identity({ grants: [{ tool: "send_email", preauthorizedActionClasses: [] }] }),
      catalog: CATALOG,
    });
    const result = await tool(buildToolset(ctx), "send_email").run({ to: "a@b.com" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("interactive_consequential_denied");
  });

  test("an ungranted external tool is not exposed at all", () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock, { catalog: CATALOG });
    const tools = buildToolset(ctx);
    expect(tools.some((t) => t.spec.name === "send_email")).toBe(false);
  });
});

describe("memory tools (SPEC §8, §7.1 isolation)", () => {
  test("memory_write then search round-trips for the same identity, hit carries the memory id", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    const tools = buildToolset(ctx);

    const written = await tool(tools, "memory_write").run({ content: "on-call rotates weekly" });
    expect(written.success).toBe(true);
    const { memoryId } = JSON.parse(written.output);

    const found = await tool(tools, "search").run({ query: "on-call rotates" });
    const hits = JSON.parse(found.output);
    expect(hits.map((h: any) => h.memoryId)).toContain(memoryId);
    expect(hits.find((h: any) => h.memoryId === memoryId).text).toBe("on-call rotates weekly");
    expect(hits.find((h: any) => h.memoryId === memoryId).tier).toBe("core"); // §8.6 default
  });

  test("memory_tier demotes a core item to searchable archive (SPEC §8.6)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    const tools = buildToolset(ctx);

    const written = await tool(tools, "memory_write").run({ content: "the sprint retro moved to thursdays" });
    const { memoryId } = JSON.parse(written.output);

    const moved = await tool(tools, "memory_tier").run({ id: memoryId, tier: "archive" });
    expect(moved.success).toBe(true);

    const found = await tool(tools, "search").run({ query: "sprint retro" });
    const hit = JSON.parse(found.output).find((h: any) => h.memoryId === memoryId);
    expect(hit.tier).toBe("archive"); // demoted but still searchable — never lost
    expect(ctx.effects.some((e: any) => e.kind === "memory_tiered")).toBe(true);
  });

  test("memory_tier cannot move another identity's item (SPEC §7.1)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const { writeMemory } = await import("../src/ledger/memory");
    writeMemory(db, clock, { id: "finance-item", identityId: "finance", content: "confidential" });

    const ctx = baseCtx(db, clock, { identity: identity({ id: "eng" }) });
    const result = await tool(buildToolset(ctx), "memory_tier").run({ id: "finance-item", tier: "archive" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("not_found");
  });

  test("retraction takes effect within the handling turn — immediately absent from the next search", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    const tools = buildToolset(ctx);

    const written = await tool(tools, "memory_write").run({ content: "a wrong fact about exports" });
    const { memoryId } = JSON.parse(written.output);

    const retracted = await tool(tools, "memory_retract").run({ id: memoryId });
    expect(retracted.success).toBe(true);

    const found = await tool(tools, "search").run({ query: "wrong fact exports" });
    const hits = JSON.parse(found.output);
    expect(hits.map((h: any) => h.memoryId)).not.toContain(memoryId);
  });

  test("search only ever returns this turn's own identity — cross-identity access is structurally impossible", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const { writeMemory } = await import("../src/ledger/memory");
    writeMemory(db, clock, { id: "finance-secret", identityId: "finance", content: "confidential roadmap" });

    const ctx = baseCtx(db, clock, { identity: identity({ id: "eng" }) });
    const result = await tool(buildToolset(ctx), "search").run({ query: "confidential roadmap" });
    expect(JSON.parse(result.output)).toEqual([]);
  });

  test("memory_retract cannot retract another identity's item, even by guessing its id", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const { writeMemory, queryMemory } = await import("../src/ledger/memory");
    writeMemory(db, clock, { id: "finance-secret", identityId: "finance", content: "confidential roadmap" });

    const ctx = baseCtx(db, clock, { identity: identity({ id: "eng" }) });
    const result = await tool(buildToolset(ctx), "memory_retract").run({ id: "finance-secret" });

    expect(result.success).toBe(false);
    expect(result.output).toContain("not_found");
    expect(queryMemory(db, "finance").map((i) => i.id)).toEqual(["finance-secret"]);
  });

  test("a resident wake writes and reads memory (§8)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    const tools = buildToolset(ctx);
    const written = await tool(tools, "memory_write").run({ content: "distilled fact" });
    expect(written.success).toBe(true);
  });

  test("memory_write defaults to core; tier 'recent' is an explicit reduced-standing save (SPEC §8.6)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    await tool(buildToolset(ctx), "memory_write").run({ content: "vetted fact" });
    await tool(buildToolset(ctx), "memory_write").run({ content: "overheard maybe-fact", tier: "recent" });
    const items = queryMemory(db, "eng");
    expect(items.find((i) => i.content === "vetted fact")?.tier).toBe("core");
    expect(items.find((i) => i.content === "overheard maybe-fact")?.tier).toBe("recent");
  });

  test("an interactive memory_write still lands in core (explicit writes act next turn)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    const tools = buildToolset(ctx);

    const written = await tool(tools, "memory_write").run({ content: "remember: sam owns exports" });
    const { memoryId } = JSON.parse(written.output);
    const { queryMemory } = await import("../src/ledger/memory");
    expect(queryMemory(db, "eng").find((m) => m.id === memoryId)!.tier).toBe("core");
  });
});

describe("audit_query (SPEC §15: granted per identity, scoped to that identity)", () => {
  test("is absent from the toolset when not granted", () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    const tools = buildToolset(ctx);
    expect(tools.some((t) => t.spec.name === "audit_query")).toBe(false);
  });

  test("is present and works once granted", async () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    const ctx = baseCtx(db, clock, { identity: identity({ grants: [{ tool: "audit_query", preauthorizedActionClasses: [] }] }) });
    const tools = buildToolset(ctx);
    expect(tools.some((t) => t.spec.name === "audit_query")).toBe(true);

    await tool(tools, "task_create").run({ title: "t", spec: "s" });
    const result = await tool(tools, "audit_query").run({ kind: "task_created" });
    const records = JSON.parse(result.output);
    expect(records).toHaveLength(1);
    expect(records[0].payload.taskId).toBe("T-1");
  });

  test("only ever returns this identity's own audit records, never another's", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const { writeAudit } = await import("../src/ledger/audit");
    writeAudit(db, clock(), "finance", "task_created", { taskId: "T-secret" });

    const ctx = baseCtx(db, clock, { identity: identity({ id: "eng", grants: [{ tool: "audit_query", preauthorizedActionClasses: [] }] }) });
    const result = await tool(buildToolset(ctx), "audit_query").run({});
    const records = JSON.parse(result.output);
    expect(records.some((r: any) => r.payload.taskId === "T-secret")).toBe(false);
    expect(records.every((r: any) => r.identityId === "eng")).toBe(true);
  });
});

// SPEC §11/§18 (toolbox digest) — every tool buildToolset exposes lands in a NAMED builtin
// or integration group; the digest and the built toolset agree exactly. An orphan singleton
// group here means a tool was added without a registry home.
describe("toolbox digest covers the built toolset", () => {
  test("all built-ins (audit included) group under named registries, digest ≡ toolset", () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock, {
      identity: identity({ grants: [{ tool: "audit_query", preauthorizedActionClasses: [] }] }),
    });
    const tools = buildToolset(ctx);
    const tb = buildToolbox(tools, BUILTIN_REGISTRIES);
    expect(tb.flatMap((g) => g.tools.map((t) => t.name)).sort()).toEqual(tools.map((t) => t.spec.name).sort());
    const named = new Set(BUILTIN_REGISTRIES.map((r) => r.name));
    for (const g of tb) expect(named.has(g.registry)).toBe(true);
  });

  test("granted integration tools group under their integration registry alongside built-ins", () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock, {
      identity: identity({ grants: [{ tool: "linear_read", preauthorizedActionClasses: [] }] }),
      catalog: integrationCatalog(),
    });
    const tools = buildToolset(ctx);
    const tb = buildToolbox(tools, [...BUILTIN_REGISTRIES, ...INTEGRATION_REGISTRIES]);
    const linear = tb.find((g) => g.registry === "linear")!;
    expect(linear.tools.map((t) => t.name)).toEqual(["linear_read"]);
    expect(linear.skill!.length).toBeGreaterThan(0);
    expect(linear.examples!.every((e) => e.tool === "linear_read")).toBe(true);
    expect(tb.flatMap((g) => g.tools.map((t) => t.name)).sort()).toEqual(tools.map((t) => t.spec.name).sort());
  });
});

// SPEC §11 "Expose exactly … subject to per-kind restrictions" — restriction happens at
// EXPOSURE (the tool isn't registered for the turn), not just deny-at-call, so the toolbox
// digest and the schemas codex sees are honest per kind. The broker's per-call gate stays as
// defense in depth.
describe("per-kind tool exposure", () => {
  const grants = [
    { tool: "linear_read", preauthorizedActionClasses: [] },
    { tool: "linear_write", preauthorizedActionClasses: [] },
  ];
  function names(kind: ToolsetContext["turnKind"], extra: Partial<ToolsetContext> = {}) {
    const db = freshDb();
    const ctx = baseCtx(db, fakeClock(), { turnKind: kind, identity: identity({ grants }), catalog: integrationCatalog(), ...extra });
    return buildToolset(ctx).map((t) => t.spec.name);
  }

  test("resident: no outcome tools and no set_wake (an execution's own yield); task and external tools stay", () => {
    const n = names("resident");
    for (const gone of ["task_complete", "task_fail", "task_ask", "set_wake"]) expect(n).not.toContain(gone);
    for (const there of ["task_create", "task_confirm", "reply", "react", "search", "memory_write", "linear_read", "linear_write"]) expect(n).toContain(there);
  });

  test("execution_step: outcome tools stay; no task_mutating or confirm", () => {
    const n = names("execution_step", { taskId: "T-1" });
    for (const there of ["task_complete", "task_fail", "task_ask", "set_wake"]) expect(n).toContain(there);
    for (const gone of ["task_create", "task_steer", "task_cancel", "task_confirm"]) expect(n).not.toContain(gone);
  });
});
