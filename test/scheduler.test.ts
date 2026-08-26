import { describe, expect, test } from "bun:test";
import { openLedger, checkpointWal, many, one } from "../src/ledger/db";
import { createTask, transition, getTask } from "../src/ledger/tasks";
import {
  fireDueTimers,
  dispatchRunnable,
  recoverFromRestart,
  msUntilNextTimer,
} from "../src/ledger/scheduler";
import type { Clock } from "../src/ledger/clock";
import { tempDbPath, cleanupDbFile, fakeClock } from "./helpers";
import { scheduleTimer } from "../src/ledger/timers";

function freshDb() {
  return openLedger(":memory:");
}

function seedEvent(
  db: ReturnType<typeof openLedger>,
  id: string,
  clock: Clock,
  identityId = "eng",
) {
  db.query(
    "INSERT INTO events (id, dedup_key, kind, identity_id, received_at) VALUES (?, ?, 'addressed_message', ?, ?)",
  ).run(id, `k-${id}`, identityId, clock());
}

function makeTask(
  db: ReturnType<typeof openLedger>,
  clock: Clock,
  id: string,
  identityId = "eng",
  overrides: Partial<Parameters<typeof createTask>[2]> = {},
) {
  seedEvent(db, `${id}-e`, clock, identityId);
  return createTask(db, clock, {
    id,
    identityId,
    title: id,
    spec: "s",
    sponsorId: "U1",
    homeAnchor: { venueId: "C1", threadRootId: null },
    originEventId: `${id}-e`,
    ...overrides,
  });
}

describe("fireDueTimers (SPEC §13)", () => {
  test("a due task_wake timer revives a waiting(timer) task to open", () => {
    const db = freshDb();
    const clock = fakeClock();
    makeTask(db, clock, "T-1");
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
    transition(db, clock, "T-1", "waiting", {
      type: "yield_timer",
      wakeAt: "2026-07-02T01:00:00Z",
    });

    clock.advance("2026-07-02T01:00:00Z");
    const results = fireDueTimers(db, clock, { parkAfterMs: 172800000 });

    expect(results).toEqual([
      {
        timerId: "T-1:task_wake:2026-07-02T01:00:00Z",
        kind: "task_wake",
        subjectId: "T-1",
        applied: true,
      },
    ]);
    expect(getTask(db, "T-1")?.status).toBe("open");
  });

  test("due nudge timer re-arms wake_at to park deadline (no post)", () => {
    const db = freshDb();
    const clock = fakeClock();
    makeTask(db, clock, "T-1");
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
    transition(db, clock, "T-1", "waiting", {
      type: "yield_human",
      nudgeDeadline: "2026-07-02T01:00:00Z",
    });

    clock.advance("2026-07-02T01:00:00Z");
    const results = fireDueTimers(db, clock, { parkAfterMs: 2 * 24 * 60 * 60 * 1000 });

    expect(results[0]?.applied).toBe(true);
    const task = getTask(db, "T-1")!;
    expect(task.status).toBe("waiting");
    expect(task.waitingOn).toBe("human");
    expect(task.wakeAt).toBe("2026-07-04T01:00:00.000Z");

    const parkTimers = many<{ due_at: string }>(
      db,
      "SELECT due_at FROM timers WHERE subject_id = 'T-1' AND kind = 'park'",
    );
    expect(parkTimers).toEqual([{ due_at: "2026-07-04T01:00:00.000Z" }]);
  });

  test("a due park timer parks a still-unanswered waiting(human) task", () => {
    const db = freshDb();
    const clock = fakeClock();
    makeTask(db, clock, "T-1");
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
    transition(db, clock, "T-1", "waiting", {
      type: "yield_human",
      nudgeDeadline: "2026-07-02T01:00:00Z",
    });
    clock.advance("2026-07-02T01:00:00Z");
    fireDueTimers(db, clock, { parkAfterMs: 2 * 24 * 60 * 60 * 1000 });

    clock.advance("2026-07-04T01:00:00Z");
    const results = fireDueTimers(db, clock, { parkAfterMs: 2 * 24 * 60 * 60 * 1000 });

    expect(results.some((r) => r.kind === "park" && r.applied)).toBe(true);
    expect(getTask(db, "T-1")?.status).toBe("parked");
  });

  test("a stale timer (task already moved on) is a safe no-op, still marked fired", () => {
    const db = freshDb();
    const clock = fakeClock();
    makeTask(db, clock, "T-1");
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
    transition(db, clock, "T-1", "waiting", {
      type: "yield_human",
      nudgeDeadline: "2026-07-02T01:00:00Z",
    });
    // The member replies before the nudge fires: task is revived out of waiting(human).
    transition(db, clock, "T-1", "open", { type: "revive" });

    clock.advance("2026-07-02T01:00:00Z");
    const results = fireDueTimers(db, clock, { parkAfterMs: 172800000 });

    expect(results).toEqual([
      {
        timerId: "T-1:nudge:2026-07-02T01:00:00Z",
        kind: "nudge",
        subjectId: "T-1",
        applied: false,
      },
    ]);
    expect(getTask(db, "T-1")?.status).toBe("open");
  });

  test("overdue timers (well past due after a long restart) still fire", () => {
    const db = freshDb();
    const clock = fakeClock();
    makeTask(db, clock, "T-1");
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
    transition(db, clock, "T-1", "waiting", {
      type: "yield_timer",
      wakeAt: "2026-07-02T01:00:00Z",
    });

    clock.advance("2026-08-01T00:00:00Z");
    const results = fireDueTimers(db, clock, { parkAfterMs: 172800000 });

    expect(results[0]?.applied).toBe(true);
    expect(getTask(db, "T-1")?.status).toBe("open");
  });
});

