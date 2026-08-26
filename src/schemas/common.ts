import { z } from "zod";

export const RefTagSchema = z.string().regex(/^r\d+$/);
export const AddressModeSchema = z.enum(["mention", "dm", "thread_follow"]);
export const TaskTierSchema = z.enum(["low", "medium", "high"]);
export const MemoryTierSchema = z.enum(["core", "recent", "archive"]);

export function looseString(fallback = ""): z.ZodType<string> {
  return z.preprocess((value) => (typeof value === "string" ? value : fallback), z.string());
}

export function looseNumber(fallback: number): z.ZodType<number> {
  return z.preprocess((value) => (typeof value === "number" ? value : fallback), z.number());
}

export function looseNumberOrNull(fallback: number | null): z.ZodType<number | null> {
  return z.preprocess((value) => {
    if (value === null) return null;
    return typeof value === "number" ? value : fallback;
  }, z.number().nullable());
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
