import { writeMemory, retractMemory, setMemoryTier } from "../ledger/memory";
import { searchArchive } from "../ledger/search";
import { defineTool } from "../schemas/tool";
import {
  MemoryRetractArgsSchema,
  MemoryTierArgsSchema,
  MemoryWriteArgsSchema,
  SearchArgsSchema,
} from "../schemas/tools";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { ToolsetContext } from "./toolset-types";

export function memoryWriteTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "memory_write",
    "Write a distilled fact (not a transcript). tier 'core' rides every conversation with you; 'archive' is searchable background. Default is archive; use core for member-'remember X' or confirmed standing facts. Input: { content, provenance?, tier? }.",
    MemoryWriteArgsSchema,
    async ({ content, provenance, tier }) => {
      const item = writeMemory(ctx.db, ctx.clock, {
        id: crypto.randomUUID(),
        identityId: ctx.identity.id,
        content,
        provenance: provenance ?? [],
        tier: tier ?? "archive",
      });
      ctx.effects.push({ kind: "memory_written", memoryId: item.id });
      return { success: true, output: JSON.stringify({ memoryId: item.id }) };
    },
  );
}

export function memoryRetractTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "memory_retract",
    "Retract a memory item (use search first to find its id). Input: { id, supersededBy? }.",
    MemoryRetractArgsSchema,
    async ({ id, supersededBy }) => {
      if (!retractMemory(ctx.db, ctx.clock, ctx.identity.id, id, supersededBy ?? null))
        return { success: false, output: `no memory with id ${id}` };
      ctx.effects.push({ kind: "memory_retracted", memoryId: id });
      return { success: true, output: `retracted ${id}` };
    },
  );
}

export function searchTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "search",
    "Search everything you've heard (full message history across your channels) and everything you remember. Hits carry venue, time, speaker, a permalink — cite them — and a ref you can reply/react to (speaking there starts by reading the conversation as it now stands). venueId/principalId filters narrow to messages. Input: { query, venueId?, principalId?, after?, before?, limit? } (after/before are ISO timestamps).",
    SearchArgsSchema,
    async (toolArgs) => {
      const hits = searchArchive(ctx.db, ctx.identity.id, toolArgs).map((hit) =>
        Object.assign(hit, {
          text: hit.text.slice(0, 700),
          ...(hit.kind === "message" && hit.ts
            ? {
                ref: ctx.refs.mint({
                  venueId: hit.venueId,
                  threadRootId: hit.threadRootId,
                  ts: hit.ts,
                  via: "search",
                }),
                permalink: ctx.permalink(hit.venueId, hit.ts),
              }
            : {}),
        }),
      );
      return { success: true, output: JSON.stringify(hits) };
    },
  );
}

export function memoryTierTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "memory_tier",
    "Move a memory item between tiers: 'core' (rides every conversation) and 'archive' (searchable background). Input: { id, tier }.",
    MemoryTierArgsSchema,
    async ({ id, tier }) => {
      if (!setMemoryTier(ctx.db, ctx.clock, ctx.identity.id, id, tier))
        return { success: false, output: `no memory with id ${id}` };
      ctx.effects.push({ kind: "memory_tiered", memoryId: id, tier });
      return { success: true, output: `${id} → ${tier}` };
    },
  );
}
