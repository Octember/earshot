// Recent-budget distillation: arm when recent is full; wipe remaining recent after a pass.
import type { Database } from "bun:sqlite";
import { and, eq, isNull } from "drizzle-orm";
import type { Clock } from "./clock";
import { orm } from "./db";
import { timers } from "./schema";
import { queryMemory, setMemoryTier } from "./memory";
import { scheduleTimer } from "./timers";

export function distillationTimerId(identityId: string): string {
  return `distillation:${identityId}`;
}

export function recentCharTotal(db: Database, identityId: string): number {
  return queryMemory(db, identityId, { tier: "recent" }).reduce(
    (sum, item) => sum + item.content.length,
    0,
  );
}

function hasPendingDistillation(db: Database, identityId: string): boolean {
  return (
    orm(db)
      .select({ id: timers.id })
      .from(timers)
      .where(
        and(
          eq(timers.kind, "distillation"),
          eq(timers.identityId, identityId),
          isNull(timers.firedAt),
        ),
      )
      .get() !== undefined
  );
}

/** Arm a due-now distillation timer when recent is at/over budget. Singleton per identity. */
export function maybeArmDistillation(
  db: Database,
  clock: Clock,
  identityId: string,
  recentCharBudget: number,
): boolean {
  if (recentCharTotal(db, identityId) < recentCharBudget) return false;
  if (hasPendingDistillation(db, identityId)) return true;
  const id = distillationTimerId(identityId);
  // Stable id may still hold a fired row — clear it so we can re-arm after a failed pass.
  orm(db).delete(timers).where(eq(timers.id, id)).run();
  scheduleTimer(db, {
    id,
    kind: "distillation",
    identityId,
    subjectId: null,
    dueAt: clock(),
  });
  return true;
}

/** Demote every active recent item to archive (never delete). */
export function archiveAllRecent(db: Database, clock: Clock, identityId: string): string[] {
  const recent = queryMemory(db, identityId, { tier: "recent" });
  for (const item of recent) setMemoryTier(db, clock, item.id, "archive");
  return recent.map((item) => item.id);
}