describe("dispatchRunnable (SPEC §6.2, §17.3)", () => {
  test("dispatches open tasks oldest-opened-first", () => {
    const db = freshDb();
    const clock = fakeClock();
    makeTask(db, clock, "T-1");
    clock.advance("2026-07-02T00:00:01Z");
    makeTask(db, clock, "T-2");
    clock.advance("2026-07-02T00:00:02Z");
    makeTask(db, clock, "T-3");

    let seq = 0;
    const result = dispatchRunnable(db, clock, {
      maxConcurrentPerIdentity: 10,
      maxConcurrentGlobal: 10,
      newExecutionId: () => `x${++seq}`,
    });

    expect(result.dispatched).toEqual(["T-1", "T-2", "T-3"]);
    expect(getTask(db, "T-1")?.status).toBe("active");
  });

  test("defers dispatch beyond the per-identity concurrency cap", () => {
    const db = freshDb();
    const clock = fakeClock();
    makeTask(db, clock, "T-1", "eng");
    makeTask(db, clock, "T-2", "eng");

    let seq = 0;
    const result = dispatchRunnable(db, clock, {
      maxConcurrentPerIdentity: 1,
      maxConcurrentGlobal: 10,
      newExecutionId: () => `x${++seq}`,
    });

    expect(result.dispatched).toEqual(["T-1"]);
    expect(result.deferredConcurrency).toEqual(["T-2"]);
    expect(getTask(db, "T-2")?.status).toBe("open");
  });

  test("a task capped by identity concurrency doesn't block a different identity's task", () => {
    const db = freshDb();
    const clock = fakeClock();
    makeTask(db, clock, "T-1", "eng");
    makeTask(db, clock, "T-2", "eng");
    makeTask(db, clock, "T-3", "sales");

    let seq = 0;
    const result = dispatchRunnable(db, clock, {
      maxConcurrentPerIdentity: 1,
      maxConcurrentGlobal: 10,
      newExecutionId: () => `x${++seq}`,
    });

    expect(result.dispatched.toSorted()).toEqual(["T-1", "T-3"]);
    expect(result.deferredConcurrency).toEqual(["T-2"]);
  });

  test("defers dispatch beyond the global concurrency cap", () => {
    const db = freshDb();
    const clock = fakeClock();
    makeTask(db, clock, "T-1", "eng");
    makeTask(db, clock, "T-2", "sales");

    let seq = 0;
    const result = dispatchRunnable(db, clock, {
      maxConcurrentPerIdentity: 10,
      maxConcurrentGlobal: 1,
      newExecutionId: () => `x${++seq}`,
    });

    expect(result.dispatched).toEqual(["T-1"]);
    expect(result.deferredConcurrency).toEqual(["T-2"]);
  });

  test("insufficient budget defers dispatch; task stays open (§10.3)", () => {
    const db = freshDb();
    const clock = fakeClock();
    makeTask(db, clock, "T-1", "eng");

    let seq = 0;
    const result = dispatchRunnable(db, clock, {
      maxConcurrentPerIdentity: 10,
      maxConcurrentGlobal: 10,
      hasBudgetHeadroom: () => false,
      newExecutionId: () => `x${++seq}`,
    });

    expect(result.dispatched).toEqual([]);
    expect(result.deferredBudget).toEqual(["T-1"]);
    expect(getTask(db, "T-1")?.status).toBe("open");
  });

  test("running execution counts against identity concurrency at startup", () => {
    const db = freshDb();
    const clock = fakeClock();
    makeTask(db, clock, "T-1", "eng");
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x0" });
    makeTask(db, clock, "T-2", "eng");

    let seq = 0;
    const result = dispatchRunnable(db, clock, {
      maxConcurrentPerIdentity: 1,
      maxConcurrentGlobal: 10,
      newExecutionId: () => `x${++seq}`,
    });

    expect(result.dispatched).toEqual([]);
    expect(result.deferredConcurrency).toEqual(["T-2"]);
  });
});

