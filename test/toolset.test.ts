import { describe, expect, test } from "bun:test";
import { openLedger, one } from "../src/ledger/db";
import { queryMemory } from "../src/ledger/memory";
import { getTask, transition } from "../src/ledger/tasks";
import { makeRefTable } from "../src/ledger/conversations";
import { buildToolset, BUILTIN_REGISTRIES, type ToolsetContext } from "../src/turn-runner/toolset";
import {
  buildToolbox,
  integrationCatalog,
  INTEGRATION_REGISTRIES,
  topLevelMutationFields,
} from "../src/tools/catalog";
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
    ambient: { eventDebounceMs: 0 },
    venueInstructions: {},
    ...overrides,
  };
}

function baseCtx(
  db: ReturnType<typeof openLedger>,
  clock: Clock,
  overrides: Partial<ToolsetContext> = {},
): ToolsetContext {
  const posts: { anchor: any; text: string }[] = [];
  // A standing rendered ref for the wake's home conversation — what task_create homes to.
  // Minted the way the renderer does: carrying the provenance (event + speaker) of the line,
  // which is where durable writes (sponsor/origin, confirmation approver) now bind.
  const refs = makeRefTable();
  refs.mint({
    venueId: "C1",
    threadRootId: null,
    via: "rendered",
    eventId: "e1",
    principalId: "U1",
  }); // r1
  return {
    refs,
    db,
    clock,
    identity: identity(),
    turnKind: "resident",
    catalog: {},
    anchor: { venueId: "C1", threadRootId: null },
    principal: { id: "U1", isOperator: false },
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
  const found = tools.find((entry) => entry.spec.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
}

describe("task_create (SPEC §5.3, §11)", () => {
  test("creates a task using the turn's anchor, principal, and origin event", async () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    const ctx = baseCtx(db, clock);
    const tools = buildToolset(ctx);

    const result = await tool(tools, "task_create").run({
      title: "dig in",
      spec: "why is it slow",
      ref: "r1",
    });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.taskId).toBe("T-1");
    const task = getTask(db, "T-1")!;
    expect(task.sponsorId).toBe("U1");
    expect(task.homeVenueId).toBe("C1");
    expect(task.homeThreadRootId).toBeNull();
    expect(ctx.effects).toEqual([{ kind: "task_created", taskId: "T-1" }]);
  });

  test("is not available to execution_step turns (§11 KIND_BUILTIN_CLASSES)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    const ctx = baseCtx(db, clock, { turnKind: "execution_step" });
    const tools = buildToolset(ctx);

    // §11: kind restriction at exposure — tool not registered.
    expect(tools.some((t) => t.spec.name === "task_create")).toBe(false);
  });

  test("task_create rejects recurrence — §6.5 unbuilt, capability absent", async () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    const tools = buildToolset(baseCtx(db, clock));
    const create = tool(tools, "task_create");
    expect(JSON.stringify(create.spec.inputSchema)).not.toContain("recurrence");
    const result = await create.run({ title: "t", spec: "s", ref: "r1", recurrence: "every day" });
    expect(result.success).toBe(true); // the stray arg is ignored, never stored
    const row = one<{ recurrence: string | null }>(
      db,
      "SELECT recurrence FROM tasks WHERE id = 'T-1'",
    );
    expect(row?.recurrence).toBeNull();
  });
});

