import { refreshSoul } from "./service-soul";
import type { TurnEffect } from "./schemas/effects";

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { queryMemory, setMemoryTier, maybeArmDistillation } from "./ledger/memory";
import type { MemoryItem } from "./ledger/schema";
import { buildToolset } from "./turn-runner/toolset";
import { runTurn } from "./turn-runner/turn";
import type { TurnStatus } from "./ledger/schema";
import type { Service } from "./service";

function bullets(items: MemoryItem[], label: string): string {
  if (items.length === 0) return "(empty)";
  return items
    .map((i) => `- [${i.id}] (${label} ${i.lastConfirmedAt.slice(0, 10)}) ${i.content}`)
    .join("\n");
}

export function distillRecentMemories(host: Service, identityId: string): void {
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
    const coreChars = core.reduce((n, i) => n + i.content.length, 0);
    const recentChars = recent.reduce((n, i) => n + i.content.length, 0);
    writeFileSync(
      join(cwd, "AGENTS.md"),
      `# Distill recent → core

Never post. Promote durable standing facts from recent into core (merge overlaps, stay under ${coreCharBudget} chars). Use memory_write tier:"core", memory_tier, memory_retract, search. Channel rules stay in venue_instructions. Stop when done; harness archives remaining recent.

Core (${coreChars} / ${coreCharBudget}):
${bullets(core, "as of")}

Recent (${recentChars} / ${recentCharBudget}):
${bullets(recent, "noticed")}
`,
    );

    let status: TurnStatus = "failed";
    try {
      const effects: TurnEffect[] = [];
      const tools = buildToolset({
        db: host.d.db,
        clock: host.d.clock,
        identity,
        turnKind: "distillation",
        catalog: host.catalog,
        anchor: null,
        parkAfterMs: host.policy().tasks.parkAfterMs,
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
            title: `distill:${identity.id}`,
            db: host.d.db,
            clock: host.d.clock,
            turnId: host.d.newId(),
            identityId: identity.id,
            kind: "distillation",
            effects,
            timeoutMs: host.policy().turns.interactiveTimeoutMs,
          })
        ).status;
      } finally {
        session.stop();
      }
    } catch (error) {
      host.log.error("distillRecentMemories threw", { identityId, error: String(error) });
    }
    if (status === "succeeded") {
      for (const item of queryMemory(host.d.db, identityId, { tier: "recent" }))
        setMemoryTier(host.d.db, host.d.clock, item.id, "archive");
      refreshSoul(host);
    } else {
      host.log.warn("distillRecentMemories failed — recent kept", { identityId, status });
      maybeArmDistillation(host.d.db, host.d.clock, identityId, recentCharBudget);
    }
  })().finally(() => {
    host.distillRunning.delete(identityId);
  });
  host.track(host.wakes, promise);
}
