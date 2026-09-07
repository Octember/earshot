import { and, eq } from "drizzle-orm";
import { now } from "./clock";
import type { Ledger } from "./db";
import { steppedBack } from "./schema";

function where(venueId: string, threadRootId: string) {
  return and(eq(steppedBack.venueId, venueId), eq(steppedBack.threadRootId, threadRootId));
}

export function outOf(db: Ledger, venueId: string, threadRootId: string): string | null {
  return (
    db.select({ why: steppedBack.why }).from(steppedBack).where(where(venueId, threadRootId)).get()
      ?.why ?? null
  );
}

export function stepBack(db: Ledger, venueId: string, threadRootId: string, why: string): void {
  db.insert(steppedBack)
    .values({ venueId, threadRootId, why, at: now() })
    .onConflictDoUpdate({
      target: [steppedBack.venueId, steppedBack.threadRootId],
      set: { why, at: now() },
    })
    .run();
}

export function reengage(db: Ledger, venueId: string, threadRootId: string): void {
  db.delete(steppedBack).where(where(venueId, threadRootId)).run();
}