describe("task_steer / task_cancel / task_confirm", () => {
  async function activeTask(db: ReturnType<typeof openLedger>, clock: Clock, ctx: ToolsetContext) {
    seedEvent(db, "e1", clock);
    await tool(buildToolset(ctx), "task_create").run({ title: "t", spec: "s", ref: "r1" });
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

    const result = await tool(tools, "task_steer").run({
      taskId: "T-1",
      kind: "guidance",
      text: "check redis too",
      ref: "r1",
    });
    expect(result.success).toBe(true);
    expect(getTask(db, "T-1")?.spec).toContain("check redis too");
  });

  test("task_steer rejects cancel/confirm kinds (dedicated tools exist)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    await activeTask(db, clock, ctx);
    seedEvent(db, "e2", clock);
    const steerCtx = { ...ctx, originEventId: "e2" };
    const tools = buildToolset(steerCtx);

    const result = await tool(tools, "task_steer").run({
      taskId: "T-1",
      kind: "cancel",
      ref: "r1",
    });
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
    const result = await tool(buildToolset(cancelCtx), "task_cancel").run({
      taskId: "T-1",
      report: "member asked to stop",
      ref: "r1",
    });

    expect(result.success).toBe(true);
    expect(getTask(db, "T-1")?.status).toBe("cancelled");
    // Cancel report is ledger-only; nothing posted.
    expect(cancelCtx.effects).toEqual([{ kind: "task_cancelled", taskId: "T-1", applied: true }]);
  });

  test("task_confirm resolves pending confirmation for eligible principal", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    await activeTask(db, clock, ctx);
    // put task into pending-confirmation via ledger
    const { requestConfirmation } = await import("../src/ledger/tasks");
    requestConfirmation(db, clock, {
      taskId: "T-1",
      actionRef: "send_email:x",
      description: "send it?",
      nudgeDeadline: "2026-07-03T00:00:00Z",
    });

    const confirmCtx = baseCtx(db, clock, { principal: { id: "U2", isOperator: false } });
    // Approver is the speaker of the ref'd approval message, not the wake principal.
    seedEvent(db, "e9", clock);
    const approvalRef = confirmCtx.refs!.mint({
      venueId: "C1",
      threadRootId: null,
      ts: "9.9",
      via: "rendered",
      eventId: "e9",
      principalId: "U2",
    });
    const bare = await tool(buildToolset(confirmCtx), "task_confirm").run({
      taskId: "T-1",
      approve: true,
    });
    expect(bare.success).toBe(false); // a refless confirm has no speaker to attribute
    expect(bare.output).toContain("is not a message ref");
    const result = await tool(buildToolset(confirmCtx), "task_confirm").run({
      taskId: "T-1",
      approve: true,
      ref: approvalRef,
    });
    expect(result.success).toBe(true);
    expect(getTask(db, "T-1")?.status).toBe("open");
    expect(getTask(db, "T-1")?.pendingConfirmation?.resolution?.principalId).toBe("U2");
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

  async function activeCreate(
    db: ReturnType<typeof openLedger>,
    clock: Clock,
    ctx: ToolsetContext,
  ) {
    seedEvent(db, "e1", clock);
    await tool(buildToolset(ctx), "task_create").run({ title: "t", spec: "s", ref: "r1" });
  }
});

function seededRefs(targets: Parameters<ReturnType<typeof makeRefTable>["mint"]>[0][]): {
  refs: ReturnType<typeof makeRefTable>;
  minted: string[];
} {
  const refs = makeRefTable();
  return { refs, minted: targets.map((t) => refs.mint(t)) };
}

