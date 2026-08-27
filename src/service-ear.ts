import {
  loadEarBatch,
  buildEarPrompt,
  runEarSession,
  commitEarJudgments,
} from "./service-ear-pass";
import { drainOutStanceJudgments } from "./ledger/conversations";
import { makeRefTable } from "./ledger/conversations";
import type { TurnStatus } from "./ledger/turns";
import { isDirectAddress, type ServiceHost } from "./service-util";
import { runWake } from "./service-wake";

export function scheduleEar(host: ServiceHost, identityId: string): void {
  if (host.stopping) return;
  if (host.earDebounce.has(identityId)) return;
  const identity = host.identityById(identityId);
  host.earDebounce.set(
    identityId,
    setTimeout(() => {
      host.earDebounce.delete(identityId);
      if (!host.stopping) runEarPass(host, identityId);
    }, identity?.ambient.eventDebounceMs ?? 20_000),
  );
}

export function runEarPass(host: ServiceHost, identityId: string): void {
  if (host.earRunning.has(identityId)) {
    host.earRerun.add(identityId);
    return;
  }
  host.earRunning.add(identityId);
  const promise = (async () => {
    drainOutStanceJudgments(host.d.db, host.d.clock, identityId);
    const convos = loadEarBatch(host, identityId);
    if (convos.length === 0) return;
    const effects: unknown[] = [];
    let needWake = false;
    const refs = makeRefTable();
    const prompt = buildEarPrompt(host, identityId, convos, refs);
    let status: TurnStatus = "failed";
    try {
      status = await runEarSession(host, identityId, prompt, effects, refs, () => {
        needWake = true;
      });
    } catch (error) {
      host.log.error("ear pass threw", { identityId, error: String(error) });
    } finally {
      commitEarJudgments(host, identityId, convos);
    }
    if (status !== "succeeded") {
      const hasDirect = convos.some((convo) =>
        convo.messages.some((message) => isDirectAddress(message)),
      );
      const hasExternal = convos.some((convo) =>
        convo.messages.some((message) => message.kind === "external_signal"),
      );
      if (!needWake && (hasDirect || hasExternal)) {
        host.log.warn("ear pass did not succeed — waking for direct or worker traffic", {
          identityId,
          status,
          hasDirect,
          hasExternal,
        });
        needWake = true;
      } else if (!needWake) {
        host.log.warn("ear pass did not succeed — failing closed", { identityId, status });
      }
    }
    if (needWake) runWake(host, identityId);
  })().finally(() => {
    host.earRunning.delete(identityId);
    const again = host.earRerun.delete(identityId);
    if (!host.stopping && again) runEarPass(host, identityId);
  });
  host.track(host.wakes, promise);
}
