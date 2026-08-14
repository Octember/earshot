// The events table IS the inbox — deduped, identity-scoped, durable. Delivery itself is
// per-conversation (ledger/conversations.ts owns the watermarks); this module keeps the row
// shape and the raw after-rowid read that §5.5's moved-check uses.
import type { Database } from "bun:sqlite";
import { asString, isRecord, parseJson } from "../guard";
import { many } from "./db";

export interface InboxMessage {
  rowid: number;
  id: string;
  kind: "addressed_message" | "observed_message" | "external_signal";
  venueId: string | null;
  threadRootId: string | null;
  principalId: string | null;
  // The principal's human name as the adapter resolved it at ingestion (absent on events from
  // before names existed, or when the roster missed). Rendering only; principalId stays the key.
  principalName?: string;
  text: string;
  ts: string | null;
  receivedAt: string;
  // How an addressed message reached her (router.ts writes it into the payload): a direct
  // address (mention/dm) wakes the mind immediately; thread_follow is the ear's to judge.
  addressMode?: "mention" | "dm" | "thread_follow";
  // Attachment metadata as the router recorded it. urlPrivate is how a turn addresses the
  // original file (download_file) — older events carry name only.
  files?: { name: string; mimetype?: string; urlPrivate?: string; size?: number }[];
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
  return files.length ? files : undefined;
}

export function messagesAfter(db: Database, identityId: string, afterRowid: number, limit = 200): InboxMessage[] {
  const cursor = afterRowid;
  const rows = many<{
    rowid: number;
    id: string;
    kind: string;
    venue_id: string | null;
    thread_root_id: string | null;
    principal_id: string | null;
    payload: string;
    received_at: string;
  }>(
    db,
    `SELECT rowid, id, kind, venue_id, thread_root_id, principal_id, payload, received_at FROM events
       WHERE identity_id = ? AND rowid > ? AND kind IN ('addressed_message','observed_message','external_signal')
       ORDER BY rowid LIMIT ?`,
    identityId,
    cursor,
    limit,
  );
  return rows.map((r) => {
    const parsed = parseJson(r.payload);
    const p = isRecord(parsed) ? parsed : {};
    const addressMode = asAddressMode(p.addressMode);
    const files = parseFiles(p.files);
    return {
      rowid: r.rowid,
      id: r.id,
      kind: asInboxKind(r.kind),
      venueId: r.venue_id,
      threadRootId: r.thread_root_id,
      principalId: r.principal_id,
      text: asString(p.text),
      ts: typeof p.ts === "string" ? p.ts : null,
      receivedAt: r.received_at,
      ...(typeof p.principalName === "string" ? { principalName: p.principalName } : {}),
      ...(addressMode ? { addressMode } : {}),
      ...(files?.length ? { files } : {}),
    };
  });
}