describe("reply posting-scope rule (SPEC §11) — addressing as refs", () => {
  test("resident wakes may post to any venue the identity serves", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const { refs, minted } = seededRefs([{ venueId: "C1", threadRootId: null, via: "rendered" }]);
    const ctx = baseCtx(db, clock, { refs }); // identity serves C1
    const ok = await tool(buildToolset(ctx), "reply").run({ text: "hi", ref: minted[0] });
    expect(ok.success).toBe(true);
  });

  test("resident wakes may NOT post outside the identity's venues", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const { refs, minted } = seededRefs([{ venueId: "C3", threadRootId: null, via: "rendered" }]);
    const ctx = baseCtx(db, clock, { refs });
    const denied = await tool(buildToolset(ctx), "reply").run({ text: "flag", ref: minted[0] });
    expect(denied.success).toBe(false);
    expect(denied.output).toContain("posting_scope_violation");
  });

  test("a wildcard identity posts anywhere", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const { refs, minted } = seededRefs([{ venueId: "C9", threadRootId: null, via: "rendered" }]);
    const ctx = baseCtx(db, clock, { identity: identity({ venueIds: ["*"] }), refs });
    const ok = await tool(buildToolset(ctx), "reply").run({ text: "hi", ref: minted[0] });
    expect(ok.success).toBe(true);
  });

  // Ladder R4: addressing is a capability, not a string. A coordinate pair is not expressible
  // at all — the schema has no venue/thread fields — and a ref the turn was never shown does
  // not resolve. The wrong-venue-thread mismatch family (2026-07-14/15) has no syntax left.
  test("R4: coordinates are inexpressible; an unknown ref is rejected; nothing posts", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const posts: unknown[] = [];
    const { refs } = seededRefs([]);
    const ctx = baseCtx(db, clock, {
      refs,
      postMessage: async (anchor: unknown, text: string) => {
        posts.push({ anchor, text });
        return { messageId: "m1" };
      },
    });
    const replyTool = tool(buildToolset(ctx), "reply");
    expect(JSON.stringify(replyTool.spec.inputSchema)).not.toContain("venueId");
    const bare = await replyTool.run({ text: "hi" });
    expect(bare.success).toBe(false);
    expect(bare.output).toContain("is not a ref");
    const invented = await replyTool.run({ text: "hi", ref: "r99" });
    expect(invented.success).toBe(false);
    const smuggled = await replyTool.run({
      text: "hi",
      ref: "r1",
      venueId: "C1",
      threadRootId: "9.9",
    });
    expect(smuggled.success).toBe(false); // extra coordinate fields change nothing — there is no path from strings to a destination
    expect(posts).toHaveLength(0);
  });

  test("R4: a react needs a MESSAGE ref — unknown or conversation refs are rejected", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const { refs, minted } = seededRefs([{ venueId: "C1", threadRootId: "1.0", via: "rendered" }]); // conversation ref, no ts
    const ctx = baseCtx(db, clock, { refs, reactTo: async () => {} });
    const bare = await tool(buildToolset(ctx), "react").run({ emoji: "eyes" });
    expect(bare.success).toBe(false);
    expect(bare.output).toContain("no such message ref");
    const convoRef = await tool(buildToolset(ctx), "react").run({ emoji: "eyes", ref: minted[0] });
    expect(convoRef.success).toBe(false);
  });

  test("execution steps cannot post; workers report to resident", () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock, {
      turnKind: "execution_step",
      anchor: { venueId: "C1", threadRootId: null },
      taskId: "T-1",
    });
    const names = buildToolset(ctx).map((t) => t.spec.name);
    for (const posting of ["reply", "react"]) expect(names).not.toContain(posting);
  });
});

describe("react targeting a specific message (resident wakes)", () => {
  test("a resident wake reacts to a delivered message by its ref, scope-checked", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const reactions: { venueId: string; ts: string; emoji: string }[] = [];
    const refs = makeRefTable();
    const inC1 = refs.mint({ venueId: "C1", threadRootId: null, ts: "9.9", via: "rendered" });
    const inC3 = refs.mint({ venueId: "C3", threadRootId: null, ts: "3.3", via: "rendered" });
    const ctx = baseCtx(db, clock, {
      refs,
      reactTo: async (venueId, ts, emoji) => {
        reactions.push({ venueId, ts, emoji });
      },
    });
    const ok = await tool(buildToolset(ctx), "react").run({ emoji: "eyes", ref: inC1 });
    expect(ok.success).toBe(true);
    expect(reactions).toEqual([{ venueId: "C1", ts: "9.9", emoji: "eyes" }]);
    // Scope still applies: ref outside identity venues refused.
    const denied = await tool(buildToolset(ctx), "react").run({ emoji: "eyes", ref: inC3 });
    expect(denied.success).toBe(false);
    expect(denied.output).toContain("posting_scope_violation");
  });
});

