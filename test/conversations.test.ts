import { describe, expect, test } from "bun:test";
import { one, openLedger } from "../src/ledger/db";
import { recordHold, recordWakeWhy, consumeJudgment, getConversationJudgment, engage, stepBack, stanceOf, pendingConversations } from "../src/ledger/conversations";
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

    const consumed = consumeJudgment(db, clock, "eng", { venueId: "C1", threadRootId: "1.0" }, 42);
    expect(consumed).toEqual({ venueId: "C1", threadRootId: "1.0", holds: 1, holdWhys: ["settled by kate"], wakeWhy: "noah is rejecting your assessment" });

    // Consumed: the next delivery of this conversation starts from a clean judgment.
    const after = getConversationJudgment(db, "eng", "C1", "1.0")!;
    expect(after.holds).toBe(0);
    expect(after.holdWhys).toEqual([]);
    expect(after.wakeWhy).toBeNull();
    const row = one<{ delivered_rowid: number; judged_rowid: number }>(
      db,
      "SELECT delivered_rowid, judged_rowid FROM conversations WHERE venue_id = 'C1' AND thread_root_id = '1.0'",
    )!;
    expect(row.delivered_rowid).toBe(42);
    // judged is the EAR's watermark and may trail — delivery never drags it forward
    expect(row.judged_rowid).toBe(0);
  });

  test("consuming a conversation with no recorded judgment yields a clean read, not an error", () => {
    const db = freshDb();
    const consumed = consumeJudgment(db, fakeClock(), "eng", { venueId: "C1", threadRootId: null }, 7);
    expect(consumed).toEqual({ venueId: "C1", threadRootId: null, holds: 0, holdWhys: [], wakeWhy: null });
  });

});

describe("stance (SPEC §5.1 participation + the ear design's step-back, absorbed)", () => {
  test("an unknown conversation has stance 'none'; engaging records 'engaged'", () => {
    const db = freshDb();
    expect(stanceOf(db, "eng", "C1", "1.0").stance).toBe("none");
    engage(db, fakeClock(), "eng", "C1", "1.0");
    expect(stanceOf(db, "eng", "C1", "1.0").stance).toBe("engaged");
  });

  test("stepping out records when and why; re-engaging (a mention, or her own post) clears it", () => {
    const db = freshDb();
    engage(db, fakeClock(), "eng", "C1", "1.0");
    stepBack(db, fakeClock("2026-08-10T17:36:00Z"), "eng", "C1", "1.0", "the humans have it");
    expect(stanceOf(db, "eng", "C1", "1.0")).toEqual({ stance: "out", why: "the humans have it", at: "2026-08-10T17:36:00Z" });
    engage(db, fakeClock("2026-08-10T18:00:00Z"), "eng", "C1", "1.0");
    expect(stanceOf(db, "eng", "C1", "1.0")).toEqual({ stance: "engaged", why: null, at: "2026-08-10T18:00:00Z" });
  });

  test("stance is scoped to the conversation — venue and thread each their own row", () => {
    const db = freshDb();
    engage(db, fakeClock(), "eng", "C1", "1.0");
    expect(stanceOf(db, "eng", "C2", "1.0").stance).toBe("none");
    expect(stanceOf(db, "eng", "C1", null).stance).toBe("none");
  });
});

function insertEvent(db: ReturnType<typeof freshDb>, id: string, kind: string, venueId: string, threadRootId: string | null, text: string, addressMode?: string) {
  db.query("INSERT INTO events (id, dedup_key, kind, identity_id, venue_id, thread_root_id, principal_id, payload, received_at) VALUES (?, ?, ?, 'eng', ?, ?, 'U1', ?, '2026-08-11T00:00:00Z')").run(
    id, `k-${id}`, kind, venueId, threadRootId, JSON.stringify({ text, ts: id, ...(addressMode ? { addressMode } : {}) }),
  );
}

describe("out-stance delivery exceptions (review findings, 2026-08-11)", () => {

  test("a worker's external_signal report delivers even into a stepped-out conversation — a terminal report can never be swallowed", () => {
    const db = freshDb();
    engage(db, fakeClock(), "eng", "C1", "1.0");
    stepBack(db, fakeClock(), "eng", "C1", "1.0", "the humans have it");
    insertEvent(db, "5.0", "observed_message", "C1", "1.0", "chatter she left behind");
    insertEvent(db, "6.0", "external_signal", "C1", "1.0", "[task update] finished. Worker's handoff: done");
    const batch = pendingConversations(db, "eng");
    expect(batch).toHaveLength(1);
    // Her stance still holds the chatter; the report alone delivers (the renderer's tail
    // carries the surrounding room as context when it renders).
    expect(batch[0]!.messages.map((m) => m.text)).toEqual(["[task update] finished. Worker's handoff: done"]);
  });

  test("an ear wake verdict (wake_why) overrides an out stance for that stretch — the ear can escalate a room she left", () => {
    const db = freshDb();
    stepBack(db, fakeClock(), "eng", "C1", "1.0", "the humans have it");
    insertEvent(db, "5.0", "observed_message", "C1", "1.0", "URGENT: prod is down in here");
    expect(pendingConversations(db, "eng")).toHaveLength(0); // her stance holds
    recordWakeWhy(db, fakeClock(), "eng", "C1", "1.0", "this looks like a real emergency");
    expect(pendingConversations(db, "eng")).toHaveLength(1); // the ear's escalation delivers it
  });

  test("a direct address never waits behind a backlog — it rides the batch past the row window", () => {
    const db = freshDb();
    stepBack(db, fakeClock(), "eng", "C1", "1.0", "muted");
    recordWakeWhy(db, fakeClock(), "eng", "C1", "1.0", "escalated"); // un-holds the 300-row backlog
    for (let i = 0; i < 300; i++) insertEvent(db, `10.${i}`, "observed_message", "C1", "1.0", `backlog ${i}`);
    insertEvent(db, "999.0", "addressed_message", "C2", null, "<@BOT1> are you there?", "mention");
    const batch = pendingConversations(db, "eng"); // default limit 200 — the mention is beyond it
    const mention = batch.find((c) => c.venueId === "C2");
    expect(mention).toBeDefined();
    expect(mention!.messages[0]!.text).toContain("are you there?");
  });
});
