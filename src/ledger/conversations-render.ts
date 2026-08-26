import type { Database } from "bun:sqlite";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { orm } from "./db";
import { acts, events } from "./schema";
import type { InboxMessage } from "./inbox";
import type { InboxMessageFile } from "../schemas/event-payload";
import type { ConversationJudgment, ConversationKey, StanceState } from "./conversations-stance";
import { conversationEventsWhere, DELIVERABLE_KINDS, sameNullable } from "./conversations-util";
import { conversationOf, type RefTable, type RefTarget } from "./conversations-refs";

export { conversationOf, makeRefTable, type RefTable, type RefTarget } from "./conversations-refs";

const TAIL_LIMIT = 8;
const MESSAGE_TEXT_LIMIT = 2500;
const TAIL_TEXT_LIMIT = 300;

function venueLabel(key: ConversationKey): string {
  return `<#${key.venueId}>${key.threadRootId ? ` thread=${key.threadRootId}` : ""}`;
}

function messageCoords(message: InboxMessage): string {
  const thread = message.threadRootId ? ` thread=${message.threadRootId}` : "";
  return `[<#${message.venueId}>${thread} ts=${message.ts}]`;
}

function formatWho(person: { principalId: string | null; principalName?: string }): string {
  return `<@${person.principalId ?? "?"}>${person.principalName ? ` (${person.principalName})` : ""}`;
}

function formatAttachments(files: InboxMessageFile[]): string {
  const parts = files.map((file) => {
    const mime = file.mimetype ? ` (${file.mimetype})` : "";
    const url = file.urlPrivate ? ` url_private=${file.urlPrivate}` : "";
    return `${file.name}${mime}${url}`;
  });
  return ` [attached: ${parts.join(", ")}]`;
}

function formatMessageBody(message: InboxMessage): string {
  const files = message.files?.length ? formatAttachments(message.files) : "";
  return `${messageCoords(message)} ${formatWho(message)}: ${message.text.slice(0, MESSAGE_TEXT_LIMIT)}${files}`;
}

function judgmentHeaderBits(
  stance: StanceState | undefined,
  judgment: ConversationJudgment | undefined,
): string[] {
  const bits: string[] = [];
  if (stance?.stance === "out") {
    bits.push(
      `stepped out of this conversation${stance.at ? ` at ${stance.at}` : ""}${stance.why ? ` — "${stance.why}"` : ""}`,
    );
  }
  if (judgment && judgment.holds > 0) {
    bits.push(
      `the ear held it ${judgment.holds}x without a wake: ${judgment.holdWhys.map((why) => `"${why}"`).join("; ")}`,
    );
  }
  if (judgment?.wakeWhy) bits.push(`first read: ${judgment.wakeWhy}`);
  return bits;
}

type LineProvenance = { eventId?: string; principalId?: string | null };

function mintRenderedRef(
  refs: RefTable | undefined,
  key: ConversationKey,
  surfaceTs: string | null | undefined,
  provenance?: LineProvenance,
): string {
  if (!refs || !surfaceTs) return "";
  const target: RefTarget = {
    venueId: key.venueId,
    threadRootId: key.threadRootId,
    ts: surfaceTs,
    via: "rendered",
    ...(provenance?.eventId ? { eventId: provenance.eventId } : {}),
    ...(provenance?.principalId !== undefined ? { principalId: provenance.principalId } : {}),
  };
  return `[${refs.mint(target)}] `;
}

function renderHeader(
  key: ConversationKey,
  refs: RefTable | undefined,
  stance: StanceState | undefined,
  judgment: ConversationJudgment | undefined,
  anchorMessage: InboxMessage | undefined,
): string {
  const where = venueLabel(key);
  const bits = judgmentHeaderBits(stance, judgment);
  const convRef = refs?.mint({
    venueId: key.venueId,
    threadRootId: key.threadRootId,
    via: "rendered",
    ...(anchorMessage ? { eventId: anchorMessage.id, principalId: anchorMessage.principalId } : {}),
  });
  if (bits.length === 0 && !convRef) return "";
  const address = convRef ? `${convRef} ${where}` : where;
  const suffix = bits.length > 0 ? `: ${bits.join(" | ")}` : "";
  return `[${address}${suffix}]\n`;
}

export function provenanceOfRef(
  db: Database,
  identityId: string,
  target: RefTarget,
): { eventId: string; principalId: string | null } | null {
  if (target.eventId) return { eventId: target.eventId, principalId: target.principalId ?? null };
  if (target.ts) {
    const exact = orm(db)
      .select({ id: events.id, principalId: events.principalId })
      .from(events)
      .where(
        and(
          eq(events.identityId, identityId),
          eq(events.venueId, target.venueId),
          sql`json_extract(${events.payload}, '$.ts') = ${target.ts}`,
        ),
      )
      .orderBy(desc(sql`${events}.rowid`))
      .limit(1)
      .get();
    if (exact) return { eventId: exact.id, principalId: exact.principalId };
  }
  const key = conversationOf(target);
  const row = orm(db)
    .select({ id: events.id, principalId: events.principalId })
    .from(events)
    .where(conversationEventsWhere(identityId, key, inArray(events.kind, DELIVERABLE_KINDS)))
    .orderBy(desc(sql`${events}.rowid`))
    .limit(1)
    .get();
  return row ? { eventId: row.id, principalId: row.principalId } : null;
}

