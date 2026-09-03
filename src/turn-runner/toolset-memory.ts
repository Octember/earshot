import {
  writeMemory,
  retractMemory,
  queryMemory,
  setMemoryTier,
  maybeArmDistillation,
} from "../ledger/memory";
import { searchArchive } from "../ledger/search";
import { defineTool } from "../schemas/tool";
import {
  MemoryRetractArgsSchema,
  MemoryTierArgsSchema,
  MemoryWriteArgsSchema,
  SearchArgsSchema,
} from "../schemas/tools";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import { pushEffect, type ToolsetContext } from "./toolset-types";

function armIfRecentFull(toolCtx: ToolsetContext): void {
  if (toolCtx.recentCharBudget === undefined) return;
  maybeArmDistillation(toolCtx.db, toolCtx.clock, toolCtx.identity.id, toolCtx.recentCharBudget);
}

export function memoryWriteTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "memory_write",
    "Write a distilled fact (not a transcript). Default tier is 'recent'. Use tier:'core' only for member-'remember X' or confirmed standing facts. Input: { content, provenance?, tier? }.",
    MemoryWriteArgsSchema,
    async ({ content, provenance, tier }, toolCtx) => {
      const item = writeMemory(toolCtx.db, toolCtx.clock, {
        id: crypto.randomUUID(),
        identityId: toolCtx.identity.id,
        content,
        provenance,
        tier: tier ?? "recent",
      });
      pushEffect(toolCtx, { kind: "memory_written", memoryId: item.id });
      if (item.tier === "recent") armIfRecentFull(toolCtx);
      return { success: true, output: JSON.stringify({ memoryId: item.id }) };
    },
  )(ctx);
}

export function memoryRetractTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "memory_retract",
    "Retract a memory item (use search first to find its id). Input: { id, supersededBy? }.",
    MemoryRetractArgsSchema,
    async ({ id, supersededBy }, toolCtx) => {
      const existing = queryMemory(toolCtx.db, toolCtx.identity.id, {
        includeRetracted: true,
      }).find((memory) => memory.id === id);
      if (!existing) {
        return {
          success: false,
          output: `not_found: no memory item ${id} for this identity`,
        };
      }
      retractMemory(toolCtx.db, toolCtx.clock, { id, supersededBy });
      pushEffect(toolCtx, { kind: "memory_retracted", memoryId: id });
      return { success: true, output: `retracted ${id}` };
    },
  )(ctx);
}

export function searchTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "search",
    "Search everything you've heard (full message history across your channels) and everything you remember (memory, both tiers). Hits carry venue, time, speaker, a permalink — cite them — and a ref you can reply/react to (speaking there starts by reading the conversation as it now stands). venueId/principalId filters narrow to messages. Input: { query, venueId?, principalId?, after?, before?, limit? } (after/before are ISO timestamps).",
    SearchArgsSchema,
    async (toolArgs, toolCtx) => {
      const hits = searchArchive(toolCtx.db, toolCtx.identity.id, toolArgs).map((hit) => {
        const located = hit.venueId && hit.ts ? { venueId: hit.venueId, ts: hit.ts } : null;
        return Object.assign(hit, {
          text: hit.text.slice(0, 700),
          ...(located && toolCtx.refs
            ? {
                ref: toolCtx.refs.mint({
                  ...located,
                  threadRootId: hit.threadRootId ?? null,
                  via: "search",
                }),
              }
            : {}),
          ...(located ? { permalink: toolCtx.permalink?.(located.venueId, located.ts) } : {}),
        });
      });
      return { success: true, output: JSON.stringify(hits) };
    },
  )(ctx);
}

export function memoryTierTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "memory_tier",
    "Move a memory item between tiers: 'core' (always in mind), 'recent' (newly noticed, unvetted), 'archive' (searchable background). Input: { id, tier }.",
    MemoryTierArgsSchema,
    async ({ id, tier }, toolCtx) => {
      const existing = queryMemory(toolCtx.db, toolCtx.identity.id, {
        includeRetracted: true,
      }).find((memory) => memory.id === id);
      if (!existing) {
        return {
          success: false,
          output: `not_found: no memory item ${id} for this identity`,
        };
      }
      const item = setMemoryTier(toolCtx.db, toolCtx.clock, id, tier);
      pushEffect(toolCtx, { kind: "memory_tiered", memoryId: id, tier: item.tier });
      if (item.tier === "recent") armIfRecentFull(toolCtx);
      return { success: true, output: `${id} → ${item.tier}` };
    },
  )(ctx);
}
