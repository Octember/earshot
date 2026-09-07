import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { inject, singleton } from "tsyringe";
import { WORKSPACE } from "./tokens";

@singleton()
export class Workspaces {
  readonly home: string;
  readonly ear: string;
  readonly files: string;

  constructor(@inject(WORKSPACE) root: string) {
    this.home = ensure(root);
    this.ear = ensure(`${root}-ear`);
    this.files = ensure(join(root, "files"));
  }
}

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
