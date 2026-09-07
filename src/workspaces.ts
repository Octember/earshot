import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { inject, singleton } from "tsyringe";
import { WORKSPACE } from "./tokens";

@singleton()
export class Workspaces {
  constructor(@inject(WORKSPACE) private readonly root: string) {}

  for(identityId: string): string {
    return this.ensure(join(this.root, identityId));
  }

  ear(identityId: string): string {
    return this.ensure(join(`${this.root}-ear`, identityId));
  }

  files(): string {
    return this.ensure(join(this.root, "files"));
  }

  private ensure(dir: string): string {
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}
