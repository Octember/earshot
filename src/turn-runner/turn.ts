import { maybeRotateGateway } from "@bevyl-ai/agent-tools";
import type { AppServerSession } from "@bevyl-ai/agent-tools";

function stallWatch(
  session: AppServerSession,
  done: Promise<unknown>,
  stallTimeoutMs: number,
): Promise<never> {
  let settled = false;
  void done.finally(() => {
    settled = true;
  });
  const pollMs = Math.max(10, Math.min(1000, stallTimeoutMs / 5));
  return new Promise<never>((_, reject) => {
    const check = () => {
      if (settled) return;
      if (session.msSinceLastActivity() >= stallTimeoutMs) {
        session.stop();
        reject(new Error(`no runtime activity for ${stallTimeoutMs}ms`));
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
}): Promise<void> {
  const turn = params.session.runTurn(params.threadId, params.cwd, params.prompt, params.title);
  turn.catch((error: unknown) =>
    maybeRotateGateway({ reason: error instanceof Error ? error.message : String(error) }),
  );
  await Promise.race([turn, stallWatch(params.session, turn, params.stallTimeoutMs)]);
}
