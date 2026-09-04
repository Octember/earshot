import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildToolset } from "./turn-runner/toolset";
import { composeInstructions } from "./turn-runner/soul";
import { buildToolbox, renderToolbox } from "./tools/catalog";
import type { Service } from "./service";

export function readMemory(host: Service, identityId: string): string {
  const path = join(host.workspaceFor(identityId), "MEMORY.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function refreshSoul(host: Service): void {
  try {
    for (const identity of host.policy().identities) {
      const digest = renderToolbox(
        buildToolbox(
          buildToolset({
            db: host.d.db,
            clock: host.d.clock,
            identity,
            turnKind: "resident",
            external: host.external,
            parkAfterMs: 0,
            post: null,
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
          [{ identity: identity.id, memory: readMemory(host, identity.id) }],
          [{ identity: identity.id, venues: identity.venueInstructions }],
          [{ identity: identity.id, digest }],
        ),
      );
    }
  } catch (error) {
    host.log.warn("could not write soul (AGENTS.md) — using codex default voice", {
      error: String(error),
    });
  }
}
