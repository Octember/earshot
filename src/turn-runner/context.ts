// The entire model-facing input of a turn, as ONE typed struct. Builders (service.ts) fill the
// slots with structured data — selection and sizing is theirs; every formatting decision (labels,
// list shapes, order, what an empty slot looks like) lives in renderTurnPrompt and nowhere else.
// Adding a slot later is one field here plus one block in the renderer; the compiler flags every
// construction site. No slot renders anything when absent.
import type { MemoryItem } from "../ledger/memory";
import type { RecentConversation } from "../ledger/continuity";
import type { MessageFile } from "@bevyl-ai/agent-tools";
import type { ToolboxGroup } from "../tools/catalog";

export interface Speaker {
  venueId: string;
  principalId: string | null;
  standingInstruction?: string; // operator's per-venue instruction (§9.5), when one exists
}

export interface TaskDigest {
  id: string;
  status: string;
  waitingOn?: string | null;
  title: string;
}

export interface ChatterMessage {
  venueId: string;
  ts: string;
  threadRootId?: string | null;
  principalId: string | null;
  text: string;
}

export interface ThreadMessage {
  user: string | null;
  text: string;
  ts: string;
  files?: MessageFile[];
}

export interface TurnPrompt {
  // who's being answered and where — fresh interactive threads only (a resumed codex thread
  // already knows)
  speaker?: Speaker;
  // SPEC §11's toolbox digest — the turn's exposed tools grouped by registry, derived from the
  // BUILT toolset (buildToolbox), fresh contexts only like `speaker`
  toolbox?: ToolboxGroup[];
  // core-tier memory (§8.6), already budget-selected by the builder
  facts?: MemoryItem[];
  // recent-tier memory (§8.6): internalized in passing, unvetted — rendered with that caveat
  noticed?: MemoryItem[];
  openTasks?: TaskDigest[];
  recentTerminals?: TaskDigest[];
  otherConversations?: RecentConversation[];
  // overheard messages — builders size the texts (interactive trims hard, ambient passes full)
  chatter?: ChatterMessage[];
  // the distiller's working set: core items WITH ids (memory_tier/memory_retract need them) plus
  // budget status — deliberately a separate slot from `facts`, which never shows internal ids
  curation?: { items: MemoryItem[]; usedChars: number; budgetChars: number };
  // the Slack thread being replied in, newest tail, trigger message excluded by the builder
  threadTail?: { threadTs: string; messages: ThreadMessage[] };
  // what this turn is about: the triggering message(s), or a sweep's charter
  trigger: string;
  ownLastReply?: string;
  heldDraft?: string;
  // turn-kind mechanics — always last, always present
  guidance: string;
}

// §8.6 core budget selection: most recently confirmed facts first, until the budget is spent.
// Returns what was dropped so the caller can log the hygiene defect (truncation is the safety
// net; the distiller's curation is the fix).
export function coreWithinBudget(items: MemoryItem[], budgetChars: number): { kept: MemoryItem[]; dropped: MemoryItem[] } {
  const byRecency = [...items].sort((a, b) => b.lastConfirmedAt.localeCompare(a.lastConfirmedAt));
  const kept: MemoryItem[] = [];
  const dropped: MemoryItem[] = [];
  let used = 0;
  for (const item of byRecency) {
    if (used + item.content.length <= budgetChars) {
      kept.push(item);
      used += item.content.length;
    } else {
      dropped.push(item);
    }
  }
  return { kept, dropped };
}

// SPEC §11's toolbox digest, rendered: the registry's skill as a block under its heading, one
// line per exposed tool, worked examples with canonical-JSON args, and the room-safe closing
// line. Exported for the one prompt built outside renderTurnPrompt (the execution loop's
// buildPrompt) so the digest looks identical everywhere.
export function renderToolbox(toolbox: ToolboxGroup[]): string {
  const groups = toolbox.map((g) => {
    const lines = [`## ${g.registry}`];
    if (g.skill) lines.push(g.skill);
    lines.push(...g.tools.map((t) => `- ${t.name}: ${t.description}`));
    for (const ex of g.examples ?? []) {
      lines.push(`For example — ${ex.when}:`, `${ex.tool} ${JSON.stringify(ex.args)}`);
      if (ex.result) lines.push(`→ ${ex.result}`);
    }
    return lines.join("\n");
  });
  return `Your tools this turn:\n\n${groups.join("\n\n")}\n\nIf a tool isn't listed, you don't have it this turn; say so plainly rather than working around it.`;
}

