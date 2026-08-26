import { z } from "zod";
import { looseString } from "./common";
import type { PendingConfirmation } from "../ledger/tasks-types";

export const ConfirmationResolutionSchema = z.object({
  approved: z.boolean(),
  principalId: looseString(),
  resolvedAt: looseString(),
});

export const PendingConfirmationSchema = z.object({
  actionRef: looseString(),
  description: looseString(),
  requestedAt: looseString(),
  resolution: ConfirmationResolutionSchema.optional(),
  consumedAt: z.string().optional(),
});

export function parsePendingConfirmation(raw: unknown): PendingConfirmation | null {
  if (!raw) return null;
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  const parsed = PendingConfirmationSchema.safeParse(value);
  return parsed.success
    ? ({
        actionRef: parsed.data.actionRef,
        description: parsed.data.description,
        requestedAt: parsed.data.requestedAt,
        ...(parsed.data.resolution ? { resolution: parsed.data.resolution } : {}),
        ...(parsed.data.consumedAt ? { consumedAt: parsed.data.consumedAt } : {}),
      } satisfies PendingConfirmation)
    : null;
}

export function parseTaskArtifacts(raw: unknown): string[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item : String(item)));
}
