import type { InboxMessage } from "./inbox";
import type { InboxMessageFile } from "../schemas/event-payload";
import type { ConversationJudgment, ConversationKey, StanceState } from "./conversations-stance";
import type { RefTable, RefTarget } from "./conversations-refs";

export function formatVenueWhere(key: ConversationKey): string {
  return `<#${key.venueId}>${key.threadRootId ? ` thread=${key.threadRootId}` : ""}`;
}

export function formatWho(person: { principalId: string | null; principalName?: string }): string {
  return `<@${person.principalId ?? "?"}>${person.principalName ? ` (${person.principalName})` : ""}`;
}

function formatAttachedFiles(files: InboxMessageFile[]): string {
  const parts = files.map((file) => {
    const mime = file.mimetype ? ` (${file.mimetype})` : "";
    const url = file.urlPrivate ? ` url_private=${file.urlPrivate}` : "";
    return `${file.name}${mime}${url}`;
  });
  return ` [attached: ${parts.join(", ")}]`;
}

export function formatInboxLine(message: InboxMessage): string {
  const coords = `[<#${message.venueId}>${message.threadRootId ? ` thread=${message.threadRootId}` : ""} ts=${message.ts}]`;
  const files = message.files?.length ? formatAttachedFiles(message.files) : "";
  return `${coords} ${formatWho(message)}: ${message.text.slice(0, 2500)}${files}`;
}

export function buildHeaderBits(
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

export function mintLineRef(
  refs: RefTable | undefined,
  key: ConversationKey,
  surfaceTs: string | null,
  eventId?: string,
  principalId?: string | null,
): string {
  if (!refs || !surfaceTs) return "";
  const target: RefTarget = {
    venueId: key.venueId,
    threadRootId: key.threadRootId,
    ts: surfaceTs,
    via: "rendered",
    ...(eventId ? { eventId } : {}),
    ...(principalId !== undefined ? { principalId } : {}),
  };
  return `[${refs.mint(target)}] `;
}

export interface TailLineView {
  surfaceTs: string | null;
  line: string;
  eventId?: string;
  principalId?: string | null;
}

export function formatTailBlock(
  where: string,
  tail: TailLineView[],
  tag: (surfaceTs: string | null, eventId?: string, principalId?: string | null) => string,
): string {
  if (tail.length === 0) return "";
  const lines = tail.map(
    (row) => `  ${tag(row.surfaceTs, row.eventId, row.principalId)}${row.line}`,
  );
  return `earlier in ${where} (already heard — so you can tell who is talking to whom):\n${lines.join("\n")}\n`;
}

export function formatNewMessageLines(
  messages: InboxMessage[],
  mark: (message: InboxMessage) => string,
  tag: (surfaceTs: string | null, eventId?: string, principalId?: string | null) => string,
): string {
  return messages
    .map(
      (message) =>
        `${tag(message.ts, message.id, message.principalId)}${mark(message)}${formatInboxLine(message)}`,
    )
    .join("\n");
}
