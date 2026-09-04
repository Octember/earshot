import { maybeRotateGateway } from "@bevyl-ai/agent-tools";
import type { AppServerSession } from "@bevyl-ai/agent-tools";

export type TurnStatus = "succeeded" | "failed";

function stallWatch(
  session: AppServerSession,
  done: Promise<unknown>,
  stallTimeoutMs: number,
): Promise<"stalled"> {
  let settled = false;
  void done.finally(() => {
    settled = true;
  });
  const pollMs = Math.max(10, Math.min(1000, stallTimeoutMs / 5));
  return new Promise<"stalled">((resolve) => {
    const check = () => {
      if (settled) return;
      if (session.msSinceLastActivity() >= stallTimeoutMs) {
        resolve("stalled");
        return;
      }
      setTimeout(check, pollMs);
    };
    setTimeout(check, pollMs);
  });
}

export async function runTurn(params: {
  session: AppServerSession;
  threadId: string;
  cwd: string;
  prompt: string;
  title: string;
  stallTimeoutMs: number;
}): Promise<{ status: TurnStatus; cause?: string }> {
  const turn = params.session.runTurn(params.threadId, params.cwd, params.prompt, params.title);
  turn.catch((error: unknown) =>
    maybeRotateGateway({ reason: error instanceof Error ? error.message : String(error) }),
  );
  const done = turn.then(
    () => ({ status: "succeeded" as const }),
    (error: unknown) => ({
      status: "failed" as const,
      cause: error instanceof Error ? error.message : String(error),
    }),
  );
  const settled = await Promise.race([
    done,
    stallWatch(params.session, done, params.stallTimeoutMs),
  ]);
  if (settled === "stalled") {
    params.session.stop();
    return { status: "failed", cause: `no runtime activity for ${params.stallTimeoutMs}ms` };
  }
  return settled;
}
