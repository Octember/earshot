import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRefTable } from "./ledger/conversations";
import { queryMemory, coreWithinBudget, decayRecentToArchive } from "./ledger/memory";
import { buildToolset } from "./turn-runner/toolset";
import { composeInstructions } from "./turn-runner/soul";
import { buildToolbox, renderToolbox, type ToolRegistry } from "./tools/catalog";
import type { ToolCatalog } from "./policy/broker";
import type { Logger } from "./log";
import type { ServiceDeps } from "./service-util";
import type { Policy } from "./policy/schema";

export type SoulHost = {
  d: ServiceDeps;
  log: Logger;
  catalog: ToolCatalog;
  registries: ToolRegistry[];
  policy: () => Policy;
  workspaceFor: (identityId: string) => string;
};

export function refreshSoul(host: SoulHost): void {
  try {
    for (const identity of host.policy().identities) {
      const decayed = decayRecentToArchive(
        host.d.db,
        host.d.clock,
        identity.id,
        host.policy().memory.recentMaxAgeMs,
      );
      if (decayed.length > 0)
        host.log.info("recent memory decayed to archive (§8.6)", {
          identityId: identity.id,
          decayed: decayed.length,
        });
      const { kept, dropped } = coreWithinBudget(
        queryMemory(host.d.db, identity.id, { tier: "core" }),
        host.policy().memory.coreCharBudget,
      );
      if (dropped.length > 0)
        host.log.warn(
          "core memory over budget — items truncated from the soul (§8.6 hygiene defect)",
          { identityId: identity.id, dropped: dropped.length },
        );
      const recent = coreWithinBudget(
        queryMemory(host.d.db, identity.id, { tier: "recent" }),
        host.policy().memory.recentCharBudget,
      );
      const knowledge = {
        identity: identity.id,
        facts: kept.map((memory) => ({ content: memory.content, asOf: memory.lastConfirmedAt })),
        dropped: dropped.length,
        recent: recent.kept.map((memory) => ({
          content: memory.content,
          asOf: memory.lastConfirmedAt,
        })),
      };
      const standing = { identity: identity.id, venues: identity.venueInstructions };
      const digest = renderToolbox(
        buildToolbox(
          buildToolset({
            db: host.d.db,
            clock: host.d.clock,
            identity,
            turnKind: "resident",
            catalog: host.catalog,
            anchor: null,
            nudgeAfterMs: 0,
            postMessage: async () => ({ messageId: "digest-probe" }),
            refs: makeRefTable(),
            effects: [],
          }),
          host.registries,
        ),
        "",
      );
      const path = join(host.workspaceFor(identity.id), "AGENTS.md");
      writeFileSync(
        path,
        composeInstructions(
          identity.persona ? [identity.persona] : [],
          [knowledge],
          [standing],
          [{ identity: identity.id, digest }],
        ),
      );
      host.log.info("soul written", {
        path,
        identity: identity.id,
        knowledgeItems: knowledge.facts.length,
        recentItems: knowledge.recent.length,
      });
    }
  } catch (error) {
    host.log.warn("could not write soul (AGENTS.md) — using codex default voice", {
      error: String(error),
    });
  }
}
