import { z } from "zod";
import { AddressModeSchema, looseString } from "./common";

export const InboxMessageFileSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  mimetype: z.string().optional(),
  urlPrivate: z.string().optional(),
  size: z.number().optional(),
});

export type InboxMessageFile = z.infer<typeof InboxMessageFileSchema>;

export const StrictMessageFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimetype: z.string(),
  urlPrivate: z.string(),
  size: z.number(),
});

function parseInboxFiles(value: unknown): z.infer<typeof InboxMessageFileSchema>[] | undefined {
  if (!Array.isArray(value)) return void 0;
  const files: z.infer<typeof InboxMessageFileSchema>[] = [];
  for (const item of value) {
    const parsed = InboxMessageFileSchema.safeParse(item);
    if (parsed.success) files.push(parsed.data);
  }
  return files.length > 0 ? files : void 0;
}

export const EventPayloadSchema = z.object({
  text: looseString(),
  ts: z.preprocess((value) => (typeof value === "string" ? value : null), z.string().nullable()),
  principalName: z.string().optional(),
  addressMode: AddressModeSchema.optional(),
  files: z.preprocess(parseInboxFiles, z.array(InboxMessageFileSchema).optional()),
  isBot: z.boolean().optional(),
});

export type EventPayload = z.infer<typeof EventPayloadSchema>;

export function parseEventPayload(raw: unknown): EventPayload {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return { text: "", ts: null };
    }
  }
  const parsed = EventPayloadSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return { text: "", ts: null };
}

export function parseStrictMessageFiles(value: unknown) {
  if (!Array.isArray(value)) return void 0;
  const files: z.infer<typeof StrictMessageFileSchema>[] = [];
  for (const item of value) {
    const parsed = StrictMessageFileSchema.safeParse(item);
    if (parsed.success) files.push(parsed.data);
  }
  return files.length > 0 ? files : void 0;
}

function rawPayloadFiles(raw: unknown): unknown {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return void 0;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value) && "files" in value) {
    return value.files;
  }
  return void 0;
}

export function messageFilesFromPayload(
  raw: unknown,
  parsedFiles?: unknown,
): z.infer<typeof StrictMessageFileSchema>[] | undefined {
  return parseStrictMessageFiles(parsedFiles) ?? parseStrictMessageFiles(rawPayloadFiles(raw));
}
