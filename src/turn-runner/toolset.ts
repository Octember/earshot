// SPEC §11 — the standard toolset exposed to a turn, gated through policy/broker.ts's decide()
// on every call so grant/toolset-kind/confirmation-eligibility can never be bypassed by a tool
// implementation forgetting to check. Posting is scope-checked here too (SPEC §11's posting-scope
// rule): interactive/execution_step turns may only post within their own anchor's venue; ambient
// only within its enabled venues; distillation never.
import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";
import {
  createTask,
  getTask,
  steerTask,
  requestConfirmation,
  resolveConfirmation,
  transition,
  ledgerView,
  nextTaskId,
  type Anchor,
} from "../ledger/tasks";
import { writeMemory, retractMemory, queryMemory, setMemoryTier, type MemoryTier } from "../ledger/memory";
import { closeAttentionItemsForThread } from "../ledger/attention";
import { searchArchive, type SearchHit } from "../ledger/search";
import { engage, stepBack, conversationOf, convoKey, provenanceOfRef, lastSpeakerIn, type RefTable } from "../ledger/conversations";
import { queryAudit, type AuditKind } from "../ledger/audit";
import { decide, exposableForKind, actionRefFor, canonicalJson, type ToolCatalog, type TurnKind } from "../policy/broker";
import type { ToolRegistry } from "../tools/catalog";
import type { IdentityConfig } from "../policy/schema";
import type { DynamicTool } from "./types";
import { and, eq, gt } from "drizzle-orm";
import { asString, isRecord } from "../guard";
import { orm } from "../ledger/db";
import { outwardCalls } from "../ledger/schema";

function fields(args: unknown): Record<string, unknown> {
  return isRecord(args) ? args : {};
}
function optString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function optTaskTier(v: unknown): "low" | "medium" | "high" | undefined {
  return v === "low" || v === "medium" || v === "high" ? v : undefined;
}
function optMemoryTier(v: unknown): MemoryTier | undefined {
  return v === "core" || v === "recent" || v === "archive" ? v : undefined;
}
function optAuditKind(v: unknown): AuditKind | undefined {
  switch (v) {
    case "event_received":
    case "turn_started":
    case "turn_ended":
    case "task_created":
    case "task_transitioned":
    case "tool_invoked":
    case "confirmation_requested":
    case "confirmation_resolved":
    case "ambient_posted":
    case "budget_denied":
    case "memory_written":
    case "memory_retracted":
    case "memory_tier_changed":
      return v;
    default:
      return undefined;
  }
}
function checklistItems(v: unknown): { text: string; done: boolean }[] {
  if (!Array.isArray(v)) return [];
  return v.map((item) => {
    const r = isRecord(item) ? item : {};
    return { text: asString(r.text), done: r.done === true };
  });
}

// A tool as its factory builds it: spec + raw implementation, NOT yet callable. buildToolset is
// the only site that turns a factory into a DynamicTool, by wrapping impl in the broker gate —
// an unbrokered tool is unconstructible, not a convention (SPEC §10.1 as structure).
interface ToolFactory {
  spec: DynamicTool["spec"];
  impl: (args: unknown) => Promise<{ success: boolean; output: string }>;
}

export interface Principal {
  id: string;
  isGuest: boolean;
  isOperator: boolean;
}

export interface ToolsetContext {
  db: Database;
  clock: Clock;
  identity: IdentityConfig;
  turnKind: TurnKind;
  catalog: ToolCatalog;
  // The turn's own anchor: the triggering anchor (interactive), the task's home anchor
  // (execution_step), or null (ambient is venue-scoped not anchor-scoped; distillation posts
  // nowhere).
  anchor: Anchor | null;
  principal?: Principal | undefined;
  originEventId?: string | undefined;
  taskId?: string | undefined; // the task this execution_step turn belongs to
  outwardScopeId?: string | undefined; // outward-call dedupe scope for taskless turns (the wake id)
  nudgeAfterMs: number;
  postMessage: (anchor: Anchor, text: string) => Promise<{ messageId: string }>;
  // SPEC §5.5 stale-reply withholding: set only when the turn's batch had no direct address.
  // Replies then buffer with the caller until turn end, which posts each one or withholds it
  // (newer addressed arrivals on its conversation) into the next wake as an unsent draft. The
  // caller owns the posted/withheld effect records; replyTool records nothing for a buffered call.
  // Returns true when the reply buffered for §5.5's turn-end flush; false means the target
  // conversation was directly addressed this wake and the reply should post immediately.
  bufferReply?: ((anchor: Anchor, text: string) => boolean) | undefined;
  // Addressing as capability (ladder R4): the turn's ref table is the ONLY source of speakable
  // targets — reply/react/step_back accept refs, never coordinates. via='search' refs (drafts,
  // owed items, search hits) bounce once with the conversation's card before a send passes.
  refs?: RefTable | undefined;
  renderConversationCard?: ((target: { venueId: string; threadRootId: string | null }) => string) | undefined;
  // Edit an already-posted message (Slack chat.update). Enables the live checklist. Optional — a
  // surface without it just re-posts instead of editing in place.
  updateMessage?: ((venueId: string, messageId: string, text: string) => Promise<void>) | undefined;
  // Shared holder for live checklist message ids, keyed by convoKey — persists across a turn's
  // attempts (and an execution's turns) so the `checklist` tool edits ONE message in place per
  // conversation (Claude Tag's signature UX).
  checklist?: Map<string, string> | undefined;
  // React to a message by venue + surface ts (Slack reactions.add) — sometimes an emoji IS the
  // right reply ("if u see this please emoji it"). threadRootId is the ref target's own thread
  // (null for a top-level message): the react's ledger residence comes from the line the model
  // was shown, never re-derived from the batch. Venue-scoped like any post.
  reactTo?: ((venueId: string, messageId: string, emoji: string, threadRootId: string | null) => Promise<void>) | undefined;
  // Render a checklist as NATIVE task cards on the stream seated at `seat`. Returns false when
  // the surface has no native cards (caller falls back to the emoji-text message).
  renderChecklist?: ((items: { text: string; done: boolean }[], seat: Anchor) => Promise<boolean>) | undefined;
  // Resolve a principal id to its standing (operator/guest) — for durable writes whose person
  // comes from a ref's provenance rather than the wake-level principal.
  resolvePrincipal?: ((principalId: string) => Principal) | undefined;
  // Build a surface permalink for a message (SPEC §8.7: search hits carry receipts). Absent when
  // the surface can't construct one; hits then cite venue + timestamp only.
  permalink?: ((venueId: string, messageId: string) => string | undefined) | undefined;
  effects: unknown[]; // mutated in place — collected for turns.ts's recordTurn
}

