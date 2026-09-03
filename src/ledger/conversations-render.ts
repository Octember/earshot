import type { Database } from "bun:sqlite";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { orm } from "./db";
import { acts, events } from "./schema";
import type { Event } from "./schema";
import type { MessageFile } from "@bevyl-ai/agent-tools";
import type { Anchor } from "./tasks-types";
import type { Conversation } from "./schema";
import { conversationEventsWhere, DELIVERABLE_KINDS, sameNullable } from "./conversations-util";
import { conversationOf, type RefTable, type RefTarget } from "./conversations-refs";
import { venueCoords } from "../prompt/format";

const TAIL_LIMIT = 8;
const MESSAGE_TEXT_LIMIT = 2500;
const TAIL_TEXT_LIMIT = 300;

function formatWho(person: {
  principalId: string | null;
  principalName?: string | undefined;
}): string {
  return `<@${person.principalId ?? "?"}>${person.principalName ? ` (${person.principalName})` : ""}`;
}

function formatAttachments(files: MessageFile[]): string {
  const parts = files.map((file) => {
    const mime = file.mimetype ? ` (${file.mimetype})` : "";
    return `${file.name}${mime}`;
  });
  return ` [attached: ${parts.join(", ")}]`;
}

function formatMessageBody(message: Event): string {
  const files = message.payload.files?.length ? formatAttachments(message.payload.files) : "";
  return `${formatWho(message)}: ${message.payload.text.slice(0, MESSAGE_TEXT_LIMIT)}${files}`;
}

function contextNote(
  stance: Conversation | null | undefined,
  wakeWhy: string | null | undefined,
): string {
  const parts: string[] = [];
  if (stance?.stance === "out") {
    parts.push(`Out${stance.stanceWhy ? `: ${stance.stanceWhy}` : ""}`);
  }
  if (wakeWhy) parts.push(wakeWhy);
  return parts.join(" · ");
}

function mintRenderedRef(
  refs: RefTable | undefined,
  key: Anchor,
  surfaceTs: string | null | undefined,
  provenance?: { eventId?: string; principalId?: string | null },
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
  key: Anchor,
  refs: RefTable | undefined,
  stance: Conversation | null | undefined,
  wakeWhy: string | null | undefined,
  anchorMessage: Event | undefined,
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

export function lastSpeakerIn(db: Database, identityId: string, key: Anchor): string | null {
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
  key: Anchor,
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
        ? `${selfLabel}: ${act.text.slice(0, TAIL_TEXT_LIMIT)}`
        : `${selfLabel} reacted :${act.text}: to ts=${act.ts}`,
  }));

  return [...fromThem, ...fromSelf].toSorted((a, b) => a.sortTs - b.sortTs).slice(-TAIL_LIMIT);
}

function renderTail(entries: TailEntry[]): string {
  if (entries.length === 0) return "";
  return `Earlier:\n${entries.map((entry) => `  ${entry.text}`).join("\n")}\n`;
}

function renderNewMessages(
  key: Anchor,
  refs: RefTable | undefined,
  messages: Event[],
  mark: (message: Event) => string,
): string {
  if (messages.length === 0) return "";
  return `New:\n${messages
    .map(
      (message) =>
        `  ${mintRenderedRef(refs, key, message.payload.ts, { eventId: message.id, principalId: message.principalId })}${mark(message)}${formatMessageBody(message)}`,
    )
    .join("\n")}\n`;
}

export interface RenderOpts {
  newMessages: Event[];
  mark?: ((message: Event) => string) | undefined;
  wakeWhy?: string | null | undefined;
  stance?: Conversation | null | undefined;
  beforeRowid: number;
  selfLabel?: "you" | "she" | undefined;
  refs?: RefTable | undefined;
}

export function renderConversation(
  db: Database,
  identityId: string,
  key: Anchor,
  opts: RenderOpts,
): string {
  const selfLabel = opts.selfLabel ?? "you";
  const mark = opts.mark ?? (() => "");
  const header = renderHeader(key, opts.refs, opts.stance, opts.wakeWhy, opts.newMessages.at(-1));
  const tail = renderTail(loadConversationTail(db, identityId, key, opts.beforeRowid, selfLabel));
  const body = renderNewMessages(key, opts.refs, opts.newMessages, mark);
  return `${header}${tail}${body}`;
}
