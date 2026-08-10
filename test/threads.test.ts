import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { recordThreadParticipation, isThreadParticipant, stepBackFromThread, steppedBackState } from "../src/ledger/threads";
import type { Clock } from "../src/ledger/clock";

function freshDb() {
  return openLedger(":memory:");
}

function fakeClock(start = "2026-07-02T00:00:00Z"): Clock {
  return () => start;
}

describe("thread participation (SPEC §5.1: posted or mentioned)", () => {
  test("a thread is not participated by default", () => {
    const db = freshDb();
    expect(isThreadParticipant(db, "C1", "1.0")).toBe(false);
  });

  test("recording participation makes it participated", () => {
    const db = freshDb();
    const clock = fakeClock();
    recordThreadParticipation(db, clock, "eng", "C1", "1.0");
    expect(isThreadParticipant(db, "C1", "1.0")).toBe(true);
  });

  test("is scoped to venue + thread — a different venue with the same thread id is not participated", () => {
    const db = freshDb();
    const clock = fakeClock();
    recordThreadParticipation(db, clock, "eng", "C1", "1.0");
    expect(isThreadParticipant(db, "C2", "1.0")).toBe(false);
  });

  test("recording the same thread twice is idempotent (first_at is not overwritten)", () => {
    const db = freshDb();
    const clock = fakeClock("2026-07-02T00:00:00Z");
    recordThreadParticipation(db, clock, "eng", "C1", "1.0");
    const clock2 = fakeClock("2026-08-01T00:00:00Z");
    recordThreadParticipation(db, clock2, "eng", "C1", "1.0");

    const row = db.query("SELECT first_at FROM thread_participation WHERE venue_id = 'C1' AND thread_root_id = '1.0'").get() as any;
    expect(row.first_at).toBe("2026-07-02T00:00:00Z");
  });
});

describe("step-back state (the ear design: her judgment to leave a conversation)", () => {
  test("an engaged thread has no stepped-back state; neither does an unknown one", () => {
    const db = freshDb();
    recordThreadParticipation(db, fakeClock(), "eng", "C1", "1.0");
    expect(steppedBackState(db, "C1", "1.0")).toBeNull();
    expect(steppedBackState(db, "C1", "9.9")).toBeNull();
  });

  test("stepping back records when and why", () => {
    const db = freshDb();
    recordThreadParticipation(db, fakeClock(), "eng", "C1", "1.0");
    stepBackFromThread(db, fakeClock("2026-07-02T01:00:00Z"), "C1", "1.0", "the humans have it");
    expect(steppedBackState(db, "C1", "1.0")).toEqual({ at: "2026-07-02T01:00:00Z", why: "the humans have it" });
  });

  test("re-recorded participation (a mention, or her own post) clears it", () => {
    const db = freshDb();
    recordThreadParticipation(db, fakeClock(), "eng", "C1", "1.0");
    stepBackFromThread(db, fakeClock("2026-07-02T01:00:00Z"), "C1", "1.0", "the humans have it");
    recordThreadParticipation(db, fakeClock("2026-07-02T02:00:00Z"), "eng", "C1", "1.0");
    expect(steppedBackState(db, "C1", "1.0")).toBeNull();
  });
});