export function lastSpeakerIn(
  db: Database,
  identityId: string,
  key: ConversationKey,
): string | null {
  const row = orm(db)
    .select({ principalId: events.principalId })
    .from(events)
    .where(conversationEventsWhere(identityId, key, isNotNull(events.principalId)))
    .orderBy(desc(sql`${events}.rowid`))
    .limit(1)
    .get();
  return row?.principalId ?? null;
}

interface TailEntry {
  sortTs: number;
  surfaceTs: string | null;
  text: string;
  provenance?: LineProvenance;
}

function loadConversationTail(
  db: Database,
  identityId: string,
  key: ConversationKey,
  beforeRowid: number,
  selfLabel: string,
): TailEntry[] {
  const inbound = orm(db)
    .select({
      id: events.id,
      principalId: events.principalId,
      text: sql<string | null>`json_extract(${events.payload}, '$.text')`,
      name: sql<string | null>`json_extract(${events.payload}, '$.principalName')`,
      ts: sql<string | null>`json_extract(${events.payload}, '$.ts')`,
    })
    .from(events)
    .where(
      conversationEventsWhere(
        identityId,
        key,
        and(
          sql`${events}.rowid <= ${beforeRowid}`,
          inArray(events.kind, ["addressed_message", "observed_message"]),
        ),
      ),
    )
    .orderBy(desc(sql`${events}.rowid`))
    .limit(TAIL_LIMIT)
    .all();

  const fromThem: TailEntry[] = inbound.toReversed().map((row) => ({
    sortTs: row.ts ? Number(row.ts) : 0,
    surfaceTs: row.ts,
    provenance: { eventId: row.id, principalId: row.principalId },
    text: `${formatWho({ principalId: row.principalId, ...(row.name ? { principalName: row.name } : {}) })}: ${(row.text ?? "").slice(0, TAIL_TEXT_LIMIT)}`,
  }));

  const outbound = orm(db)
    .select({ kind: acts.kind, ts: acts.ts, text: acts.text, at: acts.at })
    .from(acts)
    .where(
      and(
        eq(acts.identityId, identityId),
        eq(acts.venueId, key.venueId),
        sameNullable(acts.threadRootId, key.threadRootId),
      ),
    )
    .orderBy(desc(acts.id))
    .limit(TAIL_LIMIT)
    .all();

  const fromSelf: TailEntry[] = outbound.toReversed().map((act) => ({
    sortTs: act.ts ? Number(act.ts) : Date.parse(act.at) / 1000,
    surfaceTs: null,
    text:
      act.kind === "posted"
        ? `${selfLabel}: ${(act.text ?? "").slice(0, TAIL_TEXT_LIMIT)}`
        : `${selfLabel} reacted :${act.text}: to ts=${act.ts}`,
  }));

  return [...fromThem, ...fromSelf].toSorted((a, b) => a.sortTs - b.sortTs).slice(-TAIL_LIMIT);
}

function renderTail(
  key: ConversationKey,
  refs: RefTable | undefined,
  entries: TailEntry[],
): string {
  if (entries.length === 0) return "";
  const where = venueLabel(key);
  const lines = entries.map(
    (entry) => `  ${mintRenderedRef(refs, key, entry.surfaceTs, entry.provenance)}${entry.text}`,
  );
  return `earlier in ${where} (already heard — so you can tell who is talking to whom):\n${lines.join("\n")}\n`;
}

function renderNewMessages(
  key: ConversationKey,
  refs: RefTable | undefined,
  messages: InboxMessage[],
  mark: (message: InboxMessage) => string,
): string {
  return messages
    .map(
      (message) =>
        `${mintRenderedRef(refs, key, message.ts, { eventId: message.id, principalId: message.principalId })}${mark(message)}${formatMessageBody(message)}`,
    )
    .join("\n");
}

export interface RenderOpts {
  newMessages: InboxMessage[];
  mark?: ((message: InboxMessage) => string) | undefined;
  judgment?: ConversationJudgment | undefined;
  stance?: StanceState | undefined;
  beforeRowid: number;
  selfLabel?: "you" | "she" | undefined;
  refs?: RefTable | undefined;
}

export function renderConversation(
  db: Database,
  identityId: string,
  key: ConversationKey,
  opts: RenderOpts,
): string {
  const selfLabel = opts.selfLabel ?? "you";
  const mark = opts.mark ?? (() => "");
  const header = renderHeader(key, opts.refs, opts.stance, opts.judgment, opts.newMessages.at(-1));
  const tail = renderTail(
    key,
    opts.refs,
    loadConversationTail(db, identityId, key, opts.beforeRowid, selfLabel),
  );
  const body = renderNewMessages(key, opts.refs, opts.newMessages, mark);
  return `${header}${tail}${body}`;
}
