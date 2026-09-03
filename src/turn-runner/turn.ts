import type { TurnEffect } from "../schemas/effects";

import { maybeRotateGateway } from "@bevyl-ai/agent-tools";
import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";
import { recordTurn } from "../ledger/turns";
import type { TurnKind, TurnStatus } from "../ledger/schema";
import type { Anchor } from "../ledger/tasks-types";
import type { AppServerSession } from "@bevyl-ai/agent-tools";

async function raceStall(
  session: AppServerSession,
  done: Promise<"completed" | "failed">,
  stallTimeoutMs: number,
): Promise<"completed" | "failed" | "stalled"> {
  let settled = false;
  void done.finally(() => {
    settled = true;
  });
  const pollMs = Math.max(10, Math.min(1000, stallTimeoutMs / 5));
  const stallWatch = new Promise<"stalled">((resolve) => {
    const check = () => {
      if (settled) return;
      if ((session.msSinceLastActivity?.() ?? 0) >= stallTimeoutMs) {
        resolve("stalled");
        return;
      }
      setTimeout(check, pollMs);
    };
    setTimeout(check, pollMs);
  });
  return Promise.race([done, stallWatch]);
}

export async function runTurn(params: {
  images?: string[];
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
  tokensUsed: () => number;
  spendAmount: () => number;
  envelope?: {
    timeoutMs: number;
    tokenCeiling: number;
  };

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
    undefined,
    undefined,
    params.images,
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

  let status: TurnStatus;
  if (params.envelope) {
    const envelope = params.envelope;
    const timeout = new Promise<"timed_out">((resolve) => {
      setTimeout(() => {
        resolve("timed_out");
      }, envelope.timeoutMs);
    });

    const work = params.stallTimeoutMs
      ? raceStall(params.session, done, params.stallTimeoutMs)
      : done;
    const settled = await Promise.race([work, timeout]);
    if (settled === "timed_out") {
      params.session.stop();
      status = "timed_out";
    } else if (settled === "stalled") {
      params.session.stop();
      status = "failed";
      cause ??= `no runtime activity for ${params.stallTimeoutMs}ms`;
    } else if (settled === "failed") {
      status = "failed";
    } else if (params.tokensUsed() > envelope.tokenCeiling) {
      status = "timed_out";
    } else {
      status = "succeeded";
    }
  } else if (params.stallTimeoutMs) {
    const settled = await raceStall(params.session, done, params.stallTimeoutMs);
    if (settled === "stalled") {
      params.session.stop();
      status = "failed";
    } else if (settled === "failed") {
      status = "failed";
    } else {
      status = "succeeded";
    }
  } else {
    status = (await done) === "failed" ? "failed" : "succeeded";
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
    spendAmount: params.spendAmount(),
    startedAt,
  });

  return cause === undefined ? { status } : { status, cause };
}
