import type { Anchor } from "./tasks-types";

export interface RefTarget extends Anchor {
  ts?: string;
  via: "rendered" | "search";
  eventId?: number;
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

export function conversationOf(target: RefTarget): Anchor {
  return { venueId: target.venueId, threadRootId: target.threadRootId ?? target.ts ?? null };
}
