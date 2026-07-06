import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { createTask, transition } from "../src/ledger/tasks";
import { recordTurn } from "../src/ledger/turns";
import { runtimeSnapshot } from "../src/status";
import type { Clock } from "../src/ledger/clock";

function freshDb() {
  return openLedger(":memory:");
}
function fakeClock(iso = "2026-07-15T12:00:00Z"): Clock {
  return () => iso;
}

function seed(db: ReturnType<typeof openLedger>, clock: Clock, id: string, identityId: string) {
  db.query("INSERT INTO events (id, dedup_key, kind, identity_id, received_at) VALUES (?, ?, 'addressed_message', ?, ?)").run(`${id}-e`, `${id}-k`, identityId, clock());
  createTask(db, clock, { id, identityId, title: id, spec: "s", sponsorId: "U1", homeAnchor: { venueId: "C1", threadRootId: null }, originEventId: `${id}-e` });
}

describe("runtimeSnapshot (SPEC §15 operator status)", () => {
  test("reports per-identity open/running/waiting counts and spend this month", () => {
    const db = freshDb();
    const clock = fakeClock();
    seed(db, clock, "T-1", "eng");
    seed(db, clock, "T-2", "eng");
    transition(db, clock, "T-2", "active", { type: "dispatch", executionId: "x1" });
    recordTurn(db, clock, { id: "turn-1", identityId: "eng", kind: "execution_step", executionId: "x1", status: "succeeded", effects: [], spendAmount: 3.5, startedAt: clock() });
    seed(db, clock, "T-3", "sales");
    transition(db, clock, "T-3", "active", { type: "dispatch", executionId: "x2" });
    transition(db, clock, "T-3", "waiting", { type: "yield_human", nudgeDeadline: "2026-07-16T00:00:00Z" });

    const snap = runtimeSnapshot(db, clock, "UTC");

    const eng = snap.identities.find((i) => i.identityId === "eng")!;
    expect(eng.open).toBe(1); // T-1 open (T-2 is active, counted separately)
    expect(eng.running).toBe(1); // T-2's execution
    expect(eng.spendThisMonth).toBe(3.5);

    const sales = snap.identities.find((i) => i.identityId === "sales")!;
    expect(sales.waitingHuman).toBe(1); // T-3

    expect(snap.globalSpendThisMonth).toBe(3.5);
  });

  test("reports timers due now vs upcoming", () => {
    const db = freshDb();
    const clock = fakeClock("2026-07-15T12:00:00Z");
    seed(db, clock, "T-1", "eng");
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x1" });
    transition(db, clock, "T-1", "waiting", { type: "yield_timer", wakeAt: "2026-07-15T11:00:00Z" }); // already due
    seed(db, clock, "T-2", "eng");
    transition(db, clock, "T-2", "active", { type: "dispatch", executionId: "x2" });
    transition(db, clock, "T-2", "waiting", { type: "yield_timer", wakeAt: "2026-07-20T00:00:00Z" }); // future

    const snap = runtimeSnapshot(db, clock, "UTC");
    expect(snap.timersDue).toBe(1);
    expect(snap.timersPending).toBe(1);
  });

  test("an empty ledger yields an empty but well-formed snapshot", () => {
    const db = freshDb();
    const snap = runtimeSnapshot(db, fakeClock(), "UTC");
    expect(snap.identities).toEqual([]);
    expect(snap.globalSpendThisMonth).toBe(0);
    expect(snap.timersDue).toBe(0);
  });
});
