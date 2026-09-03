import { transition } from "../ledger/tasks-transition";
import { outwardCallOf, setOutwardCallState } from "../ledger/outward-calls";
import type { ToolGroup } from "../tools/catalog-types";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { ToolsetContext } from "./toolset-types";

export const BUILTIN_GROUPS: ToolGroup[] = [
  {
    name: "tasks",
    skill:
      "Delegation is how heavy work leaves your turn: a worker runs the task on its own budget and reports back to you. " +
      "Anything beyond a few checks and a reply belongs in a task rather than inline in your turn.",
    tools: ["task_create", "task_steer", "task_cancel", "task_confirm", "task_query"],
  },
  {
    name: "posting",
    skill:
      "Reply and react using [rN] tags on New lines (or the conversation header to post). Messages can come from different threads; answer each where it belongs.",
    tools: ["reply", "react", "step_back"],
  },
  { name: "scheduling", tools: ["set_wake"] },
  { name: "outcome", tools: ["task_complete", "task_fail", "task_ask"] },
  {
    name: "memory",
    skill:
      "Everything you've ever heard in your channels is searchable, and memory is how you stay smart across threads. " +
      "Before you guess, say you don't know, or make a claim about a past discussion, search for the receipt. " +
      "memory_write defaults to archive (searchable). Use tier:'core' only for member-'remember X' or confirmed standing law; core rides every conversation, so keep it to what must always be in mind.",
    tools: ["memory_write", "memory_retract", "memory_tier", "search"],
  },
];

const BUILTIN_TOOL_NAME = new Set(BUILTIN_GROUPS.flatMap((group) => group.tools));

export function externalTools(ctx: ToolsetContext): DynamicTool[] {
  const tools: DynamicTool[] = [];

  const outwardScope = ctx.taskId ?? ctx.outwardScopeId ?? "unscoped";
  for (const grant of ctx.identity.grants) {
    if (BUILTIN_TOOL_NAME.has(grant.tool)) continue;
    const spec = ctx.catalog[grant.tool];
    if (!spec) continue;
    const impl = spec.tool.run.bind(spec.tool);
    tools.push({
      spec: spec.tool.spec,
      run: async (args) => {
        const classes = spec.actionClasses?.(args) ?? [];
        if (classes.length === 0) return impl(args);
        const needsApproval = classes.some(
          (actionClass) => !grant.preauthorizedActionClasses.includes(actionClass),
        );
        if (needsApproval && ctx.turnKind === "resident")
          return {
            success: false,
            output:
              "that changes something outside Slack, so it runs inside a task: task_create it and the worker will do it there. When you tell the room, say what you're taking on and where you'll report back.",
          };
        const call = { identityId: ctx.identity.id, scopeId: outwardScope, tool: grant.tool, args };
        const state = outwardCallOf(ctx.db, outwardScope, grant.tool, args)?.state;
        if (state === "ran")
          return {
            success: false,
            output:
              "already done: this exact call already ran for this piece of work and completed. If you meant a different change, change the arguments.",
          };
        if (state === "running")
          return {
            success: false,
            output:
              "this exact call was attempted earlier and its outcome is unknown — check the target system first (search/read it); if it truly didn't land, make the call distinguishable (e.g. note the retry in its text).",
          };
        if (needsApproval && state !== "approved") {
          if (state === "denied")
            return {
              success: false,
              output:
                "a human declined exactly this action — it stays declined. Change the approach, or task_fail with what you wanted and why it was refused.",
            };
          if (state === "pending_approval")
            return {
              success: false,
              output:
                "a go-ahead request is already pending on this task — stop here and end the turn; ask for anything else after it resolves",
            };
          if (!ctx.taskId)
            return {
              success: false,
              output: "that needs a go-ahead from a person, and only a task can wait for one",
            };
          const description = `Requesting confirmation to call ${grant.tool} (${classes.join(", ")}) with ${JSON.stringify(args)}`;
          setOutwardCallState(ctx.db, ctx.clock, call, "pending_approval", { description });
          transition(ctx.db, ctx.clock, ctx.taskId, {
            type: "wait",
            waitingOn: "human",
            why: description,
            wakeAt: new Date(new Date(ctx.clock()).getTime() + ctx.parkAfterMs).toISOString(),
          });
          ctx.effects.push({
            kind: "confirmation_requested",
            tool: grant.tool,
            actionClasses: classes,
          });
          return {
            success: false,
            output:
              "asked: this task now waits for a person's go-ahead, which reaches them through the room. Stop here and end the turn; don't retry the call and don't use the outcome tools.",
          };
        }
        setOutwardCallState(ctx.db, ctx.clock, call, "running");
        const result = await impl(args);
        setOutwardCallState(ctx.db, ctx.clock, call, result.success ? "ran" : "failed");
        return result;
      },
    });
  }
  return tools;
}
