import { z } from "zod";

export const RefTagSchema = z.string().regex(/^r\d+$/);
const AddressModeSchema = z.enum(["mention", "dm", "thread_follow"]);
export const TaskTierSchema = z.enum(["low", "medium", "high"]);
export const MemoryTierSchema = z.enum(["core", "recent", "archive"]);

export function looseNumber(fallback: number): z.ZodType<number> {
  return z.preprocess((value) => (typeof value === "number" ? value : fallback), z.number());
}

export function looseStringArray(): z.ZodType<string[]> {
  return z.preprocess(
    (value) => (Array.isArray(value) ? value.map(String) : []),
    z.array(z.string()),
  );
}

export function looseRecord(): z.ZodType<Record<string, unknown>> {
  return z.preprocess(
    (value) => {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
      return {};
    },
    z.record(z.string(), z.unknown()),
  );
}

export type AddressMode = z.infer<typeof AddressModeSchema>;
