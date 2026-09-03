import type { RefTable } from "../ledger/conversations-refs";

import type { Anchor } from "../ledger/tasks-types";

export const REF_LEGEND = "[rN] tags mark lines you can reply to or react to.\n\n";

export function lines(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join("\n");
}

export function append(base: string, ...sections: (string | false | null | undefined)[]): string {
  return base + sections.filter(Boolean).join("");
}

export function titledSection(title: string, body: string): string {
  return body ? `\n\n${title}:\n${body}` : "";
}

export function venueCoords(at: Anchor, ts?: string | null): string {
  const thread = at.threadRootId ? ` thread=${at.threadRootId}` : "";
  const stamp = ts ? ` ts=${ts}` : "";
  return `<#${at.venueId}>${thread}${stamp}`;
}

export function refVenueLine(refs: RefTable, at: Anchor, body: string, note?: string): string {
  const ref = refs.mint({ venueId: at.venueId, threadRootId: at.threadRootId, via: "search" });
  return `- [${ref}] ${venueCoords(at)} · ${body}${note ?? ""}`;
}

export function idVenueLine(id: string, at: Anchor, body: string): string {
  return `- (${id}) ${venueCoords(at)} · ${body}`;
}

export interface ListedSectionOpts {
  cap?: number;
  overflow?: (hidden: number) => string;
}

export function listedSection<T>(
  title: string,
  items: readonly T[],
  line: (item: T) => string,
  opts?: ListedSectionOpts,
): string {
  const cap = opts?.cap ?? items.length;
  const rows = items.slice(0, cap).map((item) => line(item));
  const hidden = items.length - cap;
  const foot = hidden > 0 && opts?.overflow ? opts.overflow(hidden) : "";
  return titledSection(title, lines(...rows, foot));
}
