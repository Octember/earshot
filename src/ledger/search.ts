// BM25 search over events + memory_items; FTS maintained by schema triggers.
import type { Database } from "bun:sqlite";
import { and, eq, sql, type SQL, gte, lte } from "drizzle-orm";
import type { MemoryTier } from "./schema";
import { orm } from "./db";
import { events, eventsFts, memoryFts, memoryItems } from "./schema";

interface SearchOpts {
  query: string;
  venueId?: string | undefined; // messages only — memories carry no venue, so these filters skip them
  principalId?: string | undefined;
  after?: string | undefined; // ISO bounds on received_at (messages) / created_at (memories)
  before?: string | undefined;
  limit?: number | undefined;
}

export interface SearchHit {
  kind: "message" | "memory";
  text: string;
  rank: number; // bm25 — lower is better
  at: string; // received_at / created_at
  venueId: string | null;
  threadRootId: string | null;
  principalId: string | null;
  ts: string | null; // the surface message ts — permalink input; null for memories
  memoryId: string | null;
  tier: MemoryTier | null;
}

// Try raw FTS first; on error/empty, quote tokens OR-joined for recall.
function ftsMatch<T>(run: (match: string) => T[], query: string): T[] {
  let hits: T[] = [];
  try {
    hits = run(query);
  } catch {
    // fall through to the sanitized retry
  }
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

export function searchArchive(db: Database, identityId: string, opts: SearchOpts): SearchHit[] {
  const limit = Math.min(opts.limit ?? 10, 25);

  const messages = ftsMatch<SearchHit>((match) => {
    const conds: SQL[] = [sql`events_fts MATCH ${match}`, eq(events.identityId, identityId)];
    if (opts.venueId) conds.push(eq(events.venueId, opts.venueId));
    if (opts.principalId) conds.push(eq(events.principalId, opts.principalId));
    if (opts.after) conds.push(gte(events.receivedAt, opts.after));
    if (opts.before) conds.push(lte(events.receivedAt, opts.before));
    return orm(db)
      .select({
        text: sql<string | null>`json_extract(${events.payload}, '$.text')`,
        rank: sql<number>`bm25(events_fts)`,
        at: events.receivedAt,
        venueId: events.venueId,
        threadRootId: events.threadRootId,
        principalId: events.principalId,
        ts: sql<string | null>`json_extract(${events.payload}, '$.ts')`,
      })
      .from(eventsFts)
      .innerJoin(events, eq(events.rowid, eventsFts.rowid))
      .where(and(...conds))
      .orderBy(sql`rank`)
      .limit(limit)
      .all()
      .map((row) => ({
        kind: "message" as const,
        text: row.text ?? "",
        rank: row.rank,
        at: row.at,
        venueId: row.venueId,
        threadRootId: row.threadRootId,
        principalId: row.principalId,
        ts: row.ts,
        memoryId: null,
        tier: null,
      }));
  }, opts.query);

  // venue/principal filter messages only; memories ignore them.
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
            .innerJoin(memoryItems, eq(memoryItems.rowid, memoryFts.rowid))
            .where(and(...conds))
            .orderBy(sql`rank`)
            .limit(limit)
            .all()
            .map((row) => ({
              kind: "memory" as const,
              text: row.text,
              rank: row.rank,
              at: row.at,
              venueId: null,
              threadRootId: null,
              principalId: null,
              ts: null,
              memoryId: row.id,
              tier: row.tier,
            }));
        }, opts.query);

  return [...messages, ...memories].toSorted((a, b) => a.rank - b.rank).slice(0, limit);
}
