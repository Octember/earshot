import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { writeAudit, queryAudit } from "../src/ledger/audit";

function freshDb() {
  return openLedger(":memory:");
}

describe("queryAudit (SPEC §15: 'what did you do this week / what did you spend')", () => {
  test("returns records for the given identity only", () => {
    const db = freshDb();
    writeAudit(db, "2026-07-01T00:00:00Z", "eng", "task_created", { taskId: "T-1" });
    writeAudit(db, "2026-07-01T00:00:00Z", "sales", "task_created", { taskId: "T-2" });

    const results = queryAudit(db, "eng");
    expect(results).toHaveLength(1);
    expect(results[0]?.payload).toEqual({ taskId: "T-1" });
  });

  test("filters by time range", () => {
    const db = freshDb();
    writeAudit(db, "2026-06-01T00:00:00Z", "eng", "task_created", { taskId: "T-1" });
    writeAudit(db, "2026-07-15T00:00:00Z", "eng", "task_created", { taskId: "T-2" });

    const results = queryAudit(db, "eng", { sinceIso: "2026-07-01T00:00:00Z" });
    expect(results.map((r) => (r.payload as any).taskId)).toEqual(["T-2"]);
  });

  test("filters by kind", () => {
    const db = freshDb();
    writeAudit(db, "2026-07-01T00:00:00Z", "eng", "task_created", { taskId: "T-1" });
    writeAudit(db, "2026-07-01T00:00:00Z", "eng", "task_transitioned", { taskId: "T-1", to: "done" });

    const results = queryAudit(db, "eng", { kind: "task_transitioned" });
    expect(results).toHaveLength(1);
    expect(results[0]?.kind).toBe("task_transitioned");
  });

  test("filters by taskId embedded in the payload", () => {
    const db = freshDb();
    writeAudit(db, "2026-07-01T00:00:00Z", "eng", "task_created", { taskId: "T-1" });
    writeAudit(db, "2026-07-01T00:00:00Z", "eng", "task_created", { taskId: "T-2" });

    const results = queryAudit(db, "eng", { taskId: "T-1" });
    expect(results).toHaveLength(1);
  });

  test("results are ordered chronologically", () => {
    const db = freshDb();
    writeAudit(db, "2026-07-03T00:00:00Z", "eng", "task_created", { taskId: "T-2" });
    writeAudit(db, "2026-07-01T00:00:00Z", "eng", "task_created", { taskId: "T-1" });

    const results = queryAudit(db, "eng");
    expect(results.map((r) => (r.payload as any).taskId)).toEqual(["T-1", "T-2"]);
  });
});
