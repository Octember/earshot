import { z } from "zod";
import { memoryItems, tasks } from "../ledger/schema";

export const RefTagSchema = z.string().regex(/^r\d+$/);
export const TaskTierSchema = z.enum(tasks.tier.enumValues);
export const MemoryTierSchema = z.enum(memoryItems.tier.enumValues);
