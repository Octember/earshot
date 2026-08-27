// Memory: curated facts with provenance; queries are identity-scoped.
import type { Database } from "bun:sqlite";
import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import type { Clock } from "./clock";
import { writeAudit } from "./audit";
import { orm } from "./db";
import { memoryItems, timers, type MemoryItem, type MemoryStatus, type MemoryTier } from "./schema";
import { scheduleTimer } from "./timers";

export type { MemoryItem, MemoryStatus, MemoryTier };

function getItem(db: Database, id: string): MemoryItem | null {
  return orm(db).select().from(memoryItems).where(eq(memoryItems.id, id)).get() ?? null;
}

function requireItem(db: Database, id: string): MemoryItem {
  const item = getItem(db, id);
  if (!item) throw new Error(`no such memory item: ${id}`);
  return item;
}

export interface WriteMemoryParams {
  id: string;
  identityId: string;
  content: string;
  provenance?: unknown[] | undefined;
  tier?: MemoryTier | undefined; // omitted → recent (promote via distiller or explicit tier)
}

// Refuse credential-shaped content at the write primitive (§10.6).
const SECRET_SHAPES = [
  /xox[baprs]-[A-Za-z0-9-]{10,}/, // slack tokens
  /sk-[A-Za-z0-9_-]{20,}/, // api secret keys
  /(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/, // github tokens
  /AKIA[0-9A-Z]{16}/, // aws access keys
  /-----BEGIN [A-Z ]*PRIVATE KEY/, // pem material
  /:\/\/[^/\s:]+:[^@\s]+@/, // credentials embedded in a url
];

export function writeMemory(db: Database, clock: Clock, params: WriteMemoryParams): MemoryItem {
  if (SECRET_SHAPES.some((pattern) => pattern.test(params.content))) {
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
  writeAudit(db, now, params.identityId, "memory_written", { memoryId: params.id });
  return requireItem(db, params.id);
}

export interface RetractMemoryParams {
  id: string;
  supersededBy?: string | undefined;
}

export function retractMemory(db: Database, clock: Clock, params: RetractMemoryParams): MemoryItem {
  const item = requireItem(db, params.id);
  const now = clock();
  orm(db)
    .update(memoryItems)
    .set({ status: "retracted", supersededBy: params.supersededBy ?? null, updatedAt: now })
    .where(eq(memoryItems.id, params.id))
    .run();
  writeAudit(db, now, item.identityId, "memory_retracted", {
    memoryId: params.id,
    supersededBy: params.supersededBy ?? null,
  });
  return requireItem(db, params.id);
}

export interface CorrectMemoryParams {
  oldId: string;
  newId: string;
  newContent: string;
  provenance?: unknown[] | undefined;
}

export function correctMemory(
  db: Database,
  clock: Clock,
  params: CorrectMemoryParams,
): { retracted: MemoryItem; created: MemoryItem } {
  const old = requireItem(db, params.oldId);
  const created = writeMemory(db, clock, {
    id: params.newId,
    identityId: old.identityId,
    content: params.newContent,
    provenance: params.provenance,
    tier: old.tier, // corrections keep the prior item's standing
  });
  const retracted = retractMemory(db, clock, { id: params.oldId, supersededBy: params.newId });
  return { retracted, created };
}

export function confirmMemory(db: Database, clock: Clock, id: string): MemoryItem {
  const now = clock();
  orm(db)
    .update(memoryItems)
    .set({ lastConfirmedAt: now, updatedAt: now })
    .where(eq(memoryItems.id, id))
    .run();
  return requireItem(db, id);
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
  writeAudit(db, now, item.identityId, "memory_tier_changed", { memoryId: id, tier });
  return requireItem(db, id);
}

export interface QueryMemoryOpts {
  includeRetracted?: boolean;
  tier?: MemoryTier;
}

export function queryMemory(
  db: Database,
  identityId: string,
  opts: QueryMemoryOpts = {},
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

export interface DecayStaleMemoryOpts {
  maxAgeMs: number;
  maxItems?: number;
}

export function decayStaleMemory(
  db: Database,
  clock: Clock,
  identityId: string,
  opts: DecayStaleMemoryOpts,
) {
  const now = clock();
  const active = queryMemory(db, identityId).toSorted((a, b) =>
    a.lastConfirmedAt.localeCompare(b.lastConfirmedAt),
  );
  const decayed: string[] = [];

  const cutoff = Number.isFinite(opts.maxAgeMs)
    ? new Date(now).getTime() - opts.maxAgeMs
    : -Infinity;
  const survivors: MemoryItem[] = [];
  for (const item of active) {
    if (new Date(item.lastConfirmedAt).getTime() < cutoff) {
      retractMemory(db, clock, { id: item.id });
      decayed.push(item.id);
    } else {
      survivors.push(item);
    }
  }

  if (opts.maxItems !== undefined && survivors.length > opts.maxItems) {
    const overflow = survivors.length - opts.maxItems;
    for (const item of survivors.slice(0, overflow)) {
      retractMemory(db, clock, { id: item.id });
      decayed.push(item.id);
    }
  }

  return { decayed };
}

// Most recently confirmed first until budget spent; returns dropped for hygiene logging.
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

export function distillationTimerId(identityId: string): string {
  return `distillation:${identityId}`;
}

export function recentCharTotal(db: Database, identityId: string): number {
  return queryMemory(db, identityId, { tier: "recent" }).reduce(
    (sum, item) => sum + item.content.length,
    0,
  );
}

/** Arm due-now distillation when recent is at/over budget (one pending per identity). */
export function maybeArmDistillation(
  db: Database,
  clock: Clock,
  identityId: string,
  recentCharBudget: number,
): boolean {
  if (recentCharTotal(db, identityId) < recentCharBudget) return false;
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
  const id = distillationTimerId(identityId);
  orm(db).delete(timers).where(eq(timers.id, id)).run(); // clear fired row so we can re-arm
  scheduleTimer(db, { id, kind: "distillation", identityId, subjectId: null, dueAt: clock() });
  return true;
}

/** Demote every active recent item to archive (never delete). */
export function archiveAllRecent(db: Database, clock: Clock, identityId: string): string[] {
  const recent = queryMemory(db, identityId, { tier: "recent" });
  for (const item of recent) setMemoryTier(db, clock, item.id, "archive");
  return recent.map((item) => item.id);
}
