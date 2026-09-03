import { describe, expect, test } from "bun:test";
import { one, openLedger } from "../src/ledger/db";
import {
  recordWakeWhy,
  wakeWhyOf,
  deliverConversation,
  engage,
  stepBack,
  stanceOf,
  pendingConversations,
  unjudgedConversations,
  hasUnjudged,
  drainOutStanceJudgments,
} from "../src/ledger/conversations";
import type { Clock } from "../src/ledger/clock";

// Conversation judgment + delivery watermark (P1).

function freshDb() {
  return openLedger(":memory:");
}

function fakeClock(start = "2026-08-10T17:00:00Z"): Clock {
  return () => start;
}

describe("conversation judgment (P1)", () => {
  test("top-level and thread conversations with same venue are separate rows", () => {
    const db = freshDb();
    const clock = fakeClock();
    recordWakeWhy(db, clock, "eng", "C1", null, "channel");
    recordWakeWhy(db, clock, "eng", "C1", "1.0", "thread");
    expect(wakeWhyOf(db, "eng", { venueId: "C1", threadRootId: null })).toBe("channel");
    expect(wakeWhyOf(db, "eng", { venueId: "C1", threadRootId: "1.0" })).toBe("thread");
  });

  test("delivery takes the wake why and advances the watermark", () => {
    const db = freshDb();
    const clock = fakeClock();
    const key = { venueId: "C1", threadRootId: "1.0" };
    recordWakeWhy(db, clock, "eng", "C1", "1.0", "noah is rejecting your assessment");
    expect(wakeWhyOf(db, "eng", key)).toBe("noah is rejecting your assessment");

    deliverConversation(db, clock, "eng", key, 42);
    expect(wakeWhyOf(db, "eng", key)).toBeNull();
    const row = one<{ delivered_rowid: number; judged_rowid: number }>(
      db,
      "SELECT delivered_rowid, judged_rowid FROM conversations WHERE venue_id = 'C1' AND thread_root_id = '1.0'",
    )!;
    expect(row.delivered_rowid).toBe(42);
    // judged is the EAR's watermark and may trail — delivery never drags it forward
    expect(row.judged_rowid).toBe(0);
  });

  test("delivery of an unknown conversation creates its row", () => {
    const db = freshDb();
    const key = { venueId: "C1", threadRootId: null };
    deliverConversation(db, fakeClock(), "eng", key, 7);
    expect(wakeWhyOf(db, "eng", key)).toBeNull();
    const row = one<{ delivered_rowid: number }>(
      db,
      "SELECT delivered_rowid FROM conversations WHERE venue_id = 'C1' AND thread_root_id = ''",
    )!;
    expect(row.delivered_rowid).toBe(7);
  });
});

describe("stance (SPEC §5.1 participation + step-back)", () => {
  test("an unknown conversation has stance 'none'; engaging records 'engaged'", () => {
    const db = freshDb();
    expect(stanceOf(db, "eng", "C1", "1.0").stance).toBe("none");
    engage(db, fakeClock(), "eng", "C1", "1.0");
    expect(stanceOf(db, "eng", "C1", "1.0").stance).toBe("engaged");
  });

  test("stepping out records when/why; mention or own post clears it", () => {
    const db = freshDb();
    engage(db, fakeClock(), "eng", "C1", "1.0");
    stepBack(db, fakeClock("2026-08-10T17:36:00Z"), "eng", "C1", "1.0", "the humans have it");
    expect(stanceOf(db, "eng", "C1", "1.0")).toEqual({
      stance: "out",
      why: "the humans have it",
      at: "2026-08-10T17:36:00Z",
    });
    engage(db, fakeClock("2026-08-10T18:00:00Z"), "eng", "C1", "1.0");
    expect(stanceOf(db, "eng", "C1", "1.0")).toEqual({
      stance: "engaged",
      why: null,
      at: "2026-08-10T18:00:00Z",
    });
  });

  test("stance is scoped to the conversation — venue and thread each their own row", () => {
    const db = freshDb();
    engage(db, fakeClock(), "eng", "C1", "1.0");
    expect(stanceOf(db, "eng", "C2", "1.0").stance).toBe("none");
    expect(stanceOf(db, "eng", "C1", null).stance).toBe("none");
  });
});

