import { and, eq } from "drizzle-orm";
import type { Clock } from "./clock";
import type { Ledger } from "./db";
import { steppedBack } from "./schema";

function where(identityId: string, venueId: string, threadRootId: string) {
  return and(
    eq(steppedBack.identityId, identityId),
    eq(steppedBack.venueId, venueId),
    eq(steppedBack.threadRootId, threadRootId),
  );
}

export function outOf(
  db: Ledger,
  identityId: string,
  venueId: string,
  threadRootId: string,
): string | null {
  return (
    db
      .select({ why: steppedBack.why })
      .from(steppedBack)
      .where(where(identityId, venueId, threadRootId))
      .get()?.why ?? null
  );
}

export function stepBack(
  db: Ledger,
  clock: Clock,
  identityId: string,
  venueId: string,
  threadRootId: string,
  why: string,
): void {
  db.insert(steppedBack)
    .values({ identityId, venueId, threadRootId, why, at: clock() })
    .onConflictDoUpdate({
      target: [steppedBack.identityId, steppedBack.venueId, steppedBack.threadRootId],
      set: { why, at: clock() },
    })
    .run();
}

export function reengage(
  db: Ledger,
  identityId: string,
  venueId: string,
  threadRootId: string,
): void {
  db.delete(steppedBack)
    .where(where(identityId, venueId, threadRootId))
    .run();
}
