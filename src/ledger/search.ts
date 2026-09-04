import type { Database } from "bun:sqlite";
import { and, eq, sql, type SQL, gte, lte } from "drizzle-orm";
import type { MemoryTier } from "./schema";
import { orm } from "./db";
import { events, eventsFts, memoryFts, memoryItems } from "./schema";

export type SearchHit =
  | {
      kind: "message";
      text: string;
      rank: number;
      at: string;
      venueId: string;
      threadRootId: string | null;
      principalId: string | null;
      ts: string;
    }
  | { kind: "memory"; text: string; rank: number; at: string; memoryId: string; tier: MemoryTier };

function ftsMatch<T>(run: (match: string) => T[], query: string): T[] {
  let hits: T[] = [];
  try {
    hits = run(query);
  } catch {}
  if (hits.length > 0) return hits;
  const tokens = query
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"`);
  if (tokens.length === 0) return [];
  try {
    return run(tokens.join(" OR "));
  } catch {
    return [];
  }
}

export function searchArchive(
  db: Database,
  identityId: string,
  opts: {
    query: string;
    venueId?: string | undefined;
    principalId?: string | undefined;
    after?: string | undefined;
    before?: string | undefined;
    limit?: number | undefined;
  },
): SearchHit[] {
  const limit = Math.min(opts.limit ?? 10, 25);

  const messages = ftsMatch<SearchHit>((match) => {
    const conds: SQL[] = [sql`events_fts MATCH ${match}`, eq(events.identityId, identityId)];
    if (opts.venueId) conds.push(eq(events.venueId, opts.venueId));
    if (opts.principalId) conds.push(eq(events.principalId, opts.principalId));
    if (opts.after) conds.push(gte(events.receivedAt, opts.after));
    if (opts.before) conds.push(lte(events.receivedAt, opts.before));
    return orm(db)
      .select({
        text: events.text,
        rank: sql<number>`bm25(events_fts)`,
        at: events.receivedAt,
        venueId: events.venueId,
        threadRootId: events.threadRootId,
        principalId: events.principalId,
        ts: events.ts,
      })
      .from(eventsFts)
      .innerJoin(events, eq(events.rowid, eventsFts.rowid))
      .where(and(...conds))
      .orderBy(sql`rank`)
      .limit(limit)
      .all()
      .map((row) => Object.assign(row, { kind: "message" as const }));
  }, opts.query);

  const memories =
    opts.venueId || opts.principalId
      ? []
      : ftsMatch<SearchHit>((match) => {
          const conds: SQL[] = [
            sql`memory_fts MATCH ${match}`,
            eq(memoryItems.identityId, identityId),
            eq(memoryItems.status, "active"),
          ];
          if (opts.after) conds.push(gte(memoryItems.createdAt, opts.after));
          if (opts.before) conds.push(lte(memoryItems.createdAt, opts.before));
          return orm(db)
            .select({
              text: memoryItems.content,
              rank: sql<number>`bm25(memory_fts)`,
              at: memoryItems.createdAt,
              id: memoryItems.id,
              tier: memoryItems.tier,
            })
            .from(memoryFts)
            .innerJoin(memoryItems, eq(sql`${memoryItems}.rowid`, memoryFts.rowid))
            .where(and(...conds))
            .orderBy(sql`rank`)
            .limit(limit)
            .all()
            .map((row) => ({
              kind: "memory" as const,
              text: row.text,
              rank: row.rank,
              at: row.at,
              memoryId: row.id,
              tier: row.tier,
            }));
        }, opts.query);

  return [...messages, ...memories].toSorted((a, b) => a.rank - b.rank).slice(0, limit);
}
