import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inject, singleton } from "tsyringe";
import { log } from "./log";
import { POLICY, type Policy } from "./policy";
import ear from "./soul/ear.md" with { type: "text" };
import resident from "./soul/resident.md" with { type: "text" };
import { Workspaces } from "./workspaces";

function orElse(text: string | undefined, fallback: string): string {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? fallback : trimmed;
}

function fill(template: string, holes: Record<string, string>): string {
  return template.replaceAll(/\{\{(\w+)\}\}/g, (_, name: string) => holes[name] ?? "");
}

/** AGENTS.md for her and for her ear. Prose lives in soul/*.md; this fills the holes. */
@singleton()
export class Soul {
  constructor(
    @inject(POLICY) private readonly policy: Policy,
    private readonly workspaces: Workspaces,
  ) {}

  refresh(): void {
    try {
      const memoryPath = join(this.workspaces.home, "MEMORY.md");
      const holes = {
        persona: orElse(this.policy.persona, "(none)"),
        memory: orElse(existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "", "(empty)"),
        venues: orElse(
          Object.entries(this.policy.venue_instructions)
            .map(([venueId, instruction]) => `- <#${venueId}>: ${instruction}`)
            .join("\n"),
          "(none)",
        ),
      };
      writeFileSync(join(this.workspaces.home, "AGENTS.md"), fill(resident, holes));
      writeFileSync(join(this.workspaces.ear, "AGENTS.md"), fill(ear, holes));
    } catch (error) {
      log.warn("could not write soul (AGENTS.md) — using codex default voice", {
        error: String(error),
      });
    }
  }
}