describe("recoverFromRestart (SPEC §14.2)", () => {
  test("an orphaned active task is marked interrupted and returned to open", () => {
    const db = freshDb();
    const clock = fakeClock();
    makeTask(db, clock, "T-1");
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });

    const result = recoverFromRestart(db, clock, { maxConsecutiveInterruptions: 3 });

    expect(result.reopened).toEqual(["T-1"]);
    expect(result.parked).toEqual([]);
    const task = getTask(db, "T-1")!;
    expect(task.status).toBe("open");
    expect(task.consecutiveInterruptions).toBe(1);
    const exec = one<{ status: string }>(db, "SELECT status FROM executions WHERE id = 'x1'");
    expect(exec?.status).toBe("interrupted");
  });

  test("exceeding the consecutive-interruption bound parks the task instead of churning", () => {
    const db = freshDb();
    const clock = fakeClock();
    makeTask(db, clock, "T-1");

    // Simulate three prior crash/restart cycles before this one.
    for (let i = 0; i < 3; i++) {
      transition(db, clock, "T-1", "active", { type: "dispatch", executionId: `x${i}` });
      transition(db, clock, "T-1", "open", { type: "interrupted" });
    }
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x3" });

    const result = recoverFromRestart(db, clock, { maxConsecutiveInterruptions: 3 });

    expect(result.reopened).toEqual([]);
    expect(result.parked).toEqual(["T-1"]);
    const task = getTask(db, "T-1")!;
    expect(task.status).toBe("parked");
    expect(task.consecutiveInterruptions).toBe(0);
  });

  test("a healthy task never seen as active is left untouched", () => {
    const db = freshDb();
    const clock = fakeClock();
    makeTask(db, clock, "T-1");

    const result = recoverFromRestart(db, clock, { maxConsecutiveInterruptions: 3 });

    expect(result.reopened).toEqual([]);
    expect(result.parked).toEqual([]);
    expect(getTask(db, "T-1")?.status).toBe("open");
  });
});

