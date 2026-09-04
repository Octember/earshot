import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRefTable } from "./ledger/conversations-refs";
import { activeMemory, withinBudget } from "./ledger/memory";
import { buildToolset } from "./turn-runner/toolset";
import { composeInstructions } from "./turn-runner/soul";
import { buildToolbox, renderToolbox } from "./tools/catalog";
import type { Service } from "./service";

export function refreshSoul(host: Service): void {
  try {
    for (const identity of host.policy().identities) {
      const { kept, dropped } = withinBudget(
        activeMemory(host.d.db, identity.id, "core"),
        host.policy().memory.coreCharBudget,
      );
      if (dropped > 0)
        host.log.warn("core memory over budget — items left out of the soul", {
          identityId: identity.id,
          dropped,
        });
      const knowledge = {
        identity: identity.id,
        facts: kept.map((memory) => ({ content: memory.content, asOf: memory.createdAt })),
        dropped,
      };
      const standing = { identity: identity.id, venues: identity.venueInstructions };
      const digest = renderToolbox(
        buildToolbox(
          buildToolset({
            db: host.d.db,
            clock: host.d.clock,
            identity,
            turnKind: "resident",
            external: host.external,
            anchor: null,
            parkAfterMs: 0,
            postMessage: async () => ({ held: "undelivered" }),
            permalink: host.d.permalink,
            refs: makeRefTable(),
            effects: [],
          }),
          host.groups,
        ),
        { header: "", brief: true },
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
      host.log.info("soul written", { path, identity: identity.id, facts: kept.length });
    }
  } catch (error) {
    host.log.warn("could not write soul (AGENTS.md) — using codex default voice", {
      error: String(error),
    });
  }
}
