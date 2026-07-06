import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import {
  createTask,
  transition,
  steerTask,
  requestConfirmation,
  resolveConfirmation,
  consumeSteering,
  getTask,
  IllegalTransitionError,
  RecurrenceRequiresOperatorError,
} from "../src/ledger/tasks";
import type { Clock } from "../src/ledger/clock";

function freshDb() {
  return openLedger(":memory:");
}

function fakeClock(start = "2026-07-02T00:00:00Z"): Clock & { advance: (isoOrMs: string) => void } {
  let now = start;
  const clock = (() => now) as Clock & { advance: (iso: string) => void };
  clock.advance = (iso: string) => {
    now = iso;
  };
  return clock;
}

function seedEvent(db: ReturnType<typeof openLedger>, id: string, clock: Clock) {
  db.query(
    "INSERT INTO events (id, dedup_key, kind, identity_id, received_at) VALUES (?, ?, 'addressed_message', 'eng', ?)",
  ).run(id, `k-${id}`, clock());
}

function baseTaskParams(overrides: Partial<Parameters<typeof createTask>[2]> = {}) {
  return {
    id: "T-1",
    identityId: "eng",
    title: "dig into dashboard latency",
    spec: "figure out why the dashboard is slow",
    sponsorId: "U1",
    homeAnchor: { venueId: "C1", threadRootId: null },
    originEventId: "e1",
    ...overrides,
  };
}

describe("createTask (SPEC §4.1.7, §6.1)", () => {
  test("creates an open task and audit-logs task_created", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);

    const task = createTask(db, clock, baseTaskParams());

    expect(task.status).toBe("open");
    expect(task.waitingOn).toBeNull();
    expect(task.openedAt).toBe("2026-07-02T00:00:00Z");

    const audit = db.query("SELECT kind, payload FROM audit WHERE kind = 'task_created'").all() as any[];
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].payload).taskId).toBe("T-1");
  });

  test("rejects a recurrence from a non-operator sponsor (SPEC §6.5)", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);

    expect(() =>
      createTask(db, clock, baseTaskParams({ recurrence: "weekly", sponsorIsOperator: false })),
    ).toThrow(RecurrenceRequiresOperatorError);
  });

  test("accepts a recurrence from an operator sponsor", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);

    const task = createTask(db, clock, baseTaskParams({ recurrence: "weekly", sponsorIsOperator: true }));
    expect(task.recurrence).toBe("weekly");
  });
});

describe("dispatch: open -> active (SPEC §6.2)", () => {
  test("creates the live execution row and marks the task active", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams());

    const task = transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });

    expect(task.status).toBe("active");
    const exec = db.query("SELECT status, attempt FROM executions WHERE id = 'x1'").get() as any;
    expect(exec.status).toBe("running");
    expect(exec.attempt).toBe(1);
  });

  test("a second concurrent dispatch attempt on the same task is rejected", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams());
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });

    expect(() => transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x2" })).toThrow(
      IllegalTransitionError,
    );
  });

  test("illegal transitions throw", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams());

    expect(() => transition(db, clock, "T-1", "done", { type: "completed", report: "done" })).toThrow(
      IllegalTransitionError,
    );
  });
});

