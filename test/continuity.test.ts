import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { getConversationThread, setConversationThread, clearConversationThread } from "../src/ledger/continuity";
import type { Clock } from "../src/ledger/clock";

const clock: Clock = () => "2026-07-09T12:00:00Z";

// SPEC §5 continuity + thread-rot rotation input: the map counts turns run against each codex
// thread so callers can rotate BEFORE the runtime starts compacting away its oldest history
// (which is AGENTS.md, the soul — observed live: 147 same-day ambient turns → 13 compactions →
// de-souled posts).
describe("conversation-thread continuity (turn_count + clear)", () => {
  test("turn_count starts at 1 and increments while the same codex thread is resumed", () => {
    const db = openLedger(":memory:");
    setConversationThread(db, clock, "eng", "C1", "t1", "codex-a");
    expect(getConversationThread(db, "eng", "C1", "t1")).toEqual({ codexThreadId: "codex-a", turnCount: 1 });
    setConversationThread(db, clock, "eng", "C1", "t1", "codex-a");
    setConversationThread(db, clock, "eng", "C1", "t1", "codex-a");
    expect(getConversationThread(db, "eng", "C1", "t1")).toEqual({ codexThreadId: "codex-a", turnCount: 3 });
  });

  test("a NEW codex thread on the same anchor resets the count — rotation starts a fresh budget", () => {
    const db = openLedger(":memory:");
    setConversationThread(db, clock, "eng", "C1", "t1", "codex-a");
    setConversationThread(db, clock, "eng", "C1", "t1", "codex-a");
    setConversationThread(db, clock, "eng", "C1", "t1", "codex-b"); // rotated
    expect(getConversationThread(db, "eng", "C1", "t1")).toEqual({ codexThreadId: "codex-b", turnCount: 1 });
  });

  test("clearConversationThread drops the mapping so the next turn cold-starts", () => {
    const db = openLedger(":memory:");
    setConversationThread(db, clock, "eng", "C1", "t1", "codex-a");
    clearConversationThread(db, "eng", "C1", "t1");
    expect(getConversationThread(db, "eng", "C1", "t1")).toBeNull();
  });

  test("a null thread root (DM / top-level) normalizes consistently across set/get/clear", () => {
    const db = openLedger(":memory:");
    setConversationThread(db, clock, "eng", "D1", null, "codex-dm");
    expect(getConversationThread(db, "eng", "D1", null)?.codexThreadId).toBe("codex-dm");
    clearConversationThread(db, "eng", "D1", null);
    expect(getConversationThread(db, "eng", "D1", null)).toBeNull();
  });
});