function pushEffect(ctx: ToolsetContext, effect: unknown): void {
  ctx.effects.push(effect);
}

function checkPostingScope(ctx: ToolsetContext, anchor: Anchor): string | null {
  // Resident wakes speak anywhere their identity serves (SPEC §5 post-collapse); execution
  // steps stay pinned to their task's home venue.
  if (ctx.turnKind === "resident") {
    const venues = ctx.identity.venueIds;
    return venues.includes("*") || venues.includes(anchor.venueId) ? null : `you may only post to venues you serve, got ${anchor.venueId}`;
  }
  if (!ctx.anchor) return "no anchor context for this turn";
  return anchor.venueId === ctx.anchor.venueId ? null : `turns may only post within venue ${ctx.anchor.venueId}, got ${anchor.venueId}`;
}

// SPEC §5.1: every outbound post engages (or re-engages) the conversation, not just addressed
// inbound messages — a top-level post's own returned message id becomes the thread root future
// replies will carry.
function recordPostedThread(ctx: ToolsetContext, anchor: Anchor, messageId: string): void {
  engage(ctx.db, ctx.clock, ctx.identity.id, anchor.venueId, anchor.threadRootId ?? messageId);
}

function gated(ctx: ToolsetContext, toolName: string, impl: (args: unknown) => Promise<{ success: boolean; output: string }>): DynamicTool["run"] {
  return async (args: unknown) => {
    const decision = decide(ctx.db, ctx.clock, {
      identity: ctx.identity,
      turnKind: ctx.turnKind,
      tool: toolName,
      args,
      catalog: ctx.catalog,
      taskId: ctx.taskId,
      principal: ctx.principal ? { isGuest: ctx.principal.isGuest } : undefined,
    });
    if (!decision.allow) {
      // SPEC §10.2: a denied consequential call on a granted external tool doesn't just fail —
      // execution_step turns get routed into the confirmation flow automatically.
      if (decision.reason === "confirmation_denied") {
        return {
          success: false,
          output: "a human declined exactly this action — it stays declined. Change the approach, or task_fail with what you wanted and why it was refused.",
        };
      }
      if (decision.reason === "requires_confirmation" && ctx.taskId) {
        const current = getTask(ctx.db, ctx.taskId)?.pendingConfirmation;
        if (current?.actionRef === actionRefFor(toolName, args) && current.resolution?.approved && current.consumedAt) {
          // The approved call already executed — the spent token is the receipt. Never re-ask.
          return { success: false, output: "already done: this exact call was approved and ran earlier. If you meant a different change, change the arguments." };
        }
        if (current && !current.resolution) {
          // One ask at a time: a new request must not clobber a question the human is answering.
          return { success: false, output: "a go-ahead request is already pending on this task — stop here and end the turn; ask for anything else after it resolves" };
        }
        if (current?.resolution?.approved && !current.consumedAt) {
          // An approved, unspent token for a DIFFERENT action must not be destroyed by a new ask.
          return { success: false, output: "an approved go-ahead for another action is still unspent — execute that first (or task_fail explaining why not)" };
        }
        const nudgeDeadline = new Date(new Date(ctx.clock()).getTime() + ctx.nudgeAfterMs).toISOString();
        requestConfirmation(ctx.db, ctx.clock, {
          taskId: ctx.taskId,
          actionRef: actionRefFor(toolName, args),
          description: `Requesting confirmation to call ${toolName} (${decision.actionClasses.join(", ")}) with ${JSON.stringify(args)}`,
          nudgeDeadline,
        });
        pushEffect(ctx, { kind: "confirmation_requested", tool: toolName, actionClasses: decision.actionClasses });
        return {
          success: false,
          output: `requires_confirmation: task ${ctx.taskId} is now waiting on a human go-ahead — the request reaches the room through the mind. Stop here and end the turn; do not retry the call and do not reach for outcome tools (the task is paused until the go-ahead resolves).`,
        };
      }
      // The two turn-policy denials are ones the model may need to explain in the room — hand it
      // room-ready framing (the requires_confirmation branch above already does), or it parrots
      // harness vocabulary ("mutating turn") into Slack.
      if (decision.reason === "not_available_for_turn_kind") {
        return {
          success: false,
          output: `denied: not_available_for_turn_kind — this turn is speak-only; the action can run from a task turn or after a member's go-ahead. If you mention this in the room, say it plainly ("say the word and i'll do it") — never turn kinds, mutations, or other internals.`,
        };
      }
      if (decision.reason === "interactive_consequential_denied") {
        return {
          success: false,
          output: `denied: interactive_consequential_denied — this action is consequential and must run inside a task: use task_create and it will proceed there. When you tell the room, say plainly what you're taking on and where you'll report back — never this machinery.`,
        };
      }
      return { success: false, output: `denied: ${decision.reason}` };
    }
    return impl(args);
  };
}

function taskCreateTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "task_create",
      description:
        "Record a new delegated task; a worker runs it and reports back to you. Input: { title, spec, ref, tier? }. ref is the [rN] tag of the conversation (or a message in it) this task is FOR — the worker's report comes home to that conversation, so pick the room that asked for the work, not whoever spoke last. tier is how hard the worker thinks: 'low' for routine mechanical work (tailing a ticket, fetching status), 'medium' for normal work, 'high' (default) for problems that need real thought. Write the spec as a full handoff — the worker starts with none of this conversation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["title", "spec", "ref"],
        properties: {
          title: { type: "string" },
          spec: { type: "string" },
          ref: { type: "string", pattern: "^r\\d+$" },
          tier: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
    impl: async (args) => {
      const a = fields(args);
      const title = asString(a.title);
      const spec = asString(a.spec);
      const ref = optString(a.ref);
      const tier = optTaskTier(a.tier);
      // The task's home is HER call, bound to a rendered conversation — never a batch-level
      // guess (live 2026-08-13: a task about an alert burst homed to the last thread that
      // happened to address her, and its report answered an adjacent incident).
      const target = ref ? ctx.refs?.get(ref) : undefined;
      if (!target) {
        return { success: false, output: `"${ref ?? ""}" is not a ref — home the task with the [rN] tag of the conversation its report belongs in` };
      }
      const home = conversationOf(target);
      // Sponsor and origin bind to the ref's own provenance too: the same audit found the T-354
      // fix left both on the batch-level pick, producing tasks homed to one thread but sponsored
      // by a speaker in another. A machine-authored line (worker report) has no speaker — the
      // newest human IN THAT CONVERSATION stands sponsor, never a batch-level principal.
      const prov = provenanceOfRef(ctx.db, ctx.identity.id, target);
      if (!prov) {
        return { success: false, output: "nothing recorded in that conversation yet — home the task with the [rN] tag of the message that asked for it" };
      }
      const sponsorId = prov.principalId ?? lastSpeakerIn(ctx.db, ctx.identity.id, home);
      if (!sponsorId) return { success: false, output: "can't tell who this task is for — use the [rN] tag of the asking message" };
      const sponsor = ctx.resolvePrincipal?.(sponsorId) ?? (ctx.principal?.id === sponsorId ? ctx.principal : undefined);
      const task = createTask(ctx.db, ctx.clock, {
        id: nextTaskId(ctx.db),
        identityId: ctx.identity.id,
        title,
        spec,
        sponsorId,
        homeAnchor: { venueId: home.venueId, threadRootId: home.threadRootId },
        originEventId: prov.eventId,
        tier,
        sponsorIsOperator: sponsor?.isOperator ?? false,
      });
      pushEffect(ctx, { kind: "task_created", taskId: task.id });
      return { success: true, output: JSON.stringify({ taskId: task.id, status: task.status }) };
    },
  };
}