describe("waiting(human) -> nudge -> parked -> revived (SPEC §6.1)", () => {
  function activeTask(db: ReturnType<typeof openLedger>, clock: Clock) {
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams());
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
  }

  test("active -> waiting(human) arms the nudge deadline, posting nothing (the model asks in-thread itself)", () => {
    const db = freshDb();
    const clock = fakeClock();
    activeTask(db, clock);

    const task = transition(db, clock, "T-1", "waiting", {
      type: "yield_human",
      nudgeDeadline: "2026-07-02T01:00:00Z",
    });

    expect(task.waitingOn).toBe("human");
    expect(task.wakeAt).toBe("2026-07-02T01:00:00Z");
    const exec = db.query("SELECT status FROM executions WHERE id = 'x1'").get() as any;
    expect(exec.status).toBe("yielded");
  });

  test("nudge fires: re-arms wake_at for the park deadline silently, status unchanged", () => {
    const db = freshDb();
    const clock = fakeClock();
    activeTask(db, clock);
    transition(db, clock, "T-1", "waiting", {
      type: "yield_human",
      nudgeDeadline: "2026-07-02T01:00:00Z",
    });

    clock.advance("2026-07-02T01:00:00Z");
    const task = transition(db, clock, "T-1", "waiting", {
      type: "nudge_sent",
      parkDeadline: "2026-07-04T01:00:00Z",
    });

    expect(task.status).toBe("waiting");
    expect(task.waitingOn).toBe("human");
    expect(task.wakeAt).toBe("2026-07-04T01:00:00Z");
  });

  test("park timeout: waiting(human) -> parked, revivable by steering", () => {
    const db = freshDb();
    const clock = fakeClock();
    activeTask(db, clock);
    transition(db, clock, "T-1", "waiting", {
      type: "yield_human",
      nudgeDeadline: "2026-07-02T01:00:00Z",
    });
    clock.advance("2026-07-04T01:00:00Z");

    const parked = transition(db, clock, "T-1", "parked", { type: "park_timeout" });
    expect(parked.status).toBe("parked");
    expect(parked.waitingOn).toBeNull();

    seedEvent(db, "e2", clock);
    clock.advance("2026-07-06T00:00:00Z");
    const revived = steerTask(db, clock, {
      taskId: "T-1",
      kind: "guidance",
      payload: { text: "actually check staging first" },
      sourceEventId: "e2",
    });

    expect(revived.applied).toBe(true);
    expect(revived.task.status).toBe("open");
    expect(revived.task.spec).toContain("actually check staging first");
  });

  test("park timeout is illegal from waiting(timer)", () => {
    const db = freshDb();
    const clock = fakeClock();
    activeTask(db, clock);
    transition(db, clock, "T-1", "waiting", { type: "yield_timer", wakeAt: "2026-07-03T00:00:00Z" });

    expect(() => transition(db, clock, "T-1", "parked", { type: "park_timeout" })).toThrow(IllegalTransitionError);
  });
});

describe("cancel is reachable from every non-terminal state (SPEC §6.1, §6.4)", () => {
  function setup(db: ReturnType<typeof openLedger>, clock: ReturnType<typeof fakeClock>, target: string) {
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams());
    if (target === "open") return;
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
    if (target === "active") return;
    if (target === "waiting(human)") {
      transition(db, clock, "T-1", "waiting", { type: "yield_human", nudgeDeadline: "2026-07-02T01:00:00Z" });
      return;
    }
    if (target === "waiting(timer)") {
      transition(db, clock, "T-1", "waiting", { type: "yield_timer", wakeAt: "2026-07-03T00:00:00Z" });
      return;
    }
    if (target === "waiting(external)") {
      transition(db, clock, "T-1", "waiting", { type: "yield_external" });
      return;
    }
    if (target === "parked") {
      transition(db, clock, "T-1", "waiting", { type: "yield_human", nudgeDeadline: "2026-07-02T01:00:00Z" });
      clock.advance("2026-07-04T01:00:00Z");
      transition(db, clock, "T-1", "parked", { type: "park_timeout" });
      return;
    }
    throw new Error(`unknown target ${target}`);
  }

  for (const target of ["open", "active", "waiting(human)", "waiting(timer)", "waiting(external)", "parked"]) {
    test(`cancels from ${target}`, () => {
      const db = freshDb();
      const clock = fakeClock();
      setup(db, clock, target);

      const task = transition(db, clock, "T-1", "cancelled", { type: "cancelled", report: "cancelled by member" });
      expect(task.status).toBe("cancelled");
      expect(task.terminalReport).toBe("cancelled by member");
    });
  }

  test("cancel via steerTask on a live execution queues a cancel signal for it to consume", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams());
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
    seedEvent(db, "e2", clock);

    const result = steerTask(db, clock, {
      taskId: "T-1",
      kind: "cancel",
      payload: { report: "member asked to stop" },
      sourceEventId: "e2",
    });

    expect(result.applied).toBe(true);
    expect(result.task.status).toBe("cancelled");
    const exec = db.query("SELECT status FROM executions WHERE id = 'x1'").get() as any;
    expect(exec.status).toBe("cancelled");

    const queued = consumeSteering(db, clock, "T-1");
    expect(queued.map((s) => s.kind)).toContain("cancel");
  });

  test("cancelling an already-terminal task throws at the transition() choke point", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams());
    transition(db, clock, "T-1", "cancelled", { type: "cancelled", report: "first cancel" });

    expect(() => transition(db, clock, "T-1", "cancelled", { type: "cancelled", report: "second cancel" })).toThrow(
      IllegalTransitionError,
    );
  });
});

