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
      const a = {
        content: asString(raw.content),
        provenance: Array.isArray(raw.provenance) ? raw.provenance : undefined,
        tier: rawTier,
      };
      // Explicit write defaults to core; recent tier for merely-noticed items.
      const tier = a.tier ?? "core";
      const item = writeMemory(ctx.db, ctx.clock, { id: crypto.randomUUID(), identityId: ctx.identity.id, content: a.content, provenance: a.provenance, tier });
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
      const a = { id: asString(raw.id), supersededBy: typeof raw.supersededBy === "string" ? raw.supersededBy : undefined };
      const existing = queryMemory(ctx.db, ctx.identity.id, { includeRetracted: true }).find((m) => m.id === a.id);
      if (!existing) return { success: false, output: `not_found: no memory item ${a.id} for this identity` };
      retractMemory(ctx.db, ctx.clock, { id: a.id, supersededBy: a.supersededBy });
      pushEffect(ctx, { kind: "memory_retracted", memoryId: a.id });
      return { success: true, output: `retracted ${a.id}` };
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
      const a = {
        query: asString(raw.query),
        venueId: typeof raw.venueId === "string" ? raw.venueId : undefined,
        principalId: typeof raw.principalId === "string" ? raw.principalId : undefined,
        after: typeof raw.after === "string" ? raw.after : undefined,
        before: typeof raw.before === "string" ? raw.before : undefined,
        limit: typeof raw.limit === "number" ? raw.limit : undefined,
      };
      const hits = searchArchive(ctx.db, ctx.identity.id, a).map((h) => {
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
          kind: h.kind,
          text: h.text.slice(0, 700),
          at: h.at,
        };
        // Search hits are via='search' (addressable but unread until card bounce).
        if (h.venueId && h.ts && ctx.refs) {
          hit.ref = ctx.refs.mint({ venueId: h.venueId, threadRootId: h.threadRootId ?? null, ts: h.ts, via: "search" });
        }
        if (h.venueId) hit.venueId = h.venueId;
        if (h.threadRootId) hit.threadRootId = h.threadRootId;
        if (h.principalId) hit.principalId = h.principalId;
        if (h.memoryId) {
          hit.memoryId = h.memoryId;
          hit.tier = h.tier;
        }
        const permalink = h.venueId && h.ts ? ctx.permalink?.(h.venueId, h.ts) : undefined;
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
      const a: { id: string; tier: "core" | "recent" | "archive" } = { id: asString(raw.id), tier: rawTier };
      const existing = queryMemory(ctx.db, ctx.identity.id, { includeRetracted: true }).find((m) => m.id === a.id);
      if (!existing) return { success: false, output: `not_found: no memory item ${a.id} for this identity` };
      const item = setMemoryTier(ctx.db, ctx.clock, a.id, a.tier);
      pushEffect(ctx, { kind: "memory_tiered", memoryId: a.id, tier: item.tier });
      return { success: true, output: `${a.id} → ${item.tier}` };
    },
  };
}
