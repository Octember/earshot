import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { writeMemory, retractMemory, correctMemory, queryMemory, confirmMemory, decayStaleMemory } from "../src/ledger/memory";
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

describe("writeMemory (SPEC §8.1, §8.2 explicit write)", () => {
  test("writes an active item with provenance and audits it", () => {
    const db = freshDb();
    const clock = fakeClock();

    const item = writeMemory(db, clock, {
      id: "mem-1",
      identityId: "eng",
      content: "The on-call rotation is weekly, starting Mondays.",
      provenance: [{ eventId: "e1" }],
    });

    expect(item.status).toBe("active");
    expect(item.content).toBe("The on-call rotation is weekly, starting Mondays.");
    expect(item.provenance).toEqual([{ eventId: "e1" }]);
    expect(item.lastConfirmedAt).toBe("2026-07-02T00:00:00Z");

    const audit = db.query("SELECT kind FROM audit WHERE kind = 'memory_written'").all();
    expect(audit).toHaveLength(1);
  });

  test("provenance defaults to an empty array", () => {
    const db = freshDb();
    const clock = fakeClock();
    const item = writeMemory(db, clock, { id: "mem-1", identityId: "eng", content: "x" });
    expect(item.provenance).toEqual([]);
  });
});

describe("queryMemory (SPEC §8.4 inspection, §7.1 isolation)", () => {
  test("returns only active items for the given identity by default", () => {
    const db = freshDb();
    const clock = fakeClock();
    writeMemory(db, clock, { id: "mem-1", identityId: "eng", content: "a" });
    writeMemory(db, clock, { id: "mem-2", identityId: "eng", content: "b" });
    writeMemory(db, clock, { id: "mem-3", identityId: "sales", content: "c" });
    retractMemory(db, clock, { id: "mem-2" });

    const engItems = queryMemory(db, "eng");
    expect(engItems.map((i) => i.id)).toEqual(["mem-1"]);
  });

  test("cross-identity queries are structurally impossible — there is no argument to ask for another identity's memory except its own id", () => {
    const db = freshDb();
    const clock = fakeClock();
    writeMemory(db, clock, { id: "mem-1", identityId: "finance", content: "secret roadmap detail" });

    expect(queryMemory(db, "eng")).toEqual([]);
    expect(queryMemory(db, "finance").map((i) => i.content)).toEqual(["secret roadmap detail"]);
  });

  test("includeRetracted opts in to seeing retracted items (for audit/debugging), never the default", () => {
    const db = freshDb();
    const clock = fakeClock();
    writeMemory(db, clock, { id: "mem-1", identityId: "eng", content: "a" });
    retractMemory(db, clock, { id: "mem-1" });

    expect(queryMemory(db, "eng")).toEqual([]);
    expect(queryMemory(db, "eng", { includeRetracted: true }).map((i) => i.id)).toEqual(["mem-1"]);
  });
});

describe("retractMemory / correctMemory (SPEC §8.3 correction and retraction)", () => {
  test("retraction takes effect immediately — the item is gone from the next query", () => {
    const db = freshDb();
    const clock = fakeClock();
    writeMemory(db, clock, { id: "mem-1", identityId: "eng", content: "wrong fact" });

    retractMemory(db, clock, { id: "mem-1" });

    expect(queryMemory(db, "eng")).toEqual([]);
    const audit = db.query("SELECT kind FROM audit WHERE kind = 'memory_retracted'").all();
    expect(audit).toHaveLength(1);
  });

  test("correctMemory retracts the old item, supersededBy-linked to a newly written replacement", () => {
    const db = freshDb();
    const clock = fakeClock();
    writeMemory(db, clock, { id: "mem-1", identityId: "eng", content: "pricing changes next month" });

    const { retracted, created } = correctMemory(db, clock, {
      oldId: "mem-1",
      newId: "mem-2",
      newContent: "pricing changes were cancelled",
      provenance: [{ eventId: "e2" }],
    });

    expect(retracted.status).toBe("retracted");
    expect(retracted.supersededBy).toBe("mem-2");
    expect(created.content).toBe("pricing changes were cancelled");
    expect(queryMemory(db, "eng").map((i) => i.content)).toEqual(["pricing changes were cancelled"]);
  });
});

describe("confirmMemory (SPEC §8.3: fresh observation confirms existing memory)", () => {
  test("bumps last_confirmed_at without changing content", () => {
    const db = freshDb();
    const clock = fakeClock();
    writeMemory(db, clock, { id: "mem-1", identityId: "eng", content: "still true" });

    clock.advance("2026-08-01T00:00:00Z");
    const confirmed = confirmMemory(db, clock, "mem-1");

    expect(confirmed.content).toBe("still true");
    expect(confirmed.lastConfirmedAt).toBe("2026-08-01T00:00:00Z");
  });
});

describe("decayStaleMemory (SPEC §8.5 hygiene)", () => {
  test("retracts items whose last_confirmed_at is older than maxAgeMs", () => {
    const db = freshDb();
    const clock = fakeClock("2026-01-01T00:00:00Z");
    writeMemory(db, clock, { id: "old", identityId: "eng", content: "ancient fact" });

    clock.advance("2026-07-02T00:00:00Z");
    writeMemory(db, clock, { id: "fresh", identityId: "eng", content: "recent fact" });

    const result = decayStaleMemory(db, clock, "eng", { maxAgeMs: 30 * 24 * 60 * 60 * 1000 });

    expect(result.decayed).toEqual(["old"]);
    expect(queryMemory(db, "eng").map((i) => i.id)).toEqual(["fresh"]);
  });

  test("evicts the stalest items first when over the per-identity size cap", () => {
    const db = freshDb();
    const clock = fakeClock("2026-01-01T00:00:00Z");
    writeMemory(db, clock, { id: "m1", identityId: "eng", content: "1" });
    clock.advance("2026-01-02T00:00:00Z");
    writeMemory(db, clock, { id: "m2", identityId: "eng", content: "2" });
    clock.advance("2026-01-03T00:00:00Z");
    writeMemory(db, clock, { id: "m3", identityId: "eng", content: "3" });

    const result = decayStaleMemory(db, clock, "eng", { maxAgeMs: Infinity, maxItems: 2 });

    expect(result.decayed).toEqual(["m1"]);
    expect(queryMemory(db, "eng").map((i) => i.id).sort()).toEqual(["m2", "m3"]);
  });

  test("is scoped to one identity — never touches another identity's items", () => {
    const db = freshDb();
    const clock = fakeClock("2026-01-01T00:00:00Z");
    writeMemory(db, clock, { id: "eng-old", identityId: "eng", content: "x" });
    writeMemory(db, clock, { id: "sales-old", identityId: "sales", content: "y" });

    clock.advance("2026-07-02T00:00:00Z");
    decayStaleMemory(db, clock, "eng", { maxAgeMs: 30 * 24 * 60 * 60 * 1000 });

    expect(queryMemory(db, "sales")).toHaveLength(1);
  });
});