// The durable source event a steer/cancel records: from the ref's provenance in ref-bearing
// turns (the message that asked for this — the same rung as every other durable write), else
// the turn's own origin event. A string return is the correctable bounce.
function steerSourceEvent(ctx: ToolsetContext, ref: string | undefined, asking: string): string | { bounce: string } {
  if (ctx.refs) {
    const target = ref ? ctx.refs.get(ref) : undefined;
    if (!target) return { bounce: `"${ref ?? ""}" is not a ref — pass the [rN] tag of the message ${asking}` };
    const prov = provenanceOfRef(ctx.db, ctx.identity.id, target);
    if (!prov) return { bounce: "nothing recorded in that conversation yet — point at the message itself" };
    return prov.eventId;
  }
  if (!ctx.originEventId) return { bounce: "missing turn context" };
  return ctx.originEventId;
}

function taskSteerTool(ctx: ToolsetContext): ToolFactory {
  const withRef = !!ctx.refs;
  return {
    spec: {
      name: "task_steer",
      description: `Attach guidance, a pause, or a resume to an existing task. Input: { taskId, kind: 'guidance'|'pause'|'resume', text?${withRef ? ", ref" : ""} }.${withRef ? " ref is the [rN] tag of the message asking for this." : ""}`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: withRef ? ["taskId", "kind", "ref"] : ["taskId", "kind"],
        properties: {
          taskId: { type: "string" },
          kind: { type: "string", enum: ["guidance", "pause", "resume"] },
          text: { type: "string" },
          ...(withRef ? { ref: { type: "string", pattern: "^r\\d+$" } } : {}),
        },
      },
    },
    impl: async (args) => {
      const a = fields(args);
      const taskId = asString(a.taskId);
      const kind = a.kind;
      const text = optString(a.text);
      const ref = optString(a.ref);
      const source = steerSourceEvent(ctx, ref, "asking for this steer");
      if (typeof source !== "string") return { success: false, output: source.bounce };
      // "cancel"/"confirm" have their own dedicated tools (task_cancel/task_confirm) with their
      // own eligibility rules — task_steer's declared schema excludes them, and the JS-level call
      // must enforce that too, not just trust codex to validate against inputSchema.
      if (kind !== "guidance" && kind !== "pause" && kind !== "resume") {
        return { success: false, output: `invalid_kind: task_steer only accepts guidance/pause/resume; use task_cancel or task_confirm for ${asString(kind)}` };
      }
      const result = steerTask(ctx.db, ctx.clock, { identityId: ctx.identity.id, taskId, kind, payload: { text }, sourceEventId: source });
      pushEffect(ctx, { kind: "task_steered", taskId, steerKind: kind, applied: result.applied });
      return { success: result.applied, output: result.reply ?? JSON.stringify({ status: result.task.status }) };
    },
  };
}

function taskCancelTool(ctx: ToolsetContext): ToolFactory {
  const withRef = !!ctx.refs;
  return {
    spec: {
      name: "task_cancel",
      description: `Cancel a task. The report is a ledger record — it is NOT posted to the thread. If the room should hear that the work stopped, say it yourself with reply. Input: { taskId, report?${withRef ? ", ref" : ""} }.${withRef ? " ref is the [rN] tag of the message asking for the cancel." : ""}`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: withRef ? ["taskId", "ref"] : ["taskId"],
        properties: {
          taskId: { type: "string" },
          report: { type: "string" },
          ...(withRef ? { ref: { type: "string", pattern: "^r\\d+$" } } : {}),
        },
      },
    },
    impl: async (args) => {
      const a = fields(args);
      const taskId = asString(a.taskId);
      const report = optString(a.report);
      const ref = optString(a.ref);
      const source = steerSourceEvent(ctx, ref, "asking for the cancel");
      if (typeof source !== "string") return { success: false, output: source.bounce };
      const result = steerTask(ctx.db, ctx.clock, { identityId: ctx.identity.id, taskId, kind: "cancel", payload: { report }, sourceEventId: source });
      pushEffect(ctx, { kind: "task_cancelled", taskId, applied: result.applied });
      return { success: result.applied, output: result.reply ?? JSON.stringify({ status: result.task.status }) };
    },
  };
}

