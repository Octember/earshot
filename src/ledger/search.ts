// SPEC §8.7 — the searchable floor: one lexical (BM25) search over everything an identity has
// heard (events) and remembers (memory_items, both tiers). The FTS indexes are maintained by
// schema triggers; this module only queries. Identity isolation (§7.1) is structural: every query
// takes an explicit identityId and filters on it in SQL.
import type { Database } from "bun:sqlite";
import type { MemoryTier } from "./memory";

export interface SearchOpts {
  query: string;
  venueId?: string; // messages only — memories carry no venue, so these filters skip them
  principalId?: string;
  after?: string; // ISO bounds on received_at (messages) / created_at (memories)
  before?: string;
  limit?: number;
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

// FTS5 MATCH treats bare words as query syntax, so natural text with quotes/hyphens/parens can
// error, and an all-terms AND query often misses near matches. Run the raw query first (power
// syntax — phrases, AND — works); if it errors or finds nothing, fall back to each token quoted
// and OR-joined: recall-first, with BM25 ranking carrying precision.
function ftsMatch<T>(run: (match: string) => T[], query: string): T[] {
  let hits: T[] = [];
  try {
    hits = run(query);
  } catch {
    // fall through to the sanitized retry
  }
  if (hits.length > 0) return hits;
  const tokens = query.split(/\s+/).filter(Boolean).map((t) => `"${t.replaceAll('"', '""')}"`);
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
    const where = ["events_fts MATCH ?", "e.identity_id = ?"];
    const params: string[] = [match, identityId];
    if (opts.venueId) {
      where.push("e.venue_id = ?");
      params.push(opts.venueId);
    }
    if (opts.principalId) {
      where.push("e.principal_id = ?");
      params.push(opts.principalId);
    }
    if (opts.after) {
      where.push("e.received_at >= ?");
      params.push(opts.after);
    }
    if (opts.before) {
      where.push("e.received_at <= ?");
      params.push(opts.before);
    }
    const rows = db
      .query(
        `SELECT json_extract(e.payload, '$.text') AS text, bm25(events_fts) AS rank, e.received_at AS at,
                e.venue_id, e.thread_root_id, e.principal_id, json_extract(e.payload, '$.ts') AS ts
           FROM events_fts JOIN events e ON e.rowid = events_fts.rowid
          WHERE ${where.join(" AND ")} ORDER BY rank LIMIT ?`,
      )
      .all(...params, limit) as { text: string | null; rank: number; at: string; venue_id: string | null; thread_root_id: string | null; principal_id: string | null; ts: string | null }[];
    return rows.map((r) => ({
      kind: "message" as const,
      text: r.text ?? "",
      rank: r.rank,
      at: r.at,
      venueId: r.venue_id,
      threadRootId: r.thread_root_id,
      principalId: r.principal_id,
      ts: r.ts,
      memoryId: null,
      tier: null,
    }));
  }, opts.query);

  // venue/principal filters name message properties — memories have neither, so they only join
  // an unfiltered (or time-filtered) search.
  const memories =
    opts.venueId || opts.principalId
      ? []
      : ftsMatch<SearchHit>((match) => {
          const where = ["memory_fts MATCH ?", "m.identity_id = ?", "m.status = 'active'"];
          const params: string[] = [match, identityId];
          if (opts.after) {
            where.push("m.created_at >= ?");
            params.push(opts.after);
          }
          if (opts.before) {
            where.push("m.created_at <= ?");
            params.push(opts.before);
          }
          const rows = db
            .query(
              `SELECT m.content AS text, bm25(memory_fts) AS rank, m.created_at AS at, m.id, m.tier
                 FROM memory_fts JOIN memory_items m ON m.rowid = memory_fts.rowid
                WHERE ${where.join(" AND ")} ORDER BY rank LIMIT ?`,
            )
            .all(...params, limit) as { text: string; rank: number; at: string; id: string; tier: MemoryTier }[];
          return rows.map((r) => ({
            kind: "memory" as const,
            text: r.text,
            rank: r.rank,
            at: r.at,
            venueId: null,
            threadRootId: null,
            principalId: null,
            ts: null,
            memoryId: r.id,
            tier: r.tier,
          }));
        }, opts.query);

  return [...messages, ...memories].sort((a, b) => a.rank - b.rank).slice(0, limit);
}
