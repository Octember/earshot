import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { recordTurn, getTurn } from "../src/ledger/turns";
import { createTask, transition } from "../src/ledger/tasks";
import type { Clock } from "../src/ledger/clock";

function freshDb() {
  return openLedger(":memory:");
}

function fakeClock(start = "2026-07-02T00:00:00Z"): Clock {
  return () => start;
}

function seedExecution(db: ReturnType<typeof openLedger>, clock: Clock, executionId: string) {
  db.query(
    "INSERT INTO events (id, dedup_key, kind, identity_id, received_at) VALUES ('e1', 'k1', 'addressed_message', 'eng', ?)",
  ).run(clock());
  createTask(db, clock, {
    id: "T-1",
    identityId: "eng",
    title: "t",
    spec: "s",
    sponsorId: "U1",
    homeAnchor: { venueId: "C1", threadRootId: null },
    originEventId: "e1",
  });
  transition(db, clock, "T-1", "active", { type: "dispatch", executionId });
}

describe("recordTurn (SPEC §4.1.6, §4.1.12)", () => {
  test("records a completed turn and both audit records", () => {
    const db = freshDb();
    const clock = fakeClock();

    const turn = recordTurn(db, clock, {
      id: "turn-1",
      identityId: "eng",
      kind: "interactive",
      status: "succeeded",
      effects: [{ kind: "task_created", taskId: "T-1" }],
      spendAmount: 0.05,
      startedAt: "2026-07-01T23:59:00Z",
    });

    expect(turn.id).toBe("turn-1");
    expect(turn.kind).toBe("interactive");
    expect(turn.status).toBe("succeeded");
    expect(turn.effects).toEqual([{ kind: "task_created", taskId: "T-1" }]);
    expect(turn.spendAmount).toBe(0.05);
    expect(turn.startedAt).toBe("2026-07-01T23:59:00Z");
    expect(turn.endedAt).toBe("2026-07-02T00:00:00Z");
    expect(turn.executionId).toBeNull();
    expect(turn.anchor).toBeNull();

    const kinds = db.query("SELECT kind FROM audit ORDER BY id").all() as any[];
    expect(kinds.map((k) => k.kind)).toEqual(["turn_started", "turn_ended"]);
  });

  test("records an execution_step turn with its anchor and execution id", () => {
    const db = freshDb();
    const clock = fakeClock();
    seedExecution(db, clock, "x1");

    const turn = recordTurn(db, clock, {
      id: "turn-2",
      identityId: "eng",
      kind: "execution_step",
      executionId: "x1",
      anchor: { venueId: "C1", threadRootId: "1719900000.000100" },
      status: "succeeded",
      effects: [],
      spendAmount: 0.12,
      startedAt: "2026-07-02T00:00:00Z",
    });

    expect(turn.executionId).toBe("x1");
    expect(turn.anchor).toEqual({ venueId: "C1", threadRootId: "1719900000.000100" });
  });

  test("getTurn returns null for an unknown id", () => {
    const db = freshDb();
    expect(getTurn(db, "nope")).toBeNull();
  });
});