function taskConfirmTool(ctx: ToolsetContext): ToolFactory {
  // With a ref table (resident wakes), the approver is the SPEAKER of the ref'd message — the
  // durable resolution records who actually said yes/no, never a wake-level principal pick.
  // Ref-less contexts (no rendered lines to point at) keep the turn principal.
  const withRef = !!ctx.refs;
  return {
    spec: {
      name: "task_confirm",
      description: withRef
        ? "Resolve a pending confirmation on a task from a member's approve/deny. Input: { taskId, approve, ref } — ref is the [rN] tag of the message where they granted or denied it; their word is the authority, so point at it."
        : "Resolve a pending confirmation on a task from a member's approve/deny. Input: { taskId, approve }.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: withRef ? ["taskId", "approve", "ref"] : ["taskId", "approve"],
        properties: {
          taskId: { type: "string" },
          approve: { type: "boolean" },
          ...(withRef ? { ref: { type: "string", pattern: "^r\\d+$" } } : {}),
        },
      },
    },
    impl: async (args) => {
      const a = fields(args);
      const taskId = asString(a.taskId);
      const approve = a.approve === true;
      const ref = optString(a.ref);
      let approverId: string;
      if (withRef) {
        const target = ref ? ctx.refs?.get(ref) : undefined;
        // A go-ahead belongs to the person who SAID it: only a message ref names a speaker. A
        // conversation ref would resolve to whoever spoke last in the room — the exact
        // batch-tail guess this tool exists to prevent (audit 2026-08-13, verified live-shape).
        if (!target?.ts) {
          return { success: false, output: `"${ref ?? ""}" is not a message ref — pass the [rN] tag of the member's own approve/deny line, not the conversation's` };
        }
        // Unread targets are rejected outright (no one-shot bounce like reply's): recording who
        // authorized a consequential action from a line this turn never read is never right.
        if (target.via === "search") {
          return { success: false, output: "that line isn't from this conversation as you just read it — point at the [rN] tag of the approve/deny message in the rendered card" };
        }
        const prov = provenanceOfRef(ctx.db, ctx.identity.id, target);
        if (!prov?.principalId) {
          return { success: false, output: "that line has no speaker to attribute the decision to — use the [rN] tag of the member's own message" };
        }
        approverId = prov.principalId;
      } else {
        if (!ctx.principal) return { success: false, output: "missing principal for task_confirm" };
        approverId = ctx.principal.id;
      }
      const result = resolveConfirmation(ctx.db, ctx.clock, { identityId: ctx.identity.id, taskId, principalId: approverId, approve });
      pushEffect(ctx, { kind: "confirmation_resolved", taskId, approve, applied: result.applied });
      return { success: result.applied, output: result.reply ?? JSON.stringify({ status: result.task.status }) };
    },
  };
}

function taskQueryTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "task_query",
      description: "Read your open tasks and your recently finished ones.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    impl: async () => {
      const view = ledgerView(ctx.db, ctx.identity.id);
      return { success: true, output: JSON.stringify(view) };
    },
  };
}

function replyTool(ctx: ToolsetContext): ToolFactory {
  // One bounce per unread target per attempt: the second send is her informed call and goes
  // through. Per-attempt on purpose — a retry is a fresh session that never saw the card.
  const bounced = new Set<string>();
  return {
    spec: {
      name: "reply",
      description:
        "Post a message into a conversation. ref is the [rN] tag copied from the start of the line you're answering — always the r-number (like r3), never a timestamp, channel id, or thread id (those are labels, not addresses). A message ref replies in its thread; a conversation ref posts there. Refs come only from what you can see — there is no other way to address a room.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text", "ref"],
        properties: { text: { type: "string" }, ref: { type: "string", pattern: "^r\\d+$" } },
      },
    },
    impl: async (args) => {
      const a = fields(args);
      const text = asString(a.text);
      const ref = optString(a.ref);
      const target = ref ? ctx.refs?.get(ref) : undefined;
      if (!target) {
        return { success: false, output: `"${ref ?? ""}" is not a ref — copy the [rN] tag (like r3) from the start of a line you were shown; timestamps and channel ids are labels, not addresses` };
      }
      const key = conversationOf(target);
      const anchor: Anchor = { venueId: key.venueId, threadRootId: key.threadRootId };
      const violation = checkPostingScope(ctx, anchor);
      if (violation) return { success: false, output: `posting_scope_violation: ${violation}` };

      // A via='search' target was read in some OTHER turn — the first send returns the
      // conversation as it now stands instead of posting (live 2026-08-10: a fresh session
      // posted a confident correction into a settled thread it had never read). The re-send is
      // her informed call, and posting re-engages the conversation as any post does.
      if (target.via === "search" && ctx.renderConversationCard && ref && !bounced.has(ref)) {
        bounced.add(ref);
        const card = ctx.renderConversationCard(key);
        return {
          success: false,
          output: `not sent — you haven't read this conversation this turn:\n${card}\nif your reply still holds against all of that, send it again and it goes through.`,
        };
      }

      // Harness vocabulary is for her, never for the room: a reply that quotes broker denial
      // strings or tool-result scaffolding is instruction leakage (live 2026-07-27: venue
      // instructions parroted into Slack). Screened at the single door every outward word
      // passes through.
      const HARNESS_TOKENS = ["requires_confirmation:", "posting_scope_violation", "not_available_for_turn_kind", "interactive_consequential_denied", "Requesting confirmation to call", "queued — it posts when your turn ends"];
      const leaked = HARNESS_TOKENS.find((tok) => text.includes(tok));
      if (leaked) {
        return { success: false, output: `that reads like my own internal scaffolding ("${leaked}") — say it in your words instead` };
      }

      // §5.5: this conversation didn't address her directly, so the reply waits for turn end —
      // the room may still be talking while the model composes, and an answer to a moved-on
      // conversation is the harness's to hold back, not the model's to re-litigate mid-turn.
      if (ctx.bufferReply?.(anchor, text)) {
        return { success: true, output: "queued — it posts when your turn ends, unless the conversation has moved by then (it would come back to you next time instead)" };
      }

      const result = await ctx.postMessage(anchor, text);
      // Delivery sentinels are not message ids: a post that never landed must not report
      // "posted", must not engage a conversation rooted on the sentinel string, and must not
      // arm the effects guard against the retry that could still say it.
      if (result.messageId === "undelivered") {
        return { success: false, output: "that didn't send — the surface rejected it after retries. try again, or let it go" };
      }
      if (result.messageId === "already-sent-this-wake") {
        return { success: true, output: "posted" }; // an earlier attempt of this wake already sent it
      }
      recordPostedThread(ctx, anchor, result.messageId);
      pushEffect(ctx, { kind: "posted", anchor, text });
      return { success: true, output: "posted" };
    },
  };
}

function reactTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "react",
      description:
        'Add an emoji reaction to a message. Input: { emoji, ref } — emoji name without colons (e.g. "thumbsup", "white_check_mark", "eyes"); ref is the message\'s [rN] tag. Use when a reaction alone is the best response.',
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["emoji", "ref"],
        properties: { emoji: { type: "string" }, ref: { type: "string", pattern: "^r\\d+$" } },
      },
    },
    impl: async (args) => {
      const a = fields(args);
      const emoji = asString(a.emoji).replaceAll(":", "").trim();
      if (!emoji) return { success: false, output: "empty emoji name" };
      const ref = optString(a.ref);
      const target = ref ? ctx.refs?.get(ref) : undefined;
      if (!target?.ts) return { success: false, output: "no such message ref — reactions land on a MESSAGE's [rN] tag, not a conversation's" };
      if (!ctx.reactTo) return { success: false, output: "this turn cannot react" };
      const violation = checkPostingScope(ctx, { venueId: target.venueId, threadRootId: null });
      if (violation) return { success: false, output: `posting_scope_violation: ${violation}` };
      try {
        // The target's own thread rides along: the react's ledger residence is the line she was
        // shown, never re-derived from the wake's batch (audit 2026-08-13: a react on a tail
        // line filed at the surface and rendered in the wrong conversation on later wakes).
        await ctx.reactTo(target.venueId, target.ts, emoji, target.threadRootId);
      } catch (e) {
        return { success: false, output: `reaction failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      pushEffect(ctx, { kind: "reacted", emoji, venueId: target.venueId, ts: target.ts });
      return { success: true, output: `reacted :${emoji}:` };
    },
  };
}

// set_wake IS execution_step's self-scheduling yield (SPEC §6.3: "an execution MAY set wake_at
// and yield") — not a separate staging mechanism; calling it ends the turn's task into
// waiting(timer).
function setWakeTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "set_wake",
      description: "Yield this execution, scheduling it to wake and resume at a future time. Input: { wakeAt } (ISO-8601).",
      inputSchema: { type: "object", additionalProperties: false, required: ["wakeAt"], properties: { wakeAt: { type: "string" } } },
    },
    impl: async (args) => {
      const a = fields(args);
      const wakeAtRaw = asString(a.wakeAt);
      if (!ctx.taskId) return { success: false, output: "set_wake is only available to an execution's own turns" };
      const live = getTask(ctx.db, ctx.taskId);
      if (live && live.status !== "active") {
        return { success: false, output: "this task is paused waiting on a human go-ahead — stop here and end the turn" };
      }
      // The ledger stores only harness-normalized timestamps: parse, require a real future
      // instant, clamp to a sane horizon, re-serialize canonical ISO. A malformed or past
      // wake time is rejected here, never persisted for the scheduler to trip on.
      const parsed = Date.parse(wakeAtRaw);
      if (Number.isNaN(parsed)) return { success: false, output: "wakeAt must be an ISO-8601 timestamp" };
      const now = Date.parse(ctx.clock());
      if (parsed <= now) return { success: false, output: "wakeAt is in the past — pick a future time" };
      const MAX_WAKE_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;
      const wakeAt = new Date(Math.min(parsed, now + MAX_WAKE_HORIZON_MS)).toISOString();
      transition(ctx.db, ctx.clock, ctx.taskId, "waiting", { type: "yield_timer", wakeAt });
      pushEffect(ctx, { kind: "yielded_timer", taskId: ctx.taskId, wakeAt });
      return { success: true, output: `task ${ctx.taskId} yielded until ${wakeAt}` };
    },
  };
}

// Implementation-defined (SPEC doesn't name execution_step's outcome tools explicitly — §6.3/§17.4
// describe the OUTCOME, not the tool interface). task_complete/task_fail/task_ask are how an
// execution_step turn declares "done"/"failed honestly"/"blocked on a non-action-specific
// question" respectively.
function taskCompleteTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "task_complete",
      description:
        "Complete this task. Your report is handed back to the main mind, who tells the room in her own words — write it as a complete handoff: what you did, what you found, receipts (links/ids), and anything she should flag. Input: { report }.",
      inputSchema: { type: "object", additionalProperties: false, required: ["report"], properties: { report: { type: "string" } } },
    },
    impl: async (args) => {
      const a = fields(args);
      const report = asString(a.report);
      if (!ctx.taskId) return { success: false, output: "task_complete is only available to an execution's own turns" };
      const live = getTask(ctx.db, ctx.taskId);
      if (live && live.status !== "active") {
        return { success: false, output: "this task is paused waiting on a human go-ahead — stop here and end the turn" };
      }
      if (!report.trim()) return { success: false, output: "the report is the handoff — say what happened before completing" };
      transition(ctx.db, ctx.clock, ctx.taskId, "done", { type: "completed", report });
      pushEffect(ctx, { kind: "task_completed", taskId: ctx.taskId });
      return { success: true, output: `task ${ctx.taskId} completed` };
    },
  };
}

function taskFailTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "task_fail",
      description:
        "Fail this task honestly, stating what was attempted and what broke. Your report is handed back to the main mind, who tells the room — include the real cause and what would unblock it. Input: { report }.",
      inputSchema: { type: "object", additionalProperties: false, required: ["report"], properties: { report: { type: "string" } } },
    },
    impl: async (args) => {
      const a = fields(args);
      const report = asString(a.report);
      if (!ctx.taskId) return { success: false, output: "task_fail is only available to an execution's own turns" };
      const live = getTask(ctx.db, ctx.taskId);
      if (live && live.status !== "active") {
        return { success: false, output: "this task is paused waiting on a human go-ahead — stop here and end the turn" };
      }
      if (!report.trim()) return { success: false, output: "the report is the handoff — say what happened before failing" };
      transition(ctx.db, ctx.clock, ctx.taskId, "failed", { type: "failed", report });
      pushEffect(ctx, { kind: "task_failed", taskId: ctx.taskId });
      return { success: true, output: `task ${ctx.taskId} failed` };
    },
  };
}

function taskAskTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "task_ask",
      description:
        "Yield this task on a blocking question that isn't a specific consequential action. Your question is handed back to the main mind, who asks the room — phrase it so a human can answer it cold. Input: { question }.",
      inputSchema: { type: "object", additionalProperties: false, required: ["question"], properties: { question: { type: "string" } } },
    },
    impl: async (args) => {
      const a = fields(args);
      const question = asString(a.question);
      if (!ctx.taskId) return { success: false, output: "task_ask is only available to an execution's own turns" };
      const live = getTask(ctx.db, ctx.taskId);
      if (live && live.status !== "active") {
        return { success: false, output: "this task is paused waiting on a human go-ahead — stop here and end the turn" };
      }
      const nudgeDeadline = new Date(new Date(ctx.clock()).getTime() + ctx.nudgeAfterMs).toISOString();
      transition(ctx.db, ctx.clock, ctx.taskId, "waiting", { type: "yield_human", nudgeDeadline });
      pushEffect(ctx, { kind: "task_asked", taskId: ctx.taskId, question });
      return { success: true, output: `task ${ctx.taskId} waiting on a human` };
    },
  };
}

// The live self-editing checklist — Claude Tag's signature "first reply is a checklist it edits in
// place as it goes." One message per execution: the first call posts it, each subsequent call
// chat.update's the SAME message (id held in ctx.checklist, shared across the execution's turns).
function renderChecklist(items: { text: string; done: boolean }[]): string {
  return items.map((i) => `${i.done ? "✅" : "⬜️"} ${i.text}`).join("\n");
}
function checklistTool(ctx: ToolsetContext): ToolFactory {
  // Resident wakes seat the checklist by ref — the model says which conversation the work is
  // for, same rung as reply/react/task_create (audit 2026-08-13: this was the one posting tool
  // whose destination was still the harness's batch-level guess). Ref-less contexts (an
  // execution) seat on their anchor: a task's home is already ref-bound at creation.
  const withRef = !!ctx.refs;
  return {
    spec: {
      name: "checklist",
      description:
        `Post/update a live progress checklist for this piece of work — it edits ONE message in place${withRef ? ", in the conversation whose [rN] ref you pass" : ""}. Most replies don't need one: reach for it only when the work is genuinely long and multi-step, with 2-4 high-level goals (what you're finding out, not which tools you'll run). Call it FIRST with the stages (all done:false), then flip each done as you finish. Input: { items: [{ text, done }]${withRef ? ", ref" : ""} }.${withRef ? " It renders alongside your reply there — a checklist without any words in that conversation shows nothing." : ""}`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: withRef ? ["items", "ref"] : ["items"],
        properties: {
          items: {
            type: "array",
            items: { type: "object", additionalProperties: false, required: ["text", "done"], properties: { text: { type: "string" }, done: { type: "boolean" } } },
          },
          ...(withRef ? { ref: { type: "string", pattern: "^r\\d+$" } } : {}),
        },
      },
    },
    impl: async (args) => {
      const a = fields(args);
      const items = checklistItems(a.items);
      const ref = optString(a.ref);
      let seat: Anchor;
      if (withRef) {
        const target = ref ? ctx.refs?.get(ref) : undefined;
        if (!target) {
          return { success: false, output: `"${ref ?? ""}" is not a ref — seat the checklist with the [rN] tag of the conversation its work is for` };
        }
        const key = conversationOf(target);
        seat = { venueId: key.venueId, threadRootId: key.threadRootId };
      } else {
        if (!ctx.anchor) return { success: false, output: "no anchor for this turn" };
        seat = ctx.anchor;
      }
      const violation = checkPostingScope(ctx, seat);
      if (violation) return { success: false, output: `posting_scope_violation: ${violation}` };
      const holder = ctx.checklist;
      if (!holder) return { success: false, output: "checklist is not available in this turn" };
      // Preferred rendering: native task cards on the seat conversation's streamed message.
      // Falls back to one edited-in-place emoji message only when the surface has no cards.
      const native = ctx.renderChecklist ? await ctx.renderChecklist(items, seat) : false;
      if (!native) {
        const text = renderChecklist(items);
        const seatKey = convoKey(seat.venueId, seat.threadRootId);
        const existing = holder.get(seatKey);
        if (existing && ctx.updateMessage) {
          await ctx.updateMessage(seat.venueId, existing, text);
        } else {
          const result = await ctx.postMessage(seat, text); // first call, or no edit support → (re)post
          // A delivery sentinel is not a message id — latching it would aim every later edit at
          // the literal string "undelivered" (review finding, 2026-08-11).
          if (result.messageId === "undelivered" || result.messageId === "already-sent-this-wake") {
            return { success: false, output: "the checklist message didn't land — try again" };
          }
          holder.set(seatKey, result.messageId);
        }
      }
      pushEffect(ctx, { kind: "checklist", items: items.length, done: items.filter((i) => i.done).length });
      return { success: true, output: `checklist: ${items.filter((i) => i.done).length}/${items.length} done` };
    },
  };
}

