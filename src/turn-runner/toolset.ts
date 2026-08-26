// Standard toolset: every call gated through broker decide(); posting scope-checked per turn kind.
import type { Database } from "bun:sqlite";
import { asString, isRecord } from "../guard";
import type { Clock } from "../ledger/clock";
import { and, eq, gt } from "drizzle-orm";
import { orm } from "../ledger/db";
import { outwardCalls } from "../ledger/schema";
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
import { writeMemory, retractMemory, queryMemory, setMemoryTier } from "../ledger/memory";
import { closeAttentionItemsForThread } from "../ledger/attention";
import { searchArchive, type SearchHit } from "../ledger/search";
import { engage, stepBack, conversationOf, convoKey, provenanceOfRef, lastSpeakerIn, type RefTable } from "../ledger/conversations";
import { queryAudit, type AuditKind } from "../ledger/audit";
import { decide, exposableForKind, actionRefFor, canonicalJson, type ToolCatalog, type TurnKind } from "../policy/broker";
import type { ToolRegistry } from "../tools/catalog";
import type { IdentityConfig } from "../policy/schema";
import type { DynamicTool } from "./types";

// Factories become DynamicTools only here (broker-wrapped); unbrokered tools are unconstructible.
interface ToolFactory {
  spec: DynamicTool["spec"];
  impl: (args: unknown) => Promise<{ success: boolean; output: string }>;
}

export interface Principal {
  id: string;
  isOperator: boolean;
}

export interface ToolsetContext {
  db: Database;
  clock: Clock;
  identity: IdentityConfig;
  turnKind: TurnKind;
  catalog: ToolCatalog;
  // Resident turns: no batch-level anchor — every destination is a ref.
  anchor: Anchor | null;
  principal?: Principal | undefined;
  originEventId?: string | undefined;
  taskId?: string | undefined; // the task this execution_step turn belongs to
  outwardScopeId?: string | undefined; // outward-call dedupe scope for taskless turns (the wake id)
  nudgeAfterMs: number;
  postMessage: (anchor: Anchor, text: string) => Promise<{ messageId: string }>;
  // §5.5 stale-reply withholding: set when batch had no direct address; true = buffered.
  bufferReply?: ((anchor: Anchor, text: string) => boolean) | undefined;
  // Ref table is the only speakable targets; via='search' refs bounce once with the card.
  refs?: RefTable | undefined;
  renderConversationCard?: ((target: { venueId: string; threadRootId: string | null }) => string) | undefined;
  updateMessage?: ((venueId: string, messageId: string, text: string) => Promise<void>) | undefined;
  checklist?: Map<string, string> | undefined;
  // React by venue + surface ts; threadRootId from the shown line, never re-derived from the batch.
  reactTo?: ((venueId: string, messageId: string, emoji: string, threadRootId: string | null) => Promise<void>) | undefined;
  renderChecklist?: ((items: { text: string; done: boolean }[], seat: Anchor) => Promise<boolean>) | undefined;
  // Resolve principal standing from a ref's provenance (not wake-level principal).
  resolvePrincipal?: ((principalId: string) => Principal) | undefined;
  // Surface permalink for search-hit receipts; absent → cite venue + timestamp only.
  permalink?: ((venueId: string, messageId: string) => string | undefined) | undefined;
  effects: unknown[]; // mutated in place — collected for turns.ts's recordTurn
}

function pushEffect(ctx: ToolsetContext, effect: unknown): void {
  ctx.effects.push(effect);
}

function checkPostingScope(ctx: ToolsetContext, anchor: Anchor): string | null {
  // Resident: any venue this identity serves; execution_step: pinned to task home venue.
  if (ctx.turnKind === "resident") {
    const venues = ctx.identity.venueIds;
    return venues.includes("*") || venues.includes(anchor.venueId) ? null : `you may only post to venues you serve, got ${anchor.venueId}`;
  }
  if (!ctx.anchor) return "no anchor context for this turn";
  return anchor.venueId === ctx.anchor.venueId ? null : `turns may only post within venue ${ctx.anchor.venueId}, got ${anchor.venueId}`;
}

