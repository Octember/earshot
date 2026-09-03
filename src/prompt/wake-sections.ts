import type { AttentionItem } from "../ledger/schema";
import type { RefTable } from "../ledger/conversations-refs";
import { listedSection, refVenueLine } from "./format";

const OWED_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const OWED_SHOW = 5;
const STALE = " · stale";

export function renderOwedSection(
  refs: RefTable,
  owed: readonly AttentionItem[],
  nowMs: number,
): string {
  return listedSection(
    "Open",
    owed,
    (item) =>
      refVenueLine(
        refs,
        item,
        item.what,
        nowMs - Date.parse(item.openedAt) > OWED_MAX_AGE_MS ? STALE : "",
      ),
    {
      cap: OWED_SHOW,
      overflow: (hidden) => `(+${hidden} more)`,
    },
  );
}
