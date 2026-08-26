import { openItems } from "./ledger/attention";
import { peekDrafts } from "./ledger/conversations";
import type { RefTable } from "./ledger/conversations-refs";
import type { ServiceHost } from "./service-util";

const ATTENTION_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const ATTENTION_PROMPT_CAP = 5;

function formatDraftSection(heldDrafts: ReturnType<typeof peekDrafts>, refs: RefTable): string {
  if (heldDrafts.length === 0) return "";
  return `\n\n[drafted last wake but not sent — the conversation had moved on; decide fresh what (if anything) to say]\n${heldDrafts.map((draft) => `- [${refs.mint({ venueId: draft.venueId, threadRootId: draft.threadRootId, via: "search" })}] to <#${draft.venueId}>${draft.threadRootId ? ` thread=${draft.threadRootId}` : ""}: ${draft.text}`).join("\n")}`;
}

function formatOwedSection(host: ServiceHost, identityId: string, refs: RefTable): string {
  const owed = openItems(host.d.db, identityId);
  if (owed.length === 0) return "";
  const lines = owed.slice(0, ATTENTION_PROMPT_CAP).map((item) => {
    const overdue = Date.parse(host.d.clock()) - Date.parse(item.openedAt) > ATTENTION_MAX_AGE_MS;
    return `- [${refs.mint({ venueId: item.venueId, threadRootId: item.threadRootId, via: "search" })}] <#${item.venueId}>${item.threadRootId ? ` thread=${item.threadRootId}` : ""}: ${item.what}${overdue ? " (open a long time — settle it or drop it)" : ""}`;
  });
  const tail =
    owed.length > ATTENTION_PROMPT_CAP
      ? `\n(+${owed.length - ATTENTION_PROMPT_CAP} newer ones not shown — they surface as these settle)`
      : "";
  return `\n\n[still owed]\n${lines.join("\n")}${tail}`;
}

export function appendWakePromptSections(
  host: ServiceHost,
  identityId: string,
  rendered: string,
  refs: RefTable,
): { prompt: string; heldDrafts: ReturnType<typeof peekDrafts> } {
  const heldDrafts = peekDrafts(host.d.db, identityId);
  return {
    prompt: `${rendered}${formatDraftSection(heldDrafts, refs)}${formatOwedSection(host, identityId, refs)}`,
    heldDrafts,
  };
}
