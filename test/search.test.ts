import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { writeMemory, retractMemory, setMemoryTier, queryMemory } from "../src/ledger/memory";
import { searchArchive } from "../src/ledger/search";
import type { Clock } from "../src/ledger/clock";
import type { Database } from "bun:sqlite";

const clock: Clock = () => "2026-07-09T12:00:00Z";

let n = 0;
function seedEvent(db: Database, identityId: string, text: string, over: Partial<{ venueId: string; principalId: string; receivedAt: string; ts: string }> = {}): void {
  n++;
  db.query("INSERT INTO events (id, dedup_key, kind, identity_id, venue_id, thread_root_id, principal_id, payload, received_at) VALUES (?, ?, 'observed_message', ?, ?, NULL, ?, ?, ?)").run(
    `e${n}`,
    `k${n}`,
    identityId,
    over.venueId ?? "C1",
    over.principalId ?? "U1",
    JSON.stringify({ text, ts: over.ts ?? `${n}.0` }),
    over.receivedAt ?? clock(),
  );
}

// SPEC §8.7 — the searchable floor over events + memories, with receipts and isolation.
describe("searchArchive (SPEC §8.7)", () => {
  test("finds messages by content, hit carries venue/speaker/ts/time receipts", () => {
    const db = openLedger(":memory:");
    seedEvent(db, "eng", "the safari export bug is back", { venueId: "C9", principalId: "U7", ts: "1783.42" });
    seedEvent(db, "eng", "lunch orders in five minutes");

    const hits = searchArchive(db, "eng", { query: "safari export" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "message", venueId: "C9", principalId: "U7", ts: "1783.42", at: clock() });
    expect(hits[0]!.text).toContain("safari export bug");
  });

  test("finds memories in BOTH tiers; retracted memories never surface (§8.3)", () => {
    const db = openLedger(":memory:");
    writeMemory(db, clock, { id: "m1", identityId: "eng", content: "julia owns export QA" });
    const archived = writeMemory(db, clock, { id: "m2", identityId: "eng", content: "the old export pipeline used ffmpeg 4" });
    setMemoryTier(db, clock, archived.id, "archive");
    const dead = writeMemory(db, clock, { id: "m3", identityId: "eng", content: "export QA moved to fridays" });
    retractMemory(db, clock, { id: dead.id });

    const hits = searchArchive(db, "eng", { query: "export" });
    expect(hits.map((h) => h.memoryId).sort()).toEqual(["m1", "m2"]);
    expect(hits.find((h) => h.memoryId === "m2")!.tier).toBe("archive");
  });

  test("identity isolation is structural — another identity's rows are unreachable (§7.1)", () => {
    const db = openLedger(":memory:");
    seedEvent(db, "sales", "the export deal closed");
    writeMemory(db, clock, { id: "m1", identityId: "sales", content: "export deal owner is dana" });

    expect(searchArchive(db, "eng", { query: "export" })).toHaveLength(0);
  });

  test("venue/principal/time filters narrow messages; venue filter skips memories", () => {
    const db = openLedger(":memory:");
    seedEvent(db, "eng", "export slow in C1", { venueId: "C1", receivedAt: "2026-07-01T00:00:00Z" });
    seedEvent(db, "eng", "export slow in C2", { venueId: "C2", receivedAt: "2026-07-08T00:00:00Z" });
    seedEvent(db, "eng", "export slow again in C2", { venueId: "C2", principalId: "U9", receivedAt: "2026-07-09T00:00:00Z" });
    writeMemory(db, clock, { id: "m1", identityId: "eng", content: "export slowness is a known theme" });

    expect(searchArchive(db, "eng", { query: "export slow", venueId: "C2" })).toHaveLength(2);
    expect(searchArchive(db, "eng", { query: "export slow", venueId: "C2", principalId: "U9" })).toHaveLength(1);
    const timeboxed = searchArchive(db, "eng", { query: "export slow", after: "2026-07-07T00:00:00Z", before: "2026-07-08T12:00:00Z" });
    expect(timeboxed.filter((h) => h.kind === "message")).toHaveLength(1);
    expect(timeboxed.filter((h) => h.kind === "message")[0]!.venueId).toBe("C2");
    // no venue filter → the memory participates
    expect(searchArchive(db, "eng", { query: "export" }).some((h) => h.kind === "memory")).toBe(true);
  });

  test("FTS metacharacters degrade gracefully, and a too-strict query broadens instead of returning nothing", () => {
    const db = openLedger(":memory:");
    seedEvent(db, "eng", "the drag-and-drop upload fails on safari");

    // raw would blow up FTS5 syntax — must not throw
    expect(searchArchive(db, "eng", { query: 'drag-and-drop ("safari' }).length).toBeGreaterThan(0);
    // AND of all terms matches nothing; the OR fallback still finds the near miss
    expect(searchArchive(db, "eng", { query: "upload fails chrome" }).length).toBeGreaterThan(0);
  });

  test("results are ranked and capped by limit", () => {
    const db = openLedger(":memory:");
    for (let i = 0; i < 30; i++) seedEvent(db, "eng", `export note number ${i}`);
    expect(searchArchive(db, "eng", { query: "export", limit: 5 })).toHaveLength(5);
    expect(searchArchive(db, "eng", { query: "export" })).toHaveLength(10); // default
  });
});

