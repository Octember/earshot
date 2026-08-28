import { and, eq, gt } from "drizzle-orm";
import { queryAudit } from "../ledger/audit";
import { orm } from "../ledger/db";
import { outwardCalls } from "../ledger/schema";
import { canonicalJson } from "../policy/broker";
import type { ToolRegistry } from "../tools/catalog";
import { defineTool } from "../schemas/tool";
import { AuditQueryArgsSchema } from "../schemas/tools";
import type { ToolFactory, ToolsetContext } from "./toolset-types";

export const BUILTIN_REGISTRIES: ToolRegistry[] = [
  {
    name: "tasks",
    skill:
      "Delegation is how heavy work leaves your turn: a worker runs the task on its own budget and reports back to you. " +
      "Anything beyond a few checks and a reply belongs in a task rather than inline in your turn.",
    tools: { task_create: {}, task_steer: {}, task_cancel: {}, task_confirm: {}, task_query: {} },
  },
  {
    name: "posting",
    skill:
      "Reply and react using [rN] tags on New lines (or the conversation header to post). Messages can come from different threads; answer each where it belongs.",
    tools: { reply: {}, react: {}, step_back: {} },
  },
  { name: "scheduling", tools: { set_wake: {} } },
  { name: "outcome", tools: { task_complete: {}, task_fail: {}, task_ask: {} } },
  {
    name: "memory",
    skill:
      "Everything you've ever heard in your channels is searchable, and memory is how you stay smart across threads. " +
      "Before you guess, say you don't know, or make a claim about a past discussion, search for the receipt. " +
      "When you notice a fact, memory_write defaults to recent (staging). Use tier:'core' only for member-'remember X' or confirmed standing law. " +
      "A distiller promotes recent into core when recent fills; do not stuff core yourself.",
    tools: { memory_write: {}, memory_retract: {}, memory_tier: {}, search: {} },
  },
  { name: "audit", tools: { audit_query: {} } },
];

const BUILTIN_TOOL_NAME = new Set(
  BUILTIN_REGISTRIES.flatMap((registry) => Object.keys(registry.tools)),
);

export function externalTools(ctx: ToolsetContext): ToolFactory[] {
  const tools: ToolFactory[] = [];
  // Outward-call dedupe is durable (UNIQUE scope/tool/args_hash); 24h window.
  const outwardScope = ctx.taskId ?? ctx.outwardScopeId ?? "unscoped";
  for (const grant of ctx.identity.grants) {
    if (BUILTIN_TOOL_NAME.has(grant.tool)) continue; // built-ins (audit_query included) are constructed below, not granted specs
    const spec = ctx.catalog[grant.tool];
    tools.push({
      spec: {
        name: grant.tool,
        description: spec?.description ?? `granted external tool: ${grant.tool}`,
        inputSchema: spec?.inputSchema ?? { type: "object" },
      },
      impl: async (args) => {
        const impl = spec?.run;
        if (!impl)
          return {
            success: false,
            output: `no implementation registered for external tool ${grant.tool}`,
          };
        if ((spec?.actionClasses?.(args) ?? []).length > 0) {
          const argsHash = canonicalJson(args);
          const cutoff = new Date(Date.parse(ctx.clock()) - 24 * 60 * 60 * 1000).toISOString();
          const prior = orm(ctx.db)
            .select({ confirmed: outwardCalls.confirmed })
            .from(outwardCalls)
            .where(
              and(
                eq(outwardCalls.scopeId, outwardScope),
                eq(outwardCalls.tool, grant.tool),
                eq(outwardCalls.argsHash, argsHash),
                gt(outwardCalls.at, cutoff),
              ),
            )
            .get();
          if (prior?.confirmed) {
            return {
              success: false,
              output:
                "already done: this exact call already ran for this piece of work and completed. If you meant a different change, change the arguments.",
            };
          }
          if (prior) {
            // Ambiguous prior write — never silently redo; verify first.
            return {
              success: false,
              output:
                "this exact call was attempted earlier and its outcome is unknown — check the target system first (search/read it); if it truly didn't land, make the call distinguishable (e.g. note the retry in its text).",
            };
          }
          orm(ctx.db)
            .insert(outwardCalls)
            .values({
              identityId: ctx.identity.id,
              scopeId: outwardScope,
              tool: grant.tool,
              argsHash,
              at: ctx.clock(),
              confirmed: 0,
            })
            .onConflictDoUpdate({
              target: [outwardCalls.scopeId, outwardCalls.tool, outwardCalls.argsHash],
              set: { at: ctx.clock(), confirmed: 0 },
            })
            .run();
          const result = await impl(args);
          if (result.success) {
            orm(ctx.db)
              .update(outwardCalls)
              .set({ confirmed: 1 })
              .where(
                and(
                  eq(outwardCalls.scopeId, outwardScope),
                  eq(outwardCalls.tool, grant.tool),
                  eq(outwardCalls.argsHash, argsHash),
                ),
              )
              .run();
          } else {
            orm(ctx.db)
              .delete(outwardCalls)
              .where(
                and(
                  eq(outwardCalls.scopeId, outwardScope),
                  eq(outwardCalls.tool, grant.tool),
                  eq(outwardCalls.argsHash, argsHash),
                ),
              )
              .run();
          }
          return result;
        }
        return impl(args);
      },
    });
  }
  return tools;
}

export function auditQueryTool(ctx: ToolsetContext): ToolFactory | null {
  if (!ctx.identity.grants.some((grant) => grant.tool === "audit_query")) return null;
  return defineTool(
    "audit_query",
    "Read your own audit log: what you did, when, and what was allowed or denied. Input: { sinceIso?, untilIso?, kind?, taskId? }.",
    AuditQueryArgsSchema,
    async (toolArgs, toolCtx) => {
      const records = queryAudit(toolCtx.db, toolCtx.identity.id, toolArgs);
      return { success: true, output: JSON.stringify(records) };
    },
  )(ctx);
}
