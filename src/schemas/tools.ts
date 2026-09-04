import { z } from "zod";

export const ReplyArgsSchema = z.object({
  text: z.string(),
  channel: z.string(),
  thread_ts: z.string().optional(),
});

export const ReactArgsSchema = z.object({
  emoji: z.string(),
  channel: z.string(),
  ts: z.string(),
});

export const SetWakeArgsSchema = z.object({
  wakeAt: z.string(),
});

export const StepBackArgsSchema = z.object({
  why: z.string(),
  channel: z.string(),
  thread_ts: z.string(),
});

export const TaskReportArgsSchema = z.object({
  report: z.string(),
});

export const TaskAskArgsSchema = z.object({
  question: z.string(),
});

export const EmptyArgsSchema = z.object({}).strict();

export const VerdictArgsSchema = z.object({
  decision: z.enum(["hold", "wake"]),
  why: z.string(),
  channel: z.string(),
  thread_ts: z.string(),
});

export const SearchArgsSchema = z.object({
  query: z.string(),
  count: z.number().optional(),
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
  channel: z.string(),
  thread_ts: z.string().optional(),
  title: z.string().optional(),
});

export const EmojiSetArgsSchema = z.object({
  name: z.string(),
  url: z.string(),
});
