import type { Database } from "bun:sqlite";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { orm } from "./db";
import { acts, events } from "./schema";
import type { InboxMessage } from "./inbox";
import type { ConversationJudgment, ConversationKey, StanceState } from "./conversations-stance";
import { DELIVERABLE_KINDS, sameNullable } from "./conversations-util";

const TAIL_LIMIT = 8;

export interface RefTarget {
  venueId: string;
  threadRootId: string | null;
  ts?: string; // present on message refs — the message's own surface ts
  via: "rendered" | "search";
  // Line provenance for durable writes (not batch-level speaker pick).
  eventId?: string;
  principalId?: string | null;
}

export interface RefTable {
  mint(target: RefTarget): string;
  get(ref: string): RefTarget | undefined;
}

export function makeRefTable(): RefTable {
  let n = 0;
  const table = new Map<string, RefTarget>();
  return {
    mint(target) {
      const ref = `r${++n}`;
      table.set(ref, target);
      return ref;
    },
    get: (ref) => table.get(ref),
  };
}

// Message ref → conversation (thread, or thread rooted by top-level msg).
export function conversationOf(t: RefTarget): ConversationKey {
  return { venueId: t.venueId, threadRootId: t.threadRootId ?? t.ts ?? null };
}

// Provenance for durable writes: mint-time if present, else ledger event in the ref's conversation.
export function provenanceOfRef(db: Database, identityId: string, t: RefTarget): { eventId: string; principalId: string | null } | null {
  if (t.eventId) return { eventId: t.eventId, principalId: t.principalId ?? null };
  if (t.ts) {
    const exact = orm(db)
      .select({ id: events.id, principalId: events.principalId })
      .from(events)
      .where(and(eq(events.identityId, identityId), eq(events.venueId, t.venueId), sql`json_extract(${events.payload}, '$.ts') = ${t.ts}`))
      .orderBy(desc(sql`${events}.rowid`))
      .limit(1)
      .get();
    if (exact) return { eventId: exact.id, principalId: exact.principalId };
  }
  const key = conversationOf(t);
  const row = orm(db)
    .select({ id: events.id, principalId: events.principalId })
    .from(events)
    .where(
      and(
        eq(events.identityId, identityId),
        eq(events.venueId, key.venueId),
        inArray(events.kind, DELIVERABLE_KINDS),
        key.threadRootId
          ? or(eq(events.threadRootId, key.threadRootId), sql`json_extract(${events.payload}, '$.ts') = ${key.threadRootId}`)
          : isNull(events.threadRootId),
      ),
    )
    .orderBy(desc(sql`${events}.rowid`))
    .limit(1)
    .get();
  return row ? { eventId: row.id, principalId: row.principalId } : null;
}

// Newest human speaker in conversation (sponsor fallback for machine lines).
export function lastSpeakerIn(db: Database, identityId: string, key: ConversationKey): string | null {
  const row = orm(db)
    .select({ principalId: events.principalId })
    .from(events)
    .where(
      and(
        eq(events.identityId, identityId),
        eq(events.venueId, key.venueId),
        isNotNull(events.principalId),
        key.threadRootId
          ? or(eq(events.threadRootId, key.threadRootId), sql`json_extract(${events.payload}, '$.ts') = ${key.threadRootId}`)
          : isNull(events.threadRootId),
      ),
    )
    .orderBy(desc(sql`${events}.rowid`))
    .limit(1)
    .get();
  return row?.principalId ?? null;
}

interface TailLine {
  sortTs: number;
  surfaceTs: string | null; // their messages carry one (a ref target); own acts render bare
  line: string; // formatted WITHOUT a ref prefix — the renderer prepends the minted ref
  eventId?: string; // provenance for the minted ref (their messages only)
  principalId?: string | null;
}

function who(p: { principalId: string | null; principalName?: string }): string {
  return `<@${p.principalId ?? "?"}>${p.principalName ? ` (${p.principalName})` : ""}`;
}

// Delivered line + coordinates; address via refs only.
export function inboxLine(m: InboxMessage): string {
  const files = m.files?.length
    ? ` [attached: ${m.files.map((f) => `${f.name}${f.mimetype ? ` (${f.mimetype})` : ""}${f.urlPrivate ? ` url_private=${f.urlPrivate}` : ""}`).join(", ")}]`
    : "";
  return `[<#${m.venueId}>${m.threadRootId ? ` thread=${m.threadRootId}` : ""} ts=${m.ts}] ${who(m)}: ${m.text.slice(0, 2500)}${files}`;
}