describe("terminal transitions (SPEC §6.1 no dangling threads)", () => {
  test("completed records the terminal report in the ledger and marks the execution succeeded", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams());
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });

    const task = transition(db, clock, "T-1", "done", { type: "completed", report: "fixed the slow query" });

    expect(task.terminalReport).toBe("fixed the slow query");
    const exec = db.query("SELECT status FROM executions WHERE id = 'x1'").get() as any;
    expect(exec.status).toBe("succeeded");
  });

  test("failed records an honest failure report and marks the execution failed", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams());
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });

    const task = transition(db, clock, "T-1", "failed", { type: "failed", report: "could not reach the DB" });

    expect(task.status).toBe("failed");
    expect(task.terminalReport).toBe("could not reach the DB");
    const exec = db.query("SELECT status FROM executions WHERE id = 'x1'").get() as any;
    expect(exec.status).toBe("failed");
  });

  test("steering after a terminal transition returns a visible reply instead of a silent drop", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams());
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
    transition(db, clock, "T-1", "done", { type: "completed", report: "shipped" });

    seedEvent(db, "e2", clock);
    const result = steerTask(db, clock, {
      taskId: "T-1",
      kind: "guidance",
      payload: { text: "also check staging" },
      sourceEventId: "e2",
    });

    expect(result.applied).toBe(false);
    expect(result.reply).toBe("T-1 already done");
    const task = getTask(db, "T-1");
    expect(task?.spec).not.toContain("also check staging");
  });
});

describe("steering (SPEC §6.4)", () => {
  test("guidance on an open task with no live execution updates spec, stays open", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams());
    seedEvent(db, "e2", clock);

    const result = steerTask(db, clock, {
      taskId: "T-1",
      kind: "guidance",
      payload: { text: "focus on the /api/dash endpoint" },
      sourceEventId: "e2",
    });

    expect(result.task.status).toBe("open");
    expect(result.task.spec).toContain("focus on the /api/dash endpoint");
  });

  test("guidance on waiting(timer) updates spec but does not revive", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams());
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
    transition(db, clock, "T-1", "waiting", { type: "yield_timer", wakeAt: "2026-07-03T00:00:00Z" });
    seedEvent(db, "e2", clock);

    const result = steerTask(db, clock, {
      taskId: "T-1",
      kind: "guidance",
      payload: { text: "also look at redis" },
      sourceEventId: "e2",
    });

    expect(result.task.status).toBe("waiting");
    expect(result.task.waitingOn).toBe("timer");
    expect(result.task.spec).toContain("also look at redis");
  });

  test("guidance on an active task is queued to the steering_queue for the execution to consume", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams());
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
    seedEvent(db, "e2", clock);

    steerTask(db, clock, {
      taskId: "T-1",
      kind: "guidance",
      payload: { text: "also check the API" },
      sourceEventId: "e2",
    });

    const before = db.query("SELECT consumed_at FROM steering WHERE task_id = 'T-1'").all() as any[];
    expect(before[0]?.consumed_at).toBeNull();

    const queued = consumeSteering(db, clock, "T-1");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.kind).toBe("guidance");

    const after = db.query("SELECT consumed_at FROM steering WHERE task_id = 'T-1'").all() as any[];
    expect(after[0]?.consumed_at).not.toBeNull();
  });

  test("pause transitions directly to parked with no post, and is idempotent", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams());
    seedEvent(db, "e2", clock);

    const result = steerTask(db, clock, {
      taskId: "T-1",
      kind: "pause",
      payload: {},
      sourceEventId: "e2",
    });
    expect(result.task.status).toBe("parked");

    seedEvent(db, "e3", clock);
    const again = steerTask(db, clock, { taskId: "T-1", kind: "pause", payload: {}, sourceEventId: "e3" });
    expect(again.applied).toBe(false);
  });

  test("pause is not defined for an active task (use cancel to stop live work)", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams());
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
    seedEvent(db, "e2", clock);

    const result = steerTask(db, clock, { taskId: "T-1", kind: "pause", payload: {}, sourceEventId: "e2" });
    expect(result.applied).toBe(false);
    expect(result.task.status).toBe("active");
  });

  test("resume only applies to a parked task", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams());
    seedEvent(db, "e2", clock);
    steerTask(db, clock, { taskId: "T-1", kind: "pause", payload: {}, sourceEventId: "e2" });

    seedEvent(db, "e3", clock);
    const resumed = steerTask(db, clock, { taskId: "T-1", kind: "resume", payload: {}, sourceEventId: "e3" });
    expect(resumed.applied).toBe(true);
    expect(resumed.task.status).toBe("open");

    seedEvent(db, "e4", clock);
    const noop = steerTask(db, clock, { taskId: "T-1", kind: "resume", payload: {}, sourceEventId: "e4" });
    expect(noop.applied).toBe(false);
  });
});

