import {
  loadEarBatch,
  buildEarPrompt,
  runEarSession,
  commitEarJudgments,
} from "./service-ear-pass";
import { makeRefTable } from "./ledger/conversations";
import type { TurnStatus } from "./ledger/turns";
import type { ServiceHost } from "./service-util";
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
      host.log.warn("ear pass did not succeed — failing open to a wake", { identityId, status });
      needWake = true;
    }
    if (needWake) runWake(host, identityId);
  })().finally(() => {
    host.earRunning.delete(identityId);
    const again = host.earRerun.delete(identityId);
    if (!host.stopping && again) runEarPass(host, identityId);
  });
  host.track(host.wakes, promise);
}
