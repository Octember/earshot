import { decide } from "../policy/broker";
import type { ToolsetContext } from "./toolset-types";

export function gateToolCall(
  ctx: ToolsetContext,
  toolName: string,
  args: unknown,
  impl: (args: unknown) => Promise<{ success: boolean; output: string }>,
): Promise<{ success: boolean; output: string }> {
  const decision = decide({
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
        'not from here: that action runs inside a task, or after someone gives the go-ahead. If you mention it in the room, say it plainly ("say the word and i\'ll do it").',
    });
  if (decision.reason === "scope_violation")
    return Promise.resolve({ success: false, output: `not allowed here: ${decision.detail}` });
  return Promise.resolve({ success: false, output: "you don't have that tool" });
}
