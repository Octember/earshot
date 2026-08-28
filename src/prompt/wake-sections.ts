import type { AttentionItem } from "../ledger/attention";
import type { RefTable } from "../ledger/conversations-refs";
import { listedSection, refVenueLine } from "./format";

const OWED_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const OWED_SHOW = 5;
const STALE = " · stale";

type HeldDraft = { venueId: string; threadRootId: string | null; text: string };

function draftLine(refs: RefTable, draft: HeldDraft): string {
  return refVenueLine(refs, draft, draft.text);
}

function owedLine(refs: RefTable, item: AttentionItem, nowMs: number): string {
  const stale = nowMs - Date.parse(item.openedAt) > OWED_MAX_AGE_MS ? STALE : "";
  return refVenueLine(refs, item, item.what, stale);
}

export function renderDraftsSection(refs: RefTable, drafts: readonly HeldDraft[]): string {
  return listedSection("Unsent", drafts, (draft) => draftLine(refs, draft));
}

export function renderOwedSection(
  refs: RefTable,
  owed: readonly AttentionItem[],
  nowMs: number,
): string {
  return listedSection("Open", owed, (item) => owedLine(refs, item, nowMs), {
    cap: OWED_SHOW,
    overflow: (hidden) => `(+${hidden} more)`,
  });
}