describe("pending_confirmation lifecycle (SPEC §10.2)", () => {
  function activeTask(db: ReturnType<typeof openLedger>, clock: Clock) {
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams());
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
  }

  test("request records intent and yields to waiting(human) with pending_confirmation set", () => {
    const db = freshDb();
    const clock = fakeClock();
    activeTask(db, clock);

    const task = requestConfirmation(db, clock, {
      taskId: "T-1",
      actionRef: "send_email:release-notes",
      description: "Send the release-notes email to the customer list",
      nudgeDeadline: "2026-07-02T01:00:00Z",
    });

    expect(task.status).toBe("waiting");
    expect(task.waitingOn).toBe("human");
    expect(task.pendingConfirmation?.actionRef).toBe("send_email:release-notes");
    expect(task.pendingConfirmation?.resolution).toBeUndefined();
    expect(task.pendingConfirmation?.description).toContain("Send the release-notes email");

    const audit = db.query("SELECT kind FROM audit WHERE kind = 'confirmation_requested'").all();
    expect(audit).toHaveLength(1);
  });

  test("resolve via confirm writes the resolution and revives the task to open", () => {
    const db = freshDb();
    const clock = fakeClock();
    activeTask(db, clock);
    requestConfirmation(db, clock, {
      taskId: "T-1",
      actionRef: "send_email:release-notes",
      description: "Send the release-notes email",
      nudgeDeadline: "2026-07-02T01:00:00Z",
    });

    const result = resolveConfirmation(db, clock, { taskId: "T-1", principalId: "U2", approve: true });

    expect(result.task.status).toBe("open");
    expect(result.task.pendingConfirmation?.resolution).toEqual({
      approved: true,
      principalId: "U2",
      resolvedAt: "2026-07-02T00:00:00Z",
    });

    const audit = db.query("SELECT kind FROM audit WHERE kind = 'confirmation_resolved'").all();
    expect(audit).toHaveLength(1);
  });

  test("denial is recorded the same way as approval", () => {
    const db = freshDb();
    const clock = fakeClock();
    activeTask(db, clock);
    requestConfirmation(db, clock, {
      taskId: "T-1",
      actionRef: "send_email:release-notes",
      description: "Send the release-notes email",
      nudgeDeadline: "2026-07-02T01:00:00Z",
    });

    const result = resolveConfirmation(db, clock, { taskId: "T-1", principalId: "U2", approve: false });
    expect(result.task.pendingConfirmation?.resolution?.approved).toBe(false);
    expect(result.task.status).toBe("open");
  });

  test("resolving with nothing pending returns a graceful reply, not a throw", () => {
    const db = freshDb();
    const clock = fakeClock();
    activeTask(db, clock);

    const result = resolveConfirmation(db, clock, { taskId: "T-1", principalId: "U2", approve: true });
    expect(result.applied).toBe(false);
    expect(result.reply).toContain("no pending confirmation");
  });

  test("pending_confirmation is cleared on terminal transition (expires with the task)", () => {
    const db = freshDb();
    const clock = fakeClock();
    activeTask(db, clock);
    requestConfirmation(db, clock, {
      taskId: "T-1",
      actionRef: "send_email:release-notes",
      description: "Send the release-notes email",
      nudgeDeadline: "2026-07-02T01:00:00Z",
    });
    resolveConfirmation(db, clock, { taskId: "T-1", principalId: "U2", approve: true });
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x2" });

    const task = transition(db, clock, "T-1", "done", { type: "completed", report: "sent" });
    expect(task.pendingConfirmation).toBeNull();
  });
});