// SPEC §8 — memory tools. §11 names exactly these three (no separate "correct" tool); a
// correction is memory_retract (optionally linking supersededBy) followed by memory_write, not a
// fourth tool. Every memory_retract call verifies the item actually belongs to ctx.identity.id
// BEFORE retracting it — memory IDs are opaque UUIDs, not chat-visible, but §7.1 isolation must be
// enforced at the storage/broker layer regardless of how unlikely guessing one is.
function memoryWriteTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "memory_write",
      description:
        "Write a distilled, durable fact (not a transcript) to your memory. Tiers: 'core' is always in mind, 'recent' is newly-noticed and unvetted (decays unless confirmed), 'archive' is searchable background. Input: { content, provenance?, tier? }.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["content"],
        properties: { content: { type: "string" }, provenance: { type: "array" }, tier: { type: "string", enum: ["core", "recent", "archive"] } },
      },
    },
    impl: async (args) => {
      const a = fields(args);
      const content = asString(a.content);
      const provenance = Array.isArray(a.provenance) ? a.provenance : undefined;
      // SPEC §8.6: an explicit write defaults to core; she can save something merely noticed
      // at reduced standing by passing tier 'recent' herself.
      const tier = optMemoryTier(a.tier) ?? "core";
      const item = writeMemory(ctx.db, ctx.clock, { id: crypto.randomUUID(), identityId: ctx.identity.id, content, provenance, tier });
      pushEffect(ctx, { kind: "memory_written", memoryId: item.id });
      return { success: true, output: JSON.stringify({ memoryId: item.id }) };
    },
  };
}

function memoryRetractTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "memory_retract",
      description: "Retract a memory item (use search first to find its id). Input: { id, supersededBy? }.",
      inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" }, supersededBy: { type: "string" } } },
    },
    impl: async (args) => {
      const a = fields(args);
      const id = asString(a.id);
      const supersededBy = optString(a.supersededBy);
      const existing = queryMemory(ctx.db, ctx.identity.id, { includeRetracted: true }).find((m) => m.id === id);
      if (!existing) return { success: false, output: `not_found: no memory item ${id} for this identity` };
      retractMemory(ctx.db, ctx.clock, { id, supersededBy });
      pushEffect(ctx, { kind: "memory_retracted", memoryId: id });
      return { success: true, output: `retracted ${id}` };
    },
  };
}

