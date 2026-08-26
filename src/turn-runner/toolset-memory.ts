import { asString, isRecord } from "../guard";
import { writeMemory, retractMemory, queryMemory, setMemoryTier } from "../ledger/memory";
import { searchArchive, type SearchHit } from "../ledger/search";
import { pushEffect, type ToolFactory, type ToolsetContext } from "./toolset-types";

export function memoryWriteTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "memory_write",
      description:
        "Write a distilled, durable fact (not a transcript) to your memory. Tiers: 'core' is always in mind, 'recent' is newly-noticed and unvetted (decays unless confirmed), 'archive' is searchable background. Input: { content, provenance?, tier? }.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["content"],
        properties: { content: { type: "string" }, provenance: { type: "array" }, tier: { type: "string", enum: ["core", "recent", "archive"] } },
      },
    },
    impl: async (args) => {
      const raw = isRecord(args) ? args : {};
      const rawTier: "core" | "recent" | "archive" | undefined = raw.tier === "core" || raw.tier === "recent" || raw.tier === "archive" ? raw.tier : undefined;
      const toolArgs = {
        content: asString(raw.content),
        provenance: Array.isArray(raw.provenance) ? raw.provenance : undefined,
        tier: rawTier,
      };
      // Explicit write defaults to core; recent tier for merely-noticed items.
      const tier = toolArgs.tier ?? "core";
      const item = writeMemory(ctx.db, ctx.clock, { id: crypto.randomUUID(), identityId: ctx.identity.id, content: toolArgs.content, provenance: toolArgs.provenance, tier });
      pushEffect(ctx, { kind: "memory_written", memoryId: item.id });
      return { success: true, output: JSON.stringify({ memoryId: item.id }) };
    },
  };
}

export function memoryRetractTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "memory_retract",
      description: "Retract a memory item (use search first to find its id). Input: { id, supersededBy? }.",
      inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" }, supersededBy: { type: "string" } } },
    },
    impl: async (args) => {
      const raw = isRecord(args) ? args : {};
      const toolArgs = { id: asString(raw.id), supersededBy: typeof raw.supersededBy === "string" ? raw.supersededBy : undefined };
      const existing = queryMemory(ctx.db, ctx.identity.id, { includeRetracted: true }).find((memory) => memory.id === toolArgs.id);
      if (!existing) return { success: false, output: `not_found: no memory item ${toolArgs.id} for this identity` };
      retractMemory(ctx.db, ctx.clock, { id: toolArgs.id, supersededBy: toolArgs.supersededBy });
      pushEffect(ctx, { kind: "memory_retracted", memoryId: toolArgs.id });
      return { success: true, output: `retracted ${toolArgs.id}` };
    },
  };
}

export function searchTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "search",
      description:
        "Search everything you've heard (full message history across your channels) and everything you remember (memory, both tiers). Hits carry venue, time, speaker, a permalink — cite them — and a ref you can reply/react to (speaking there starts by reading the conversation as it now stands). venueId/principalId filters narrow to messages. Input: { query, venueId?, principalId?, after?, before?, limit? } (after/before are ISO timestamps).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string" },
          venueId: { type: "string" },
          principalId: { type: "string" },
          after: { type: "string" },
          before: { type: "string" },
          limit: { type: "number" },
        },
      },
    },
    impl: async (args) => {
      const raw = isRecord(args) ? args : {};
      const toolArgs = {
        query: asString(raw.query),
        venueId: typeof raw.venueId === "string" ? raw.venueId : undefined,
        principalId: typeof raw.principalId === "string" ? raw.principalId : undefined,
        after: typeof raw.after === "string" ? raw.after : undefined,
        before: typeof raw.before === "string" ? raw.before : undefined,
        limit: typeof raw.limit === "number" ? raw.limit : undefined,
      };
      const hits = searchArchive(ctx.db, ctx.identity.id, toolArgs).map((searchHit) => {
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
        // Search hits are via='search' (addressable but unread until card bounce).
        if (searchHit.venueId && searchHit.ts && ctx.refs) {
          hit.ref = ctx.refs.mint({ venueId: searchHit.venueId, threadRootId: searchHit.threadRootId ?? null, ts: searchHit.ts, via: "search" });
        }
        if (searchHit.venueId) hit.venueId = searchHit.venueId;
        if (searchHit.threadRootId) hit.threadRootId = searchHit.threadRootId;
        if (searchHit.principalId) hit.principalId = searchHit.principalId;
        if (searchHit.memoryId) {
          hit.memoryId = searchHit.memoryId;
          hit.tier = searchHit.tier;
        }
        const permalink = searchHit.venueId && searchHit.ts ? ctx.permalink?.(searchHit.venueId, searchHit.ts) : undefined;
        if (permalink) hit.permalink = permalink;
        return hit;
      });
      return { success: true, output: JSON.stringify(hits) };
    },
  };
}

export function memoryTierTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "memory_tier",
      description: "Move a memory item between tiers: 'core' (always in mind), 'recent' (newly noticed, unvetted), 'archive' (searchable background). Input: { id, tier }.",
      inputSchema: { type: "object", additionalProperties: false, required: ["id", "tier"], properties: { id: { type: "string" }, tier: { type: "string", enum: ["core", "recent", "archive"] } } },
    },
    impl: async (args) => {
      const raw = isRecord(args) ? args : {};
      const rawTier = raw.tier;
      if (rawTier !== "core" && rawTier !== "recent" && rawTier !== "archive") {
        return { success: false, output: "memory_tier needs tier to be one of core/recent/archive" };
      }
      const toolArgs: { id: string; tier: "core" | "recent" | "archive" } = { id: asString(raw.id), tier: rawTier };
      const existing = queryMemory(ctx.db, ctx.identity.id, { includeRetracted: true }).find((memory) => memory.id === toolArgs.id);
      if (!existing) return { success: false, output: `not_found: no memory item ${toolArgs.id} for this identity` };
      const item = setMemoryTier(ctx.db, ctx.clock, toolArgs.id, toolArgs.tier);
      pushEffect(ctx, { kind: "memory_tiered", memoryId: toolArgs.id, tier: item.tier });
      return { success: true, output: `${toolArgs.id} → ${item.tier}` };
    },
  };
}
