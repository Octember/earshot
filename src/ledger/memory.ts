import type { Database } from "bun:sqlite";
import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import type { Clock } from "./clock";
import { writeAudit } from "./audit";
import { orm } from "./db";
import { memoryItems, timers, type MemoryItem, type MemoryTier } from "./schema";
import { scheduleTimer } from "./timers";

function requireItem(db: Database, id: string): MemoryItem {
  const item = orm(db).select().from(memoryItems).where(eq(memoryItems.id, id)).get();
  if (!item) throw new Error(`no such memory item: ${id}`);
  return item;
}

export function writeMemory(
  db: Database,
  clock: Clock,
  params: {
    id: string;
    identityId: string;
    content: string;
    provenance?: unknown[] | undefined;
    tier?: MemoryTier | undefined;
  },
): MemoryItem {
  const secretShapes = [
    /xox[baprs]-[A-Za-z0-9-]{10,}/,
    /sk-[A-Za-z0-9_-]{20,}/,
    /(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY/,
    /:\/\/[^/\s:]+:[^@\s]+@/,
  ];
  if (secretShapes.some((pattern) => pattern.test(params.content))) {
    throw new Error(
      "memory refuses credential-shaped content — reference where a secret lives, never its value",
    );
  }
  const now = clock();
  orm(db)
    .insert(memoryItems)
    .values({
      id: params.id,
      identityId: params.identityId,
      content: params.content,
      provenance: params.provenance ?? [],
      tier: params.tier ?? "recent",
      status: "active",
      supersededBy: null,
      createdAt: now,
      updatedAt: now,
      lastConfirmedAt: now,
    })
    .run();
  writeAudit(db, now, params.identityId, {
    kind: "memory_written",
    payload: { memoryId: params.id },
  });
  return requireItem(db, params.id);
}

export function retractMemory(
  db: Database,
  clock: Clock,
  params: {
    id: string;
    supersededBy?: string | undefined;
  },
): MemoryItem {
  const item = requireItem(db, params.id);
  const now = clock();
  orm(db)
    .update(memoryItems)
    .set({ status: "retracted", supersededBy: params.supersededBy ?? null, updatedAt: now })
    .where(eq(memoryItems.id, params.id))
    .run();
  writeAudit(db, now, item.identityId, {
    kind: "memory_retracted",
    payload: {
      memoryId: params.id,
      supersededBy: params.supersededBy ?? null,
    },
  });
  return requireItem(db, params.id);
}

export function setMemoryTier(
  db: Database,
  clock: Clock,
  id: string,
  tier: MemoryTier,
): MemoryItem {
  const item = requireItem(db, id);
  const now = clock();
  orm(db).update(memoryItems).set({ tier, updatedAt: now }).where(eq(memoryItems.id, id)).run();
  writeAudit(db, now, item.identityId, {
    kind: "memory_tier_changed",
    payload: { memoryId: id, tier },
  });
  return requireItem(db, id);
}

export function queryMemory(
  db: Database,
  identityId: string,
  opts: {
    includeRetracted?: boolean;
    tier?: MemoryTier;
  } = {},
): MemoryItem[] {
  const conds: SQL[] = [eq(memoryItems.identityId, identityId)];
  if (!opts.includeRetracted) conds.push(eq(memoryItems.status, "active"));
  if (opts.tier) conds.push(eq(memoryItems.tier, opts.tier));
  return orm(db)
    .select()
    .from(memoryItems)
    .where(and(...conds))
    .orderBy(asc(memoryItems.createdAt))
    .all();
}

export function decayRecentToArchive(
  db: Database,
  clock: Clock,
  identityId: string,
  maxAgeMs: number,
): string[] {
  const cutoff = new Date(new Date(clock()).getTime() - maxAgeMs).toISOString();
  const stale = queryMemory(db, identityId, { tier: "recent" }).filter(
    (memory) => memory.lastConfirmedAt < cutoff,
  );
  for (const item of stale) setMemoryTier(db, clock, item.id, "archive");
  return stale.map((memory) => memory.id);
}

export function coreWithinBudget(
  items: MemoryItem[],
  budgetChars: number,
): { kept: MemoryItem[]; dropped: MemoryItem[] } {
  const byRecency = items.toSorted((a, b) => b.lastConfirmedAt.localeCompare(a.lastConfirmedAt));
  const kept: MemoryItem[] = [];
  const dropped: MemoryItem[] = [];
  let used = 0;
  for (const item of byRecency) {
    if (used + item.content.length <= budgetChars) {
      kept.push(item);
      used += item.content.length;
    } else {
      dropped.push(item);
    }
  }
  return { kept, dropped };
}

export function maybeArmDistillation(
  db: Database,
  clock: Clock,
  identityId: string,
  recentCharBudget: number,
): boolean {
  const recentChars = queryMemory(db, identityId, { tier: "recent" }).reduce(
    (sum, item) => sum + item.content.length,
    0,
  );
  if (recentChars < recentCharBudget) return false;
  const pending = orm(db)
    .select({ id: timers.id })
    .from(timers)
    .where(
      and(
        eq(timers.kind, "distillation"),
        eq(timers.identityId, identityId),
        isNull(timers.firedAt),
      ),
    )
    .get();
  if (pending) return true;
  const id = `distillation:${identityId}`;
  orm(db).delete(timers).where(eq(timers.id, id)).run();
  scheduleTimer(db, { id, kind: "distillation", identityId, dueAt: clock() });
  return true;
}
