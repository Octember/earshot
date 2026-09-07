import { inject, singleton } from "tsyringe";
import { Inbox, type Conversation } from "./inbox";
import { LEDGER, type Ledger } from "./ledger/db";
import { outOf } from "./ledger/stance";

@singleton()
export class Inboxes {
  private readonly byIdentity = new Map<string, Inbox>();

  constructor(@inject(LEDGER) private readonly db: Ledger) {}

  of(identityId: string): Inbox {
    let inbox = this.byIdentity.get(identityId);
    if (!inbox) {
      inbox = new Inbox();
      this.byIdentity.set(identityId, inbox);
    }
    return inbox;
  }

  /** Drops ambient chatter in threads she stepped back from; everything else reaches her. */
  admitted(identityId: string, convos: Conversation[]): Conversation[] {
    const dropped = convos.filter(
      (convo) =>
        convo.wakeWhy === null &&
        !convo.heard.some((h) => h.direct) &&
        outOf(this.db, identityId, convo.channel, convo.threadTs) !== null,
    );
    this.of(identityId).take(dropped);
    return convos.filter((convo) => !dropped.includes(convo));
  }
}
