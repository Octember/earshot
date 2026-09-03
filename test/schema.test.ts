import { describe, expect, test } from "bun:test";
import { many, one, openLedger } from "../src/ledger/db";
import { tempDbPath, cleanupDbFile } from "./helpers";

describe("pinned schema", () => {
  test("fresh db lands on current schema with consecutive_interruptions", () => {
    const db = openLedger(":memory:");
    const version = one<{ version: number }>(db, "SELECT version FROM schema_version")?.version;
    expect(version).toBe(17);

    const columns = many<{ name: string }>(db, "PRAGMA table_info(tasks)");
    expect(columns.map((c) => c.name)).toContain("consecutive_interruptions");

    const tables = many<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    // v13: conversation row is the only conversation-state table
    for (const dead of [
      "thread_participation",
      "conversation_threads",
      "resident_cursor",
      "ear_cursor",
    ]) {
      expect(tables.map((t) => t.name)).not.toContain(dead);
    }
    expect(tables.map((t) => t.name)).toContain("conversations");
    expect(tables.map((t) => t.name)).toContain("acts");
    expect(tables.map((t) => t.name)).toContain("drafts");
    const memCols = many<{ name: string }>(db, "PRAGMA table_info(memory_items)");
    expect(memCols.map((c) => c.name)).toContain("tier"); // v7: memory tiers
    const vtabs = many<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table'");
    expect(vtabs.map((t) => t.name)).toContain("events_fts"); // v7: the searchable floor
    expect(vtabs.map((t) => t.name)).toContain("memory_fts");
    // v9: resident wakes are recordable turns
    db.query(
      "INSERT INTO turns (id, identity_id, kind, status, started_at, ended_at) VALUES ('t-r', 'eng', 'resident', 'succeeded', '2026-07-13T00:00:00Z', '2026-07-13T00:00:01Z')",
    ).run();
  });

  test("v15: done/failed without terminal_report rejected by trigger", () => {
    const db = openLedger(":memory:");
    db.query(
      "INSERT INTO events (id, dedup_key, kind, identity_id, venue_id, received_at) VALUES ('e1','k1','addressed_message','eng','C1','2026-07-01T00:00:00Z')",
    ).run();
    db.query(
      `INSERT INTO tasks (id, identity_id, title, spec, status, sponsor_id, home_venue_id, origin_event_id, created_at, updated_at, opened_at)
       VALUES ('T-1','eng','t','s','active','U1','C1','e1','2026-07-01T00:00:00Z','2026-07-01T00:00:00Z','2026-07-01T00:00:00Z')`,
    ).run();
    expect(() => db.query("UPDATE tasks SET status = 'done' WHERE id = 'T-1'").run()).toThrow(
      /terminal_report/,
    );
    expect(() =>
      db.query("UPDATE tasks SET status = 'failed', terminal_report = '  ' WHERE id = 'T-1'").run(),
    ).toThrow(/terminal_report/);
    db.query(
      "UPDATE tasks SET status = 'done', terminal_report = 'found it' WHERE id = 'T-1'",
    ).run(); // with a report it lands
    expect(one<{ status: string }>(db, "SELECT status FROM tasks WHERE id='T-1'")?.status).toBe(
      "done",
    );
    // cancelled exempt: report optional.
    db.query(
      `INSERT INTO tasks (id, identity_id, title, spec, status, sponsor_id, home_venue_id, origin_event_id, created_at, updated_at, opened_at)
       VALUES ('T-2','eng','t','s','active','U1','C1','e1','2026-07-01T00:00:00Z','2026-07-01T00:00:00Z','2026-07-01T00:00:00Z')`,
    ).run();
    db.query("UPDATE tasks SET status = 'cancelled' WHERE id = 'T-2'").run();
  });

  test("v17: the task state machine is a trigger; done tasks cannot move", () => {
    const db = openLedger(":memory:");
    db.query(
      "INSERT INTO events (id, dedup_key, kind, identity_id, venue_id, received_at) VALUES ('e1','k1','addressed_message','eng','C1','2026-07-01T00:00:00Z')",
    ).run();
    db.query(
      `INSERT INTO tasks (id, identity_id, title, spec, status, sponsor_id, home_venue_id, origin_event_id, created_at, updated_at, opened_at)
       VALUES ('T-1','eng','t','s','open','U1','C1','e1','2026-07-01T00:00:00Z','2026-07-01T00:00:00Z','2026-07-01T00:00:00Z')`,
    ).run();
    expect(() =>
      db.query("UPDATE tasks SET status = 'done', terminal_report = 'r' WHERE id = 'T-1'").run(),
    ).toThrow(/illegal task transition/);
    db.query("UPDATE tasks SET status = 'active' WHERE id = 'T-1'").run();
    expect(() => db.query("UPDATE tasks SET status = 'waiting' WHERE id = 'T-1'").run()).toThrow(
      /CHECK/,
    );
    db.query("UPDATE tasks SET status = 'done', terminal_report = 'r' WHERE id = 'T-1'").run();
    expect(() => db.query("UPDATE tasks SET status = 'open' WHERE id = 'T-1'").run()).toThrow(
      /illegal task transition/,
    );
  });

  test("a database newer than this build supports throws", () => {
    const path = tempDbPath("earshot-migration-test");
    const seed = openLedger(path);
    seed.query("UPDATE schema_version SET version = 999").run();
    seed.close();

    expect(() => openLedger(path)).toThrow();
    cleanupDbFile(path);
  });
});
