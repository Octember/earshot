// Recent-full → model edits core → harness archives leftover recent.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  queryMemory,
  archiveAllRecent,
  maybeArmDistillation,
  type MemoryItem,
} from "./ledger/memory";
import { buildToolset } from "./turn-runner/toolset";
import { runTurn } from "./turn-runner/turn";
import type { TurnStatus } from "./ledger/turns";
import type { IdentityConfig } from "./policy/schema";
import type { Service } from "./service";

const DISTILL_PROMPT = "Recent is full. Distill durable facts into core under budget, then stop.";

function bullets(items: MemoryItem[], label: string): string {
  if (items.length === 0) return "(empty)";
  return items
    .map((i) => `- [${i.id}] (${label} ${i.lastConfirmedAt.slice(0, 10)}) ${i.content}`)
    .join("\n");
}

function buildDistilPrompt(
  core: MemoryItem[],
  recent: MemoryItem[],
  coreBudget: number,
  recentBudget: number,
): string {
  const coreChars = core.reduce((n, i) => n + i.content.length, 0);
  const recentChars = recent.reduce((n, i) => n + i.content.length, 0);
  return `# Distill recent → core

Never post. Promote durable standing facts from recent into core (merge overlaps, stay under ${coreBudget} chars). Use memory_write tier:"core", memory_tier, memory_retract, search. Channel rules stay in venue_instructions. Stop when done; harness archives remaining recent.

Core (${coreChars} / ${coreBudget}):
${bullets(core, "as of")}

Recent (${recentChars} / ${recentBudget}):
${bullets(recent, "noticed")}
`;
}

function workspaceFor(host: Service, identityId: string): string {
  const dir = join(`${host.d.cwd}-distill`, identityId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function runDistillTurn(
  host: Service,
  identity: IdentityConfig,
  cwd: string,
  recentCharBudget: number,
): Promise<TurnStatus> {
  const effects: unknown[] = [];
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
    return (
      await runTurn({
        session,
        threadId,
        cwd,
        prompt: DISTILL_PROMPT,
        title: `distill:${identity.id}`,
        db: host.d.db,
        clock: host.d.clock,
        turnId: host.d.newId(),
        identityId: identity.id,
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
}

function onDistillDone(
  host: Service,
  identityId: string,
  status: TurnStatus,
  recentCharBudget: number,
): void {
  if (status === "succeeded") {
    archiveAllRecent(host.d.db, host.d.clock, identityId);
    host.refreshSoul();
    return;
  }
  host.log.warn("distillRecentMemories failed — recent kept", { identityId, status });
  maybeArmDistillation(host.d.db, host.d.clock, identityId, recentCharBudget);
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

    const cwd = workspaceFor(host, identityId);
    writeFileSync(
      join(cwd, "AGENTS.md"),
      buildDistilPrompt(core, recent, coreCharBudget, recentCharBudget),
    );

    let status: TurnStatus = "failed";
    try {
      status = await runDistillTurn(host, identity, cwd, recentCharBudget);
    } catch (error) {
      host.log.error("distillRecentMemories threw", { identityId, error: String(error) });
    }
    onDistillDone(host, identityId, status, recentCharBudget);
  })().finally(() => {
    host.distillRunning.delete(identityId);
  });
  host.track(host.wakes, promise);
}
