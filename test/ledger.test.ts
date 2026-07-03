import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";

function freshDb() {
  return openLedger(":memory:");
}

describe("ledger schema", () => {
  test("opens and applies schema", () => {
    const db = freshDb();
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    for (const t of ["events", "tasks", "executions", "steering", "turns", "memory_items", "timers", "audit"]) {
      expect(tables).toContain(t);
    }
  });

  test("event dedup: same dedup_key cannot insert twice (SPEC §12.2)", () => {
    const db = freshDb();
    const insert = db.query(
      "INSERT INTO events (id, dedup_key, kind, identity_id, received_at) VALUES (?, ?, 'addressed_message', 'eng', ?)",
    );
    insert.run("e1", "slack:C1:1719900000.000100", "2026-07-02T00:00:00Z");
    expect(() => insert.run("e2", "slack:C1:1719900000.000100", "2026-07-02T00:00:01Z")).toThrow();
  });

  test("at most one live execution per task (SPEC §6.2)", () => {
    const db = freshDb();
    db.query(
      "INSERT INTO events (id, dedup_key, kind, identity_id, received_at) VALUES ('e1', 'k1', 'addressed_message', 'eng', '2026-07-02T00:00:00Z')",
    ).run();
    db.query(
      `INSERT INTO tasks (id, identity_id, title, spec, status, sponsor_id, home_venue_id, origin_event_id, created_at, updated_at, opened_at)
       VALUES ('T-1', 'eng', 't', 's', 'active', 'U1', 'C1', 'e1', '2026-07-02T00:00:00Z', '2026-07-02T00:00:00Z', '2026-07-02T00:00:00Z')`,
    ).run();
    const insert = db.query(
      "INSERT INTO executions (id, task_id, attempt, status, started_at) VALUES (?, 'T-1', ?, 'running', '2026-07-02T00:00:00Z')",
    );
    insert.run("x1", 1);
    expect(() => insert.run("x2", 2)).toThrow();
    // a finished execution frees the slot
    db.query("UPDATE executions SET status = 'interrupted', ended_at = '2026-07-02T00:01:00Z' WHERE id = 'x1'").run();
    insert.run("x2", 2);
  });

  test("audit is append-only (SPEC §4.1.12)", () => {
    const db = freshDb();
    db.query(
      "INSERT INTO audit (at, identity_id, kind, payload) VALUES ('2026-07-02T00:00:00Z', 'eng', 'task_created', '{}')",
    ).run();
    expect(() => db.query("UPDATE audit SET payload = '{\"x\":1}' WHERE id = 1").run()).toThrow();
    expect(() => db.query("DELETE FROM audit WHERE id = 1").run()).toThrow();
  });
});
