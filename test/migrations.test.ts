import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { many, one, openLedger } from "../src/ledger/db";
import { tempDbPath, cleanupDbFile } from "./helpers";

describe("schema migrations", () => {
  test("fresh db lands on current schema with consecutive_interruptions", () => {
    const db = openLedger(":memory:");
    const version = one<{ version: number }>(db, "SELECT version FROM schema_version")?.version;
    expect(version).toBe(15);

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
      "INSERT INTO turns (id, identity_id, kind, status, started_at) VALUES ('t-r', 'eng', 'resident', 'succeeded', '2026-07-13T00:00:00Z')",
    ).run();
  });

  test("openLedger migrates an on-disk v1 database all the way to the current version", () => {
    const path = tempDbPath("earshot-migration-test");
    const seed = new Database(path, { create: true });
    seed.run(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL,
        title TEXT NOT NULL,
        spec TEXT NOT NULL,
        status TEXT NOT NULL,
        waiting_on TEXT,
        sponsor_id TEXT NOT NULL,
        home_venue_id TEXT NOT NULL,
        home_thread_root_id TEXT,
        origin_event_id TEXT NOT NULL,
        wake_at TEXT,
        pending_confirmation TEXT,
        recurrence TEXT,
        artifacts TEXT NOT NULL DEFAULT '[]',
        terminal_report TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        opened_at TEXT NOT NULL
      );
      CREATE TABLE timers (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        identity_id TEXT NOT NULL,
        subject_id TEXT,
        due_at TEXT NOT NULL,
        fired_at TEXT
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        dedup_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        identity_id TEXT NOT NULL,
        venue_id TEXT,
        thread_root_id TEXT,
        principal_id TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        received_at TEXT NOT NULL
      );
      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL,
        content TEXT NOT NULL,
        provenance TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        superseded_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_confirmed_at TEXT NOT NULL
      );
      CREATE TABLE audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        identity_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );
    `);
    // pre-existing content for v7 FTS backfill
    seed
      .query(
        "INSERT INTO events (id, dedup_key, kind, identity_id, venue_id, payload, received_at) VALUES ('e1', 'k1', 'observed_message', 'eng', 'C1', ?, '2026-07-01T00:00:00Z')",
      )
      .run(JSON.stringify({ text: "the ancient export bug", ts: "1.0" }));
    seed
      .query(
        "INSERT INTO memory_items (id, identity_id, content, status, created_at, updated_at, last_confirmed_at) VALUES ('m1', 'eng', 'exports were flaky in june', 'active', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
      )
      .run();
    seed.query("INSERT INTO schema_version (version) VALUES (1)").run();
    seed
      .query(
        `INSERT INTO tasks (id, identity_id, title, spec, status, sponsor_id, home_venue_id, origin_event_id,
         created_at, updated_at, opened_at)
       VALUES ('T-1', 'eng', 't', 's', 'open', 'U1', 'C1', 'e1', '2026-07-02T00:00:00Z', '2026-07-02T00:00:00Z', '2026-07-02T00:00:00Z')`,
      )
      .run();
    seed.close();

    const db = openLedger(path);
    const version = one<{ version: number }>(db, "SELECT version FROM schema_version")?.version;
    expect(version).toBe(15);

    const task = one<{ id: string; consecutive_interruptions: number }>(
      db,
      "SELECT id, consecutive_interruptions FROM tasks WHERE id = 'T-1'",
    );
    expect(task?.id).toBe("T-1");
    expect(task?.consecutive_interruptions).toBe(0);

    const tables = many<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    // v13 dropped pre-overhaul state tables
    for (const dead of [
      "thread_participation",
      "conversation_threads",
      "resident_cursor",
      "ear_cursor",
    ]) {
      expect(tables.map((t) => t.name)).not.toContain(dead);
    }
    expect(tables.map((t) => t.name)).toContain("acts");
    expect(tables.map((t) => t.name)).toContain("drafts");
    const memCols = many<{ name: string }>(db, "PRAGMA table_info(memory_items)");
    expect(memCols.map((c) => c.name)).toContain("tier"); // v7 reached via the ladder
    // FTS backfill indexed pre-migration rows
    const oldEvent = one<{ c: number }>(
      db,
      "SELECT count(*) c FROM events_fts WHERE events_fts MATCH 'ancient'",
    );
    expect(oldEvent?.c).toBe(1);
    const oldMemory = one<{ c: number }>(
      db,
      "SELECT count(*) c FROM memory_fts WHERE memory_fts MATCH 'flaky'",
    );
    expect(oldMemory?.c).toBe(1);
    // v12: the conversations row seeded from pre-existing events, watermarked at the (v9-seeded)
    // global cursor so nothing re-delivers on upgrade.
    const convo = one<{ delivered_rowid: number; judged_rowid: number; holds: number }>(
      db,
      "SELECT delivered_rowid, judged_rowid, holds FROM conversations WHERE venue_id = 'C1' AND thread_root_id = ''",
    );
    expect(convo).not.toBeNull();
    expect(convo?.holds).toBe(0);

    db.close();
    cleanupDbFile(path);
  });

  // v5: stacked ambient/distillation timers → one pending tick per identity (earliest) + unique index.
  test("v5 dedupes stacked ambient/distillation ticks, keeps earliest", () => {
    const path = tempDbPath("earshot-migration-test");
    const seed = openLedger(path);
    seed.query("UPDATE schema_version SET version = 4").run();
    seed.query("DROP INDEX timers_singleton_pending").run();
    // Rebuild pre-v5 tables later migrations alter/drop.
    seed.run(`CREATE TABLE thread_participation (venue_id TEXT NOT NULL, thread_root_id TEXT NOT NULL, identity_id TEXT NOT NULL, first_at TEXT NOT NULL, PRIMARY KEY (venue_id, thread_root_id));
      CREATE TABLE conversation_threads (identity_id TEXT NOT NULL, venue_id TEXT NOT NULL, thread_root_id TEXT NOT NULL, codex_thread_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (identity_id, venue_id, thread_root_id));`);
    seed.query("DROP TABLE conversations").run();
    seed.query("DROP TABLE acts").run();
    seed.query("DROP TABLE drafts").run();
    // drop tier column and FTS floor so later migrations rebuild them
    seed.query("ALTER TABLE memory_items DROP COLUMN tier").run();
    seed.query("ALTER TABLE tasks DROP COLUMN tier").run();
    seed.run(
      "DROP TRIGGER events_fts_insert; DROP TRIGGER memory_fts_insert; DROP TABLE events_fts; DROP TABLE memory_fts",
    );
    const insert = seed.query(
      "INSERT INTO timers (id, kind, identity_id, subject_id, due_at, fired_at) VALUES (?, ?, ?, NULL, ?, ?)",
    );
    insert.run("ambient_tick:eng:a", "ambient_tick", "eng", "2026-07-04T01:10:00Z", null);
    insert.run("ambient_tick:eng:b", "ambient_tick", "eng", "2026-07-04T00:56:00Z", null); // earliest — survives
    insert.run("ambient_tick:eng:c", "ambient_tick", "eng", "2026-07-04T01:24:00Z", null);
    insert.run(
      "ambient_tick:eng:old",
      "ambient_tick",
      "eng",
      "2026-07-03T23:00:00Z",
      "2026-07-03T23:00:01Z",
    ); // fired — untouched
    insert.run("ambient_tick:sales:a", "ambient_tick", "sales", "2026-07-04T02:00:00Z", null); // other identity — survives
    insert.run("distillation:eng:a", "distillation", "eng", "2026-07-04T15:00:00Z", null);
    insert.run("distillation:eng:b", "distillation", "eng", "2026-07-04T16:00:00Z", null);
    seed.close();

    const db = openLedger(path);
    const pending = many<{ id: string }>(
      db,
      "SELECT id FROM timers WHERE fired_at IS NULL ORDER BY id",
    );
    expect(pending.map((r) => r.id)).toEqual([
      "ambient_tick:eng:b",
      "ambient_tick:sales:a",
      "distillation:eng:a",
    ]);
    const fired = one<{ c: number }>(
      db,
      "SELECT COUNT(*) c FROM timers WHERE fired_at IS NOT NULL",
    );
    expect(fired?.c).toBe(1);

    db.close();
    cleanupDbFile(path);
  });

  // Review finding #14/#21: a live DB that ran the SHIPPED v12 (whose conversations table
  // carries CHECK (judged_rowid >= delivered_rowid)) must migrate to v13 losing the CHECK —
  // the new code deliberately lets the ear's judged watermark trail delivery.
  test("v13 rebuilds conversations: drops judged>=delivered CHECK; imports stance", () => {
    const path = tempDbPath("earshot-migration-test");
    const seed = openLedger(path); // fresh v13 shape...
    seed.query("UPDATE schema_version SET version = 12").run();
    // rewound to shipped v12: conversations WITH CHECK, thread_participation present.
    seed.run(`DROP TABLE conversations; DROP TABLE acts; DROP TABLE drafts;
      DROP INDEX IF EXISTS events_conversation; DROP INDEX IF EXISTS events_root_ts;
      CREATE TABLE conversations (
        identity_id TEXT NOT NULL, venue_id TEXT NOT NULL, thread_root_id TEXT NOT NULL,
        first_at TEXT NOT NULL, delivered_rowid INTEGER NOT NULL DEFAULT 0,
        judged_rowid INTEGER NOT NULL DEFAULT 0, holds INTEGER NOT NULL DEFAULT 0,
        hold_whys TEXT NOT NULL DEFAULT '[]', wake_why TEXT,
        CHECK (judged_rowid >= delivered_rowid),
        PRIMARY KEY (identity_id, venue_id, thread_root_id));
      CREATE TABLE thread_participation (
        venue_id TEXT NOT NULL, thread_root_id TEXT NOT NULL, identity_id TEXT NOT NULL,
        first_at TEXT NOT NULL, stepped_back_at TEXT, stepped_back_why TEXT,
        PRIMARY KEY (venue_id, thread_root_id));`);
    seed
      .query(
        "INSERT INTO conversations (identity_id, venue_id, thread_root_id, first_at, delivered_rowid, judged_rowid, holds, hold_whys) VALUES ('eng','C1','1.0','2026-08-10T00:00:00Z', 5, 5, 2, '[\"settled\"]')",
      )
      .run();
    seed
      .query(
        "INSERT INTO thread_participation (venue_id, thread_root_id, identity_id, first_at, stepped_back_at, stepped_back_why) VALUES ('C1','1.0','eng','2026-08-10T00:00:00Z','2026-08-10T17:36:00Z','noah said stop')",
      )
      .run();
    seed.close();

    const db = openLedger(path);
    // Judgment survived rebuild; stance imported from participation.
    const row = one<{
      delivered_rowid: number;
      holds: number;
      stance: string;
      stance_why: string | null;
    }>(
      db,
      "SELECT delivered_rowid, holds, stance, stance_why FROM conversations WHERE venue_id='C1' AND thread_root_id='1.0'",
    );
    expect(row?.delivered_rowid).toBe(5);
    expect(row?.holds).toBe(2);
    expect(row?.stance).toBe("out");
    expect(row?.stance_why).toBe("noah said stop");
    // CHECK gone: judged may trail delivered.
    db.query("UPDATE conversations SET judged_rowid = 1 WHERE venue_id='C1'").run();
    db.close();
    cleanupDbFile(path);
  });

  // v15 / SPEC §6.1: "no dangling threads" as schema — a task cannot be written into
  // done/failed without a terminal report, whatever code path tries.
  test("v15: done/failed without terminal_report rejected by trigger", () => {
    const db = openLedger(":memory:");
    db.query(
      "INSERT INTO events (id, dedup_key, kind, identity_id, received_at) VALUES ('e1','k1','addressed_message','eng','2026-07-01T00:00:00Z')",
    ).run();
    db.query(
      `INSERT INTO tasks (id, identity_id, title, spec, status, sponsor_id, home_venue_id, origin_event_id, created_at, updated_at, opened_at)
       VALUES ('T-1','eng','t','s','open','U1','C1','e1','2026-07-01T00:00:00Z','2026-07-01T00:00:00Z','2026-07-01T00:00:00Z')`,
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
      "UPDATE tasks SET status = 'cancelled', terminal_report = NULL WHERE id = 'T-1'",
    ).run();
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
