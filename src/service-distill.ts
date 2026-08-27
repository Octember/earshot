// When recent hits budget: model promotes durable facts to core, then harness archives the rest.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { queryMemory, archiveAllRecent, maybeArmDistillation } from "./ledger/memory";
import { buildToolset } from "./turn-runner/toolset";
import { runTurn } from "./turn-runner/turn";
import type { TurnStatus } from "./ledger/turns";
import type { MemoryItem } from "./ledger/memory";
import type { ServiceHost } from "./service-util";

function memoryBullets(items: MemoryItem[], label: string): string {
  if (items.length === 0) return "(empty)";
  return items
    .map((i) => `- [${i.id}] (${label} ${i.lastConfirmedAt.slice(0, 10)}) ${i.content}`)
    .join("\n");
}

export function distillRecentMemories(host: ServiceHost, identityId: string): void {
  if (host.stopping || host.distillRunning.has(identityId)) return;
  const identity = host.identityById(identityId);
  if (!identity) return;

  host.distillRunning.add(identityId);
  const promise = (async () => {
    const { coreCharBudget, recentCharBudget } = host.policy().memory;
    const core = queryMemory(host.d.db, identityId, { tier: "core" });
    const recent = queryMemory(host.d.db, identityId, { tier: "recent" });
    if (recent.length === 0) return;

    const cwd = join(`${host.d.cwd}-distill`, identityId);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(cwd, "AGENTS.md"),
      `# Distill recent → core

Never post. Promote durable standing facts from recent into core (merge overlaps, stay under ${coreCharBudget} chars). Use memory_write tier:"core", memory_tier, memory_retract, search. Channel rules stay in venue_instructions. Stop when done; harness archives remaining recent.

Core (${core.reduce((n, i) => n + i.content.length, 0)} / ${coreCharBudget}):
${memoryBullets(core, "as of")}

Recent (${recent.reduce((n, i) => n + i.content.length, 0)} / ${recentCharBudget}):
${memoryBullets(recent, "noticed")}
`,
    );

    let status: TurnStatus = "failed";
    const effects: unknown[] = [];
    try {
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
        recentCharBudget,
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
      host.log.error("distillRecentMemories threw", { identityId, error: String(error) });
    }

    if (status === "succeeded") {
      archiveAllRecent(host.d.db, host.d.clock, identityId);
      host.refreshSoul();
    } else {
      host.log.warn("distillRecentMemories failed — recent kept", { identityId, status });
      maybeArmDistillation(host.d.db, host.d.clock, identityId, recentCharBudget);
    }
  })().finally(() => {
    host.distillRunning.delete(identityId);
  });
  host.track(host.wakes, promise);
}