describe("simulated process kill + restart (SPEC §14.2, real on-disk db)", () => {
  test("an active task survives a hard kill and is recovered on reopen", () => {
    const path = tempDbPath("earshot-restart-test");
    const clock = fakeClock();

    let db = openLedger(path);
    makeTask(db, clock, "T-1");
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
    // No clean shutdown here: the process is presumed killed with T-1 mid-execution.
    db.close();

    db = openLedger(path);
    const recovery = recoverFromRestart(db, clock, { maxConsecutiveInterruptions: 3 });
    expect(recovery.reopened).toEqual(["T-1"]);
    expect(getTask(db, "T-1")?.status).toBe("open");

    const exec = one<{ status: string }>(db, "SELECT status FROM executions WHERE id = 'x1'");
    expect(exec?.status).toBe("interrupted");

    db.close();
    cleanupDbFile(path);
  });

  test("timers scheduled before a kill still fire, in due-time order, after reopen", () => {
    const path = tempDbPath("earshot-restart-test");
    const clock = fakeClock();

    let db = openLedger(path);
    makeTask(db, clock, "T-1");
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
    transition(db, clock, "T-1", "waiting", {
      type: "yield_timer",
      wakeAt: "2026-07-02T01:00:00Z",
    });
    db.close();

    db = openLedger(path);
    clock.advance("2026-08-01T00:00:00Z");
    const results = fireDueTimers(db, clock, { parkAfterMs: 172800000 });

    expect(results).toEqual([
      {
        timerId: "T-1:task_wake:2026-07-02T01:00:00Z",
        kind: "task_wake",
        subjectId: "T-1",
        applied: true,
      },
    ]);
    expect(getTask(db, "T-1")?.status).toBe("open");

    db.close();
    cleanupDbFile(path);
  });
});

// Legacy distillation/ambient timers drain as no-ops.
describe("legacy tick drain", () => {
  test("legacy distillation/ambient rows drain as fired no-ops", () => {
    const db = freshDb();
    const clock = fakeClock("2026-07-02T00:00:00Z");
    scheduleTimer(db, {
      id: "distillation:eng:old",
      kind: "distillation",
      identityId: "eng",
      subjectId: null,
      dueAt: "2026-07-01T00:00:00Z",
    });
    scheduleTimer(db, {
      id: "ambient_tick:eng:old",
      kind: "ambient_tick",
      identityId: "eng",
      subjectId: null,
      dueAt: "2026-07-01T00:00:00Z",
    });
    fireDueTimers(db, clock, { parkAfterMs: 172800000 });
    const pending = one<{ c: number }>(db, "SELECT count(*) c FROM timers WHERE fired_at IS NULL");
    expect(pending?.c).toBe(0); // drained, and nothing re-armed
  });
});

describe("msUntilNextTimer (M9 idle-efficient heartbeat)", () => {
  test("returns maxMs when there are no pending timers", () => {
    const db = freshDb();
    const clock = fakeClock("2026-07-02T00:00:00Z");
    expect(msUntilNextTimer(db, clock, 60000)).toBe(60000);
  });

  test("returns the ms until the soonest unfired timer, clamped to maxMs", () => {
    const db = freshDb();
    const clock = fakeClock("2026-07-02T00:00:00Z");
    scheduleTimer(db, {
      id: "t-eng",
      kind: "task_wake",
      identityId: "eng",
      subjectId: "T-1",
      dueAt: "2026-07-02T00:00:05Z",
    });
    scheduleTimer(db, {
      id: "t-sales",
      kind: "task_wake",
      identityId: "sales",
      subjectId: "T-2",
      dueAt: "2026-07-02T00:00:20Z",
    });
    expect(msUntilNextTimer(db, clock, 60000)).toBe(5000);
    expect(msUntilNextTimer(db, clock, 3000)).toBe(3000); // clamped
  });

  test("returns 0 for an already-overdue timer (fires immediately)", () => {
    const db = freshDb();
    const clock = fakeClock("2026-07-02T00:00:00Z");
    scheduleTimer(db, {
      id: "t-eng",
      kind: "task_wake",
      identityId: "eng",
      subjectId: "T-1",
      dueAt: "2026-07-02T00:00:05Z",
    });
    clock.advance("2026-07-02T01:00:00Z"); // way past due
    expect(msUntilNextTimer(db, clock, 60000)).toBe(0);
  });
});

describe("checkpointWal (M9)", () => {
  test("runs without error on an on-disk WAL database", () => {
    const path = tempDbPath("earshot-wal-test");
    const db = openLedger(path);
    db.query(
      "INSERT INTO events (id, dedup_key, kind, identity_id, received_at) VALUES ('e1','k1','observed_message','eng','2026-07-02T00:00:00Z')",
    ).run();
    expect(() => checkpointWal(db)).not.toThrow();
    db.close();
    cleanupDbFile(path);
  });
});
