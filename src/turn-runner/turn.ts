// Run one turn against an agent runtime session and record it.
import { maybeRotateGateway } from "@bevyl-ai/agent-tools";
import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";
import { recordTurn, type TurnKind, type TurnStatus } from "../ledger/turns";
import type { Anchor } from "../ledger/tasks";
import type { AgentRuntimeSession } from "./types";

export interface EnvelopeOpts {
  timeoutMs: number;
  tokenCeiling: number;
}

export interface RunTurnParams {
  images?: string[]; // local image paths attached to the turn input (vision)
  session: AgentRuntimeSession;
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
  effects: unknown[];
  tokensUsed: () => number;
  spendAmount: () => number;
  envelope?: EnvelopeOpts;
  // After model settles, before turn row — buffered replies post/withhold here.
  beforeRecord?: (status: TurnStatus) => Promise<void>;
  // Idle (no activity) watchdog, not total turn time.
  stallTimeoutMs?: number;
}

export interface RunTurnResult {
  status: TurnStatus;
  // Rejection message when status is "failed" via rejected turn promise.
  cause?: string;
}

async function raceStall(session: AgentRuntimeSession, done: Promise<"completed" | "failed">, stallTimeoutMs: number): Promise<"completed" | "failed" | "stalled"> {
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

export async function runTurn(params: RunTurnParams): Promise<RunTurnResult> {
  const startedAt = params.clock();
  const turnPromise = params.session.runTurn(params.threadId, params.cwd, params.prompt, params.title, undefined, undefined, params.images);
  // Rotate CODEX_GATEWAY_POOL on usage-limit failures (kit-owned; unset pool = no-op).
  turnPromise.catch((e: unknown) => maybeRotateGateway({ reason: e instanceof Error ? e.message : String(e) }));

  let cause: string | undefined;
  const done = turnPromise.then(
    () => "completed" as const,
    (e: unknown) => {
      cause = e instanceof Error ? e.message : String(e);
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
    // Envelope = honest work; stall = dead runtime. Silence fails early for retry;
    // an in-flight host tool call counts as activity, not silence.
    const work = params.stallTimeoutMs ? raceStall(params.session, done, params.stallTimeoutMs) : done;
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
      status = "timed_out"; // over token ceiling despite finishing
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
