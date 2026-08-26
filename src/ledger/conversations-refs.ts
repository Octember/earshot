import type { ConversationKey } from "./conversations-stance";

export interface RefTarget {
  venueId: string;
  threadRootId: string | null;
  ts?: string;
  via: "rendered" | "search";
  eventId?: string;
  principalId?: string | null;
}

export interface RefTable {
  mint(target: RefTarget): string;
  get(ref: string): RefTarget | undefined;
}

export function makeRefTable(): RefTable {
  let nextId = 0;
  const table = new Map<string, RefTarget>();
  return {
    mint(target) {
      const ref = `r${++nextId}`;
      table.set(ref, target);
      return ref;
    },
    get: (ref) => table.get(ref),
  };
}

export function conversationOf(target: RefTarget): ConversationKey {
  return { venueId: target.venueId, threadRootId: target.threadRootId ?? target.ts ?? null };
}
