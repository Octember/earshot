// SPEC §4.1.12 — the append-only audit log. One shared writer so every module logs through the
// same choke point (the table itself also enforces append-only via triggers, SPEC schema v1).
import type { Database } from "bun:sqlite";

export type AuditKind =
  | "event_received"
  | "turn_started"
  | "turn_ended"
  | "task_created"
  | "task_transitioned"
  | "tool_invoked"
  | "confirmation_requested"
  | "confirmation_resolved"
  | "ambient_posted"
  | "budget_denied"
  | "memory_written"
  | "memory_retracted";

export function writeAudit(db: Database, at: string, identityId: string, kind: AuditKind, payload: unknown): void {
  db.query("INSERT INTO audit (at, identity_id, kind, payload) VALUES (?, ?, ?, ?)").run(
    at,
    identityId,
    kind,
    JSON.stringify(payload),
  );
}

export interface AuditRecord {
  id: number;
  at: string;
  identityId: string;
  kind: AuditKind;
  payload: unknown;
}

export interface AuditQueryFilter {
  sinceIso?: string;
  untilIso?: string;
  kind?: AuditKind;
  taskId?: string; // matches a `taskId` field embedded in the record's payload, if present
}

// SPEC §15: "queryable by the operator, at minimum: by identity, by task, by time range, by kind"
// — and per §15, an identity's own audit-query tool is scoped to that identity, same as every
// other ledger query in this codebase (§7.1).
export function queryAudit(db: Database, identityId: string, filter: AuditQueryFilter = {}): AuditRecord[] {
  const clauses = ["identity_id = ?"];
  const params: unknown[] = [identityId];
  if (filter.sinceIso) {
    clauses.push("at >= ?");
    params.push(filter.sinceIso);
  }
  if (filter.untilIso) {
    clauses.push("at <= ?");
    params.push(filter.untilIso);
  }
  if (filter.kind) {
    clauses.push("kind = ?");
    params.push(filter.kind);
  }
  const rows = db
    .query(`SELECT id, at, identity_id, kind, payload FROM audit WHERE ${clauses.join(" AND ")} ORDER BY at, id`)
    .all(...(params as [])) as { id: number; at: string; identity_id: string; kind: AuditKind; payload: string }[];

  const records = rows.map((r) => ({ id: r.id, at: r.at, identityId: r.identity_id, kind: r.kind, payload: JSON.parse(r.payload) as unknown }));
  return filter.taskId ? records.filter((r) => (r.payload as { taskId?: string }).taskId === filter.taskId) : records;
}
