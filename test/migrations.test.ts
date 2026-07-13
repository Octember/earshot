import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openLedger } from "../src/ledger/db";
import { tempDbPath, cleanupDbFile } from "./helpers";

describe("schema migrations", () => {
  test("fresh database lands on the current schema version with consecutive_interruptions present", () => {
    const db = openLedger(":memory:");
    const version = (db.query("SELECT version FROM schema_version").get() as { version: number }).version;
    expect(version).toBe(11);

    const columns = db.query("PRAGMA table_info(tasks)").all() as any[];
    expect(columns.map((c) => c.name)).toContain("consecutive_interruptions");

    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[];
    expect(tables.map((t) => t.name)).toContain("thread_participation");
    expect(tables.map((t) => t.name)).toContain("conversation_threads"); // v4: interactive continuity
    const ctCols = db.query("PRAGMA table_info(conversation_threads)").all() as any[];
    expect(ctCols.map((c) => c.name)).toContain("turn_count"); // v6: thread-rot rotation input
    const memCols = db.query("PRAGMA table_info(memory_items)").all() as any[];
    expect(memCols.map((c) => c.name)).toContain("tier"); // v7: memory tiers
    const vtabs = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[];
    expect(vtabs.map((t) => t.name)).toContain("events_fts"); // v7: the searchable floor
    expect(vtabs.map((t) => t.name)).toContain("memory_fts");
    expect(vtabs.map((t) => t.name)).toContain("resident_cursor"); // v9: the Collapse's inbox cursor
    // v9: resident wakes are recordable turns
    db.query("INSERT INTO turns (id, identity_id, kind, status, started_at) VALUES ('t-r', 'eng', 'resident', 'succeeded', '2026-07-13T00:00:00Z')").run();
  });

  test("openLedger migrates an on-disk v1 database all the way to the current version", () => {
    const path = tempDbPath("earshot-migration-test");
    const seed = new Database(path, { create: true });
    seed.exec(`
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
    // pre-existing content that v7's FTS backfill must index
    seed.query("INSERT INTO events (id, dedup_key, kind, identity_id, venue_id, payload, received_at) VALUES ('e1', 'k1', 'observed_message', 'eng', 'C1', ?, '2026-07-01T00:00:00Z')").run(JSON.stringify({ text: "the ancient export bug", ts: "1.0" }));
    seed.query("INSERT INTO memory_items (id, identity_id, content, status, created_at, updated_at, last_confirmed_at) VALUES ('m1', 'eng', 'exports were flaky in june', 'active', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')").run();
    seed.query("INSERT INTO schema_version (version) VALUES (1)").run();
    seed.query(
      `INSERT INTO tasks (id, identity_id, title, spec, status, sponsor_id, home_venue_id, origin_event_id,
         created_at, updated_at, opened_at)
       VALUES ('T-1', 'eng', 't', 's', 'open', 'U1', 'C1', 'e1', '2026-07-02T00:00:00Z', '2026-07-02T00:00:00Z', '2026-07-02T00:00:00Z')`,
    ).run();
    seed.close();

    const db = openLedger(path);
    const version = (db.query("SELECT version FROM schema_version").get() as { version: number }).version;
    expect(version).toBe(11);

    const task = db.query("SELECT id, consecutive_interruptions FROM tasks WHERE id = 'T-1'").get() as any;
    expect(task.id).toBe("T-1");
    expect(task.consecutive_interruptions).toBe(0);

    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[];
    expect(tables.map((t) => t.name)).toContain("thread_participation");
    expect(tables.map((t) => t.name)).toContain("conversation_threads"); // v4 reached via the ladder
    const ctCols = db.query("PRAGMA table_info(conversation_threads)").all() as any[];
    expect(ctCols.map((c) => c.name)).toContain("turn_count"); // v6 reached via the ladder
    const memCols = db.query("PRAGMA table_info(memory_items)").all() as any[];
    expect(memCols.map((c) => c.name)).toContain("tier"); // v7 reached via the ladder
    // the FTS backfill indexed rows that existed before the migration
    const oldEvent = db.query("SELECT count(*) c FROM events_fts WHERE events_fts MATCH 'ancient'").get() as any;
    expect(oldEvent.c).toBe(1);
    const oldMemory = db.query("SELECT count(*) c FROM memory_fts WHERE memory_fts MATCH 'flaky'").get() as any;
    expect(oldMemory.c).toBe(1);

    db.close();
    cleanupDbFile(path);
  });

  // v5: a restart-stacked timers table (N parallel ambient/distillation chains, SPEC §9.1's "A
  // durable ambient tick per identity" violated) collapses to one pending tick per identity —
  // the earliest — and the unique index prevents restacking.
  test("v5 dedupes stacked pending ambient/distillation ticks, keeping the earliest", () => {
    const path = tempDbPath("earshot-migration-test");
    const seed = openLedger(path);
    seed.query("UPDATE schema_version SET version = 4").run();
    seed.query("DROP INDEX timers_singleton_pending").run();
    seed.query("ALTER TABLE conversation_threads DROP COLUMN turn_count").run(); // v6 hasn't happened yet
    // ...and v7 hasn't either: drop the tier column and the FTS floor so the ladder rebuilds them
    seed.query("ALTER TABLE memory_items DROP COLUMN tier").run();
    seed.query("ALTER TABLE tasks DROP COLUMN tier").run(); // v10 hasn't happened yet either
    seed.query("ALTER TABLE thread_participation DROP COLUMN stepped_back_at").run(); // v11 hasn't either
    seed.query("ALTER TABLE thread_participation DROP COLUMN stepped_back_why").run();
    seed.exec("DROP TRIGGER events_fts_insert; DROP TRIGGER memory_fts_insert; DROP TABLE events_fts; DROP TABLE memory_fts");
    const insert = seed.query("INSERT INTO timers (id, kind, identity_id, subject_id, due_at, fired_at) VALUES (?, ?, ?, NULL, ?, ?)");
    insert.run("ambient_tick:eng:a", "ambient_tick", "eng", "2026-07-04T01:10:00Z", null);
    insert.run("ambient_tick:eng:b", "ambient_tick", "eng", "2026-07-04T00:56:00Z", null); // earliest — survives
    insert.run("ambient_tick:eng:c", "ambient_tick", "eng", "2026-07-04T01:24:00Z", null);
    insert.run("ambient_tick:eng:old", "ambient_tick", "eng", "2026-07-03T23:00:00Z", "2026-07-03T23:00:01Z"); // fired — untouched
    insert.run("ambient_tick:sales:a", "ambient_tick", "sales", "2026-07-04T02:00:00Z", null); // other identity — survives
    insert.run("distillation:eng:a", "distillation", "eng", "2026-07-04T15:00:00Z", null);
    insert.run("distillation:eng:b", "distillation", "eng", "2026-07-04T16:00:00Z", null);
    seed.close();

    const db = openLedger(path);
    const pending = db.query("SELECT id FROM timers WHERE fired_at IS NULL ORDER BY id").all() as any[];
    expect(pending.map((r) => r.id)).toEqual(["ambient_tick:eng:b", "ambient_tick:sales:a", "distillation:eng:a"]);
    const fired = db.query("SELECT COUNT(*) c FROM timers WHERE fired_at IS NOT NULL").get() as any;
    expect(fired.c).toBe(1);

    db.close();
    cleanupDbFile(path);
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
