import type { Database } from "bun:sqlite";
import { and, asc, eq, type SQL } from "drizzle-orm";
import type { Clock } from "./clock";
import { orm } from "./db";
import { memoryItems, type MemoryItem, type MemoryTier } from "./schema";

const SECRET_SHAPES = [
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /:\/\/[^/\s:]+:[^@\s]+@/,
];

export function writeMemory(
  db: Database,
  clock: Clock,
  params: {
    id: string;
    identityId: string;
    content: string;
    provenance: unknown[];
    tier: MemoryTier;
  },
): MemoryItem {
  if (SECRET_SHAPES.some((pattern) => pattern.test(params.content)))
    throw new Error(
      "memory refuses credential-shaped content — reference where a secret lives, never its value",
    );
  const now = clock();
  return orm(db)
    .insert(memoryItems)
    .values({
      ...params,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function retractMemory(db: Database, clock: Clock, identityId: string, id: string): boolean {
  return (
    orm(db)
      .update(memoryItems)
      .set({ status: "retracted", updatedAt: clock() })
      .where(and(eq(memoryItems.id, id), eq(memoryItems.identityId, identityId)))
      .returning({ id: memoryItems.id })
      .get() != null
  );
}

export function setMemoryTier(
  db: Database,
  clock: Clock,
  identityId: string,
  id: string,
  tier: MemoryTier,
): boolean {
  return (
    orm(db)
      .update(memoryItems)
      .set({ tier, updatedAt: clock() })
      .where(and(eq(memoryItems.id, id), eq(memoryItems.identityId, identityId)))
      .returning({ id: memoryItems.id })
      .get() != null
  );
}

export function activeMemory(db: Database, identityId: string, tier?: MemoryTier): MemoryItem[] {
  const conds: SQL[] = [eq(memoryItems.identityId, identityId), eq(memoryItems.status, "active")];
  if (tier) conds.push(eq(memoryItems.tier, tier));
  return orm(db)
    .select()
    .from(memoryItems)
    .where(and(...conds))
    .orderBy(asc(memoryItems.createdAt))
    .all();
}

export function withinBudget(
  items: MemoryItem[],
  budgetChars: number,
): { kept: MemoryItem[]; dropped: number } {
  const kept: MemoryItem[] = [];
  let used = 0;
  for (const item of items.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (used + item.content.length > budgetChars) continue;
    kept.push(item);
    used += item.content.length;
  }
  return { kept, dropped: items.length - kept.length };
}
