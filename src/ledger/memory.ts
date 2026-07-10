// SPEC §8 — Memory. Curated, distilled facts with provenance, never raw transcripts. Identity
// isolation (§7.1) is enforced structurally: queryMemory always takes an explicit identityId and
// only ever returns that identity's rows — there is no "query all identities" shape to misuse.
import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";
import { writeAudit } from "./audit";

export type MemoryStatus = "active" | "retracted";
// SPEC §8.6 — core is injected into turn context (budget-bounded); recent is internalized-but-
// unvetted (ambient writes land here, injected under a smaller budget, decays to archive);
// archive is reachable only via search. Demotion moves an item down without losing it.
export type MemoryTier = "core" | "recent" | "archive";

export interface MemoryItem {
  id: string;
  identityId: string;
  content: string;
  provenance: unknown[];
  tier: MemoryTier;
  status: MemoryStatus;
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastConfirmedAt: string;
}

interface Row {
  id: string;
  identity_id: string;
  content: string;
  provenance: string;
  tier: MemoryTier;
  status: MemoryStatus;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
  last_confirmed_at: string;
}

function rowToItem(row: Row): MemoryItem {
  return {
    id: row.id,
    identityId: row.identity_id,
    content: row.content,
    provenance: JSON.parse(row.provenance),
    tier: row.tier,
    status: row.status,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastConfirmedAt: row.last_confirmed_at,
  };
}

function getItem(db: Database, id: string): MemoryItem | null {
  const row = db.query("SELECT * FROM memory_items WHERE id = ?").get(id) as Row | null;
  return row ? rowToItem(row) : null;
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
  provenance?: unknown[];
  tier?: MemoryTier; // SPEC §8.6: explicit writes default to core — "remember X" acts next turn
}

// SPEC §8.2 explicit write path (the distillation write path uses the same primitive — it's the
// SOURCE that differs, not the mechanics).
export function writeMemory(db: Database, clock: Clock, params: WriteMemoryParams): MemoryItem {
  const now = clock();
  db.query(
    `INSERT INTO memory_items (id, identity_id, content, provenance, tier, status, superseded_by, created_at, updated_at, last_confirmed_at)
     VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?)`,
  ).run(params.id, params.identityId, params.content, JSON.stringify(params.provenance ?? []), params.tier ?? "core", now, now, now);
  writeAudit(db, now, params.identityId, "memory_written", { memoryId: params.id });
  return requireItem(db, params.id);
}

export interface RetractMemoryParams {
  id: string;
  supersededBy?: string;
}

// SPEC §8.3: "forget that" — takes effect immediately (a plain synchronous write); queryMemory's
// active-only default means a retracted item is never loaded into a later turn's context.
export function retractMemory(db: Database, clock: Clock, params: RetractMemoryParams): MemoryItem {
  const item = requireItem(db, params.id);
  const now = clock();
  db.query("UPDATE memory_items SET status = 'retracted', superseded_by = ?, updated_at = ? WHERE id = ?").run(
    params.supersededBy ?? null,
    now,
    params.id,
  );
  writeAudit(db, now, item.identityId, "memory_retracted", { memoryId: params.id, supersededBy: params.supersededBy ?? null });
  return requireItem(db, params.id);
}

export interface CorrectMemoryParams {
  oldId: string;
  newId: string;
  newContent: string;
  provenance?: unknown[];
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
  db.query("UPDATE memory_items SET last_confirmed_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
  return requireItem(db, id);
}

// SPEC §8.6: a tier move — the distiller's demote/promote. Content is untouched; an archived item
// leaves injection but stays searchable.
export function setMemoryTier(db: Database, clock: Clock, id: string, tier: MemoryTier): MemoryItem {
  const item = requireItem(db, id);
  const now = clock();
  db.query("UPDATE memory_items SET tier = ?, updated_at = ? WHERE id = ?").run(tier, now, id);
  writeAudit(db, now, item.identityId, "memory_tier_changed", { memoryId: id, tier });
  return requireItem(db, id);
}

export interface QueryMemoryOpts {
  includeRetracted?: boolean;
  tier?: MemoryTier;
}

// SPEC §8.4 inspection + §7.1 isolation: always identity-scoped, active-only by default.
export function queryMemory(db: Database, identityId: string, opts: QueryMemoryOpts = {}): MemoryItem[] {
  const where = ["identity_id = ?"];
  const params: string[] = [identityId];
  if (!opts.includeRetracted) where.push("status = 'active'");
  if (opts.tier) {
    where.push("tier = ?");
    params.push(opts.tier);
  }
  const rows = db.query(`SELECT * FROM memory_items WHERE ${where.join(" AND ")} ORDER BY created_at`).all(...params) as Row[];
  return rows.map(rowToItem);
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

export interface DecayResult {
  decayed: string[];
}

// SPEC §8.5 hygiene (SHOULD, not MUST): retire old/stale items, then — if still over the
// per-identity size cap — evict the stalest remaining items first.
export function decayStaleMemory(db: Database, clock: Clock, identityId: string, opts: DecayStaleMemoryOpts): DecayResult {
  const now = clock();
  const active = queryMemory(db, identityId).sort((a, b) => a.lastConfirmedAt.localeCompare(b.lastConfirmedAt));
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
