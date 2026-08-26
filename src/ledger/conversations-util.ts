import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { asString, isRecord, parseJson } from "../guard";
import { acts, conversations, events } from "./schema";
import type { InboxMessage } from "./inbox";

export const DELIVERABLE_KINDS = ["addressed_message", "observed_message", "external_signal"] as const;

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

export function sameNullable(column: typeof events.threadRootId | typeof acts.threadRootId, value: string | null) {
  return value === null ? isNull(column) : eq(column, value);
}

export function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asInboxKind(v: string): InboxMessage["kind"] {
  return v === "addressed_message" || v === "external_signal" ? v : "observed_message";
}

function asAddressMode(v: unknown): InboxMessage["addressMode"] | undefined {
  return v === "mention" || v === "dm" || v === "thread_follow" ? v : undefined;
}

function parseFiles(v: unknown): InboxMessage["files"] {
  if (!Array.isArray(v)) return undefined;
  const files: NonNullable<InboxMessage["files"]> = [];
  for (const item of v) {
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
  const p = isRecord(parsed) ? parsed : {};
  const addressMode = asAddressMode(p.addressMode);
  const files = parseFiles(p.files);
  return {
    text: asString(p.text),
    ts: typeof p.ts === "string" ? p.ts : null,
    ...(typeof p.principalName === "string" ? { principalName: p.principalName } : {}),
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
  return or(sql`ifnull(${conversations.stance}, 'none') != 'out'`, eq(events.kind, "external_signal"), isNotNull(conversations.wakeWhy));
}

export function messagesOf(rows: Array<{ rowid: number } & Pick<typeof events.$inferSelect, "id" | "kind" | "venueId" | "threadRootId" | "principalId" | "payload" | "receivedAt">>): InboxMessage[] {
  return rows.map((r) => {
    const p = payloadOf(r.payload);
    return {
      rowid: r.rowid,
      id: r.id,
      kind: asInboxKind(r.kind),
      venueId: r.venueId,
      threadRootId: r.threadRootId,
      principalId: r.principalId,
      text: p.text,
      ts: p.ts,
      receivedAt: r.receivedAt,
      ...(p.principalName ? { principalName: p.principalName } : {}),
      ...(p.addressMode ? { addressMode: p.addressMode } : {}),
      ...(p.files?.length ? { files: p.files } : {}),
    };
  });
}