// §5.1: every outbound post engages the conversation (top-level post's id becomes thread root).
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
    });
    if (!decision.allow) {
      // §10.2: denied consequential on execution_step → confirmation flow, not bare fail.
      if (decision.reason === "confirmation_denied") {
        return {
          success: false,
          output: "a human declined exactly this action — it stays declined. Change the approach, or task_fail with what you wanted and why it was refused.",
        };
      }
      if (decision.reason === "requires_confirmation" && ctx.taskId) {
        const current = getTask(ctx.db, ctx.taskId)?.pendingConfirmation;
        if (current?.actionRef === actionRefFor(toolName, args) && current.resolution?.approved && current.consumedAt) {
          return { success: false, output: "already done: this exact call was approved and ran earlier. If you meant a different change, change the arguments." };
        }
        if (current && !current.resolution) {
          return { success: false, output: "a go-ahead request is already pending on this task — stop here and end the turn; ask for anything else after it resolves" };
        }
        if (current?.resolution?.approved && !current.consumedAt) {
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
      // Hand room-ready framing for turn-policy denials (avoid broker jargon in the venue).
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
      const raw = isRecord(args) ? args : {};
      const rawTier: "low" | "medium" | "high" | undefined = raw.tier === "low" || raw.tier === "medium" || raw.tier === "high" ? raw.tier : undefined;
      const a = {
        title: asString(raw.title),
        spec: asString(raw.spec),
        ref: typeof raw.ref === "string" ? raw.ref : undefined,
        tier: rawTier,
      };
      const target = a.ref ? ctx.refs?.get(a.ref) : undefined;
      if (!target) {
        return { success: false, output: `"${a.ref ?? ""}" is not a ref — home the task with the [rN] tag of the conversation its report belongs in` };
      }
      const home = conversationOf(target);
      // Sponsor/origin bind to the ref's provenance, never a batch-level pick.
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
        title: a.title,
        spec: a.spec,
        sponsorId,
        homeAnchor: { venueId: home.venueId, threadRootId: home.threadRootId },
        originEventId: prov.eventId,
        tier: a.tier,
        sponsorIsOperator: sponsor?.isOperator ?? false,
      });
      pushEffect(ctx, { kind: "task_created", taskId: task.id });
      return { success: true, output: JSON.stringify({ taskId: task.id, status: task.status }) };
    },
  };
}

// Steer/cancel source event: ref provenance when available, else turn origin. String = bounce.
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
      const raw = isRecord(args) ? args : {};
      const rawKind = raw.kind;
      if (rawKind !== "guidance" && rawKind !== "cancel" && rawKind !== "pause" && rawKind !== "resume" && rawKind !== "confirm") {
        return { success: false, output: `invalid_kind: task_steer only accepts guidance/pause/resume; use task_cancel or task_confirm for ${String(rawKind)}` };
      }
      const a = { taskId: asString(raw.taskId), kind: rawKind, text: typeof raw.text === "string" ? raw.text : undefined, ref: typeof raw.ref === "string" ? raw.ref : undefined };
      const source = steerSourceEvent(ctx, a.ref, "asking for this steer");
      if (typeof source !== "string") return { success: false, output: source.bounce };
      if (a.kind !== "guidance" && a.kind !== "pause" && a.kind !== "resume") {
        return { success: false, output: `invalid_kind: task_steer only accepts guidance/pause/resume; use task_cancel or task_confirm for ${a.kind}` };
      }
      const result = steerTask(ctx.db, ctx.clock, { identityId: ctx.identity.id, taskId: a.taskId, kind: a.kind, payload: { text: a.text }, sourceEventId: source });
      pushEffect(ctx, { kind: "task_steered", taskId: a.taskId, steerKind: a.kind, applied: result.applied });
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
      const raw = isRecord(args) ? args : {};
      const a = { taskId: asString(raw.taskId), report: typeof raw.report === "string" ? raw.report : undefined, ref: typeof raw.ref === "string" ? raw.ref : undefined };
      const source = steerSourceEvent(ctx, a.ref, "asking for the cancel");
      if (typeof source !== "string") return { success: false, output: source.bounce };
      const result = steerTask(ctx.db, ctx.clock, { identityId: ctx.identity.id, taskId: a.taskId, kind: "cancel", payload: { report: a.report }, sourceEventId: source });
      pushEffect(ctx, { kind: "task_cancelled", taskId: a.taskId, applied: result.applied });
      return { success: result.applied, output: result.reply ?? JSON.stringify({ status: result.task.status }) };
    },
  };
}

