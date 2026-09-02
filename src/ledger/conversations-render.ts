import type { Database } from "bun:sqlite";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { orm } from "./db";
import { acts, events } from "./schema";
import type { InboxMessage } from "./inbox";
import type { InboxMessageFile } from "../schemas/event-payload";
import type { ConversationKey, StanceState } from "./conversations-stance";
import { conversationEventsWhere, DELIVERABLE_KINDS, sameNullable } from "./conversations-util";
import { conversationOf, type RefTable, type RefTarget } from "./conversations-refs";
import { venueCoords } from "../prompt/format";

export { conversationOf, makeRefTable, type RefTable, type RefTarget } from "./conversations-refs";

const TAIL_LIMIT = 8;
const MESSAGE_TEXT_LIMIT = 2500;
const TAIL_TEXT_LIMIT = 300;

function formatWho(person: { principalId: string | null; principalName?: string }): string {
  return `<@${person.principalId ?? "?"}>${person.principalName ? ` (${person.principalName})` : ""}`;
}

function formatAttachments(files: InboxMessageFile[]): string {
  const parts = files.map((file) => {
    const mime = file.mimetype ? ` (${file.mimetype})` : "";
    return `${file.name}${mime}`;
  });
  return ` [attached: ${parts.join(", ")}]`;
}

function formatMessageBody(message: InboxMessage): string {
  const files = message.files?.length ? formatAttachments(message.files) : "";
  return `${formatWho(message)}: ${message.text.slice(0, MESSAGE_TEXT_LIMIT)}${files}`;
}

function contextNote(stance: StanceState | undefined, wakeWhy: string | null | undefined): string {
  const parts: string[] = [];
  if (stance?.stance === "out") {
    parts.push(`Out${stance.why ? `: ${stance.why}` : ""}`);
  }
  if (wakeWhy) parts.push(wakeWhy);
  return parts.join(" · ");
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
  wakeWhy: string | null | undefined,
  anchorMessage: InboxMessage | undefined,
): string {
  const where = venueCoords(key);
  const note = contextNote(stance, wakeWhy);
  const convRef = refs?.mint({
    venueId: key.venueId,
    threadRootId: key.threadRootId,
    via: "rendered",
    ...(anchorMessage ? { eventId: anchorMessage.id, principalId: anchorMessage.principalId } : {}),
  });
  const head = convRef ? `## ${where} [${convRef}]` : `## ${where}`;
  return note ? `${head}\n${note}\n` : `${head}\n`;
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
  text: string;
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
    text:
      act.kind === "posted"
        ? `${selfLabel}: ${(act.text ?? "").slice(0, TAIL_TEXT_LIMIT)}`
        : `${selfLabel} reacted :${act.text}: to ts=${act.ts}`,
  }));

  return [...fromThem, ...fromSelf].toSorted((a, b) => a.sortTs - b.sortTs).slice(-TAIL_LIMIT);
}

function renderTail(entries: TailEntry[]): string {
  if (entries.length === 0) return "";
  return `Earlier:\n${entries.map((entry) => `  ${entry.text}`).join("\n")}\n`;
}

function renderNewMessages(
  key: ConversationKey,
  refs: RefTable | undefined,
  messages: InboxMessage[],
  mark: (message: InboxMessage) => string,
): string {
  if (messages.length === 0) return "";
  return `New:\n${messages
    .map(
      (message) =>
        `  ${mintRenderedRef(refs, key, message.ts, { eventId: message.id, principalId: message.principalId })}${mark(message)}${formatMessageBody(message)}`,
    )
    .join("\n")}\n`;
}

export interface RenderOpts {
  newMessages: InboxMessage[];
  mark?: ((message: InboxMessage) => string) | undefined;
  wakeWhy?: string | null | undefined;
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
  const header = renderHeader(key, opts.refs, opts.stance, opts.wakeWhy, opts.newMessages.at(-1));
  const tail = renderTail(loadConversationTail(db, identityId, key, opts.beforeRowid, selfLabel));
  const body = renderNewMessages(key, opts.refs, opts.newMessages, mark);
  return `${header}${tail}${body}`;
}
