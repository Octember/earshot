import { openItems } from "./ledger/attention";
import { peekDrafts } from "./ledger/conversations";
import type { RefTable } from "./ledger/conversations-refs";
import { REF_LEGEND, append } from "./prompt/format";
import { renderDraftsSection, renderOwedSection } from "./prompt/wake-sections";
import type { ServiceHost } from "./service-util";

export function appendWakePromptSections(
  host: ServiceHost,
  identityId: string,
  rendered: string,
  refs: RefTable,
): { prompt: string; heldDrafts: ReturnType<typeof peekDrafts> } {
  const heldDrafts = peekDrafts(host.d.db, identityId);
  const owed = openItems(host.d.db, identityId);
  const nowMs = Date.parse(host.d.clock());

  const prompt = append(
    rendered ? REF_LEGEND + rendered : rendered,
    renderDraftsSection(refs, heldDrafts),
    renderOwedSection(refs, owed, nowMs),
  );

  return { prompt, heldDrafts };
}
