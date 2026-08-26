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
  let nextId = 0;
  const table = new Map<string, RefTarget>();
  return {
    mint(target) {
      const ref = `r${++nextId}`;
      table.set(ref, target);
      return ref;
    },
    get: (ref) => table.get(ref),
  };
}

// Message ref → conversation (thread, or thread rooted by top-level msg).
export function conversationOf(target: RefTarget): ConversationKey {
  return { venueId: target.venueId, threadRootId: target.threadRootId ?? target.ts ?? null };
}

// Provenance for durable writes: mint-time if present, else ledger event in the ref's conversation.
export function provenanceOfRef(db: Database, identityId: string, target: RefTarget): { eventId: string; principalId: string | null } | null {
  if (target.eventId) return { eventId: target.eventId, principalId: target.principalId ?? null };
  if (target.ts) {
    const exact = orm(db)
      .select({ id: events.id, principalId: events.principalId })
      .from(events)
      .where(and(eq(events.identityId, identityId), eq(events.venueId, target.venueId), sql`json_extract(${events.payload}, '$.ts') = ${target.ts}`))
      .orderBy(desc(sql`${events}.rowid`))
      .limit(1)
      .get();
    if (exact) return { eventId: exact.id, principalId: exact.principalId };
  }
  const key = conversationOf(target);
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

function who(person: { principalId: string | null; principalName?: string }): string {
  return `<@${person.principalId ?? "?"}>${person.principalName ? ` (${person.principalName})` : ""}`;
}

// Delivered line + coordinates; address via refs only.
export function inboxLine(message: InboxMessage): string {
  const files = message.files?.length
    ? ` [attached: ${message.files.map((file) => `${file.name}${file.mimetype ? ` (${file.mimetype})` : ""}${file.urlPrivate ? ` url_private=${file.urlPrivate}` : ""}`).join(", ")}]`
    : "";
  return `[<#${message.venueId}>${message.threadRootId ? ` thread=${message.threadRootId}` : ""} ts=${message.ts}] ${who(message)}: ${message.text.slice(0, 2500)}${files}`;
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
  const theirs: TailLine[] = theirsEvents.toReversed().map((row) => ({
    sortTs: row.ts ? Number(row.ts) : 0,
    surfaceTs: row.ts,
    eventId: row.id,
    principalId: row.principalId,
    line: `${who({ principalId: row.principalId, ...(row.name ? { principalName: row.name } : {}) })}: ${(row.text ?? "").slice(0, 300)}`,
  }));
  const hersActs = orm(db)
    .select({ kind: acts.kind, ts: acts.ts, text: acts.text, at: acts.at })
    .from(acts)
    .where(and(eq(acts.identityId, identityId), eq(acts.venueId, key.venueId), sameNullable(acts.threadRootId, key.threadRootId)))
    .orderBy(desc(acts.id))
    .limit(TAIL_LIMIT)
    .all();
  const hers: TailLine[] = hersActs.toReversed().map((act) => ({
    sortTs: act.ts ? Number(act.ts) : Date.parse(act.at) / 1000,
    surfaceTs: null,
    line: act.kind === "posted" ? `${selfLabel}: ${(act.text ?? "").slice(0, 300)}` : `${selfLabel} reacted :${act.text}: to ts=${act.ts}`,
  }));
  return [...theirs, ...hers].toSorted((a, b) => a.sortTs - b.sortTs).slice(-TAIL_LIMIT);
}

export interface RenderOpts {
  // New lines this render delivers; mark is optional per-line prefix.
  newMessages: InboxMessage[];
  mark?: ((message: InboxMessage) => string) | undefined;
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
    headerBits.push(`the ear held it ${opts.judgment.holds}x without a wake: ${opts.judgment.holdWhys.map((why) => `"${why}"`).join("; ")}`);
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
    ? `earlier in ${where} (already heard — so you can tell who is talking to whom):\n${tail.map((tailLine) => `  ${tag(tailLine.surfaceTs, tailLine.eventId, tailLine.principalId)}${tailLine.line}`).join("\n")}\n`
    : "";
  const newLines = opts.newMessages.map((message) => `${tag(message.ts, message.id, message.principalId)}${mark(message)}${inboxLine(message)}`).join("\n");
  return `${header}${tailBlock}${newLines}`;
}
