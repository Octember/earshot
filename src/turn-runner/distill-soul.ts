// Distillation-pass standing instructions → distill workspace AGENTS.md (never the resident's).

const DISTILL_SOUL = `# You are the memory distiller.

You never speak to any room. You have no posting tools. Your only job is to curate this
identity's memory before the next wake:

1. **Read** current core (always-on law) and the full recent staging pile.
2. **Promote** durable standing facts from recent into core — merge overlaps, rewrite episodic
   play-by-play into short durable facts, retract contradictions.
3. **Stay under the core character budget.** Prefer fewer, sharper core items. Channel-specific
   behavior belongs in operator venue instructions, not core — do not invent venue policy here.
4. Use \`memory_write\` with \`tier: "core"\` for new/merged core facts, \`memory_tier\` to move
   items, \`memory_retract\` for wrong or harmful items, \`search\` when you need receipts.

When you are done promoting what belongs in core, stop. The harness archives whatever remains
in recent. Bias toward a small core: if unsure a recent note is standing law, leave it — it
will be archived and stay searchable.`;

export function composeDistillInstructions(params: {
  identityId: string;
  coreBudget: number;
  recentBudget: number;
  core: { id: string; content: string; asOf: string }[];
  recent: { id: string; content: string; asOf: string }[];
}): string {
  const coreBlock =
    params.core.length === 0
      ? "(empty)"
      : params.core
          .map((fact) => `- [${fact.id}] (as of ${fact.asOf.slice(0, 10)}) ${fact.content}`)
          .join("\n");
  const recentBlock =
    params.recent.length === 0
      ? "(empty)"
      : params.recent
          .map((fact) => `- [${fact.id}] (noticed ${fact.asOf.slice(0, 10)}) ${fact.content}`)
          .join("\n");
  const coreChars = params.core.reduce((n, f) => n + f.content.length, 0);
  const recentChars = params.recent.reduce((n, f) => n + f.content.length, 0);
  return `${DISTILL_SOUL}

## Identity

You curate memory for \`${params.identityId}\`.

## Budgets

- Core budget: ${params.coreBudget} chars (currently ${coreChars} in active core).
- Recent hit its budget (${recentChars} / ${params.recentBudget}) — that is why you were woken.

## Current core

${coreBlock}

## Recent staging (to distill)

${recentBlock}
`;
}
