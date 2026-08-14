// SPEC §4.1.12 — the append-only audit log. One shared writer so every module logs through the
// same choke point (the table itself also enforces append-only via triggers, SPEC schema v1).
import type { Database } from "bun:sqlite";
import { and, asc, eq, gte, lte, type SQL } from "drizzle-orm";
import { isRecord } from "../guard";
import { orm } from "./db";
import { audit, type Audit, type AuditKind } from "./schema";

export type { Audit as AuditRecord, AuditKind };

export function writeAudit(db: Database, at: string, identityId: string, kind: AuditKind, payload: unknown): void {
  orm(db).insert(audit).values({ at, identityId, kind, payload }).run();
}

export interface AuditQueryFilter {
  sinceIso?: string | undefined;
  untilIso?: string | undefined;
  kind?: AuditKind | undefined;
  taskId?: string | undefined; // matches a `taskId` field embedded in the record's payload, if present
}

// SPEC §15: "queryable by the operator, at minimum: by identity, by task, by time range, by kind"
// — and per §15, an identity's own audit-query tool is scoped to that identity, same as every
// other ledger query in this codebase (§7.1).
export function queryAudit(db: Database, identityId: string, filter: AuditQueryFilter = {}): Audit[] {
  const conds: SQL[] = [eq(audit.identityId, identityId)];
  if (filter.sinceIso) conds.push(gte(audit.at, filter.sinceIso));
  if (filter.untilIso) conds.push(lte(audit.at, filter.untilIso));
  if (filter.kind) conds.push(eq(audit.kind, filter.kind));
  const records = orm(db)
    .select()
    .from(audit)
    .where(and(...conds))
    .orderBy(asc(audit.at), asc(audit.id))
    .all();
  return filter.taskId
    ? records.filter((r) => isRecord(r.payload) && r.payload.taskId === filter.taskId)
    : records;
}
