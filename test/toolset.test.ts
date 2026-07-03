import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { getTask, transition } from "../src/ledger/tasks";
import { buildToolset, type ToolsetContext, type Principal } from "../src/turn-runner/toolset";
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
    ambient: { enabledVenues: ["C2"], tickIntervalMs: 1800000, dailyPostCap: 5, followupQuietMs: 3600000 },
    ...overrides,
  };
}

function baseCtx(db: ReturnType<typeof openLedger>, clock: Clock, overrides: Partial<ToolsetContext> = {}): ToolsetContext {
  const posts: { anchor: any; text: string }[] = [];
  return {
    db,
    clock,
    identity: identity(),
    turnKind: "interactive",
    catalog: {},
    anchor: { venueId: "C1", threadRootId: null },
    ambientDailyPostCap: 5,
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

    const result = await tool(tools, "task_create").run({ title: "x", spec: "y" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("denied");
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
    expect(cancelCtx.effects).toEqual([
      { kind: "posted", anchor: { venueId: "C1", threadRootId: null }, text: "member asked to stop" },
      { kind: "task_cancelled", taskId: "T-1", applied: true },
    ]);
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
  test("interactive turns may post within their own anchor's venue", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    const result = await tool(buildToolset(ctx), "reply").run({ text: "hi" });
    expect(result.success).toBe(true);
  });

  test("interactive turns may NOT post to a different venue", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    const result = await tool(buildToolset(ctx), "reply").run({ text: "hi", venueId: "C-OTHER" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("posting_scope_violation");
  });

  test("ambient turns may only post to ambient-enabled venues", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock, { turnKind: "ambient", anchor: null, ambientEnabledVenues: ["C2"] });
    const ok = await tool(buildToolset(ctx), "reply").run({ text: "flag", venueId: "C2" });
    expect(ok.success).toBe(true);
    const denied = await tool(buildToolset(ctx), "reply").run({ text: "flag", venueId: "C3" });
    expect(denied.success).toBe(false);
  });

  test("distillation turns can never post", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock, { turnKind: "distillation", anchor: null });
    const result = await tool(buildToolset(ctx), "reply").run({ text: "x", venueId: "C1" });
    expect(result.success).toBe(false);
  });
});

describe("ambient daily post cap (SPEC §9.2)", () => {
  test("posts up to the cap succeed; the next one is dropped with an audit record", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock, { turnKind: "ambient", anchor: null, ambientEnabledVenues: ["C2"], ambientDailyPostCap: 2 });
    const tools = buildToolset(ctx);

    expect((await tool(tools, "reply").run({ text: "flag 1", venueId: "C2" })).success).toBe(true);
    expect((await tool(tools, "reply").run({ text: "flag 2", venueId: "C2" })).success).toBe(true);
    const third = await tool(tools, "reply").run({ text: "flag 3", venueId: "C2" });
    expect(third.success).toBe(false);
    expect(third.output).toContain("ambient_daily_cap_exceeded");

    const audit = db.query("SELECT payload FROM audit WHERE kind = 'ambient_posted'").all() as any[];
    expect(audit).toHaveLength(3);
    expect(JSON.parse(audit[2].payload)).toEqual({ venueId: "C2", posted: false });
  });

  test("the cap is per venue — a different venue has its own budget", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock, { turnKind: "ambient", anchor: null, ambientEnabledVenues: ["C2", "C3"], ambientDailyPostCap: 1 });
    const tools = buildToolset(ctx);

    expect((await tool(tools, "reply").run({ text: "flag", venueId: "C2" })).success).toBe(true);
    expect((await tool(tools, "reply").run({ text: "flag", venueId: "C3" })).success).toBe(true);
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

  test("task_complete transitions the task to done and posts the report", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const execCtx = await activeExecutionCtx(db, clock);
    const result = await tool(buildToolset(execCtx), "task_complete").run({ report: "fixed it" });
    expect(result.success).toBe(true);
    expect(getTask(db, "T-1")?.status).toBe("done");
    expect(getTask(db, "T-1")?.terminalReport).toBe("fixed it");
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
    // interactive turnKind: broker itself denies task_complete since it's not in KIND_BUILTIN_CLASSES for interactive... actually
    // task_complete/task_fail/task_ask aren't builtins at all, so they fall through to the grant pipeline and are denied as not_granted.
    const ctx = baseCtx(db, clock, { turnKind: "interactive" });
    const result = await tool(buildToolset(ctx), "task_complete").run({ report: "x" });
    expect(result.success).toBe(false);
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
  test("memory_write then memory_query round-trips for the same identity", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    const tools = buildToolset(ctx);

    const written = await tool(tools, "memory_write").run({ content: "on-call rotates weekly" });
    expect(written.success).toBe(true);
    const { memoryId } = JSON.parse(written.output);

    const queried = await tool(tools, "memory_query").run({});
    const items = JSON.parse(queried.output);
    expect(items.map((i: any) => i.id)).toContain(memoryId);
    expect(items.find((i: any) => i.id === memoryId).content).toBe("on-call rotates weekly");
  });

  test("retraction takes effect within the handling turn — immediately absent from the next memory_query", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    const tools = buildToolset(ctx);

    const written = await tool(tools, "memory_write").run({ content: "wrong fact" });
    const { memoryId } = JSON.parse(written.output);

    const retracted = await tool(tools, "memory_retract").run({ id: memoryId });
    expect(retracted.success).toBe(true);

    const queried = await tool(tools, "memory_query").run({});
    const items = JSON.parse(queried.output);
    expect(items.map((i: any) => i.id)).not.toContain(memoryId);
  });

  test("memory_query only ever returns this turn's own identity — cross-identity access is structurally impossible", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const { writeMemory } = await import("../src/ledger/memory");
    writeMemory(db, clock, { id: "finance-secret", identityId: "finance", content: "confidential roadmap" });

    const ctx = baseCtx(db, clock, { identity: identity({ id: "eng" }) });
    const result = await tool(buildToolset(ctx), "memory_query").run({});
    const items = JSON.parse(result.output);
    expect(items).toEqual([]);
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

  test("distillation turns may write and read memory but never post (SPEC §11)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock, { turnKind: "distillation", anchor: null });
    const tools = buildToolset(ctx);

    const written = await tool(tools, "memory_write").run({ content: "distilled fact" });
    expect(written.success).toBe(true);
    expect(tools.some((t) => t.spec.name === "reply")).toBe(true); // the tool exists...
    const replyResult = await tool(tools, "reply").run({ text: "x", venueId: "C1" });
    expect(replyResult.success).toBe(false); // ...but is always denied for this turn kind
  });

  test("ambient turns cannot write or retract memory (speak-only)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock, { turnKind: "ambient", anchor: null, ambientEnabledVenues: ["C2"] });
    const tools = buildToolset(ctx);

    const write = await tool(tools, "memory_write").run({ content: "x" });
    expect(write.success).toBe(false);
    const retract = await tool(tools, "memory_retract").run({ id: "whatever" });
    expect(retract.success).toBe(false);
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
