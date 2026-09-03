import type { TurnEffect } from "../schemas/effects";

import { maybeRotateGateway } from "@bevyl-ai/agent-tools";
import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";
import { recordTurn } from "../ledger/turns";
import type { TurnKind, TurnStatus } from "../ledger/schema";
import type { Anchor } from "../ledger/tasks-types";
import type { AppServerSession } from "@bevyl-ai/agent-tools";

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
  db: Database;
  clock: Clock;
  turnId: string;
  identityId: string;
  kind: TurnKind;
  executionId?: string | null;
  anchor?: Anchor | null;
  effects: TurnEffect[];
  timeoutMs?: number;

  beforeRecord?: (status: TurnStatus) => Promise<void>;

  stallTimeoutMs?: number;
}): Promise<{
  status: TurnStatus;

  cause?: string;
}> {
  const startedAt = params.clock();
  const turnPromise = params.session.runTurn(
    params.threadId,
    params.cwd,
    params.prompt,
    params.title,
  );

  turnPromise.catch((error: unknown) =>
    maybeRotateGateway({ reason: error instanceof Error ? error.message : String(error) }),
  );

  let cause: string | undefined;
  const done = turnPromise.then(
    () => "completed" as const,
    (error: unknown) => {
      cause = error instanceof Error ? error.message : String(error);
      return "failed" as const;
    },
  );

  const racers: Promise<"completed" | "failed" | "stalled" | "timed_out">[] = [done];
  if (params.stallTimeoutMs) racers.push(stallWatch(params.session, done, params.stallTimeoutMs));
  if (params.timeoutMs)
    racers.push(
      new Promise<"timed_out">((resolve) => {
        setTimeout(() => {
          resolve("timed_out");
        }, params.timeoutMs);
      }),
    );
  const settled = await Promise.race(racers);
  let status: TurnStatus;
  if (settled === "completed") status = "succeeded";
  else if (settled === "failed") status = "failed";
  else {
    params.session.stop();
    status = settled === "timed_out" ? "timed_out" : "failed";
    if (settled === "stalled") cause ??= `no runtime activity for ${params.stallTimeoutMs}ms`;
  }

  if (params.beforeRecord) await params.beforeRecord(status);

  recordTurn(params.db, params.clock, {
    id: params.turnId,
    identityId: params.identityId,
    kind: params.kind,
    executionId: params.executionId ?? null,
    anchor: params.anchor ?? null,
    status,
    effects: params.effects,
    startedAt,
  });

  return cause === undefined ? { status } : { status, cause };
}
