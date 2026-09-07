import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { inject, singleton } from "tsyringe";
import { WORKSPACE } from "./tokens";

export type Role = "resident" | "ear" | "worker";

@singleton()
export class Workspaces {
  readonly files: string;
  private readonly home: string;
  private readonly ear: string;

  constructor(@inject(WORKSPACE) root: string) {
    this.home = ensure(root);
    this.ear = ensure(`${root}-ear`);
    this.files = ensure(join(root, "files"));
  }

  for(role: Role): string {
    return role === "ear" ? this.ear : this.home;
  }
}

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
