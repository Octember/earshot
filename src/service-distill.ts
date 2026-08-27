// Recent-budget distillation pass: edit core, then harness-archive remaining recent.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { queryMemory } from "./ledger/memory";
import { archiveAllRecent, maybeArmDistillation } from "./ledger/memory-distill";
import { composeDistillInstructions } from "./turn-runner/distill-soul";
import { buildToolset } from "./turn-runner/toolset";
import { runTurn } from "./turn-runner/turn";
import type { TurnStatus } from "./ledger/turns";
import type { AgentEvent } from "./turn-runner/types";
import type { ServiceHost } from "./service-util";

export function distillWorkspace(host: ServiceHost): string {
  return `${host.d.cwd}-distill`;
}

export function distillWorkspaceFor(host: ServiceHost, identityId: string): string {
  const dir = join(distillWorkspace(host), identityId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function refreshDistillSoul(host: ServiceHost, identityId: string): void {
  const memory = host.policy().memory;
  const core = queryMemory(host.d.db, identityId, { tier: "core" });
  const recent = queryMemory(host.d.db, identityId, { tier: "recent" });
  writeFileSync(
    join(distillWorkspaceFor(host, identityId), "AGENTS.md"),
    composeDistillInstructions({
      identityId,
      coreBudget: memory.coreCharBudget,
      recentBudget: memory.recentCharBudget,
      core: core.map((item) => ({
        id: item.id,
        content: item.content,
        asOf: item.lastConfirmedAt,
      })),
      recent: recent.map((item) => ({
        id: item.id,
        content: item.content,
        asOf: item.lastConfirmedAt,
      })),
    }),
  );
}

export function armDistillationIfNeeded(host: ServiceHost, identityId: string): boolean {
  return maybeArmDistillation(
    host.d.db,
    host.d.clock,
    identityId,
    host.policy().memory.recentCharBudget,
  );
}

export function runDistillPass(host: ServiceHost, identityId: string): void {
  if (host.stopping) return;
  if (host.distillRunning.has(identityId)) {
    host.distillRerun.add(identityId);
    return;
  }
  const identity = host.identityById(identityId);
  if (!identity) {
    host.log.warn("distillation fired for unknown identity", { identityId });
    return;
  }
  host.distillRunning.add(identityId);
  const promise = (async () => {
    const recent = queryMemory(host.d.db, identityId, { tier: "recent" });
    if (recent.length === 0) {
      host.log.info("distillation skipped — recent empty", { identityId });
      return;
    }
    let status: TurnStatus = "failed";
    const effects: unknown[] = [];
    try {
      refreshDistillSoul(host, identityId);
      const cwd = distillWorkspaceFor(host, identityId);
      const tools = buildToolset({
        db: host.d.db,
        clock: host.d.clock,
        identity,
        turnKind: "distillation",
        catalog: host.catalog,
        anchor: null,
        nudgeAfterMs: host.policy().tasks.nudgeAfterMs,
        postMessage: async () => ({ messageId: "distill-no-post" }),
        effects,
        recentCharBudget: host.policy().memory.recentCharBudget,
        defaultMemoryTier: "core",
      });
      const session = host.d.sessionFactory(
        tools,
        (agentEvent: AgentEvent) => {
          if (agentEvent.log) host.log.info("distill", { line: agentEvent.log });
        },
        host.policy().models.medium,
      );
      try {
        await session.start(cwd);
        const threadId = await session.startThread(cwd);
        status = (
          await runTurn({
            session,
            threadId,
            cwd,
            prompt:
              "Recent memory is full. Distill durable standing facts into core (under budget), then stop. The harness will archive whatever recent remains.",
            title: `distill:${identityId}`,
            db: host.d.db,
            clock: host.d.clock,
            turnId: host.d.newId(),
            identityId,
            kind: "distillation",
            effects,
            tokensUsed: () => 0,
            spendAmount: () => 0,
            envelope: {
              timeoutMs: host.policy().turns.interactiveTimeoutMs,
              tokenCeiling: host.policy().turns.interactiveTokenCeiling,
            },
          })
        ).status;
      } finally {
        session.stop();
      }
    } catch (error) {
      host.log.error("distillation threw", { identityId, error: String(error) });
      status = "failed";
    }

    if (status === "succeeded") {
      const archived = archiveAllRecent(host.d.db, host.d.clock, identityId);
      host.log.info("distillation succeeded — archived remaining recent", {
        identityId,
        archived: archived.length,
      });
      host.refreshSoul();
    } else {
      host.log.warn("distillation did not succeed — leaving recent intact", {
        identityId,
        status,
      });
      armDistillationIfNeeded(host, identityId);
    }
  })().finally(() => {
    host.distillRunning.delete(identityId);
    const again = host.distillRerun.delete(identityId);
    if (!host.stopping && again) runDistillPass(host, identityId);
  });
  host.track(host.wakes, promise);
}