// SPEC §8.6 — tiers on the memory ledger itself.
describe("memory tiers (SPEC §8.6)", () => {
  test("writes land in core by default; tier filter separates the two", () => {
    const db = openLedger(":memory:");
    writeMemory(db, clock, { id: "m1", identityId: "eng", content: "a core fact" });
    writeMemory(db, clock, { id: "m2", identityId: "eng", content: "an episodic detail", tier: "archive" });

    expect(queryMemory(db, "eng", { tier: "core" }).map((m) => m.id)).toEqual(["m1"]);
    expect(queryMemory(db, "eng", { tier: "archive" }).map((m) => m.id)).toEqual(["m2"]);
    expect(queryMemory(db, "eng")).toHaveLength(2); // no filter → both
  });

  test("setMemoryTier demotes without losing content, and is audit-logged", () => {
    const db = openLedger(":memory:");
    writeMemory(db, clock, { id: "m1", identityId: "eng", content: "sam prefers friday deploys" });
    const moved = setMemoryTier(db, clock, "m1", "archive");
    expect(moved.tier).toBe("archive");
    expect(moved.content).toBe("sam prefers friday deploys");
    const audit = db.query("SELECT * FROM audit WHERE kind = 'memory_tier_changed'").all();
    expect(audit).toHaveLength(1);
  });
});

// SPEC §8.6 — recent decays to archive (demotion, never deletion).
describe("recent-tier decay (SPEC §8.6)", () => {
  test("stale recent items demote to archive; fresh ones and core items are untouched", async () => {
    const { decayRecentToArchive } = await import("../src/ledger/memory");
    const db = openLedger(":memory:");
    const old: Clock = () => "2026-07-01T00:00:00Z";
    const now: Clock = () => "2026-07-09T00:00:00Z";
    writeMemory(db, old, { id: "stale", identityId: "eng", content: "overheard last week", tier: "recent" });
    writeMemory(db, now, { id: "fresh", identityId: "eng", content: "overheard today", tier: "recent" });
    writeMemory(db, old, { id: "durable", identityId: "eng", content: "an old core fact" });

    const demoted = decayRecentToArchive(db, now, "eng", 7 * 24 * 60 * 60 * 1000);
    expect(demoted).toEqual(["stale"]);
    expect(queryMemory(db, "eng", { tier: "archive" }).map((m) => m.id)).toEqual(["stale"]); // demoted, still searchable
    expect(queryMemory(db, "eng", { tier: "recent" }).map((m) => m.id)).toEqual(["fresh"]);
    expect(queryMemory(db, "eng", { tier: "core" }).map((m) => m.id)).toEqual(["durable"]);
  });
});
