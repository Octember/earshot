import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { inject, singleton } from "tsyringe";
import { WORKSPACE } from "./tokens";

export type Role = "resident" | "ear" | "worker";

@singleton()
export class Workspaces {
  readonly resident: string;
  readonly ear: string;
  readonly worker: string;
  readonly files: string;

  constructor(@inject(WORKSPACE) root: string) {
    this.resident = ensure(root);
    this.ear = ensure(`${root}-ear`);
    this.worker = this.resident;
    this.files = ensure(join(root, "files"));
  }
}

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
