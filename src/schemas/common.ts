import { z } from "zod";
import { tasks } from "../ledger/schema";

export const TaskTierSchema = z.enum(tasks.tier.enumValues);
