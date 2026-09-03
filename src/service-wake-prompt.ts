import { openItems } from "./ledger/attention";
import { peekDrafts } from "./ledger/conversations-acts";
import type { RefTable } from "./ledger/conversations-refs";
import { REF_LEGEND, append } from "./prompt/format";
import { renderOwedSection } from "./prompt/wake-sections";
import { listedSection, refVenueLine } from "./prompt/format";
import type { Service } from "./service";

export function appendWakePromptSections(
  host: Service,
  identityId: string,
  rendered: string,
  refs: RefTable,
): { prompt: string; heldDrafts: ReturnType<typeof peekDrafts> } {
  const heldDrafts = peekDrafts(host.d.db, identityId);
  const owed = openItems(host.d.db, identityId);
  const nowMs = Date.parse(host.d.clock());

  const prompt = append(
    rendered ? REF_LEGEND + rendered : rendered,
    listedSection("Unsent", heldDrafts, (draft) => refVenueLine(refs, draft, draft.text)),
    renderOwedSection(refs, owed, nowMs),
  );

  return { prompt, heldDrafts };
}
