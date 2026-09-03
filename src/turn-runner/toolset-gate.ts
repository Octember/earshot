import { decide } from "../policy/broker";
import type { ToolsetContext } from "./toolset-types";

export function gateToolCall(
  ctx: ToolsetContext,
  toolName: string,
  args: unknown,
  impl: (args: unknown) => Promise<{ success: boolean; output: string }>,
): Promise<{ success: boolean; output: string }> {
  const decision = decide(ctx.db, ctx.clock, {
    identity: ctx.identity,
    turnKind: ctx.turnKind,
    tool: toolName,
    args,
    catalog: ctx.catalog,
  });
  if (decision.allow) return impl(args);
  if (decision.reason === "not_available_for_turn_kind")
    return Promise.resolve({
      success: false,
      output:
        "denied: not_available_for_turn_kind — this turn is speak-only; the action can run from a task turn or after a member's go-ahead. If you mention this in the room, say it plainly (\"say the word and i'll do it\") — never turn kinds, mutations, or other internals.",
    });
  if (decision.reason === "scope_violation")
    return Promise.resolve({ success: false, output: `denied: ${decision.detail}` });
  return Promise.resolve({ success: false, output: `denied: ${decision.reason}` });
}
