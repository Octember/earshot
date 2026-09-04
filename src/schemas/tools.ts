import { z } from "zod";
import { RefTagSchema, MemoryTierSchema } from "./common";

export const ReplyArgsSchema = z.object({
  text: z.string(),
  ref: RefTagSchema,
});

export const ReactArgsSchema = z.object({
  emoji: z.string(),
  ref: RefTagSchema,
});

export const SetWakeArgsSchema = z.object({
  wakeAt: z.string(),
});

export const StepBackArgsSchema = z.object({
  why: z.string(),
  ref: RefTagSchema,
});

export const TaskReportArgsSchema = z.object({
  report: z.string(),
});

export const TaskAskArgsSchema = z.object({
  question: z.string(),
});

export const EmptyArgsSchema = z.object({}).strict();

export const MemoryWriteArgsSchema = z.object({
  content: z.string(),
  provenance: z.array(z.unknown()).optional(),
  tier: MemoryTierSchema.optional(),
});

export const MemoryRetractArgsSchema = z.object({ id: z.string() });

export const MemoryTierArgsSchema = z.object({
  id: z.string(),
  tier: MemoryTierSchema,
});

export const SearchArgsSchema = z.object({
  query: z.string(),
  venueId: z.string().optional(),
  principalId: z.string().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  limit: z.number().optional(),
});

export const VerdictArgsSchema = z.object({
  decision: z.enum(["hold", "wake"]),
  why: z.string(),
  ref: RefTagSchema,
});

export const ReadChannelArgsSchema = z.object({
  channel: z.string(),
  limit: z.number().optional(),
});

export const ReadThreadArgsSchema = z.object({
  channel: z.string(),
  thread_ts: z.string(),
  limit: z.number().optional(),
});

export const DownloadFileArgsSchema = z.object({
  url: z.string(),
  name: z.string().optional(),
});

export const UploadFileArgsSchema = z.object({
  path: z.string(),
  venueId: z.string(),
  threadRootId: z.string().nullable().optional(),
  title: z.string().optional(),
});

export const EmojiSetArgsSchema = z.object({
  name: z.string(),
  url: z.string(),
});