describe("execution_step outcome tools (SPEC §6.3, §17.4)", () => {
  async function activeExecutionCtx(db: ReturnType<typeof openLedger>, clock: Clock) {
    const createCtx = baseCtx(db, clock);
    seedEvent(db, "e1", clock);
    await tool(buildToolset(createCtx), "task_create").run({ title: "t", spec: "s", ref: "r1" });
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
    return baseCtx(db, clock, {
      turnKind: "execution_step",
      taskId: "T-1",
      anchor: { venueId: "C1", threadRootId: null },
    });
  }

  test("task_complete → done; report in ledger, nothing posted", async () => {
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
    const result = await tool(buildToolset(execCtx), "task_fail").run({
      report: "could not reach the db",
    });
    expect(result.success).toBe(true);
    expect(getTask(db, "T-1")?.status).toBe("failed");
  });

  test("task_ask yields to waiting(human)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const execCtx = await activeExecutionCtx(db, clock);
    const result = await tool(buildToolset(execCtx), "task_ask").run({
      question: "which environment?",
    });
    expect(result.success).toBe(true);
    expect(getTask(db, "T-1")?.status).toBe("waiting");
    expect(getTask(db, "T-1")?.waitingOn).toBe("human");
  });

  test("set_wake yields to waiting(timer)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const execCtx = await activeExecutionCtx(db, clock);
    const result = await tool(buildToolset(execCtx), "set_wake").run({
      wakeAt: "2026-07-09T00:00:00Z",
    });
    expect(result.success).toBe(true);
    expect(getTask(db, "T-1")?.status).toBe("waiting");
    expect(getTask(db, "T-1")?.waitingOn).toBe("timer");
  });

  test("outcome tools unavailable outside execution's own turn", async () => {
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
      tool: {
        spec: { name: "send_email", description: "send", inputSchema: { type: "object" } },
        run: async (args: unknown) => ({ success: true, output: `sent: ${JSON.stringify(args)}` }),
      },
    },
  };

  test("a granted, preauthorized external tool call runs its implementation", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock, {
      identity: identity({
        grants: [{ tool: "send_email", preauthorizedActionClasses: ["outward"] }],
      }),
      catalog: CATALOG,
    });
    const result = await tool(buildToolset(ctx), "send_email").run({ to: "a@b.com" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("sent");
  });

  test("non-preauthorized outward action on execution_step auto-requests confirm", async () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    const createCtx = baseCtx(db, clock);
    await tool(buildToolset(createCtx), "task_create").run({ title: "t", spec: "s", ref: "r1" });
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

  test("interactive turns denied non-preauthorized outward action (no confirm)", async () => {
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
  test("memory_write then search round-trips; hit carries memory id", async () => {
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
    expect(hits.find((h: any) => h.memoryId === memoryId).tier).toBe("recent"); // §8.6 default
  });

  test("memory_tier demotes core item to searchable archive (§8.6)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    const tools = buildToolset(ctx);

    const written = await tool(tools, "memory_write").run({
      content: "the sprint retro moved to thursdays",
    });
    const { memoryId } = JSON.parse(written.output);

    const moved = await tool(tools, "memory_tier").run({ id: memoryId, tier: "archive" });
    expect(moved.success).toBe(true);

    const found = await tool(tools, "search").run({ query: "sprint retro" });
    const hit = JSON.parse(found.output).find((h: any) => h.memoryId === memoryId);
    expect(hit.tier).toBe("archive"); // demoted but still searchable — never lost
    expect(ctx.effects.some((e: any) => e.kind === "memory_tiered")).toBe(true);
  });

  test("memory_tier cannot move another identity's item (§7.1)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const { writeMemory } = await import("../src/ledger/memory");
    writeMemory(db, clock, { id: "finance-item", identityId: "finance", content: "confidential" });

    const ctx = baseCtx(db, clock, { identity: identity({ id: "eng" }) });
    const result = await tool(buildToolset(ctx), "memory_tier").run({
      id: "finance-item",
      tier: "archive",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("not_found");
  });

  test("retraction takes effect in-turn; immediately absent from next search", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    const tools = buildToolset(ctx);

    const written = await tool(tools, "memory_write").run({
      content: "a wrong fact about exports",
    });
    const { memoryId } = JSON.parse(written.output);

    const retracted = await tool(tools, "memory_retract").run({ id: memoryId });
    expect(retracted.success).toBe(true);

    const found = await tool(tools, "search").run({ query: "wrong fact exports" });
    const hits = JSON.parse(found.output);
    expect(hits.map((h: any) => h.memoryId)).not.toContain(memoryId);
  });

  test("search returns only this turn's identity; cross-identity impossible", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const { writeMemory } = await import("../src/ledger/memory");
    writeMemory(db, clock, {
      id: "finance-secret",
      identityId: "finance",
      content: "confidential roadmap",
    });

    const ctx = baseCtx(db, clock, { identity: identity({ id: "eng" }) });
    const result = await tool(buildToolset(ctx), "search").run({ query: "confidential roadmap" });
    expect(JSON.parse(result.output)).toEqual([]);
  });

  test("memory_retract cannot retract another identity's item", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const { writeMemory } = await import("../src/ledger/memory");
    writeMemory(db, clock, {
      id: "finance-secret",
      identityId: "finance",
      content: "confidential roadmap",
    });

    const ctx = baseCtx(db, clock, { identity: identity({ id: "eng" }) });
    const result = await tool(buildToolset(ctx), "memory_retract").run({ id: "finance-secret" });

    expect(result.success).toBe(false);
    expect(result.output).toContain("not_found");
    expect(queryMemory(db, "finance").map((i) => i.id)).toEqual(["finance-secret"]);
  });

  test("memory_write defaults to recent; tier 'core' is explicit (§8.6)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock);
    await tool(buildToolset(ctx), "memory_write").run({ content: "noticed fact" });
    await tool(buildToolset(ctx), "memory_write").run({
      content: "remember this standing rule",
      tier: "core",
    });
    const items = queryMemory(db, "eng");
    expect(items.find((i) => i.content === "noticed fact")?.tier).toBe("recent");
    expect(items.find((i) => i.content === "remember this standing rule")?.tier).toBe("core");
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
    const ctx = baseCtx(db, clock, {
      identity: identity({ grants: [{ tool: "audit_query", preauthorizedActionClasses: [] }] }),
    });
    const tools = buildToolset(ctx);
    expect(tools.some((t) => t.spec.name === "audit_query")).toBe(true);

    await tool(tools, "task_create").run({ title: "t", spec: "s", ref: "r1" });
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

    const ctx = baseCtx(db, clock, {
      identity: identity({
        id: "eng",
        grants: [{ tool: "audit_query", preauthorizedActionClasses: [] }],
      }),
    });
    const result = await tool(buildToolset(ctx), "audit_query").run({});
    const records = JSON.parse(result.output);
    expect(records.some((r: any) => r.payload.taskId === "T-secret")).toBe(false);
    expect(records.every((r: any) => r.identityId === "eng")).toBe(true);
  });
});

