import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openLedger } from "../src/ledger/db";
import { tempDbPath, cleanupDbFile } from "./helpers";

describe("schema migrations", () => {
  test("fresh database lands on the current schema version with consecutive_interruptions present", () => {
    const db = openLedger(":memory:");
    const version = (db.query("SELECT version FROM schema_version").get() as { version: number }).version;
    expect(version).toBe(4);

    const columns = db.query("PRAGMA table_info(tasks)").all() as any[];
    expect(columns.map((c) => c.name)).toContain("consecutive_interruptions");

    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[];
    expect(tables.map((t) => t.name)).toContain("thread_participation");
    expect(tables.map((t) => t.name)).toContain("conversation_threads"); // v4: interactive continuity
  });

  test("openLedger migrates an on-disk v1 database all the way to the current version", () => {
    const path = tempDbPath("tag-migration-test");
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
    `);
    seed.query("INSERT INTO schema_version (version) VALUES (1)").run();
    seed.query(
      `INSERT INTO tasks (id, identity_id, title, spec, status, sponsor_id, home_venue_id, origin_event_id,
         created_at, updated_at, opened_at)
       VALUES ('T-1', 'eng', 't', 's', 'open', 'U1', 'C1', 'e1', '2026-07-02T00:00:00Z', '2026-07-02T00:00:00Z', '2026-07-02T00:00:00Z')`,
    ).run();
    seed.close();

    const db = openLedger(path);
    const version = (db.query("SELECT version FROM schema_version").get() as { version: number }).version;
    expect(version).toBe(4);

    const task = db.query("SELECT id, consecutive_interruptions FROM tasks WHERE id = 'T-1'").get() as any;
    expect(task.id).toBe("T-1");
    expect(task.consecutive_interruptions).toBe(0);

    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[];
    expect(tables.map((t) => t.name)).toContain("thread_participation");
    expect(tables.map((t) => t.name)).toContain("conversation_threads"); // v4 reached via the ladder

    db.close();
    cleanupDbFile(path);
  });

  test("a database newer than this build supports throws", () => {
    const path = tempDbPath("tag-migration-test");
    const seed = openLedger(path);
    seed.query("UPDATE schema_version SET version = 999").run();
    seed.close();

    expect(() => openLedger(path)).toThrow();
    cleanupDbFile(path);
  });
});