function insertEvent(
  db: ReturnType<typeof freshDb>,
  id: string,
  kind: string,
  venueId: string,
  threadRootId: string | null,
  text: string,
  addressMode?: string,
) {
  db.query(
    "INSERT INTO events (id, dedup_key, kind, identity_id, venue_id, thread_root_id, principal_id, payload, received_at) VALUES (?, ?, ?, 'eng', ?, ?, 'U1', ?, '2026-08-11T00:00:00Z')",
  ).run(
    id,
    `k-${id}`,
    kind,
    venueId,
    threadRootId,
    JSON.stringify({ text, ts: id, ...(addressMode ? { addressMode } : {}) }),
  );
}

describe("out-stance delivery exceptions", () => {
  test("external_signal delivers even into stepped-out conversation", () => {
    const db = freshDb();
    engage(db, fakeClock(), "eng", "C1", "1.0");
    stepBack(db, fakeClock(), "eng", "C1", "1.0", "the humans have it");
    insertEvent(db, "5.0", "observed_message", "C1", "1.0", "chatter she left behind");
    insertEvent(
      db,
      "6.0",
      "external_signal",
      "C1",
      "1.0",
      "[task update] finished. Worker's handoff: done",
    );
    const batch = pendingConversations(db, "eng");
    expect(batch).toHaveLength(1);
    // Her stance still holds the chatter; the report alone delivers (the renderer's tail
    // carries the surrounding room as context when it renders).
    expect(batch[0]!.messages.map((m) => m.payload.text)).toEqual([
      "[task update] finished. Worker's handoff: done",
    ]);
  });

  test("ear wake_why overrides out stance for that stretch", () => {
    const db = freshDb();
    stepBack(db, fakeClock(), "eng", "C1", "1.0", "the humans have it");
    insertEvent(db, "5.0", "observed_message", "C1", "1.0", "URGENT: prod is down in here");
    expect(pendingConversations(db, "eng")).toHaveLength(0); // her stance holds
    recordWakeWhy(db, fakeClock(), "eng", "C1", "1.0", "this looks like a real emergency");
    expect(pendingConversations(db, "eng")).toHaveLength(1); // the ear's escalation delivers it
  });

  test("direct address bypasses backlog row window into the batch", () => {
    const db = freshDb();
    stepBack(db, fakeClock(), "eng", "C1", "1.0", "muted");
    recordWakeWhy(db, fakeClock(), "eng", "C1", "1.0", "escalated"); // un-holds the 300-row backlog
    for (let i = 0; i < 300; i++)
      insertEvent(db, `10.${i}`, "observed_message", "C1", "1.0", `backlog ${i}`);
    insertEvent(db, "999.0", "addressed_message", "C2", null, "<@BOT1> are you there?", "mention");
    const batch = pendingConversations(db, "eng"); // default limit 200 — the mention is beyond it
    const mention = batch.find((c) => c.venueId === "C2");
    expect(mention).toBeDefined();
    expect(mention!.messages[0]!.payload.text).toContain("are you there?");
  });
});

describe("out-stance ear batch (§11)", () => {
  test("observed traffic in stepped-out thread skips unjudged batch", () => {
    const db = freshDb();
    stepBack(db, fakeClock(), "eng", "C1", "1.0", "the humans have it");
    insertEvent(db, "5.0", "observed_message", "C1", "1.0", "kate took it from here");
    expect(unjudgedConversations(db, "eng")).toHaveLength(0);
    expect(hasUnjudged(db, "eng")).toBe(false);
  });

  test("drainOutStanceJudgments advances judged for stepped-out chatter", () => {
    const db = freshDb();
    const clock = fakeClock();
    stepBack(db, clock, "eng", "C1", "1.0", "the humans have it");
    insertEvent(db, "5.0", "observed_message", "C1", "1.0", "more chatter");
    expect(drainOutStanceJudgments(db, clock, "eng")).toBe(1);
    expect(hasUnjudged(db, "eng")).toBe(false);
    const row = one<{ judged_rowid: number }>(
      db,
      "SELECT judged_rowid FROM conversations WHERE venue_id = 'C1' AND thread_root_id = '1.0'",
    )!;
    expect(row.judged_rowid).toBeGreaterThan(0);
  });

  test("direct mention in stepped-out thread still reaches unjudged batch", () => {
    const db = freshDb();
    stepBack(db, fakeClock(), "eng", "C1", "1.0", "muted");
    insertEvent(db, "9.0", "addressed_message", "C1", "1.0", "<@BOT1> back?", "mention");
    expect(unjudgedConversations(db, "eng")).toHaveLength(1);
    expect(unjudgedConversations(db, "eng")[0]!.messages[0]!.payload.text).toContain("back?");
  });
});
