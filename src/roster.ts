import { singleton } from "tsyringe";
import { WebClient, type UsersListResponse } from "@slack/web-api";
import { log } from "./log";

@singleton()
export class Roster {
  private readonly names = new Map<string, string>();

  constructor(web: WebClient) {
    void this.load(web).catch((error: unknown) => {
      log.warn("users.list failed — ids will render without names", { error: String(error) });
    });
  }

  nameOf(principalId: string): string | null {
    return this.names.get(principalId) ?? null;
  }

  private async load(web: WebClient): Promise<void> {
    for await (const page of web.paginate("users.list", { limit: 200 })) {
      for (const member of (page as UsersListResponse).members ?? []) {
        const name = [member.profile?.display_name, member.profile?.real_name, member.name].find(
          Boolean,
        );
        if (member.id && name) this.names.set(member.id, name);
      }
    }
  }
}
