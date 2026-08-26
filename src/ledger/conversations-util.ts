import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { asString, isRecord, parseJson } from "../guard";
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

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

function asInboxKind(value: string): InboxMessage["kind"] {
  return value === "addressed_message" || value === "external_signal" ? value : "observed_message";
}

function asAddressMode(value: unknown): InboxMessage["addressMode"] | undefined {
  return value === "mention" || value === "dm" || value === "thread_follow" ? value : undefined;
}

function parseFiles(value: unknown): InboxMessage["files"] {
  if (!Array.isArray(value)) return undefined;
  const files: NonNullable<InboxMessage["files"]> = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string") continue;
    files.push({
      name: item.name,
      ...(typeof item.mimetype === "string" ? { mimetype: item.mimetype } : {}),
      ...(typeof item.urlPrivate === "string" ? { urlPrivate: item.urlPrivate } : {}),
      ...(typeof item.size === "number" ? { size: item.size } : {}),
    });
  }
  return files.length > 0 ? files : undefined;
}

export function payloadOf(raw: unknown): {
  text: string;
  ts: string | null;
  principalName?: string;
  addressMode?: InboxMessage["addressMode"];
  files?: InboxMessage["files"];
} {
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  const payload = isRecord(parsed) ? parsed : {};
  const addressMode = asAddressMode(payload.addressMode);
  const files = parseFiles(payload.files);
  return {
    text: asString(payload.text),
    ts: typeof payload.ts === "string" ? payload.ts : null,
    ...(typeof payload.principalName === "string" ? { principalName: payload.principalName } : {}),
    ...(addressMode ? { addressMode } : {}),
    ...(files?.length ? { files } : {}),
  };
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
    const payload = payloadOf(row.payload);
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
