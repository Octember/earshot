import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inject, singleton } from "tsyringe";
import { log } from "./log";
import { POLICY, type IdentityConfig, type Policy } from "./policy";
import ear from "./soul/ear.md" with { type: "text" };
import resident from "./soul/resident.md" with { type: "text" };
import { BOT_USER_ID } from "./tokens";
import { Workspaces } from "./workspaces";

function orElse(text: string | undefined, fallback: string): string {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? fallback : trimmed;
}

function fill(template: string, holes: Record<string, string>): string {
  return template.replaceAll(/\{\{(\w+)\}\}/g, (_, name: string) => holes[name] ?? "");
}

/** AGENTS.md for every identity: hers, and her ear's. Prose lives in soul/*.md; this fills the holes. */
@singleton()
export class Soul {
  constructor(
    @inject(POLICY) private readonly policy: Policy,
    @inject(BOT_USER_ID) private readonly botUserId: string,
    private readonly workspaces: Workspaces,
  ) {}

  refresh(): void {
    try {
      for (const identity of this.policy.identities) {
        const holes = this.holes(identity);
        writeFileSync(join(this.workspaces.for(identity.id), "AGENTS.md"), fill(resident, holes));
        writeFileSync(join(this.workspaces.ear(identity.id), "AGENTS.md"), fill(ear, holes));
      }
    } catch (error) {
      log.warn("could not write soul (AGENTS.md) — using codex default voice", {
        error: String(error),
      });
    }
  }

  private holes(identity: IdentityConfig): Record<string, string> {
    const memoryPath = join(this.workspaces.for(identity.id), "MEMORY.md");
    return {
      id: identity.id,
      botUserId: this.botUserId,
      persona: orElse(identity.persona, "(none)"),
      memory: orElse(existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "", "(empty)"),
      venues: orElse(
        Object.entries(identity.venue_instructions)
          .map(([venueId, instruction]) => `- <#${venueId}>: ${instruction}`)
          .join("\n"),
        "(none)",
      ),
    };
  }
}