function threadLine(m: ThreadMessage): string {
  return `[${m.ts}] ${m.user ?? "?"}: ${m.text.slice(0, 1500)}${m.files?.length ? ` [attached: ${m.files.map((f) => f.name).join(", ")}]` : ""}`;
}

export function renderTurnPrompt(p: TurnPrompt): string {
  const parts: string[] = [];

  if (p.speaker) {
    parts.push(`You are replying in <#${p.speaker.venueId}>. The person speaking is <@${p.speaker.principalId ?? "unknown"}>.`);
    if (p.speaker.standingInstruction) parts.push(`Standing instruction from your operator for THIS venue:\n${p.speaker.standingInstruction}`);
  }
  if (p.toolbox && p.toolbox.length > 0) parts.push(renderToolbox(p.toolbox));
  if (p.facts) parts.push(`Your durable memory:\n${p.facts.map((m) => `- ${m.content}`).join("\n") || "(none yet)"}`);
  if (p.noticed && p.noticed.length > 0)
    parts.push(`Recently noticed (picked up in passing, not yet vetted — confirm before leaning on these):\n${p.noticed.map((m) => `- ${m.content}`).join("\n")}`);
  if (p.openTasks) parts.push(`Your open tasks:\n${p.openTasks.map((t) => `- ${t.id} [${t.status}${t.waitingOn ? `/${t.waitingOn}` : ""}] ${t.title}`).join("\n") || "(none)"}`);
  if (p.recentTerminals) parts.push(`Recently finished tasks:\n${p.recentTerminals.map((t) => `- ${t.id} [${t.status}] ${t.title}`).join("\n") || "(none)"}`);
  if (p.otherConversations)
    parts.push(
      `Your other recent conversations (separate threads — find details with search, or read a channel with read_channel):\n${p.otherConversations.map((c) => `- <#${c.venueId}> ${c.lastAt}: "${c.snippet}"`).join("\n") || "(none)"}`,
    );
  if (p.chatter)
    parts.push(
      `Recent channel chatter you've overheard:\n${p.chatter.map((m) => `- [<#${m.venueId}> ts=${m.ts}${m.threadRootId ? ` thread=${m.threadRootId}` : ""}] ${m.principalId ? `<@${m.principalId}>` : "?"}: ${m.text}`).join("\n") || "(no new messages)"}`,
    );
  if (p.curation)
    parts.push(
      `Your current injected memory (core ${p.curation.usedChars}/${p.curation.budgetChars} chars of budget), each item as [id] (tier) content:\n${p.curation.items.map((m) => `- [${m.id}] (${m.tier}) ${m.content}`).join("\n") || "(none yet)"}`,
    );
  if (p.threadTail && p.threadTail.messages.length > 0)
    parts.push(`The thread you are replying in (thread ts ${p.threadTail.threadTs}, oldest first — read_thread for more):\n${p.threadTail.messages.map(threadLine).join("\n")}`);

  parts.push(p.trigger);

  if (p.ownLastReply)
    parts.push(`Your own most recent reply in this thread — it IS posted and everyone saw it, even if the thread fetch above doesn't show it yet; don't say it again:\n"""\n${p.ownLastReply.slice(0, 1500)}\n"""`);
  if (p.heldDraft)
    parts.push(
      `Last turn you drafted this reply, but the conversation moved on before it posted, so it was held back - NOBODY SAW IT:\n"""\n${p.heldDraft}\n"""\nThe default is to let it go: if the moment passed, someone else covered it, or posting would re-serve a point you already made, post NOTHING. Post it (reworked for where the room stands now) only if it answers something still open that nobody else has.`,
    );

  parts.push(p.guidance);
  return parts.join("\n\n");
}