// SPEC §8.7 — the searchable floor: everything this identity has heard plus its memory (both
// tiers), one lexical search. Hits carry receipts (venue/ts/speaker/permalink) so a cited claim
// is evidence, not vibes.
function searchTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "search",
      description:
        "Search everything you've heard (full message history across your channels) and everything you remember (memory, both tiers). Hits carry venue, time, speaker, a permalink — cite them — and a ref you can reply/react to (speaking there starts by reading the conversation as it now stands). venueId/principalId filters narrow to messages. Input: { query, venueId?, principalId?, after?, before?, limit? } (after/before are ISO timestamps).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string" },
          venueId: { type: "string" },
          principalId: { type: "string" },
          after: { type: "string" },
          before: { type: "string" },
          limit: { type: "number" },
        },
      },
    },
    impl: async (args) => {
      const a = fields(args);
      const hits = searchArchive(ctx.db, ctx.identity.id, {
        query: asString(a.query),
        venueId: optString(a.venueId),
        principalId: optString(a.principalId),
        after: optString(a.after),
        before: optString(a.before),
        limit: typeof a.limit === "number" ? a.limit : undefined,
      }).map((h) => {
        const hit: {
          kind: SearchHit["kind"];
          text: string;
          at: string;
          ref?: string;
          venueId?: string;
          threadRootId?: string;
          principalId?: string;
          memoryId?: string;
          tier?: SearchHit["tier"];
          permalink?: string;
        } = {
          kind: h.kind,
          text: h.text.slice(0, 700),
          at: h.at,
        };
        // A search hit is addressable but UNREAD: its ref carries via='search', so the first
        // send there returns the conversation's card instead of posting.
        if (h.venueId && h.ts && ctx.refs) {
          hit.ref = ctx.refs.mint({ venueId: h.venueId, threadRootId: h.threadRootId ?? null, ts: h.ts, via: "search" });
        }
        if (h.venueId) hit.venueId = h.venueId;
        if (h.threadRootId) hit.threadRootId = h.threadRootId;
        if (h.principalId) hit.principalId = h.principalId;
        if (h.memoryId) {
          hit.memoryId = h.memoryId;
          hit.tier = h.tier;
        }
        const permalink = h.venueId && h.ts ? ctx.permalink?.(h.venueId, h.ts) : undefined;
        if (permalink) hit.permalink = permalink;
        return hit;
      });
      return { success: true, output: JSON.stringify(hits) };
    },
  };
}

// SPEC §8.6 — the distiller's demote/promote. Content is untouched; an archived item leaves the
// always-injected core but stays searchable, so curation never loses information.
function memoryTierTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "memory_tier",
      description: "Move a memory item between tiers: 'core' (always in mind), 'recent' (newly noticed, unvetted), 'archive' (searchable background). Input: { id, tier }.",
      inputSchema: { type: "object", additionalProperties: false, required: ["id", "tier"], properties: { id: { type: "string" }, tier: { type: "string", enum: ["core", "recent", "archive"] } } },
    },
    impl: async (args) => {
      const a = fields(args);
      const id = asString(a.id);
      const tier = optMemoryTier(a.tier) ?? "core";
      const existing = queryMemory(ctx.db, ctx.identity.id, { includeRetracted: true }).find((m) => m.id === id);
      if (!existing) return { success: false, output: `not_found: no memory item ${id} for this identity` };
      const item = setMemoryTier(ctx.db, ctx.clock, id, tier);
      pushEffect(ctx, { kind: "memory_tiered", memoryId: id, tier: item.tier });
      return { success: true, output: `${id} → ${item.tier}` };
    },
  };
}

// SPEC §11's toolbox digest: built-ins grouped by registry, same shape as the integration
// registries. GROUPING ONLY — the empty specs carry no behavior; a tool's digest description
// comes from the DynamicTool actually built for the turn (buildToolbox), and a group can earn
// a `skill` here when its tools need a manual. BUILTIN_TOOL_NAME derives from this, so a new
// built-in must pick its registry home or the toolset tests fail.
export const BUILTIN_REGISTRIES: ToolRegistry[] = [
  {
    name: "tasks",
    skill:
      "Delegation is how heavy work leaves your turn: a worker runs the task on its own budget and reports back to you. " +
      "Anything beyond a few checks and a reply belongs in a task rather than inline in your turn.",
    tools: { task_create: {}, task_steer: {}, task_cancel: {}, task_confirm: {}, task_query: {} },
  },
  {
    name: "posting",
    skill:
      "Every post and reaction says exactly where it lands: copy the coordinates from the line of the message you're answering (its <#venue>, its thread= value when shown, else its ts). " +
      "The messages you wake to can come from different conversations; answer each in its own thread, never all in one place.",
    tools: { reply: {}, react: {}, checklist: {}, step_back: {} },
  },
  { name: "scheduling", tools: { set_wake: {} } },
  { name: "outcome", tools: { task_complete: {}, task_fail: {}, task_ask: {} } },
  {
    name: "memory",
    skill:
      "Everything you've ever heard in your channels is searchable, and memory is how you stay smart across threads. " +
      "Before you guess, say you don't know, or make a claim about a past discussion, search for the receipt. " +
      "When you learn a durable fact (a person, a decision, a preference, a project detail), save it at the strength it arrived, source attached; never save a claim the room is still disputing.",
    tools: { memory_write: {}, memory_retract: {}, memory_tier: {}, search: {} },
  },
  { name: "audit", tools: { audit_query: {} } },
];

const BUILTIN_TOOL_NAME = new Set(BUILTIN_REGISTRIES.flatMap((r) => Object.keys(r.tools)));

