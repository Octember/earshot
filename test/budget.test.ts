import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { createTask, transition } from "../src/ledger/tasks";
import { recordTurn } from "../src/ledger/turns";
import {
  identitySpendThisMonth,
  globalSpendThisMonth,
  taskSpend,
  budgetStatus,
  budgetHeadroomChecker,
} from "../src/policy/budget";
import type { Clock } from "../src/ledger/clock";

function freshDb() {
  return openLedger(":memory:");
}

function fakeClock(start = "2026-07-15T12:00:00Z"): Clock {
  return () => start;
}

function seedTask(db: ReturnType<typeof openLedger>, clock: Clock, id: string, identityId: string) {
  db.query(
    "INSERT INTO events (id, dedup_key, kind, identity_id, received_at) VALUES (?, ?, 'addressed_message', ?, ?)",
  ).run(`${id}-e`, `${id}-k`, identityId, clock());
  createTask(db, clock, {
    id,
    identityId,
    title: id,
    spec: "s",
    sponsorId: "U1",
    homeAnchor: { venueId: "C1", threadRootId: null },
    originEventId: `${id}-e`,
  });
}

function spendTurn(db: ReturnType<typeof openLedger>, id: string, identityId: string, amount: number, startedAt: string) {
  recordTurn(db, () => startedAt, {
    id,
    identityId,
    kind: "interactive",
    status: "succeeded",
    effects: [],
    spendAmount: amount,
    startedAt,
  });
}

describe("identitySpendThisMonth / globalSpendThisMonth (SPEC §10.3, calendar-month, timezone-aware)", () => {
  test("sums only turns within the current calendar month (UTC)", () => {
    const db = freshDb();
    spendTurn(db, "t1", "eng", 10, "2026-07-01T00:00:00Z");
    spendTurn(db, "t2", "eng", 20, "2026-07-15T00:00:00Z");
    spendTurn(db, "t3", "eng", 5, "2026-06-30T23:59:59Z"); // previous month
    spendTurn(db, "t4", "eng", 7, "2026-08-01T00:00:01Z"); // next month

    const clock = fakeClock("2026-07-20T00:00:00Z");
    expect(identitySpendThisMonth(db, clock, "eng", "UTC")).toBe(30);
  });

  test("sums across all identities for the global total", () => {
    const db = freshDb();
    spendTurn(db, "t1", "eng", 10, "2026-07-01T00:00:00Z");
    spendTurn(db, "t2", "sales", 20, "2026-07-02T00:00:00Z");

    const clock = fakeClock("2026-07-20T00:00:00Z");
    expect(globalSpendThisMonth(db, clock, "UTC")).toBe(30);
    expect(identitySpendThisMonth(db, clock, "eng", "UTC")).toBe(10);
  });

  test("month boundary respects the configured timezone, not UTC", () => {
    const db = freshDb();
    // 2026-07-01T02:00:00Z is still June 30th in America/Los_Angeles (UTC-7 in July, DST).
    spendTurn(db, "t1", "eng", 10, "2026-07-01T02:00:00Z");

    const clockJuly = fakeClock("2026-07-15T00:00:00Z");
    expect(identitySpendThisMonth(db, clockJuly, "eng", "America/Los_Angeles")).toBe(0);
    expect(identitySpendThisMonth(db, clockJuly, "eng", "UTC")).toBe(10);

    const clockJune = fakeClock("2026-06-15T00:00:00Z");
    expect(identitySpendThisMonth(db, clockJune, "eng", "America/Los_Angeles")).toBe(10);
  });
});

