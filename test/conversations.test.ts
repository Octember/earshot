import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { recordHold, recordWakeWhy, consumeJudgments, getConversationJudgment } from "../src/ledger/conversations";
import type { Clock } from "../src/ledger/clock";

// One room, one row (specs/2026-08-10-one-room-redesign.md, P1): ear judgment is durable state
// on the conversation's row, consumed by delivery in the same transaction that advances the
// watermark — never a discarded verdict (2026-08-10 live incident).

function freshDb() {
  return openLedger(":memory:");
}

function fakeClock(start = "2026-08-10T17:00:00Z"): Clock {
  return () => start;
}

describe("conversation judgment (one room, one row — P1)", () => {
  test("holds accumulate on the row with a bounded why-history, oldest dropped first", () => {
    const db = freshDb();
    const clock = fakeClock();
    for (const why of ["settled by kate", "still settled", "nothing for her", "resolved upstream", "humans have it"]) {
      recordHold(db, clock, "eng", "C1", "1.0", why);
    }
    const j = getConversationJudgment(db, "eng", "C1", "1.0")!;
    expect(j.holds).toBe(5);
    // Five holds, four whys kept: the count stays honest while the history stays bounded.
    expect(j.holdWhys).toEqual(["still settled", "nothing for her", "resolved upstream", "humans have it"]);
  });

  test("a top-level conversation (null thread root) and a thread with the same venue are separate rows", () => {
    const db = freshDb();
    const clock = fakeClock();
    recordHold(db, clock, "eng", "C1", null, "channel chatter");
    recordHold(db, clock, "eng", "C1", "1.0", "thread chatter");
    expect(getConversationJudgment(db, "eng", "C1", null)!.holds).toBe(1);
    expect(getConversationJudgment(db, "eng", "C1", "1.0")!.holds).toBe(1);
  });

  test("delivery consumes the judgment and advances the watermark in one step — messages cannot be taken without it", () => {
    const db = freshDb();
    const clock = fakeClock();
    recordHold(db, clock, "eng", "C1", "1.0", "settled by kate");
    recordWakeWhy(db, clock, "eng", "C1", "1.0", "noah is rejecting your assessment");

    const consumed = consumeJudgments(db, clock, "eng", [{ venueId: "C1", threadRootId: "1.0" }], 42);
    expect(consumed).toEqual([{ venueId: "C1", threadRootId: "1.0", holds: 1, holdWhys: ["settled by kate"], wakeWhy: "noah is rejecting your assessment" }]);

    // Consumed: the next delivery of this conversation starts from a clean judgment.
    const after = getConversationJudgment(db, "eng", "C1", "1.0")!;
    expect(after.holds).toBe(0);
    expect(after.holdWhys).toEqual([]);
    expect(after.wakeWhy).toBeNull();
    const row = db.query("SELECT delivered_rowid, judged_rowid FROM conversations WHERE venue_id = 'C1' AND thread_root_id = '1.0'").get() as {
      delivered_rowid: number;
      judged_rowid: number;
    };
    expect(row.delivered_rowid).toBe(42);
    expect(row.judged_rowid).toBe(42);
  });

  test("consuming a conversation with no recorded judgment yields a clean read, not an error", () => {
    const db = freshDb();
    const consumed = consumeJudgments(db, fakeClock(), "eng", [{ venueId: "C1", threadRootId: null }], 7);
    expect(consumed).toEqual([{ venueId: "C1", threadRootId: null, holds: 0, holdWhys: [], wakeWhy: null }]);
  });

  test("the schema forbids cursor skew: judged can never trail delivered", () => {
    const db = freshDb();
    recordHold(db, fakeClock(), "eng", "C1", "1.0", "x");
    expect(() => db.query("UPDATE conversations SET delivered_rowid = 10, judged_rowid = 5 WHERE venue_id = 'C1'").run()).toThrow();
  });
});
