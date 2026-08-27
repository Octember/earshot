// Recent-budget distillation: edit core, then harness-archive remaining recent.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { queryMemory, archiveAllRecent, maybeArmDistillation } from "./ledger/memory";
import { buildToolset } from "./turn-runner/toolset";
import { runTurn } from "./turn-runner/turn";
import type { TurnStatus } from "./ledger/turns";
import type { ServiceHost } from "./service-util";

function distillCwd(host: ServiceHost, identityId: string): string {
  const dir = join(`${host.d.cwd}-distill`, identityId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeDistillSoul(host: ServiceHost, identityId: string, cwd: string): void {
  const { coreCharBudget, recentCharBudget } = host.policy().memory;
  const core = queryMemory(host.d.db, identityId, { tier: "core" });
  const recent = queryMemory(host.d.db, identityId, { tier: "recent" });
  const line = (item: (typeof core)[number], label: string) =>
    `- [${item.id}] (${label} ${item.lastConfirmedAt.slice(0, 10)}) ${item.content}`;
  writeFileSync(
    join(cwd, "AGENTS.md"),
    `# Memory distiller

You never post. Promote durable standing facts from recent into core (merge overlaps, stay under ${coreCharBudget} chars). Use memory_write with tier:"core", memory_tier, memory_retract, search. Channel rules belong in venue_instructions — not core. When done, stop; the harness archives remaining recent.

Core (${core.reduce((n, i) => n + i.content.length, 0)} / ${coreCharBudget}):
${core.length ? core.map((i) => line(i, "as of")).join("\n") : "(empty)"}

Recent (${recent.reduce((n, i) => n + i.content.length, 0)} / ${recentCharBudget}) — why you were woken:
${recent.length ? recent.map((i) => line(i, "noticed")).join("\n") : "(empty)"}
`,
  );
}

export function runDistillPass(host: ServiceHost, identityId: string): void {
  if (host.stopping || host.distillRunning.has(identityId)) return;
  const identity = host.identityById(identityId);
  if (!identity) return;

  host.distillRunning.add(identityId);
  const promise = (async () => {
    if (queryMemory(host.d.db, identityId, { tier: "recent" }).length === 0) return;

    let status: TurnStatus = "failed";
    const effects: unknown[] = [];
    const cwd = distillCwd(host, identityId);
    try {
      writeDistillSoul(host, identityId, cwd);
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
      });
      const session = host.d.sessionFactory(tools, undefined, host.policy().models.medium);
      try {
        await session.start(cwd);
        const threadId = await session.startThread(cwd);
        status = (
          await runTurn({
            session,
            threadId,
            cwd,
            prompt: "Recent is full. Distill durable facts into core under budget, then stop.",
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
    }

    if (status === "succeeded") {
      archiveAllRecent(host.d.db, host.d.clock, identityId);
      host.refreshSoul();
    } else {
      host.log.warn("distillation failed — recent kept", { identityId, status });
      maybeArmDistillation(
        host.d.db,
        host.d.clock,
        identityId,
        host.policy().memory.recentCharBudget,
      );
    }
  })().finally(() => {
    host.distillRunning.delete(identityId);
  });
  host.track(host.wakes, promise);
}