function taskConfirmTool(ctx: ToolsetContext): ToolFactory {
  // Approver is the speaker of the ref'd message; ref-less contexts keep turn principal.
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
      const raw = isRecord(args) ? args : {};
      const a = { taskId: asString(raw.taskId), approve: raw.approve === true, ref: typeof raw.ref === "string" ? raw.ref : undefined };
      let approverId: string;
      if (withRef) {
        const target = a.ref ? ctx.refs?.get(a.ref) : undefined;
        // Only a message ref names a speaker; conversation refs rejected (batch-tail guess).
        if (!target?.ts) {
          return { success: false, output: `"${a.ref ?? ""}" is not a message ref — pass the [rN] tag of the member's own approve/deny line, not the conversation's` };
        }
        // Unread targets rejected (no bounce): cannot record authorization from unread lines.
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
      const result = resolveConfirmation(ctx.db, ctx.clock, { identityId: ctx.identity.id, taskId: a.taskId, principalId: approverId, approve: a.approve });
      pushEffect(ctx, { kind: "confirmation_resolved", taskId: a.taskId, approve: a.approve, applied: result.applied });
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
  // One bounce per unread target per attempt; second send goes through.
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
      const raw = isRecord(args) ? args : {};
      const a = { text: asString(raw.text), ref: typeof raw.ref === "string" ? raw.ref : undefined };
      const target = a.ref ? ctx.refs?.get(a.ref) : undefined;
      if (!target) {
        return { success: false, output: `"${a.ref ?? ""}" is not a ref — copy the [rN] tag (like r3) from the start of a line you were shown; timestamps and channel ids are labels, not addresses` };
      }
      const key = conversationOf(target);
      const anchor: Anchor = { venueId: key.venueId, threadRootId: key.threadRootId };
      const violation = checkPostingScope(ctx, anchor);
      if (violation) return { success: false, output: `posting_scope_violation: ${violation}` };

      // via='search': first send returns the conversation card; re-send posts and engages.
      if (target.via === "search" && ctx.renderConversationCard && !bounced.has(a.ref!)) {
        bounced.add(a.ref!);
        const card = ctx.renderConversationCard(key);
        return {
          success: false,
          output: `not sent — you haven't read this conversation this turn:\n${card}\nif your reply still holds against all of that, send it again and it goes through.`,
        };
      }

      // Screen broker/harness jargon at the outbound door — never post denial strings.
      const HARNESS_TOKENS = ["requires_confirmation:", "posting_scope_violation", "not_available_for_turn_kind", "interactive_consequential_denied", "Requesting confirmation to call", "queued — it posts when your turn ends"];
      const leaked = HARNESS_TOKENS.find((tok) => a.text.includes(tok));
      if (leaked) {
        return { success: false, output: `that reads like my own internal scaffolding ("${leaked}") — say it in your words instead` };
      }

      // §5.5: no direct address on this conversation → buffer reply until turn end.
      if (ctx.bufferReply?.(anchor, a.text)) {
        return { success: true, output: "queued — it posts when your turn ends, unless the conversation has moved by then (it would come back to you next time instead)" };
      }

      const result = await ctx.postMessage(anchor, a.text);
      // Sentinel undelivered id: not a real post — must not engage or close attention.
      if (result.messageId === "undelivered") {
        return { success: false, output: "that didn't send — the surface rejected it after retries. try again, or let it go" };
      }
      if (result.messageId === "already-landed") {
        return { success: true, output: "already posted — the room has these exact words from moments ago; nothing sent twice" };
      }
      if (result.messageId === "already-sent-this-wake") {
        return { success: true, output: "posted" }; // an earlier attempt of this wake already sent it
      }
      recordPostedThread(ctx, anchor, result.messageId);
      pushEffect(ctx, { kind: "posted", anchor, text: a.text });
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
      const raw = isRecord(args) ? args : {};
      const a = { emoji: asString(raw.emoji), ref: typeof raw.ref === "string" ? raw.ref : undefined };
      const emoji = a.emoji.replaceAll(":", "").trim();
      if (!emoji) return { success: false, output: "empty emoji name" };
      const target = a.ref ? ctx.refs?.get(a.ref) : undefined;
      if (!target?.ts) return { success: false, output: "no such message ref — reactions land on a MESSAGE's [rN] tag, not a conversation's" };
      if (!ctx.reactTo) return { success: false, output: "this turn cannot react" };
      const violation = checkPostingScope(ctx, { venueId: target.venueId, threadRootId: null });
      if (violation) return { success: false, output: `posting_scope_violation: ${violation}` };
      try {
        await ctx.reactTo(target.venueId, target.ts, emoji, target.threadRootId);
      } catch (e) {
        return { success: false, output: `reaction failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      pushEffect(ctx, { kind: "reacted", emoji, venueId: target.venueId, ts: target.ts });
      return { success: true, output: `reacted :${emoji}:` };
    },
  };
}

function setWakeTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "set_wake",
      description: "Yield this execution, scheduling it to wake and resume at a future time. Input: { wakeAt } (ISO-8601).",
      inputSchema: { type: "object", additionalProperties: false, required: ["wakeAt"], properties: { wakeAt: { type: "string" } } },
    },
    impl: async (args) => {
      const a = { wakeAt: asString(isRecord(args) ? args.wakeAt : undefined) };
      if (!ctx.taskId) return { success: false, output: "set_wake is only available to an execution's own turns" };
      const live = getTask(ctx.db, ctx.taskId);
      if (live && live.status !== "active") {
        return { success: false, output: "this task is paused waiting on a human go-ahead — stop here and end the turn" };
      }
      // Parse wake_at, clamp horizon, re-serialize canonical ISO.
      const parsed = Date.parse(a.wakeAt);
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

function taskCompleteTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "task_complete",
      description:
        "Complete this task. Your report is handed back to the main mind, who tells the room in her own words — write it as a complete handoff: what you did, what you found, receipts (links/ids), and anything she should flag. Input: { report }.",
      inputSchema: { type: "object", additionalProperties: false, required: ["report"], properties: { report: { type: "string" } } },
    },
    impl: async (args) => {
      const a = { report: asString(isRecord(args) ? args.report : undefined) };
      if (!ctx.taskId) return { success: false, output: "task_complete is only available to an execution's own turns" };
      const live = getTask(ctx.db, ctx.taskId);
      if (live && live.status !== "active") {
        return { success: false, output: "this task is paused waiting on a human go-ahead — stop here and end the turn" };
      }
      if (!a.report?.trim()) return { success: false, output: "the report is the handoff — say what happened before completing" };
      transition(ctx.db, ctx.clock, ctx.taskId, "done", { type: "completed", report: a.report });
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
      const a = { report: asString(isRecord(args) ? args.report : undefined) };
      if (!ctx.taskId) return { success: false, output: "task_fail is only available to an execution's own turns" };
      const live = getTask(ctx.db, ctx.taskId);
      if (live && live.status !== "active") {
        return { success: false, output: "this task is paused waiting on a human go-ahead — stop here and end the turn" };
      }
      if (!a.report?.trim()) return { success: false, output: "the report is the handoff — say what happened before failing" };
      transition(ctx.db, ctx.clock, ctx.taskId, "failed", { type: "failed", report: a.report });
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
      const a = { question: asString(isRecord(args) ? args.question : undefined) };
      if (!ctx.taskId) return { success: false, output: "task_ask is only available to an execution's own turns" };
      const live = getTask(ctx.db, ctx.taskId);
      if (live && live.status !== "active") {
        return { success: false, output: "this task is paused waiting on a human go-ahead — stop here and end the turn" };
      }
      const nudgeDeadline = new Date(new Date(ctx.clock()).getTime() + ctx.nudgeAfterMs).toISOString();
      transition(ctx.db, ctx.clock, ctx.taskId, "waiting", { type: "yield_human", nudgeDeadline });
      pushEffect(ctx, { kind: "task_asked", taskId: ctx.taskId, question: a.question });
      return { success: true, output: `task ${ctx.taskId} waiting on a human` };
    },
  };
}

function renderChecklist(items: { text: string; done: boolean }[]): string {
  return items.map((i) => `${i.done ? "✅" : "⬜️"} ${i.text}`).join("\n");
}
function checklistTool(ctx: ToolsetContext): ToolFactory {
  // Checklist seated by ref (model-chosen conversation); ref-bearing turns only.
  return {
    spec: {
      name: "checklist",
      description:
        "Post/update a live progress checklist for this piece of work — it edits ONE message in place, in the conversation whose [rN] ref you pass. Most replies don't need one: reach for it only when the work is genuinely long and multi-step, with 2-4 high-level goals (what you're finding out, not which tools you'll run). Call it FIRST with the stages (all done:false), then flip each done as you finish. Input: { items: [{ text, done }], ref }. It renders alongside your reply there — a checklist without any words in that conversation shows nothing.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["items", "ref"],
        properties: {
          items: {
            type: "array",
            items: { type: "object", additionalProperties: false, required: ["text", "done"], properties: { text: { type: "string" }, done: { type: "boolean" } } },
          },
          ref: { type: "string", pattern: "^r\\d+$" },
        },
      },
    },
    impl: async (args) => {
      const raw = isRecord(args) ? args : {};
      const items = Array.isArray(raw.items) ? raw.items.filter(isRecord).map((i) => ({ text: asString(i.text), done: i.done === true })) : [];
      const a = { items, ref: typeof raw.ref === "string" ? raw.ref : undefined };
      const target = a.ref ? ctx.refs?.get(a.ref) : undefined;
      if (!target) {
        return { success: false, output: `"${a.ref ?? ""}" is not a ref — seat the checklist with the [rN] tag of the conversation its work is for` };
      }
      const key = conversationOf(target);
      const seat: Anchor = { venueId: key.venueId, threadRootId: key.threadRootId };
      const violation = checkPostingScope(ctx, seat);
      if (violation) return { success: false, output: `posting_scope_violation: ${violation}` };
      const holder = ctx.checklist;
      if (!holder) return { success: false, output: "checklist is not available in this turn" };
      // Prefer native task cards on the seat conversation's stream.
      const native = ctx.renderChecklist ? await ctx.renderChecklist(a.items, seat) : false;
      if (!native) {
        const text = renderChecklist(a.items);
        const seatKey = convoKey(seat.venueId, seat.threadRootId);
        const existing = holder.get(seatKey);
        if (existing && ctx.updateMessage) {
          await ctx.updateMessage(seat.venueId, existing, text);
        } else {
          const result = await ctx.postMessage(seat, text); // first call, or no edit support → (re)post
          if (result.messageId === "undelivered" || result.messageId === "already-sent-this-wake" || result.messageId === "already-landed") {
            return { success: false, output: "the checklist message didn't land — try again" };
          }
          holder.set(seatKey, result.messageId);
        }
      }
      pushEffect(ctx, { kind: "checklist", items: a.items.length, done: a.items.filter((i) => i.done).length });
      return { success: true, output: `checklist: ${a.items.filter((i) => i.done).length}/${a.items.length} done` };
    },
  };
}

// Memory tools: write / retract / tier (no separate correct tool).
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
      const raw = isRecord(args) ? args : {};
      const rawTier: "core" | "recent" | "archive" | undefined = raw.tier === "core" || raw.tier === "recent" || raw.tier === "archive" ? raw.tier : undefined;
      const a = {
        content: asString(raw.content),
        provenance: Array.isArray(raw.provenance) ? raw.provenance : undefined,
        tier: rawTier,
      };
      // Explicit write defaults to core; recent tier for merely-noticed items.
      const tier = a.tier ?? "core";
      const item = writeMemory(ctx.db, ctx.clock, { id: crypto.randomUUID(), identityId: ctx.identity.id, content: a.content, provenance: a.provenance, tier });
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
      const raw = isRecord(args) ? args : {};
      const a = { id: asString(raw.id), supersededBy: typeof raw.supersededBy === "string" ? raw.supersededBy : undefined };
      const existing = queryMemory(ctx.db, ctx.identity.id, { includeRetracted: true }).find((m) => m.id === a.id);
      if (!existing) return { success: false, output: `not_found: no memory item ${a.id} for this identity` };
      retractMemory(ctx.db, ctx.clock, { id: a.id, supersededBy: a.supersededBy });
      pushEffect(ctx, { kind: "memory_retracted", memoryId: a.id });
      return { success: true, output: `retracted ${a.id}` };
    },
  };
}

// Searchable floor: heard traffic + memory for this identity.
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
      const raw = isRecord(args) ? args : {};
      const a = {
        query: asString(raw.query),
        venueId: typeof raw.venueId === "string" ? raw.venueId : undefined,
        principalId: typeof raw.principalId === "string" ? raw.principalId : undefined,
        after: typeof raw.after === "string" ? raw.after : undefined,
        before: typeof raw.before === "string" ? raw.before : undefined,
        limit: typeof raw.limit === "number" ? raw.limit : undefined,
      };
      const hits = searchArchive(ctx.db, ctx.identity.id, a).map((h) => {
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
        // Search hits are via='search' (addressable but unread until card bounce).
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

// Distiller demote/promote: content untouched; archived leaves the injected core.
function memoryTierTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "memory_tier",
      description: "Move a memory item between tiers: 'core' (always in mind), 'recent' (newly noticed, unvetted), 'archive' (searchable background). Input: { id, tier }.",
      inputSchema: { type: "object", additionalProperties: false, required: ["id", "tier"], properties: { id: { type: "string" }, tier: { type: "string", enum: ["core", "recent", "archive"] } } },
    },
    impl: async (args) => {
      const raw = isRecord(args) ? args : {};
      const rawTier = raw.tier;
      if (rawTier !== "core" && rawTier !== "recent" && rawTier !== "archive") {
        return { success: false, output: "memory_tier needs tier to be one of core/recent/archive" };
      }
      const a: { id: string; tier: "core" | "recent" | "archive" } = { id: asString(raw.id), tier: rawTier };
      const existing = queryMemory(ctx.db, ctx.identity.id, { includeRetracted: true }).find((m) => m.id === a.id);
      if (!existing) return { success: false, output: `not_found: no memory item ${a.id} for this identity` };
      const item = setMemoryTier(ctx.db, ctx.clock, a.id, a.tier);
      pushEffect(ctx, { kind: "memory_tiered", memoryId: a.id, tier: item.tier });
      return { success: true, output: `${a.id} → ${item.tier}` };
    },
  };
}

// Toolbox digest: built-ins grouped by registry (same shape as integration catalogs).
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
  // Outward-call dedupe is durable (UNIQUE scope/tool/args_hash); 24h window.
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
            // Ambiguous prior write — never silently redo; verify first.
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
          const result = await impl(args);
          if (result.success) {
            orm(ctx.db)
              .update(outwardCalls)
              .set({ confirmed: 1 })
              .where(and(eq(outwardCalls.scopeId, outwardScope), eq(outwardCalls.tool, grant.tool), eq(outwardCalls.argsHash, argsHash)))
              .run();
          } else {
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


// audit_query: identity-scoped audit read (granted per identity, unlike always-on task_query).
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
      const raw = isRecord(args) ? args : {};
      const a = {
        sinceIso: typeof raw.sinceIso === "string" ? raw.sinceIso : undefined,
        untilIso: typeof raw.untilIso === "string" ? raw.untilIso : undefined,
        kind: asAuditKind(raw.kind),
        taskId: typeof raw.taskId === "string" ? raw.taskId : undefined,
      };
      const records = queryAudit(ctx.db, ctx.identity.id, a);
      return { success: true, output: JSON.stringify(records) };
    },
  };
}

function asAuditKind(v: unknown): AuditKind | undefined {
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

// step_back: leave conversation; observed replies wait until mention or own post re-engages.
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
      const raw = isRecord(args) ? args : {};
      const a = { why: asString(raw.why), ref: typeof raw.ref === "string" ? raw.ref : undefined };
      const target = a.ref ? ctx.refs?.get(a.ref) : undefined;
      if (!target) return { success: false, output: "no such ref — step back using an [rN] tag from the conversation you're leaving" };
      const key = conversationOf(target);
      stepBack(ctx.db, ctx.clock, ctx.identity.id, key.venueId, key.threadRootId, a.why);
      // Durable leave reason rides future wakes; attention pass may reopen if still owed.
      closeAttentionItemsForThread(ctx.db, ctx.clock, ctx.identity.id, key.venueId, key.threadRootId, "stepped back");
      pushEffect(ctx, { kind: "stepped_back", venueId: key.venueId, threadRootId: key.threadRootId, why: a.why });
      return { success: true, output: "stepped back — a mention brings you back in" };
    },
  };
}

export function buildToolset(ctx: ToolsetContext): DynamicTool[] {
  const audit = auditQueryTool(ctx);
  // Per-kind restriction at registration; broker gate wraps every exposed tool.
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
