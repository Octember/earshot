import { z } from "zod";

const TaskAskedEffectSchema = z.object({
  kind: z.literal("task_asked"),
  question: z.string(),
});

export function parseTaskAskedQuestion(item: unknown): string | null {
  const parsed = TaskAskedEffectSchema.safeParse(item);
  return parsed.success ? parsed.data.question : null;
}