// Already-heard tail: events and acts merged in time order so own words sit in place.
function tailOf(db: Database, identityId: string, key: ConversationKey, beforeRowid: number, selfLabel: string): TailLine[] {
  // Thread tail = replies + root; surface tail = recent top-level.
  const theirsEvents = orm(db)
    .select({
      id: events.id,
      principalId: events.principalId,
      text: sql<string | null>`json_extract(${events.payload}, '$.text')`,
      name: sql<string | null>`json_extract(${events.payload}, '$.principalName')`,
      ts: sql<string | null>`json_extract(${events.payload}, '$.ts')`,
    })
    .from(events)
    .where(
      and(
        eq(events.identityId, identityId),
        eq(events.venueId, key.venueId),
        sql`${events}.rowid <= ${beforeRowid}`,
        inArray(events.kind, ["addressed_message", "observed_message"]),
        key.threadRootId
          ? or(eq(events.threadRootId, key.threadRootId), sql`json_extract(${events.payload}, '$.ts') = ${key.threadRootId}`)
          : isNull(events.threadRootId),
      ),
    )
    .orderBy(desc(sql`${events}.rowid`))
    .limit(TAIL_LIMIT)
    .all();
  const theirs: TailLine[] = theirsEvents.toReversed().map((r) => ({
    sortTs: r.ts ? Number(r.ts) : 0,
    surfaceTs: r.ts,
    eventId: r.id,
    principalId: r.principalId,
    line: `${who({ principalId: r.principalId, ...(r.name ? { principalName: r.name } : {}) })}: ${(r.text ?? "").slice(0, 300)}`,
  }));
  const hersActs = orm(db)
    .select({ kind: acts.kind, ts: acts.ts, text: acts.text, at: acts.at })
    .from(acts)
    .where(and(eq(acts.identityId, identityId), eq(acts.venueId, key.venueId), sameNullable(acts.threadRootId, key.threadRootId)))
    .orderBy(desc(acts.id))
    .limit(TAIL_LIMIT)
    .all();
  const hers: TailLine[] = hersActs.toReversed().map((a) => ({
    sortTs: a.ts ? Number(a.ts) : Date.parse(a.at) / 1000,
    surfaceTs: null,
    line: a.kind === "posted" ? `${selfLabel}: ${(a.text ?? "").slice(0, 300)}` : `${selfLabel} reacted :${a.text}: to ts=${a.ts}`,
  }));
  return [...theirs, ...hers].toSorted((a, b) => a.sortTs - b.sortTs).slice(-TAIL_LIMIT);
}

export interface RenderOpts {
  // New lines this render delivers; mark is optional per-line prefix.
  newMessages: InboxMessage[];
  mark?: ((m: InboxMessage) => string) | undefined;
  judgment?: ConversationJudgment | undefined;
  stance?: StanceState | undefined;
  // Tail excludes rows at/before this rowid.
  beforeRowid: number;
  // Label for own acts in the tail.
  selfLabel?: "you" | "she" | undefined;
  // When set, mint refs for conversation + each message line.
  refs?: RefTable | undefined;
}

// Render conversation into prompt text (+ refs when opts.request them).
export function renderConversation(db: Database, identityId: string, key: ConversationKey, opts: RenderOpts): string {
  const where = `<#${key.venueId}>${key.threadRootId ? ` thread=${key.threadRootId}` : ""}`;
  const selfLabel = opts.selfLabel ?? "you";
  const mark = opts.mark ?? (() => "");
  const headerBits: string[] = [];
  if (opts.stance?.stance === "out") {
    headerBits.push(`stepped out of this conversation${opts.stance.at ? ` at ${opts.stance.at}` : ""}${opts.stance.why ? ` — "${opts.stance.why}"` : ""}`);
  }
  if (opts.judgment && opts.judgment.holds > 0) {
    headerBits.push(`the ear held it ${opts.judgment.holds}x without a wake: ${opts.judgment.holdWhys.map((w) => `"${w}"`).join("; ")}`);
  }
  if (opts.judgment?.wakeWhy) {
    headerBits.push(`first read: ${opts.judgment.wakeWhy}`);
  }
  // Conversation ref provenance = newest delivered line.
  const lastNew = opts.newMessages.at(-1);
  const cref = opts.refs?.mint({
    venueId: key.venueId,
    threadRootId: key.threadRootId,
    via: "rendered",
    ...(lastNew ? { eventId: lastNew.id, principalId: lastNew.principalId } : {}),
  });
  const address = cref ? `${cref} ${where}` : where;
  const header = headerBits.length > 0 || cref ? `[${address}${headerBits.length > 0 ? `: ${headerBits.join(" | ")}` : ""}]\n` : "";
  const tag = (surfaceTs: string | null, eventId?: string, principalId?: string | null): string => {
    if (!opts.refs || !surfaceTs) return "";
    return `[${opts.refs.mint({
      venueId: key.venueId,
      threadRootId: key.threadRootId,
      ts: surfaceTs,
      via: "rendered",
      ...(eventId ? { eventId } : {}),
      ...(principalId !== undefined ? { principalId } : {}),
    })}] `;
  };
  const tail = tailOf(db, identityId, key, opts.beforeRowid, selfLabel);
  const tailBlock = tail.length > 0
    ? `earlier in ${where} (already heard — so you can tell who is talking to whom):\n${tail.map((t) => `  ${tag(t.surfaceTs, t.eventId, t.principalId)}${t.line}`).join("\n")}\n`
    : "";
  const newLines = opts.newMessages.map((m) => `${tag(m.ts, m.id, m.principalId)}${mark(m)}${inboxLine(m)}`).join("\n");
  return `${header}${tailBlock}${newLines}`;
}
