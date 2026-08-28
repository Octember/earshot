import { z } from "zod";
import { looseString } from "./common";
import type { OutboundEffect } from "../ledger/turns";

const AnchorSchema = z.object({
  venueId: looseString(),
  threadRootId: z.string().nullable().optional(),
});

const PostedEffectSchema = z.object({
  kind: z.literal("posted"),
  anchor: AnchorSchema.optional(),
  text: z.string().optional(),
});

const ReactedEffectSchema = z.object({
  kind: z.literal("reacted"),
  venueId: looseString(),
  ts: z.string().optional(),
  emoji: z.string().optional(),
});

const SteppedBackEffectSchema = z.object({
  kind: z.literal("stepped_back"),
  venueId: looseString(),
  threadRootId: z.string().nullable().optional(),
  why: z.string().optional(),
});

const TaskAskedEffectSchema = z.object({
  kind: z.literal("task_asked"),
  question: z.string(),
});

export const OutboundTurnEffectSchema = z.discriminatedUnion("kind", [
  PostedEffectSchema,
  ReactedEffectSchema,
  SteppedBackEffectSchema,
]);

export function parseOutboundEffect(item: unknown): OutboundEffect | null {
  const parsed = OutboundTurnEffectSchema.safeParse(item);
  if (!parsed.success) return null;
  const effect = parsed.data;
  switch (effect.kind) {
    case "posted":
      return {
        kind: "posted",
        venueId: effect.anchor?.venueId ?? "",
        threadRootId:
          typeof effect.anchor?.threadRootId === "string" ? effect.anchor.threadRootId : null,
        ts: null,
        emoji: null,
        text: effect.text ?? null,
        why: null,
      };
    case "reacted":
      return {
        kind: "reacted",
        venueId: effect.venueId,
        threadRootId: null,
        ts: effect.ts ?? null,
        emoji: effect.emoji ?? null,
        text: null,
        why: null,
      };
    case "stepped_back":
      return {
        kind: "stepped_back",
        venueId: effect.venueId,
        threadRootId: typeof effect.threadRootId === "string" ? effect.threadRootId : null,
        ts: null,
        emoji: null,
        text: null,
        why: effect.why ?? null,
      };
    default:
      return null;
  }
}

export function parseTaskAskedQuestion(item: unknown): string | null {
  const parsed = TaskAskedEffectSchema.safeParse(item);
  return parsed.success ? parsed.data.question : null;
}