function externalTools(ctx: ToolsetContext): ToolFactory[] {
  const tools: ToolFactory[] = [];
  // No scope needs the same mutation twice: an identical repeated outward call is a blind retry
  // (2026-07-23 replay: a failed verification read led straight to a duplicate ticket). The
  // dedupe is DURABLE (outward_calls, UNIQUE(scope_id, tool, args_hash)) because external
  // writes record no turn effects: a worker that wrote to Linear and died would otherwise
  // re-run the write on resume — across retry attempts, process restarts, and re-dispatches.
  // scope = the execution's task when there is one, else this wake. Same discipline as acts:
  // intent lands before the call and is compensated away if the call itself fails.
  const outwardScope = ctx.taskId ?? ctx.outwardScopeId ?? "unscoped";
  for (const grant of ctx.identity.grants) {
    if (BUILTIN_TOOL_NAME.has(grant.tool)) continue; // built-ins (audit_query included) are constructed below, not granted specs
    const spec = ctx.catalog[grant.tool];
    tools.push({
      spec: {
        name: grant.tool,
        description: spec?.description ?? `granted external tool: ${grant.tool}`,
        inputSchema: spec?.inputSchema ?? { type: "object" },
      },
      impl: async (args) => {
        const impl = spec?.run;
        if (!impl) return { success: false, output: `no implementation registered for external tool ${grant.tool}` };
        if ((spec?.actionClasses?.(args) ?? []).length > 0) {
          const argsHash = canonicalJson(args);
          // The dedupe window is bounded (24h): a crash-resume inside the window is correctly
          // refused; a standing task legitimately repeating tomorrow's identical write passes
          // (review finding: task-lifetime scope permanently refused legitimate repeats).
          const cutoff = new Date(Date.parse(ctx.clock()) - 24 * 60 * 60 * 1000).toISOString();
          const prior = orm(ctx.db)
            .select({ confirmed: outwardCalls.confirmed })
            .from(outwardCalls)
            .where(
              and(
                eq(outwardCalls.scopeId, outwardScope),
                eq(outwardCalls.tool, grant.tool),
                eq(outwardCalls.argsHash, argsHash),
                gt(outwardCalls.at, cutoff),
              ),
            )
            .get();
          if (prior?.confirmed) {
            return { success: false, output: "already done: this exact call already ran for this piece of work and completed. If you meant a different change, change the arguments." };
          }
          if (prior) {
            // An earlier attempt died between sending and hearing back — the write MAY have
            // landed. Never silently redo an ambiguous outward write; verify first.
            return { success: false, output: "this exact call was attempted earlier and its outcome is unknown — check the target system first (search/read it); if it truly didn't land, make the call distinguishable (e.g. note the retry in its text)." };
          }
          orm(ctx.db)
            .insert(outwardCalls)
            .values({ identityId: ctx.identity.id, scopeId: outwardScope, tool: grant.tool, argsHash, at: ctx.clock(), confirmed: 0 })
            .onConflictDoUpdate({
              target: [outwardCalls.scopeId, outwardCalls.tool, outwardCalls.argsHash],
              set: { at: ctx.clock(), confirmed: 0 },
            })
            .run();
          // NOTE a thrown impl leaves the row UNCONFIRMED on purpose — thrown ≠ "did not
          // happen"; the row is the ambiguity record the next identical call trips on.
          const result = await impl(args);
          if (result.success) {
            orm(ctx.db)
              .update(outwardCalls)
              .set({ confirmed: 1 })
              .where(and(eq(outwardCalls.scopeId, outwardScope), eq(outwardCalls.tool, grant.tool), eq(outwardCalls.argsHash, argsHash)))
              .run();
          } else {
            // The impl REPORTED failure — nothing landed; a clean retry is safe.
            orm(ctx.db)
              .delete(outwardCalls)
              .where(and(eq(outwardCalls.scopeId, outwardScope), eq(outwardCalls.tool, grant.tool), eq(outwardCalls.argsHash, argsHash)))
              .run();
          }
          return result;
        }
        return impl(args);
      },
    });
  }
  return tools;
}


// SPEC §15: "the agent itself SHOULD be able to answer such questions in-chat from an
// audit-query tool GRANTED per identity, scoped to that identity" — unlike task_query/
// search (always available), this is opt-in via a normal grant, same visibility rule as any
// external tool (§10.1: a non-granted tool doesn't exist for this turn at all). The
// implementation is internal (ledger-backed), not looked up in the catalog, since the query logic
// is the same for every deployment.
function auditQueryTool(ctx: ToolsetContext): ToolFactory | null {
  if (!ctx.identity.grants.some((g) => g.tool === "audit_query")) return null;
  return {
    spec: {
      name: "audit_query",
      description: "Read your own audit log: what you did, when, and what was allowed or denied. Input: { sinceIso?, untilIso?, kind?, taskId? }.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { sinceIso: { type: "string" }, untilIso: { type: "string" }, kind: { type: "string" }, taskId: { type: "string" } },
      },
    },
    impl: async (args) => {
      const a = fields(args);
      const records = queryAudit(ctx.db, ctx.identity.id, {
        sinceIso: optString(a.sinceIso),
        untilIso: optString(a.untilIso),
        kind: optAuditKind(a.kind),
        taskId: optString(a.taskId),
      });
      return { success: true, output: JSON.stringify(records) };
    },
  };
}

// The Ear (specs/2026-07-13-the-ear-design.md): her judgment to leave a conversation. Replies in a
// stepped-back thread stop being hers to answer until a mention (or her own post) re-engages it.
function stepBackTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "step_back",
      description:
        "Leave a conversation: replies there stop being yours to answer (and stop reaching you) until someone mentions you there again, or you post there again; anything you still owed there is dropped with it. Input: { why, ref } — the conversation's (or any of its messages') [rN] tag. Use when the humans have it between them, or when someone asks you to stop.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["why", "ref"],
        properties: { why: { type: "string" }, ref: { type: "string", pattern: "^r\\d+$" } },
      },
    },
    impl: async (args) => {
      const a = fields(args);
      const why = asString(a.why);
      const ref = optString(a.ref);
      const target = ref ? ctx.refs?.get(ref) : undefined;
      if (!target) return { success: false, output: "no such ref — step back using an [rN] tag from the conversation you're leaving" };
      const key = conversationOf(target);
      stepBack(ctx.db, ctx.clock, ctx.identity.id, key.venueId, key.threadRootId, why);
      // Leaving a conversation settles what she owed in it: a debt she judged not hers must not
      // ride every future wake (the ear reopens it if it truly was hers — SPEC §11).
      closeAttentionItemsForThread(ctx.db, ctx.clock, ctx.identity.id, key.venueId, key.threadRootId, "stepped back");
      pushEffect(ctx, { kind: "stepped_back", venueId: key.venueId, threadRootId: key.threadRootId, why });
      return { success: true, output: "stepped back — a mention brings you back in" };
    },
  };
}

export function buildToolset(ctx: ToolsetContext): DynamicTool[] {
  const audit = auditQueryTool(ctx);
  // SPEC §11 "Expose exactly": per-kind restriction happens HERE, at registration — an
  // ambient turn genuinely has no task tools, not task tools that fail. And the broker gate is
  // applied HERE, over every factory at once: the only way a tool becomes callable is through
  // gated(), so a tool that skips the broker cannot be constructed.
  const factories: ToolFactory[] = [
    taskCreateTool(ctx),
    taskSteerTool(ctx),
    taskCancelTool(ctx),
    taskConfirmTool(ctx),
    taskQueryTool(ctx),
    replyTool(ctx),
    reactTool(ctx),
    stepBackTool(ctx),
    setWakeTool(ctx),
    taskCompleteTool(ctx),
    taskFailTool(ctx),
    taskAskTool(ctx),
    checklistTool(ctx),
    memoryWriteTool(ctx),
    memoryRetractTool(ctx),
    memoryTierTool(ctx),
    searchTool(ctx),
    ...(audit ? [audit] : []),
    ...externalTools(ctx),
  ];
  return factories
    .filter((t) => exposableForKind(t.spec.name, ctx.turnKind, ctx.catalog))
    .map((t) => ({ spec: t.spec, run: gated(ctx, t.spec.name, t.impl) }));
}
