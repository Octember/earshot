import { readFileSync } from "node:fs";
import { z } from "zod";
import type { InjectionToken } from "tsyringe";

const ModelTier = z
  .object({ model: z.string().optional(), effort: z.string().optional() })
  .prefault({});

const PolicySchema = z.object({
  persona: z.string().optional(),
  venue_instructions: z.record(z.string(), z.string()).default({}),
  ear_debounce_ms: z.number().default(45_000),
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
      max_concurrent: z.number().default(4),
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
export const POLICY: InjectionToken<Policy> = Symbol("policy");
export const POLICY_PATH: InjectionToken<string> = Symbol("policyPath");

export function loadPolicy(path: string): Policy {
  return PolicySchema.parse(Bun.YAML.parse(readFileSync(path, "utf8")) ?? {});
}