// SPEC §11/§18: every exposed tool lands in a named digest group.
describe("toolbox digest covers the built toolset", () => {
  test("all built-ins (audit included) group under named registries, digest ≡ toolset", () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock, {
      identity: identity({ grants: [{ tool: "audit_query", preauthorizedActionClasses: [] }] }),
    });
    const tools = buildToolset(ctx);
    const toolbox = buildToolbox(tools, BUILTIN_REGISTRIES);
    expect(toolbox.flatMap((group) => group.tools.map((entry) => entry.name)).toSorted()).toEqual(
      tools.map((entry) => entry.spec.name).toSorted(),
    );
    const named = new Set(BUILTIN_REGISTRIES.map((registry) => registry.name));
    for (const group of toolbox) expect(named.has(group.registry)).toBe(true);
  });

  test("granted integration tools group under their registry with built-ins", () => {
    const db = freshDb();
    const clock = fakeClock();
    const ctx = baseCtx(db, clock, {
      identity: identity({ grants: [{ tool: "linear_read", preauthorizedActionClasses: [] }] }),
      catalog: integrationCatalog(),
    });
    const tools = buildToolset(ctx);
    const toolbox = buildToolbox(tools, [...BUILTIN_REGISTRIES, ...INTEGRATION_REGISTRIES]);
    const linear = toolbox.find((group) => group.registry === "linear")!;
    expect(linear.tools.map((entry) => entry.name)).toEqual(["linear_read"]);
    expect(linear.skill!.length).toBeGreaterThan(0);
    expect(linear.examples!.every((example) => example.tool === "linear_read")).toBe(true);
    expect(toolbox.flatMap((group) => group.tools.map((entry) => entry.name)).toSorted()).toEqual(
      tools.map((entry) => entry.spec.name).toSorted(),
    );
  });
});

