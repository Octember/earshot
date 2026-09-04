import type { Database } from "bun:sqlite";
import { and, desc, eq, lte } from "drizzle-orm";
import { orm } from "./db";
import { acts, events } from "./schema";
import type { Event, SlackFile } from "./schema";
import type { Anchor } from "./tasks-types";
import type { PendingConversation } from "./conversations-stance";
import { conversationEventsWhere, sameNullable } from "./conversations-util";
import type { RefTable, RefTarget } from "./conversations-refs";
import { venueCoords } from "../prompt/format";

const TAIL_LIMIT = 8;
const TAIL_TEXT_LIMIT = 300;

function formatWho(person: { principalId: string | null; principalName: string | null }): string {
  return `<@${person.principalId ?? "?"}>${person.principalName ? ` (${person.principalName})` : ""}`;
}

function formatAttachments(files: SlackFile[]): string {
  return ` [attached: ${files.map((file) => `${file.name ?? file.id} (${file.mimetype})`).join(", ")}]`;
}

function mintRenderedRef(
  refs: RefTable,
  key: Anchor,
  surfaceTs: string | null | undefined,
  provenance?: { eventId?: number; principalId?: string | null },
): string {
  if (!surfaceTs) return "";
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
      principalId: events.principalId,
      text: events.text,
      name: events.principalName,
      ts: events.ts,
    })
    .from(events)
    .where(conversationEventsWhere(identityId, key, lte(events.rowid, beforeRowid)))
    .orderBy(desc(events.rowid))
    .limit(TAIL_LIMIT)
    .all();

  const fromThem: TailEntry[] = inbound.toReversed().map((row) => ({
    sortTs: Number(row.ts),
    text: `${formatWho({ principalId: row.principalId, principalName: row.name })}: ${row.text.slice(0, TAIL_TEXT_LIMIT)}`,
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

export function renderConversation(
  db: Database,
  identityId: string,
  key: Anchor,
  opts: {
    newMessages: Event[];
    mark?: ((message: Event) => string) | undefined;
    out?: string | null | undefined;
    beforeRowid: number;
    selfLabel: "you" | "she";
    refs: RefTable;
  },
): string {
  const mark = opts.mark ?? (() => "");
  const anchorMessage = opts.newMessages.at(-1);
  const convRef = opts.refs.mint({
    venueId: key.venueId,
    threadRootId: key.threadRootId,
    via: "rendered",
    ...(anchorMessage
      ? { eventId: anchorMessage.rowid, principalId: anchorMessage.principalId }
      : {}),
  });
  const head = `## ${venueCoords(key)} [${convRef}]`;
  const wakeWhy = opts.newMessages.findLast((message) => message.wakeWhy)?.wakeWhy;
  const note = [...(opts.out ? [`Out: ${opts.out}`] : []), ...(wakeWhy ? [wakeWhy] : [])].join(
    " · ",
  );
  const header = note ? `${head}\n${note}\n` : `${head}\n`;
  const entries = loadConversationTail(db, identityId, key, opts.beforeRowid, opts.selfLabel);
  const tail =
    entries.length > 0 ? `Earlier:\n${entries.map((entry) => `  ${entry.text}`).join("\n")}\n` : "";
  const body =
    opts.newMessages.length === 0
      ? ""
      : `New:\n${opts.newMessages
          .map(
            (message) =>
              `  ${mintRenderedRef(opts.refs, key, message.ts, { eventId: message.rowid, principalId: message.principalId })}${formatWho(message)}${mark(message)}: ${message.text.slice(0, 2500)}${message.files?.length ? formatAttachments(message.files) : ""}`,
          )
          .join("\n")}\n`;
  return `${header}${tail}${body}`;
}

export function renderBatch(
  db: Database,
  identityId: string,
  convos: PendingConversation[],
  refs: RefTable,
  opts: { mark: (message: Event) => string; selfLabel: "you" | "she" },
): string {
  return convos
    .map((convo) =>
      renderConversation(db, identityId, convo, {
        newMessages: convo.messages,
        mark: opts.mark,
        out: convo.out,
        selfLabel: opts.selfLabel,
        beforeRowid: convo.messages[0]!.rowid - 1,
        refs,
      }),
    )
    .join("\n\n");
}
