import { and, eq, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { ConversationKey } from "./conversations-stance";
import { looseStringArray } from "../schemas/common";
import { parseEventPayload } from "../schemas/event-payload";
import { acts, conversations, events } from "./schema";
import type { InboxMessage } from "./inbox";

export const DELIVERABLE_KINDS = [
  "addressed_message",
  "observed_message",
  "external_signal",
] as const;

export const eventCols = {
  rowid: sql<number>`${events}.rowid`.as("rowid"),
  id: events.id,
  kind: events.kind,
  venueId: events.venueId,
  threadRootId: events.threadRootId,
  principalId: events.principalId,
  payload: events.payload,
  receivedAt: events.receivedAt,
};

export function sameNullable(
  column: typeof events.threadRootId | typeof acts.threadRootId,
  value: string | null,
) {
  return value === null ? isNull(column) : eq(column, value);
}

// Thread replies + root message ts, or top-level channel lines when threadRootId is null.
export function threadScopeFilter(threadRootId: string | null) {
  return threadRootId
    ? or(
        eq(events.threadRootId, threadRootId),
        sql`json_extract(${events.payload}, '$.ts') = ${threadRootId}`,
      )
    : isNull(events.threadRootId);
}

export function conversationEventsWhere(identityId: string, key: ConversationKey, extra?: SQL) {
  const scope = and(
    eq(events.identityId, identityId),
    eq(events.venueId, key.venueId),
    threadScopeFilter(key.threadRootId),
  );
  return extra ? and(scope, extra) : scope;
}

export function stringList(value: unknown): string[] {
  return looseStringArray().parse(value);
}

function asInboxKind(value: string): InboxMessage["kind"] {
  return value === "addressed_message" || value === "external_signal" ? value : "observed_message";
}

export function convoJoin() {
  return and(
    eq(conversations.identityId, events.identityId),
    eq(conversations.venueId, events.venueId),
    eq(conversations.threadRootId, sql`ifnull(${events.threadRootId}, '')`),
  );
}

export function outStanceExceptions() {
  return or(
    sql`ifnull(${conversations.stance}, 'none') != 'out'`,
    eq(events.kind, "external_signal"),
    isNotNull(conversations.wakeWhy),
  );
}

export function messagesOf(
  rows: Array<
    { rowid: number } & Pick<
      typeof events.$inferSelect,
      "id" | "kind" | "venueId" | "threadRootId" | "principalId" | "payload" | "receivedAt"
    >
  >,
): InboxMessage[] {
  return rows.map((row) => {
    const payload = parseEventPayload(row.payload);
    return {
      rowid: row.rowid,
      id: row.id,
      kind: asInboxKind(row.kind),
      venueId: row.venueId,
      threadRootId: row.threadRootId,
      principalId: row.principalId,
      text: payload.text,
      ts: payload.ts,
      receivedAt: row.receivedAt,
      ...(payload.principalName ? { principalName: payload.principalName } : {}),
      ...(payload.addressMode ? { addressMode: payload.addressMode } : {}),
      ...(payload.files?.length ? { files: payload.files } : {}),
    };
  });
}