// SPEC §11: kind restriction at exposure, not only deny-at-call.
describe("per-kind tool exposure", () => {
  const grants = [
    { tool: "linear_read", preauthorizedActionClasses: [] },
    { tool: "linear_write", preauthorizedActionClasses: [] },
  ];
  function names(kind: ToolsetContext["turnKind"], extra: Partial<ToolsetContext> = {}) {
    const db = freshDb();
    const ctx = baseCtx(db, fakeClock(), {
      turnKind: kind,
      identity: identity({ grants }),
      catalog: integrationCatalog(),
      ...extra,
    });
    return buildToolset(ctx).map((t) => t.spec.name);
  }

  test("resident: no outcome tools or set_wake; task and external tools stay", () => {
    const toolNames = names("resident");
    for (const gone of ["task_complete", "task_fail", "task_ask", "set_wake"])
      expect(toolNames).not.toContain(gone);
    for (const there of [
      "task_create",
      "task_confirm",
      "reply",
      "react",
      "search",
      "memory_write",
      "linear_read",
      "linear_write",
    ])
      expect(toolNames).toContain(there);
  });

  test("execution_step: outcome tools stay; no task_mutating or confirm", () => {
    const toolNames = names("execution_step", { taskId: "T-1" });
    for (const there of ["task_complete", "task_fail", "task_ask", "set_wake"])
      expect(toolNames).toContain(there);
    for (const gone of ["task_create", "task_steer", "task_cancel", "task_confirm"])
      expect(toolNames).not.toContain(gone);
  });
});

describe("duplicate outward calls (one wake, one write)", () => {
  test("an identical repeated outward call is refused; changed arguments and reads pass", async () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    let writes = 0;
    let reads = 0;
    const catalog: ToolCatalog = {
      fake_write: {
        actionClasses: () => ["outward"],
        tool: {
          spec: { name: "fake_write", description: "w", inputSchema: { type: "object" } },
          run: async () => ({ success: true, output: `w${++writes}` }),
        },
      },
      fake_read: {
        actionClasses: () => [],
        tool: {
          spec: { name: "fake_read", description: "r", inputSchema: { type: "object" } },
          run: async () => ({ success: true, output: `r${++reads}` }),
        },
      },
    };
    const ctx = baseCtx(db, clock, {
      identity: identity({
        grants: [
          { tool: "fake_write", preauthorizedActionClasses: ["outward"] },
          { tool: "fake_read", preauthorizedActionClasses: [] },
        ],
      }),
      catalog,
    });
    const tools = buildToolset(ctx);

    expect((await tool(tools, "fake_write").run({ title: "ticket A" })).success).toBe(true);
    const repeat = await tool(tools, "fake_write").run({ title: "ticket A" });
    expect(repeat.success).toBe(false);
    expect(repeat.output).toContain("already done");
    expect(writes).toBe(1); // the second identical mutation never reached the implementation
    expect((await tool(tools, "fake_write").run({ title: "ticket B" })).success).toBe(true);
    expect((await tool(tools, "fake_read").run({ q: "same" })).success).toBe(true);
    expect((await tool(tools, "fake_read").run({ q: "same" })).success).toBe(true);
    expect(reads).toBe(2); // reads repeat freely
  });

  test("a FAILED outward call may be retried with the same arguments", async () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    let calls = 0;
    const catalog: ToolCatalog = {
      fake_write: {
        actionClasses: () => ["outward"],
        tool: {
          spec: { name: "fake_write", description: "w", inputSchema: { type: "object" } },
          run: async () =>
            ++calls === 1
              ? { success: false, output: "transient" }
              : { success: true, output: "ok" },
        },
      },
    };
    const ctx = baseCtx(db, clock, {
      identity: identity({
        grants: [{ tool: "fake_write", preauthorizedActionClasses: ["outward"] }],
      }),
      catalog,
    });
    const tools = buildToolset(ctx);

    expect((await tool(tools, "fake_write").run({ x: 1 })).success).toBe(false);
    expect((await tool(tools, "fake_write").run({ x: 1 })).success).toBe(true); // failure never arms the guard
    expect(calls).toBe(2);
  });
});

