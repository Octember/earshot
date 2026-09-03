import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { writeAudit, queryAudit } from "../src/ledger/audit";
import type { AuditEntry } from "../src/schemas/audit";

function payloadTaskId(payload: AuditEntry["payload"]): string | undefined {
  return "taskId" in payload ? payload.taskId : undefined;
}

function freshDb() {
  return openLedger(":memory:");
}

describe("queryAudit (SPEC §15)", () => {
  test("returns records for the given identity only", () => {
    const db = freshDb();
    writeAudit(db, "2026-07-01T00:00:00Z", "eng", {
      kind: "task_created",
      payload: { taskId: "T-1", title: "t" },
    });
    writeAudit(db, "2026-07-01T00:00:00Z", "sales", {
      kind: "task_created",
      payload: { taskId: "T-2", title: "t" },
    });

    const results = queryAudit(db, "eng");
    expect(results).toHaveLength(1);
    expect(results[0]?.payload).toEqual({ taskId: "T-1", title: "t" });
  });

  test("filters by time range", () => {
    const db = freshDb();
    writeAudit(db, "2026-06-01T00:00:00Z", "eng", {
      kind: "task_created",
      payload: { taskId: "T-1", title: "t" },
    });
    writeAudit(db, "2026-07-15T00:00:00Z", "eng", {
      kind: "task_created",
      payload: { taskId: "T-2", title: "t" },
    });

    const results = queryAudit(db, "eng", { sinceIso: "2026-07-01T00:00:00Z" });
    expect(results.map((r) => payloadTaskId(r.payload))).toEqual(["T-2"]);
  });

  test("filters by kind", () => {
    const db = freshDb();
    writeAudit(db, "2026-07-01T00:00:00Z", "eng", {
      kind: "task_created",
      payload: { taskId: "T-1", title: "t" },
    });
    writeAudit(db, "2026-07-01T00:00:00Z", "eng", {
      kind: "task_transitioned",
      payload: { taskId: "T-1", from: "active", to: "done", cause: "completed" },
    });

    const results = queryAudit(db, "eng", { kind: "task_transitioned" });
    expect(results).toHaveLength(1);
    expect(results[0]?.kind).toBe("task_transitioned");
  });

  test("filters by taskId embedded in the payload", () => {
    const db = freshDb();
    writeAudit(db, "2026-07-01T00:00:00Z", "eng", {
      kind: "task_created",
      payload: { taskId: "T-1", title: "t" },
    });
    writeAudit(db, "2026-07-01T00:00:00Z", "eng", {
      kind: "task_created",
      payload: { taskId: "T-2", title: "t" },
    });

    const results = queryAudit(db, "eng", { taskId: "T-1" });
    expect(results).toHaveLength(1);
  });

  test("results are ordered chronologically", () => {
    const db = freshDb();
    writeAudit(db, "2026-07-03T00:00:00Z", "eng", {
      kind: "task_created",
      payload: { taskId: "T-2", title: "t" },
    });
    writeAudit(db, "2026-07-01T00:00:00Z", "eng", {
      kind: "task_created",
      payload: { taskId: "T-1", title: "t" },
    });

    const results = queryAudit(db, "eng");
    expect(results.map((r) => payloadTaskId(r.payload))).toEqual(["T-1", "T-2"]);
  });
});
