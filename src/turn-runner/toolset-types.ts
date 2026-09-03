import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";
import type { Anchor } from "../ledger/tasks-types";
import type { RefTable } from "../ledger/conversations-refs";
import type { ToolCatalog, TurnKind } from "../policy/broker";
import type { IdentityConfig } from "../policy/schema";
import type { TurnEffect } from "../schemas/effects";

export interface ToolsetContext {
  db: Database;
  clock: Clock;
  identity: IdentityConfig;
  turnKind: TurnKind;
  catalog: ToolCatalog;

  anchor: Anchor | null;
  principal?: { id: string } | undefined;
  originEventId?: string | undefined;
  taskId?: string | undefined;
  outwardScopeId?: string | undefined;
  nudgeAfterMs: number;
  postMessage: (
    anchor: Anchor,
    text: string,
    opts?: { awaitingReply?: boolean | undefined },
  ) => Promise<{ messageId: string }>;

  bufferReply?: ((anchor: Anchor, text: string, awaitingReply?: boolean) => boolean) | undefined;

  refs?: RefTable | undefined;
  renderConversationCard?:
    | ((target: { venueId: string; threadRootId: string | null }) => string)
    | undefined;

  reactTo?:
    | ((
        venueId: string,
        messageId: string,
        emoji: string,
        threadRootId: string | null,
      ) => Promise<void>)
    | undefined;

  permalink?: ((venueId: string, messageId: string) => string | undefined) | undefined;
  effects: TurnEffect[];

  recentCharBudget?: number | undefined;
}

export function pushEffect(ctx: ToolsetContext, effect: TurnEffect): void {
  ctx.effects.push(effect);
}

export function checkPostingScope(ctx: ToolsetContext, anchor: Anchor): string | null {
  if (ctx.turnKind === "resident") {
    const venues = ctx.identity.venueIds;
    return venues.includes("*") || venues.includes(anchor.venueId)
      ? null
      : `you may only post to venues you serve, got ${anchor.venueId}`;
  }
  if (!ctx.anchor) return "no anchor context for this turn";
  return anchor.venueId === ctx.anchor.venueId
    ? null
    : `turns may only post within venue ${ctx.anchor.venueId}, got ${anchor.venueId}`;
}