describe("outward-call idempotency is durable", () => {
  const CATALOG: ToolCatalog = {
    linear_write: {
      actionClasses: () => ["outward"],
      tool: {
        spec: {
          name: "linear_write",
          description: "write to linear",
          inputSchema: { type: "object" },
        },
        run: async () => ({ success: false, output: "unset" }),
      },
    },
  };
  function outwardCtx(
    db: ReturnType<typeof freshDb>,
    clock: Clock,
    impl: (args: unknown) => Promise<{ success: boolean; output: string }>,
  ) {
    CATALOG.linear_write!.tool!.run = impl;
    return baseCtx(db, clock, {
      turnKind: "execution_step" as const,
      taskId: "T-1",
      catalog: CATALOG,
      identity: identity({
        grants: [{ tool: "linear_write", preauthorizedActionClasses: ["outward"] }],
      }),
    });
  }

  test("identical consequential call refused across toolset rebuilds", async () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    let ran = 0;
    const impl = async () => (ran++, { success: true, output: "created BEV-1" });
    const first = await tool(buildToolset(outwardCtx(db, clock, impl)), "linear_write").run({
      title: "bug",
    });
    expect(first.success).toBe(true);
    // A FRESH toolset (new attempt, or a restarted process resuming the task): same scope, same args.
    const second = await tool(buildToolset(outwardCtx(db, clock, impl)), "linear_write").run({
      title: "bug",
    });
    expect(second.success).toBe(false);
    expect(second.output).toContain("already done");
    expect(ran).toBe(1);
    // Different args are a different action.
    const third = await tool(buildToolset(outwardCtx(db, clock, impl)), "linear_write").run({
      title: "other bug",
    });
    expect(third.success).toBe(true);
    expect(ran).toBe(2);
  });

  test("FAILED call compensated; retry not told 'already done' for unlanded write", async () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    let calls = 0;
    const impl = async () =>
      ++calls === 1
        ? { success: false, output: "rate limited" }
        : { success: true, output: "created" };
    const first = await tool(buildToolset(outwardCtx(db, clock, impl)), "linear_write").run({
      title: "bug",
    });
    expect(first.success).toBe(false);
    const retry = await tool(buildToolset(outwardCtx(db, clock, impl)), "linear_write").run({
      title: "bug",
    });
    expect(retry.success).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("linear_write mutation scoping", () => {
  test("extracts top-level mutation fields; aliases yes, nested/string braces no", () => {
    expect(
      topLevelMutationFields(
        "mutation($input: X!) { commentCreate(input: $input) { comment { id body } } }",
      ),
    ).toEqual(["commentCreate"]);
    expect(
      topLevelMutationFields(
        'mutation($a: String!) { update: issueUpdate(id: $a, input: { stateId: "x{y}" }) { success } comment: commentCreate(input: { body: $a }) { success } }',
      ),
    ).toEqual(["issueUpdate", "commentCreate"]);
    expect(topLevelMutationFields('query { issue(id: "x") { id } }')).toEqual([]);
  });

  test("grant allowlist refuses unlisted ops before call; listed pass", async () => {
    const check = integrationCatalog().linear_write?.scopeCheck;
    if (!check) throw new Error("expected linear_write.scopeCheck");
    const scope = {
      mutations: ["commentCreate", "issueCreate", "issueUpdate", "attachmentCreate"],
    };
    expect(
      check(scope, { query: "mutation($i: X!) { commentCreate(input: $i) { success } }" }),
    ).toBeNull();
    const denied = check(scope, { query: 'mutation { issueDelete(id: "x") { success } }' });
    expect(denied).toContain("issueDelete");
    expect(check(scope, { query: "" })).not.toBeNull(); // unparseable: fail closed
  });
});
