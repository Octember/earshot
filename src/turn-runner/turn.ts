// SPEC §4.1.6, §11 — runs one turn against an agent runtime session and records it. Interactive/
// ambient/distillation turns are envelope-bounded (time + token ceiling); execution_step turns are
// bounded instead by the execution loop's max_turns + per-turn stall watchdog (SPEC §6.3), so no
// envelope is passed for them.
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
  envelope?: EnvelopeOpts; // interactive/ambient/distillation (SPEC §4.1.6)
  // execution_step's watchdog (SPEC §6.3): wall-clock with NO activity, not total turn time.
  // Requires session.msSinceLastActivity(); a stall is "killed and treated as a failed attempt."
  stallTimeoutMs?: number;
}

export interface RunTurnResult {
  status: TurnStatus;
}

async function raceStall(session: AgentRuntimeSession, turnPromise: Promise<void>, stallTimeoutMs: number): Promise<"completed" | "failed" | "stalled"> {
  let settled = false;
  const done = turnPromise.then(
    () => "completed" as const,
    () => "failed" as const,
  );
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

  let status: TurnStatus;
  if (params.envelope) {
    const envelope = params.envelope;
    const timeout = new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), envelope.timeoutMs));
    const settled = await Promise.race([turnPromise.then(() => "completed" as const).catch(() => "failed" as const), timeout]);
    if (settled === "timed_out") {
      params.session.stop();
      status = "timed_out";
    } else if (settled === "failed") {
      status = "failed";
    } else if (params.tokensUsed() > envelope.tokenCeiling) {
      status = "timed_out"; // envelope breach: over the token ceiling even though it finished
    } else {
      status = "succeeded";
    }
  } else if (params.stallTimeoutMs) {
    const settled = await raceStall(params.session, turnPromise, params.stallTimeoutMs);
    if (settled === "stalled") {
      params.session.stop();
      status = "failed"; // SPEC §6.3: a stalled execution is killed and treated as a failed attempt
    } else if (settled === "failed") {
      status = "failed";
    } else {
      status = "succeeded";
    }
  } else {
    try {
      await turnPromise;
      status = "succeeded";
    } catch {
      status = "failed";
    }
  }

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

  return { status };
}