describe("taskSpend (SPEC §4.1.7 accumulated cost, §10.3 per_task_cap)", () => {
  test("sums spend across all of a task's executions and turns, lifetime (not month-scoped)", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedTask(db, clock, "T-1", "eng");
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
    recordTurn(db, clock, { id: "turn-1", identityId: "eng", kind: "execution_step", executionId: "x1", status: "succeeded", effects: [], spendAmount: 3, startedAt: clock() });
    transition(db, clock, "T-1", "waiting", { type: "yield_timer", wakeAt: "2026-08-01T00:00:00Z" });
    transition(db, clock, "T-1", "open", { type: "revive" });
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x2" });
    recordTurn(db, clock, { id: "turn-2", identityId: "eng", kind: "execution_step", executionId: "x2", status: "succeeded", effects: [], spendAmount: 4, startedAt: clock() });

    expect(taskSpend(db, "T-1")).toBe(7);
  });

  test("a task with no turns yet has zero spend", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedTask(db, clock, "T-1", "eng");
    expect(taskSpend(db, "T-1")).toBe(0);
  });
});

describe("budgetStatus + reserve carve-out (SPEC §10.3)", () => {
  const policy = {
    globalMonthlyCap: 100,
    reserve: 10,
    identityMonthlyCap: 50,
  };

  test("headroom is available below both caps", () => {
    const db = freshDb();
    spendTurn(db, "t1", "eng", 20, "2026-07-01T00:00:00Z");
    const clock = fakeClock();

    const status = budgetStatus(db, clock, { timezone: "UTC", identityMonthlyCap: 50, globalMonthlyCap: 100, reserve: 10 }, "eng");
    expect(status.hasHeadroom).toBe(true);
    expect(status.hasReserveHeadroom).toBe(true);
    expect(status.identitySpend).toBe(20);
  });

  test("no headroom once the identity's monthly cap is reached, even if global has room", () => {
    const db = freshDb();
    spendTurn(db, "t1", "eng", 50, "2026-07-01T00:00:00Z");
    const clock = fakeClock();

    const status = budgetStatus(db, clock, { timezone: "UTC", identityMonthlyCap: 50, globalMonthlyCap: 100, reserve: 10 }, "eng");
    expect(status.hasHeadroom).toBe(false);
  });

  test("no headroom once the global cap is reached, even if the identity has room", () => {
    const db = freshDb();
    spendTurn(db, "t1", "eng", 40, "2026-07-01T00:00:00Z");
    spendTurn(db, "t2", "sales", 60, "2026-07-01T00:00:00Z");
    const clock = fakeClock();

    const status = budgetStatus(db, clock, { timezone: "UTC", identityMonthlyCap: 50, globalMonthlyCap: 100, reserve: 10 }, "eng");
    expect(status.hasHeadroom).toBe(false);
  });

  test("reserve headroom survives past the cap for restricted interactive turns, until the reserve is also exhausted", () => {
    const db = freshDb();
    spendTurn(db, "t1", "eng", 55, "2026-07-01T00:00:00Z"); // 5 over the 50 cap, within the 10 reserve
    const clock = fakeClock();

    const status = budgetStatus(db, clock, { timezone: "UTC", identityMonthlyCap: 50, globalMonthlyCap: 100, reserve: 10 }, "eng");
    expect(status.hasHeadroom).toBe(false);
    expect(status.hasReserveHeadroom).toBe(true);

    spendTurn(db, "t2", "eng", 10, "2026-07-02T00:00:00Z"); // now 65, past cap(50)+reserve(10)=60
    const status2 = budgetStatus(db, clock, { timezone: "UTC", identityMonthlyCap: 50, globalMonthlyCap: 100, reserve: 10 }, "eng");
    expect(status2.hasReserveHeadroom).toBe(false);
  });
});

describe("budgetHeadroomChecker (wires into scheduler.dispatchRunnable's hasBudgetHeadroom hook)", () => {
  test("returns a predicate usable as dispatchRunnable's hasBudgetHeadroom option", () => {
    const db = freshDb();
    spendTurn(db, "t1", "eng", 999, "2026-07-01T00:00:00Z");
    const clock = fakeClock();

    const check = budgetHeadroomChecker(db, clock, { timezone: "UTC", globalMonthlyCap: 1000, reserve: 0, identityMonthlyCap: (id) => (id === "eng" ? 50 : 200) });
    expect(check("eng")).toBe(false);
    expect(check("sales")).toBe(true);
  });
});