describe("standing tasks (SPEC §6.5)", () => {
  function standingTask(db: ReturnType<typeof openLedger>, clock: Clock) {
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams({ recurrence: "weekly", sponsorIsOperator: true }));
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
  }

  test("a successful firing re-arms wake_at instead of terminating", () => {
    const db = freshDb();
    const clock = fakeClock();
    standingTask(db, clock);

    const task = transition(db, clock, "T-1", "waiting", {
      type: "recurrence_rearm",
      wakeAt: "2026-07-09T00:00:00Z",
    });

    expect(task.status).toBe("waiting");
    expect(task.waitingOn).toBe("timer");
    expect(task.wakeAt).toBe("2026-07-09T00:00:00Z");
    expect(task.recurrence).toBe("weekly");
    const exec = db.query("SELECT status FROM executions WHERE id = 'x1'").get() as any;
    expect(exec.status).toBe("succeeded");
  });

  test("a failing firing re-arms instead of failing the task (failure carve-out)", () => {
    const db = freshDb();
    const clock = fakeClock();
    standingTask(db, clock);

    const task = transition(db, clock, "T-1", "waiting", {
      type: "recurrence_failed",
      wakeAt: "2026-07-09T00:00:00Z",
    });

    expect(task.status).toBe("waiting");
    expect(task.recurrence).toBe("weekly");
    const exec = db.query("SELECT status FROM executions WHERE id = 'x1'").get() as any;
    expect(exec.status).toBe("failed");
  });

  test("recurrence_rearm on a non-standing task is illegal", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams());
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });

    expect(() =>
      transition(db, clock, "T-1", "waiting", { type: "recurrence_rearm", wakeAt: "2026-07-09T00:00:00Z" }),
    ).toThrow(IllegalTransitionError);
  });

  test("cancellation still ends a standing task", () => {
    const db = freshDb();
    const clock = fakeClock();
    standingTask(db, clock);
    transition(db, clock, "T-1", "waiting", {
      type: "recurrence_rearm",
      wakeAt: "2026-07-09T00:00:00Z",
    });

    const task = transition(db, clock, "T-1", "cancelled", { type: "cancelled", report: "operator stopped it" });
    expect(task.status).toBe("cancelled");
  });
});

describe("opened_at refreshes on every re-entry to open (SPEC §6.2 dispatch order)", () => {
  test("re-entering open via yield_open, revive, or interrupted bumps opened_at", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    const created = createTask(db, clock, baseTaskParams());
    expect(created.openedAt).toBe("2026-07-02T00:00:00Z");

    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
    clock.advance("2026-07-02T01:00:00Z");
    const yielded = transition(db, clock, "T-1", "open", { type: "yield_open" });
    expect(yielded.openedAt).toBe("2026-07-02T01:00:00Z");

    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x2" });
    clock.advance("2026-07-02T02:00:00Z");
    const interrupted = transition(db, clock, "T-1", "open", { type: "interrupted" });
    expect(interrupted.openedAt).toBe("2026-07-02T02:00:00Z");
  });
});

describe("consecutive interruptions and crash-loop parking (SPEC §14.2)", () => {
  function dispatched(db: ReturnType<typeof openLedger>, clock: Clock, executionId: string) {
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId });
  }

  test("interrupted increments the counter; a normal yield resets it", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams());

    dispatched(db, clock, "x1");
    let task = transition(db, clock, "T-1", "open", { type: "interrupted" });
    expect(task.consecutiveInterruptions).toBe(1);

    dispatched(db, clock, "x2");
    task = transition(db, clock, "T-1", "open", { type: "interrupted" });
    expect(task.consecutiveInterruptions).toBe(2);

    dispatched(db, clock, "x3");
    task = transition(db, clock, "T-1", "open", { type: "yield_open" });
    expect(task.consecutiveInterruptions).toBe(0);
  });

  test("crash_loop_parked takes active -> parked directly", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    createTask(db, clock, baseTaskParams());
    dispatched(db, clock, "x1");

    const task = transition(db, clock, "T-1", "parked", { type: "crash_loop_parked" });

    expect(task.status).toBe("parked");
    expect(task.consecutiveInterruptions).toBe(0);
    const exec = db.query("SELECT status FROM executions WHERE id = 'x1'").get() as any;
    expect(exec.status).toBe("interrupted");
  });
});
