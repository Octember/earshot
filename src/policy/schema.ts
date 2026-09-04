import { z } from "zod";

const ModelTier = z
  .object({ model: z.string().optional(), effort: z.string().optional() })
  .prefault({});

export const Identity = z.object({
  id: z.string(),
  persona: z.string().optional(),
  venue_ids: z.array(z.string()).default([]),
  ambient: z.object({ event_debounce_ms: z.number().default(45_000) }).prefault({}),
  venue_instructions: z.record(z.string(), z.string()).default({}),
});

export const PolicySchema = z.object({
  trusted_bot_principals: z.array(z.string()).default([]),
  default_dm_identity: z.string().optional(),
  identities: z.array(Identity).default([]),
  turns: z
    .object({
      interactive_timeout_ms: z.number().default(120_000),
      stall_timeout_ms: z.number().default(45_000),
      max_retries: z.number().default(2),
      backoff_ms: z.number().default(5_000),
    })
    .prefault({}),
  executions: z
    .object({
      max_concurrent_per_identity: z.number().default(2),
      max_concurrent_global: z.number().default(4),
      max_turns: z.number().default(40),
      stall_timeout_ms: z.number().default(5 * 60 * 1000),
      max_attempts: z.number().default(3),
      backoff_ms: z.number().default(30_000),
    })
    .prefault({}),
  tasks: z.object({ park_after_ms: z.number().default(48 * 60 * 60 * 1000) }).prefault({}),
  models: z.object({ low: ModelTier, medium: ModelTier, high: ModelTier }).prefault({}),
});

export type Policy = z.infer<typeof PolicySchema>;
export type IdentityConfig = z.infer<typeof Identity>;
