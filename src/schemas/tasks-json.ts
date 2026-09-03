import { z } from "zod";
import { looseString } from "./common";

const ConfirmationResolutionSchema = z.object({
  approved: z.boolean(),
  principalId: looseString(),
  resolvedAt: looseString(),
});

const PendingConfirmationSchema = z.object({
  actionRef: looseString(),
  description: looseString(),
  requestedAt: looseString(),
  resolution: ConfirmationResolutionSchema.optional(),
  consumedAt: z.string().optional(),
});

export type ConfirmationResolution = z.infer<typeof ConfirmationResolutionSchema>;
export type PendingConfirmation = z.infer<typeof PendingConfirmationSchema>;
