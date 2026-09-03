import { sameNullable } from "./conversations-util";
import type { Database } from "bun:sqlite";
import { and, asc, eq, isNull, or, sql, notLike } from "drizzle-orm";
import type { Clock } from "./clock";
import { orm } from "./db";
import { attentionItems, type AttentionItem } from "./schema";

export function openAttentionItem(
  db: Database,
  clock: Clock,
  item: {
    id: string;
    identityId: string;
    venueId: string;
    threadRootId: string | null;
    askTs: string | null;
    what: string;
  },
): void {
  const dup = orm(db)
    .select({ one: sql`1` })
    .from(attentionItems)
    .where(
      and(
        eq(attentionItems.identityId, item.identityId),
        eq(attentionItems.venueId, item.venueId),
        sameNullable(attentionItems.threadRootId, item.threadRootId),
        sameNullable(attentionItems.askTs, item.askTs),
        isNull(attentionItems.closedAt),
      ),
    )
    .get();
  if (dup) return;
  orm(db)
    .insert(attentionItems)
    .values({
      id: item.id,
      identityId: item.identityId,
      venueId: item.venueId,
      threadRootId: item.threadRootId,
      askTs: item.askTs,
      what: item.what,
      openedAt: clock(),
    })
    .run();
}

export function closeAttentionItemsForThread(
  db: Database,
  clock: Clock,
  identityId: string,
  venueId: string,
  threadRootId: string | null,
  cause: string,
): number {
  return orm(db)
    .update(attentionItems)
    .set({ closedAt: clock(), closedCause: cause })
    .where(
      and(
        eq(attentionItems.identityId, identityId),
        eq(attentionItems.venueId, venueId),
        sameNullable(attentionItems.threadRootId, threadRootId),
        isNull(attentionItems.closedAt),
      ),
    )
    .returning({ id: attentionItems.id })
    .all().length;
}

export function closeAttentionItem(
  db: Database,
  clock: Clock,
  identityId: string,
  id: string,
  cause: string,
): boolean {
  return (
    orm(db)
      .update(attentionItems)
      .set({ closedAt: clock(), closedCause: cause })
      .where(
        and(
          eq(attentionItems.id, id),
          eq(attentionItems.identityId, identityId),
          isNull(attentionItems.closedAt),
        ),
      )
      .returning({ id: attentionItems.id })
      .get() != null
  );
}

export function reopenAttentionItem(db: Database, identityId: string, id: string): boolean {
  return (
    orm(db)
      .update(attentionItems)
      .set({ closedAt: null, closedCause: null })
      .where(
        and(
          eq(attentionItems.id, id),
          eq(attentionItems.identityId, identityId),
          or(isNull(attentionItems.closedCause), notLike(attentionItems.closedCause, "operator:%")),
        ),
      )
      .returning({ id: attentionItems.id })
      .get() != null
  );
}

export function openItems(db: Database, identityId: string, limit = 50): AttentionItem[] {
  return orm(db)
    .select()
    .from(attentionItems)
    .where(and(eq(attentionItems.identityId, identityId), isNull(attentionItems.closedAt)))
    .orderBy(asc(attentionItems.openedAt))
    .limit(limit)
    .all();
}
