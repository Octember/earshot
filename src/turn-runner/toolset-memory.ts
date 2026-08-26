import { writeMemory, retractMemory, queryMemory, setMemoryTier } from "../ledger/memory";
import { searchArchive, type SearchHit } from "../ledger/search";
import { defineTool } from "../schemas/tool";
import {
  MemoryRetractArgsSchema,
  MemoryTierArgsSchema,
  MemoryWriteArgsSchema,
  SearchArgsSchema,
} from "../schemas/tools";
import { pushEffect, type ToolFactory, type ToolsetContext } from "./toolset-types";

export function memoryWriteTool(ctx: ToolsetContext): ToolFactory {
  return defineTool(
    "memory_write",
    "Write a distilled, durable fact (not a transcript) to your memory. Tiers: 'core' is always in mind, 'recent' is newly-noticed and unvetted (decays unless confirmed), 'archive' is searchable background. Input: { content, provenance?, tier? }.",
    MemoryWriteArgsSchema,
    async ({ content, provenance, tier }, toolCtx) => {
      const item = writeMemory(toolCtx.db, toolCtx.clock, {
        id: crypto.randomUUID(),
        identityId: toolCtx.identity.id,
        content,
        provenance,
        tier: tier ?? "core",
      });
      pushEffect(toolCtx, { kind: "memory_written", memoryId: item.id });
      return { success: true, output: JSON.stringify({ memoryId: item.id }) };
    },
  )(ctx);
}

export function memoryRetractTool(ctx: ToolsetContext): ToolFactory {
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

export function searchTool(ctx: ToolsetContext): ToolFactory {
  return defineTool(
    "search",
    "Search everything you've heard (full message history across your channels) and everything you remember (memory, both tiers). Hits carry venue, time, speaker, a permalink — cite them — and a ref you can reply/react to (speaking there starts by reading the conversation as it now stands). venueId/principalId filters narrow to messages. Input: { query, venueId?, principalId?, after?, before?, limit? } (after/before are ISO timestamps).",
    SearchArgsSchema,
    async (toolArgs, toolCtx) => {
      const hits = searchArchive(toolCtx.db, toolCtx.identity.id, toolArgs).map((searchHit) => {
        const hit: {
          kind: SearchHit["kind"];
          text: string;
          at: string;
          ref?: string;
          venueId?: string;
          threadRootId?: string;
          principalId?: string;
          memoryId?: string;
          tier?: SearchHit["tier"];
          permalink?: string;
        } = {
          kind: searchHit.kind,
          text: searchHit.text.slice(0, 700),
          at: searchHit.at,
        };
        if (searchHit.venueId && searchHit.ts && toolCtx.refs) {
          hit.ref = toolCtx.refs.mint({
            venueId: searchHit.venueId,
            threadRootId: searchHit.threadRootId ?? null,
            ts: searchHit.ts,
            via: "search",
          });
        }
        if (searchHit.venueId) hit.venueId = searchHit.venueId;
        if (searchHit.threadRootId) hit.threadRootId = searchHit.threadRootId;
        if (searchHit.principalId) hit.principalId = searchHit.principalId;
        if (searchHit.memoryId) {
          hit.memoryId = searchHit.memoryId;
          hit.tier = searchHit.tier;
        }
        const permalink =
          searchHit.venueId && searchHit.ts
            ? toolCtx.permalink?.(searchHit.venueId, searchHit.ts)
            : undefined;
        if (permalink) hit.permalink = permalink;
        return hit;
      });
      return { success: true, output: JSON.stringify(hits) };
    },
  )(ctx);
}

export function memoryTierTool(ctx: ToolsetContext): ToolFactory {
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
      return { success: true, output: `${id} → ${item.tier}` };
    },
  )(ctx);
}
