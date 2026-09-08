import { singleton } from "tsyringe";
import { WebClient, type UsersListResponse } from "@slack/web-api";

@singleton()
export class Roster {
  private readonly names = new Map<string, string>();
  private readonly loaded: Promise<void>;

  constructor(private readonly web: WebClient) {
    this.loaded = this.load();
  }

  async nameOf(principalId: string): Promise<string | null> {
    await this.loaded;
    return this.names.get(principalId) ?? null;
  }

  private async load(): Promise<void> {
    for await (const page of this.web.paginate("users.list", { limit: 200 })) {
      for (const member of (page as UsersListResponse).members ?? []) {
        const name = [member.profile?.display_name, member.profile?.real_name, member.name].find(
          Boolean,
        );
        if (member.id && name) this.names.set(member.id, name);
      }
    }
  }
}
