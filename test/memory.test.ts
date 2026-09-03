import { fakeClock } from "./helpers";
import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { writeMemory, retractMemory, queryMemory } from "../src/ledger/memory";

function freshDb() {
  return openLedger(":memory:");
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

  test("cross-identity memory queries are structurally impossible", () => {
    const db = freshDb();
    const clock = fakeClock();
    writeMemory(db, clock, {
      id: "mem-1",
      identityId: "finance",
      content: "secret roadmap detail",
    });

    expect(queryMemory(db, "eng")).toEqual([]);
    expect(queryMemory(db, "finance").map((i) => i.content)).toEqual(["secret roadmap detail"]);
  });

  test("includeRetracted opts in to retracted items; never the default", () => {
    const db = freshDb();
    const clock = fakeClock();
    writeMemory(db, clock, { id: "mem-1", identityId: "eng", content: "a" });
    retractMemory(db, clock, { id: "mem-1" });

    expect(queryMemory(db, "eng")).toEqual([]);
    expect(queryMemory(db, "eng", { includeRetracted: true }).map((i) => i.id)).toEqual(["mem-1"]);
  });
});

describe("retractMemory (SPEC §8.3 retraction)", () => {
  test("retraction takes effect immediately — the item is gone from the next query", () => {
    const db = freshDb();
    const clock = fakeClock();
    writeMemory(db, clock, { id: "mem-1", identityId: "eng", content: "wrong fact" });

    retractMemory(db, clock, { id: "mem-1" });

    expect(queryMemory(db, "eng")).toEqual([]);
    const audit = db.query("SELECT kind FROM audit WHERE kind = 'memory_retracted'").all();
    expect(audit).toHaveLength(1);
  });
});
