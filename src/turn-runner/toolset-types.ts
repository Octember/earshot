import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";
import type { Anchor } from "../ledger/tasks-types";
import type { RefTable } from "../ledger/conversations-refs";
import type { ToolCatalog, TurnKind } from "../policy/broker";
import type { IdentityConfig } from "../policy/schema";
import type { TurnEffect } from "../schemas/effects";
import type { PostResult } from "../service-wake-post";

export interface ToolsetContext {
  db: Database;
  clock: Clock;
  identity: IdentityConfig;
  turnKind: TurnKind;
  catalog: ToolCatalog;

  anchor: Anchor | null;
  taskId?: string | undefined;
  outwardScopeId?: string | undefined;
  parkAfterMs: number;
  postMessage: (anchor: Anchor, text: string) => Promise<PostResult>;

  refs: RefTable;
  renderConversationCard?: ((target: Anchor) => string) | undefined;

  reactTo?:
    | ((
        venueId: string,
        messageId: string,
        emoji: string,
        threadRootId: string | null,
      ) => Promise<void>)
    | undefined;

  permalink: (venueId: string, messageId: string) => string | undefined;
  effects: TurnEffect[];
}
