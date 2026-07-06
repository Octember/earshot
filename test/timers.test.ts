import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { createTask, transition } from "../src/ledger/tasks";
import { scheduleTimer, listDueTimers, markTimerFired } from "../src/ledger/timers";
import type { Clock } from "../src/ledger/clock";

function freshDb() {
  return openLedger(":memory:");
}

function fakeClock(start = "2026-07-02T00:00:00Z"): Clock & { advance: (iso: string) => void } {
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

describe("timers table mechanics (SPEC §13)", () => {
  test("listDueTimers returns only unfired timers at or before now, in due_at order", () => {
    const db = freshDb();
    const clock = fakeClock();
    // distinct identities: pending ambient ticks are singletons per identity (§9.1)
    scheduleTimer(db, { id: "t1", kind: "ambient_tick", identityId: "eng", dueAt: "2026-07-02T00:00:00Z" });
    scheduleTimer(db, { id: "t2", kind: "ambient_tick", identityId: "sales", dueAt: "2026-07-01T12:00:00Z" });
    scheduleTimer(db, { id: "t3", kind: "ambient_tick", identityId: "ops", dueAt: "2026-07-03T00:00:00Z" });

    const due = listDueTimers(db, clock);
    expect(due.map((t) => t.id)).toEqual(["t2", "t1"]);
  });

  test("marking a timer fired removes it from future due scans", () => {
    const db = freshDb();
    const clock = fakeClock();
    scheduleTimer(db, { id: "t1", kind: "ambient_tick", identityId: "eng", dueAt: "2026-07-02T00:00:00Z" });

    markTimerFired(db, clock, "t1");

    expect(listDueTimers(db, clock)).toHaveLength(0);
  });

  test("scheduling the same timer id twice is idempotent (no throw, single row)", () => {
    const db = freshDb();
    scheduleTimer(db, { id: "t1", kind: "ambient_tick", identityId: "eng", dueAt: "2026-07-02T00:00:00Z" });
    expect(() =>
      scheduleTimer(db, { id: "t1", kind: "ambient_tick", identityId: "eng", dueAt: "2026-07-02T00:00:00Z" }),
    ).not.toThrow();

    const rows = db.query("SELECT COUNT(*) as c FROM timers WHERE id = 't1'").get() as any;
    expect(rows.c).toBe(1);
  });

  test("overdue-on-restart: timers well past due still fire, in due-time order", () => {
    const db = freshDb();
    const clock = fakeClock("2026-07-10T00:00:00Z");
    scheduleTimer(db, { id: "old1", kind: "ambient_tick", identityId: "eng", dueAt: "2026-07-01T00:00:00Z" });
    scheduleTimer(db, { id: "old2", kind: "ambient_tick", identityId: "sales", dueAt: "2026-07-03T00:00:00Z" });

    const due = listDueTimers(db, clock);
    expect(due.map((t) => t.id)).toEqual(["old1", "old2"]);
  });
});

describe("transition() schedules the matching durable timer (SPEC §13, §6.1)", () => {
  function activeTask(db: ReturnType<typeof openLedger>, clock: Clock) {
    seedEvent(db, "e1", clock);
    createTask(db, clock, {
      id: "T-1",
      identityId: "eng",
      title: "t",
      spec: "s",
      sponsorId: "U1",
      homeAnchor: { venueId: "C1", threadRootId: null },
      originEventId: "e1",
    });
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
  }

  test("yield_human schedules a nudge timer at the nudge deadline", () => {
    const db = freshDb();
    const clock = fakeClock();
    activeTask(db, clock);

    transition(db, clock, "T-1", "waiting", {
      type: "yield_human",
      nudgeDeadline: "2026-07-02T01:00:00Z",
    });

    const rows = db.query("SELECT kind, subject_id, due_at FROM timers WHERE subject_id = 'T-1'").all() as any[];
    expect(rows).toEqual([{ kind: "nudge", subject_id: "T-1", due_at: "2026-07-02T01:00:00Z" }]);
  });

  test("nudge_sent schedules a park timer at the park deadline", () => {
    const db = freshDb();
    const clock = fakeClock();
    activeTask(db, clock);
    transition(db, clock, "T-1", "waiting", {
      type: "yield_human",
      nudgeDeadline: "2026-07-02T01:00:00Z",
    });

    transition(db, clock, "T-1", "waiting", {
      type: "nudge_sent",
      parkDeadline: "2026-07-04T01:00:00Z",
    });

    const rows = db.query("SELECT kind, due_at FROM timers WHERE subject_id = 'T-1' AND kind = 'park'").all() as any[];
    expect(rows).toEqual([{ kind: "park", due_at: "2026-07-04T01:00:00Z" }]);
  });

  test("yield_timer schedules a task_wake timer at wake_at", () => {
    const db = freshDb();
    const clock = fakeClock();
    activeTask(db, clock);

    transition(db, clock, "T-1", "waiting", { type: "yield_timer", wakeAt: "2026-07-05T00:00:00Z" });

    const rows = db
      .query("SELECT kind, due_at FROM timers WHERE subject_id = 'T-1' AND kind = 'task_wake'")
      .all() as any[];
    expect(rows).toEqual([{ kind: "task_wake", due_at: "2026-07-05T00:00:00Z" }]);
  });

  test("recurrence_rearm schedules a task_wake timer for the next occurrence", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedEvent(db, "e1", clock);
    createTask(db, clock, {
      id: "T-1",
      identityId: "eng",
      title: "t",
      spec: "s",
      sponsorId: "U1",
      homeAnchor: { venueId: "C1", threadRootId: null },
      originEventId: "e1",
      recurrence: "weekly",
      sponsorIsOperator: true,
    });
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });

    transition(db, clock, "T-1", "waiting", {
      type: "recurrence_rearm",
      wakeAt: "2026-07-09T00:00:00Z",
    });

    const rows = db
      .query("SELECT kind, due_at FROM timers WHERE subject_id = 'T-1' AND kind = 'task_wake'")
      .all() as any[];
    expect(rows).toEqual([{ kind: "task_wake", due_at: "2026-07-09T00:00:00Z" }]);
  });
});
