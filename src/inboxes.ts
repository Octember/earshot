import { singleton } from "tsyringe";
import { Inbox } from "./inbox";

@singleton()
export class Inboxes {
  private readonly byIdentity = new Map<string, Inbox>();

  of(identityId: string): Inbox {
    let inbox = this.byIdentity.get(identityId);
    if (!inbox) {
      inbox = new Inbox();
      this.byIdentity.set(identityId, inbox);
    }
    return inbox;
  }
}
