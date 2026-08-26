import type { Database } from "bun:sqlite";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { orm } from "./db";
import { acts, events } from "./schema";
import type { InboxMessage } from "./inbox";
import type { ConversationJudgment, ConversationKey, StanceState } from "./conversations-stance";
import { DELIVERABLE_KINDS, sameNullable, threadScopeFilter } from "./conversations-util";
import {
  buildHeaderBits,
  formatNewMessageLines,
  formatTailBlock,
  formatVenueWhere,
  formatWho,
  mintLineRef,
  type TailLineView,
} from "./conversations-render-format";
import { conversationOf, type RefTable, type RefTarget } from "./conversations-refs";

export { conversationOf, makeRefTable, type RefTable, type RefTarget } from "./conversations-refs";

const TAIL_LIMIT = 8;

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
    .where(
      and(
        eq(events.identityId, identityId),
        eq(events.venueId, key.venueId),
        inArray(events.kind, DELIVERABLE_KINDS),
        threadScopeFilter(key.threadRootId),
      ),
    )
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
    .where(
      and(
        eq(events.identityId, identityId),
        eq(events.venueId, key.venueId),
        isNotNull(events.principalId),
        threadScopeFilter(key.threadRootId),
      ),
    )
    .orderBy(desc(sql`${events}.rowid`))
    .limit(1)
    .get();
  return row?.principalId ?? null;
}

interface TailLine extends TailLineView {
  sortTs: number;
}

function tailOf(
  db: Database,
  identityId: string,
  key: ConversationKey,
  beforeRowid: number,
  selfLabel: string,
): TailLine[] {
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
        threadScopeFilter(key.threadRootId),
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
    line: `${formatWho({ principalId: row.principalId, ...(row.name ? { principalName: row.name } : {}) })}: ${(row.text ?? "").slice(0, 300)}`,
  }));
  const hersActs = orm(db)
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
  const hers: TailLine[] = hersActs.toReversed().map((act) => ({
    sortTs: act.ts ? Number(act.ts) : Date.parse(act.at) / 1000,
    surfaceTs: null,
    line:
      act.kind === "posted"
        ? `${selfLabel}: ${(act.text ?? "").slice(0, 300)}`
        : `${selfLabel} reacted :${act.text}: to ts=${act.ts}`,
  }));
  return [...theirs, ...hers].toSorted((a, b) => a.sortTs - b.sortTs).slice(-TAIL_LIMIT);
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
  const where = formatVenueWhere(key);
  const selfLabel = opts.selfLabel ?? "you";
  const mark = opts.mark ?? (() => "");
  const headerBits = buildHeaderBits(opts.stance, opts.judgment);
  const lastNew = opts.newMessages.at(-1);
  const cref = opts.refs?.mint({
    venueId: key.venueId,
    threadRootId: key.threadRootId,
    via: "rendered",
    ...(lastNew ? { eventId: lastNew.id, principalId: lastNew.principalId } : {}),
  });
  const address = cref ? `${cref} ${where}` : where;
  const header =
    headerBits.length > 0 || cref
      ? `[${address}${headerBits.length > 0 ? `: ${headerBits.join(" | ")}` : ""}]\n`
      : "";
  const tag = (surfaceTs: string | null, eventId?: string, principalId?: string | null) =>
    mintLineRef(opts.refs, key, surfaceTs, eventId, principalId);
  const tailBlock = formatTailBlock(
    where,
    tailOf(db, identityId, key, opts.beforeRowid, selfLabel),
    tag,
  );
  const newLines = formatNewMessageLines(opts.newMessages, mark, tag);
  return `${header}${tailBlock}${newLines}`;
}
