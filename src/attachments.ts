import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { WebClient } from "@slack/web-api";
import { singleton } from "tsyringe";
import { Workspaces } from "./workspaces";

export interface Attachment {
  id?: string | undefined;
  name?: string | null | undefined;
  mimetype?: string | undefined;
  url_private?: string | undefined;
}

@singleton()
export class Attachments {
  constructor(
    private readonly web: WebClient,
    private readonly workspaces: Workspaces,
  ) {}

  async save(file: Attachment): Promise<string> {
    const label = `${file.name ?? file.id} (${file.mimetype})`;
    if (!file.url_private || !file.id) return label;
    const path = join(this.workspaces.files, `${file.id}-${basename(file.name ?? "file")}`);
    if (existsSync(path)) return `${path} (${file.mimetype})`;
    try {
      const res = await fetch(file.url_private, {
        headers: { Authorization: `Bearer ${this.web.token}` },
      });
      if (!res.ok) return label;
      await Bun.write(path, await res.arrayBuffer());
    } catch {
      return label;
    }
    return `${path} (${file.mimetype})`;
  }
}
