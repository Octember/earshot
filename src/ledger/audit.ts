import type { Database } from "bun:sqlite";
import { and, asc, eq, gte, lte, type SQL } from "drizzle-orm";
import { orm } from "./db";
import { audit, type Audit, type AuditKind } from "./schema";
import type { AuditEntry } from "../schemas/audit";

export function writeAudit(db: Database, at: string, identityId: string, entry: AuditEntry): void {
  orm(db).insert(audit).values({ at, identityId, kind: entry.kind, payload: entry.payload }).run();
}

export function queryAudit(
  db: Database,
  identityId: string,
  filter: {
    sinceIso?: string | undefined;
    untilIso?: string | undefined;
    kind?: AuditKind | undefined;
    taskId?: string | undefined;
  },
): Audit[] {
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
    ? records.filter(
        (record) => "taskId" in record.payload && record.payload.taskId === filter.taskId,
      )
    : records;
}
