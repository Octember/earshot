// Memory: curated facts with provenance (never raw transcripts); queries are identity-scoped.
import type { Database } from "bun:sqlite";
import { and, asc, eq, type SQL } from "drizzle-orm";
import type { Clock } from "./clock";
import { writeAudit } from "./audit";
import { orm } from "./db";
import { memoryItems, type MemoryItem, type MemoryStatus, type MemoryTier } from "./schema";

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
  tier?: MemoryTier | undefined; // SPEC §8.6: explicit writes default to core — "remember X" acts next turn
}

// §10.6: memory is not a secret sink. Credential-shaped content is refused at the write
// primitive (covers the tool AND any future caller); the shapes are the major token formats,
// not a general scrubber — a quoted secret in a durable fact would outlive every rotation.
const SECRET_SHAPES = [
  /xox[baprs]-[A-Za-z0-9-]{10,}/, // slack tokens
  /sk-[A-Za-z0-9_-]{20,}/, // api secret keys
  /(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/, // github tokens
  /AKIA[0-9A-Z]{16}/, // aws access keys
  /-----BEGIN [A-Z ]*PRIVATE KEY/, // pem material
  /:\/\/[^/\s:]+:[^@\s]+@/, // credentials embedded in a url
];

// SPEC §8.2 explicit write path (the distillation write path uses the same primitive — it's the
// SOURCE that differs, not the mechanics).
export function writeMemory(db: Database, clock: Clock, params: WriteMemoryParams): MemoryItem {
  if (SECRET_SHAPES.some((p) => p.test(params.content))) {
    throw new Error("memory refuses credential-shaped content — reference where a secret lives, never its value");
  }
  const now = clock();
  orm(db)
    .insert(memoryItems)
    .values({
      id: params.id,
      identityId: params.identityId,
      content: params.content,
      provenance: params.provenance ?? [],
      tier: params.tier ?? "core",
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

// SPEC §8.3: "forget that" — takes effect immediately (a plain synchronous write); queryMemory's
// active-only default means a retracted item is never loaded into a later turn's context.
export function retractMemory(db: Database, clock: Clock, params: RetractMemoryParams): MemoryItem {
  const item = requireItem(db, params.id);
  const now = clock();
  orm(db)
    .update(memoryItems)
    .set({ status: "retracted", supersededBy: params.supersededBy ?? null, updatedAt: now })
    .where(eq(memoryItems.id, params.id))
    .run();
  writeAudit(db, now, item.identityId, "memory_retracted", { memoryId: params.id, supersededBy: params.supersededBy ?? null });
  return requireItem(db, params.id);
}

export interface CorrectMemoryParams {
  oldId: string;
  newId: string;
  newContent: string;
  provenance?: unknown[] | undefined;
}

// SPEC §8.3: "that's wrong, it's actually Y" — retract the old item, linked to a freshly written
// replacement.
export function correctMemory(db: Database, clock: Clock, params: CorrectMemoryParams): { retracted: MemoryItem; created: MemoryItem } {
  const old = requireItem(db, params.oldId);
  const created = writeMemory(db, clock, { id: params.newId, identityId: old.identityId, content: params.newContent, provenance: params.provenance });
  const retracted = retractMemory(db, clock, { id: params.oldId, supersededBy: params.newId });
  return { retracted, created };
}

// SPEC §8.3: a fresh observation that CONFIRMS existing memory bumps last_confirmed_at without
// changing content (contrast with correctMemory, which is for a contradiction).
export function confirmMemory(db: Database, clock: Clock, id: string): MemoryItem {
  const now = clock();
  orm(db).update(memoryItems).set({ lastConfirmedAt: now, updatedAt: now }).where(eq(memoryItems.id, id)).run();
  return requireItem(db, id);
}

// SPEC §8.6: a tier move — the distiller's demote/promote. Content is untouched; an archived item
// leaves injection but stays searchable.
export function setMemoryTier(db: Database, clock: Clock, id: string, tier: MemoryTier): MemoryItem {
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

// SPEC §8.4 inspection + §7.1 isolation: always identity-scoped, active-only by default.
export function queryMemory(db: Database, identityId: string, opts: QueryMemoryOpts = {}): MemoryItem[] {
  const conds: SQL[] = [eq(memoryItems.identityId, identityId)];
  if (!opts.includeRetracted) conds.push(eq(memoryItems.status, "active"));
  if (opts.tier) conds.push(eq(memoryItems.tier, opts.tier));
  return orm(db).select().from(memoryItems).where(and(...conds)).orderBy(asc(memoryItems.createdAt)).all();
}

// SPEC §8.6: recent items unconfirmed past maxAgeMs demote to archive — decay is demotion,
// never deletion (the item stays searchable). Run by the service before each distillation sweep.
export function decayRecentToArchive(db: Database, clock: Clock, identityId: string, maxAgeMs: number): string[] {
  const cutoff = new Date(new Date(clock()).getTime() - maxAgeMs).toISOString();
  const stale = queryMemory(db, identityId, { tier: "recent" }).filter((m) => m.lastConfirmedAt < cutoff);
  for (const item of stale) setMemoryTier(db, clock, item.id, "archive");
  return stale.map((m) => m.id);
}

export interface DecayStaleMemoryOpts {
  maxAgeMs: number;
  maxItems?: number;
}

// SPEC §8.5 hygiene (SHOULD, not MUST): retire old/stale items, then — if still over the
// per-identity size cap — evict the stalest remaining items first.
export function decayStaleMemory(db: Database, clock: Clock, identityId: string, opts: DecayStaleMemoryOpts) {
  const now = clock();
  const active = queryMemory(db, identityId).toSorted((a, b) => a.lastConfirmedAt.localeCompare(b.lastConfirmedAt));
  const decayed: string[] = [];

  const cutoff = Number.isFinite(opts.maxAgeMs) ? new Date(now).getTime() - opts.maxAgeMs : -Infinity;
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

// §8.6 core budget selection: most recently confirmed facts first, until the budget is spent.
// Returns what was dropped so the caller can log the hygiene defect (truncation is the safety
// net; curation is the fix).
export function coreWithinBudget(items: MemoryItem[], budgetChars: number): { kept: MemoryItem[]; dropped: MemoryItem[] } {
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
