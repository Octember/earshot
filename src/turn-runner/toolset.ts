// SPEC §11 — the standard toolset exposed to a turn, gated through policy/broker.ts's decide()
// on every call so grant/toolset-kind/confirmation-eligibility can never be bypassed by a tool
// implementation forgetting to check. Posting is scope-checked here too (SPEC §11's posting-scope
// rule): interactive/execution_step turns may only post within their own anchor's venue; ambient
// only within its enabled venues; distillation never.
import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";
import {
  createTask,
  steerTask,
  requestConfirmation,
  resolveConfirmation,
  transition,
  ledgerView,
  nextTaskId,
  getTask,
  type Anchor,
  type SteeringKind,
} from "../ledger/tasks";
import { writeMemory, retractMemory, queryMemory, setMemoryTier, type MemoryTier } from "../ledger/memory";
import { searchArchive } from "../ledger/search";
import { recordThreadParticipation } from "../ledger/threads";
import { ambientPostsToday, recordAmbientPost } from "../ledger/ambient";
import { queryAudit, type AuditKind } from "../ledger/audit";
import { decide, exposableForKind, type ToolCatalog, type TurnKind } from "../policy/broker";
import type { ToolRegistry } from "../tools/catalog";
import type { IdentityConfig } from "../policy/schema";
import type { DynamicTool } from "./types";

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
  ambientEnabledVenues?: string[];
  ambientDailyPostCap?: number; // SPEC §9.2; required when turnKind === "ambient"
  budgetTimezone?: string; // SPEC §9.2's "per calendar day (budget timezone)"; defaults to UTC
  principal?: Principal;
  originEventId?: string;
  taskId?: string; // the task this execution_step turn belongs to
  nudgeAfterMs: number;
  postMessage: (anchor: Anchor, text: string) => Promise<{ messageId: string }>;
  // Edit an already-posted message (Slack chat.update). Enables the live checklist. Optional — a
  // surface without it just re-posts instead of editing in place.
  updateMessage?: (venueId: string, messageId: string, text: string) => Promise<void>;
  // Shared holder for the execution's live checklist message id — persists across the execution's
  // turns so the `checklist` tool edits ONE message in place (Claude Tag's signature UX).
  checklist?: { messageId: string | null };
  // React to the message that triggered this turn (Slack reactions.add) — sometimes an emoji IS
  // the right reply ("if u see this please emoji it"). Bound by the service to the trigger message.
  react?: (emoji: string) => Promise<void>;
  // React to a SPECIFIC message by venue + surface ts — how an ambient turn (no trigger message)
  // acknowledges overheard chatter without posting. Venue-scoped like any post.
  reactTo?: (venueId: string, messageId: string, emoji: string) => Promise<void>;
  // Render the execution's checklist as NATIVE task cards on its streamed message. Returns false
  // when no stream is live (caller falls back to the emoji-text message).
  renderChecklist?: (items: { text: string; done: boolean }[]) => Promise<boolean>;
  // Build a surface permalink for a message (SPEC §8.7: search hits carry receipts). Absent when
  // the surface can't construct one; hits then cite venue + timestamp only.
  permalink?: (venueId: string, messageId: string) => string | undefined;
  effects: unknown[]; // mutated in place — collected for turns.ts's recordTurn
}

function pushEffect(ctx: ToolsetContext, effect: unknown): void {
  ctx.effects.push(effect);
}

function checkPostingScope(ctx: ToolsetContext, anchor: Anchor): string | null {
  if (ctx.turnKind === "distillation") return "distillation turns post nowhere";
  if (ctx.turnKind === "ambient") {
    const venues = ctx.ambientEnabledVenues ?? [];
    return venues.includes("*") || venues.includes(anchor.venueId)
      ? null
      : `ambient turns may only post to ambient-enabled venues, got ${anchor.venueId}`;
  }
  if (!ctx.anchor) return "no anchor context for this turn";
  return anchor.venueId === ctx.anchor.venueId ? null : `turns may only post within venue ${ctx.anchor.venueId}, got ${anchor.venueId}`;
}

// SPEC §5.1: every outbound post establishes (or continues) thread participation, not just
// addressed inbound messages — a top-level post's own returned message id becomes the thread
// root future replies will carry.
function recordPostedThread(ctx: ToolsetContext, anchor: Anchor, messageId: string): void {
  recordThreadParticipation(ctx.db, ctx.clock, ctx.identity.id, anchor.venueId, anchor.threadRootId ?? messageId);
}

function gated(ctx: ToolsetContext, toolName: string, impl: (args: unknown) => Promise<{ success: boolean; output: string }>): DynamicTool["run"] {
  return async (args: unknown) => {
    const decision = decide(ctx.db, ctx.clock, {
      identity: ctx.identity,
      turnKind: ctx.turnKind,
      tool: toolName,
      args,
      catalog: ctx.catalog,
      principal: ctx.principal ? { isGuest: ctx.principal.isGuest } : undefined,
    });
    if (!decision.allow) {
      // SPEC §10.2: a denied consequential call on a granted external tool doesn't just fail —
      // execution_step turns get routed into the confirmation flow automatically.
      if (decision.reason === "requires_confirmation" && ctx.taskId) {
        const nudgeDeadline = new Date(new Date(ctx.clock()).getTime() + ctx.nudgeAfterMs).toISOString();
        requestConfirmation(ctx.db, ctx.clock, {
          taskId: ctx.taskId,
          actionRef: `${toolName}:${JSON.stringify(args)}`,
          description: `Requesting confirmation to call ${toolName} (${decision.actionClasses.join(", ")}) with ${JSON.stringify(args)}`,
          nudgeDeadline,
        });
        pushEffect(ctx, { kind: "confirmation_requested", tool: toolName, actionClasses: decision.actionClasses });
        return {
          success: false,
          output: `requires_confirmation: task ${ctx.taskId} is now waiting on a human to approve this action. Nothing was posted for you — before this turn ends, use reply to tell the sponsor in your own words what you want to do and ask them to approve or deny.`,
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

function taskCreateTool(ctx: ToolsetContext): DynamicTool {
  return {
    spec: {
      name: "task_create",
      description: "Record a new delegated task. Input: { title, spec, recurrence? }.",
      inputSchema: { type: "object", additionalProperties: false, required: ["title", "spec"], properties: { title: { type: "string" }, spec: { type: "string" }, recurrence: { type: "string" } } },
    },
    run: gated(ctx, "task_create", async (args) => {
      const a = args as { title: string; spec: string; recurrence?: string };
      if (!ctx.anchor || !ctx.principal || !ctx.originEventId) return { success: false, output: "missing turn context for task_create" };
      const task = createTask(ctx.db, ctx.clock, {
        id: nextTaskId(ctx.db),
        identityId: ctx.identity.id,
        title: a.title,
        spec: a.spec,
        sponsorId: ctx.principal.id,
        homeAnchor: ctx.anchor,
        originEventId: ctx.originEventId,
        recurrence: a.recurrence,
        sponsorIsOperator: ctx.principal.isOperator,
      });
      pushEffect(ctx, { kind: "task_created", taskId: task.id });
      return { success: true, output: JSON.stringify({ taskId: task.id, status: task.status }) };
    }),
  };
}

function taskSteerTool(ctx: ToolsetContext): DynamicTool {
  return {
    spec: {
      name: "task_steer",
      description: "Attach guidance, a pause, or a resume to an existing task. Input: { taskId, kind: 'guidance'|'pause'|'resume', text? }.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["taskId", "kind"],
        properties: { taskId: { type: "string" }, kind: { type: "string", enum: ["guidance", "pause", "resume"] }, text: { type: "string" } },
      },
    },
    run: gated(ctx, "task_steer", async (args) => {
      const a = args as { taskId: string; kind: SteeringKind; text?: string };
      if (!ctx.originEventId) return { success: false, output: "missing turn context for task_steer" };
      // "cancel"/"confirm" have their own dedicated tools (task_cancel/task_confirm) with their
      // own eligibility rules — task_steer's declared schema excludes them, and the JS-level call
      // must enforce that too, not just trust codex to validate against inputSchema.
      if (a.kind !== "guidance" && a.kind !== "pause" && a.kind !== "resume") {
        return { success: false, output: `invalid_kind: task_steer only accepts guidance/pause/resume; use task_cancel or task_confirm for ${a.kind}` };
      }
      const result = steerTask(ctx.db, ctx.clock, { taskId: a.taskId, kind: a.kind, payload: { text: a.text }, sourceEventId: ctx.originEventId });
      pushEffect(ctx, { kind: "task_steered", taskId: a.taskId, steerKind: a.kind, applied: result.applied });
      return { success: result.applied, output: result.reply ?? JSON.stringify({ status: result.task.status }) };
    }),
  };
}

function taskCancelTool(ctx: ToolsetContext): DynamicTool {
  return {
    spec: {
      name: "task_cancel",
      description:
        "Cancel a task. The report is a ledger record — it is NOT posted to the thread. If the room should hear that the work stopped, say it yourself with reply. Input: { taskId, report? }.",
      inputSchema: { type: "object", additionalProperties: false, required: ["taskId"], properties: { taskId: { type: "string" }, report: { type: "string" } } },
    },
    run: gated(ctx, "task_cancel", async (args) => {
      const a = args as { taskId: string; report?: string };
      if (!ctx.originEventId) return { success: false, output: "missing turn context for task_cancel" };
      const result = steerTask(ctx.db, ctx.clock, { taskId: a.taskId, kind: "cancel", payload: { report: a.report }, sourceEventId: ctx.originEventId });
      pushEffect(ctx, { kind: "task_cancelled", taskId: a.taskId, applied: result.applied });
      return { success: result.applied, output: result.reply ?? JSON.stringify({ status: result.task.status }) };
    }),
  };
}

function taskConfirmTool(ctx: ToolsetContext): DynamicTool {
  return {
    spec: {
      name: "task_confirm",
      description: "Resolve a pending confirmation on a task from a member's approve/deny. Input: { taskId, approve }.",
      inputSchema: { type: "object", additionalProperties: false, required: ["taskId", "approve"], properties: { taskId: { type: "string" }, approve: { type: "boolean" } } },
    },
    run: gated(ctx, "task_confirm", async (args) => {
      const a = args as { taskId: string; approve: boolean };
      if (!ctx.principal) return { success: false, output: "missing principal for task_confirm" };
      const result = resolveConfirmation(ctx.db, ctx.clock, { taskId: a.taskId, principalId: ctx.principal.id, approve: a.approve });
      pushEffect(ctx, { kind: "confirmation_resolved", taskId: a.taskId, approve: a.approve, applied: result.applied });
      return { success: result.applied, output: result.reply ?? JSON.stringify({ status: result.task.status }) };
    }),
  };
}

function taskQueryTool(ctx: ToolsetContext): DynamicTool {
  return {
    spec: {
      name: "task_query",
      description: "Read your open tasks and your recently finished ones.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    run: gated(ctx, "task_query", async () => {
      const view = ledgerView(ctx.db, ctx.identity.id);
      return { success: true, output: JSON.stringify(view) };
    }),
  };
}

function replyTool(ctx: ToolsetContext): DynamicTool {
  return {
    spec: {
      name: "reply",
      description: "Post a message. Input: { text, venueId?, threadRootId? } — venueId/threadRootId default to this turn's own anchor.",
      inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" }, venueId: { type: "string" }, threadRootId: { type: ["string", "null"] } } },
    },
    run: gated(ctx, "reply", async (args) => {
      const a = args as { text: string; venueId?: string; threadRootId?: string | null };
      const anchor: Anchor = { venueId: a.venueId ?? ctx.anchor?.venueId ?? "", threadRootId: a.threadRootId ?? ctx.anchor?.threadRootId ?? null };
      const violation = checkPostingScope(ctx, anchor);
      if (violation) return { success: false, output: `posting_scope_violation: ${violation}` };

      // SPEC §9.2: ambient's only outputs are unprompted posts, capped per venue per calendar day.
      if (ctx.turnKind === "ambient") {
        const cap = ctx.ambientDailyPostCap ?? 0;
        const today = ambientPostsToday(ctx.db, ctx.clock, ctx.identity.id, anchor.venueId, ctx.budgetTimezone ?? "UTC");
        if (today >= cap) {
          recordAmbientPost(ctx.db, ctx.clock, ctx.identity.id, anchor.venueId, false);
          return { success: false, output: `ambient_daily_cap_exceeded: ${anchor.venueId} already has ${today}/${cap} posts today` };
        }
      }

      const result = await ctx.postMessage(anchor, a.text);
      recordPostedThread(ctx, anchor, result.messageId);
      if (ctx.turnKind === "ambient") recordAmbientPost(ctx.db, ctx.clock, ctx.identity.id, anchor.venueId, true);
      pushEffect(ctx, { kind: "posted", anchor, text: a.text });
      return { success: true, output: "posted" };
    }),
  };
}

function reactTool(ctx: ToolsetContext): DynamicTool {
  return {
    spec: {
      name: "react",
      description:
        'Add an emoji reaction. Input: { emoji, venueId?, ts? } — emoji name without colons (e.g. "thumbsup", "white_check_mark", "eyes"). Omit venueId/ts to react to the message that triggered this turn; pass BOTH to react to a specific message (its ts as shown in your context). Use when a reaction alone is the best response.',
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["emoji"],
        properties: { emoji: { type: "string" }, venueId: { type: "string" }, ts: { type: "string" } },
      },
    },
    run: gated(ctx, "react", async (args) => {
      const a = args as { emoji: string; venueId?: string; ts?: string };
      const emoji = a.emoji.replace(/:/g, "").trim();
      if (!emoji) return { success: false, output: "empty emoji name" };
      try {
        if (a.venueId || a.ts) {
          if (!a.venueId || !a.ts) return { success: false, output: "reacting to a specific message needs BOTH venueId and ts" };
          if (!ctx.reactTo) return { success: false, output: "this turn cannot react to arbitrary messages" };
          const violation = checkPostingScope(ctx, { venueId: a.venueId, threadRootId: null });
          if (violation) return { success: false, output: `posting_scope_violation: ${violation}` };
          await ctx.reactTo(a.venueId, a.ts, emoji);
        } else {
          if (!ctx.react) return { success: false, output: "no triggering message in this turn — react with { emoji, venueId, ts }" };
          await ctx.react(emoji);
        }
      } catch (e) {
        return { success: false, output: `reaction failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      pushEffect(ctx, { kind: "reacted", emoji, ...(a.ts ? { venueId: a.venueId, ts: a.ts } : {}) });
      return { success: true, output: `reacted :${emoji}:` };
    }),
  };
}

// set_wake IS execution_step's self-scheduling yield (SPEC §6.3: "an execution MAY set wake_at
// and yield") — not a separate staging mechanism; calling it ends the turn's task into
// waiting(timer).
function setWakeTool(ctx: ToolsetContext): DynamicTool {
  return {
    spec: {
      name: "set_wake",
      description: "Yield this execution, scheduling it to wake and resume at a future time. Input: { wakeAt } (ISO-8601).",
      inputSchema: { type: "object", additionalProperties: false, required: ["wakeAt"], properties: { wakeAt: { type: "string" } } },
    },
    run: gated(ctx, "set_wake", async (args) => {
      const a = args as { wakeAt: string };
      if (!ctx.taskId) return { success: false, output: "set_wake is only available to an execution's own turns" };
      transition(ctx.db, ctx.clock, ctx.taskId, "waiting", { type: "yield_timer", wakeAt: a.wakeAt });
      pushEffect(ctx, { kind: "yielded_timer", taskId: ctx.taskId, wakeAt: a.wakeAt });
      return { success: true, output: `task ${ctx.taskId} yielded until ${a.wakeAt}` };
    }),
  };
}

// Implementation-defined (SPEC doesn't name execution_step's outcome tools explicitly — §6.3/§17.4
// describe the OUTCOME, not the tool interface). task_complete/task_fail/task_ask are how an
// execution_step turn declares "done"/"failed honestly"/"blocked on a non-action-specific
// question" respectively.
function taskCompleteTool(ctx: ToolsetContext): DynamicTool {
  return {
    spec: {
      name: "task_complete",
      description:
        "Complete this execution's task. The report is a ledger record — it is NOT posted to the thread. Deliver your user-facing outcome with reply BEFORE completing; the report here is the terse closing summary for the ledger. Input: { report }.",
      inputSchema: { type: "object", additionalProperties: false, required: ["report"], properties: { report: { type: "string" } } },
    },
    run: gated(ctx, "task_complete", async (args) => {
      const a = args as { report: string };
      if (!ctx.taskId) return { success: false, output: "task_complete is only available to an execution's own turns" };
      transition(ctx.db, ctx.clock, ctx.taskId, "done", { type: "completed", report: a.report });
      pushEffect(ctx, { kind: "task_completed", taskId: ctx.taskId });
      return { success: true, output: `task ${ctx.taskId} completed` };
    }),
  };
}

function taskFailTool(ctx: ToolsetContext): DynamicTool {
  return {
    spec: {
      name: "task_fail",
      description:
        "Fail this execution's task honestly, stating what was attempted and what broke. The report is a ledger record — it is NOT posted to the thread. Tell the room what happened with reply BEFORE failing; a task never ENDS silently (a set_wake check-in with nothing new stays silent). Input: { report }.",
      inputSchema: { type: "object", additionalProperties: false, required: ["report"], properties: { report: { type: "string" } } },
    },
    run: gated(ctx, "task_fail", async (args) => {
      const a = args as { report: string };
      if (!ctx.taskId) return { success: false, output: "task_fail is only available to an execution's own turns" };
      transition(ctx.db, ctx.clock, ctx.taskId, "failed", { type: "failed", report: a.report });
      pushEffect(ctx, { kind: "task_failed", taskId: ctx.taskId });
      return { success: true, output: `task ${ctx.taskId} failed` };
    }),
  };
}

function taskAskTool(ctx: ToolsetContext): DynamicTool {
  return {
    spec: {
      name: "task_ask",
      description:
        "Yield this execution on a blocking question that isn't a specific consequential action. The question is NOT posted for you — ask the human in the thread with reply BEFORE yielding, or nobody will ever see it. Input: { question }.",
      inputSchema: { type: "object", additionalProperties: false, required: ["question"], properties: { question: { type: "string" } } },
    },
    run: gated(ctx, "task_ask", async (args) => {
      const a = args as { question: string };
      if (!ctx.taskId) return { success: false, output: "task_ask is only available to an execution's own turns" };
      const nudgeDeadline = new Date(new Date(ctx.clock()).getTime() + ctx.nudgeAfterMs).toISOString();
      transition(ctx.db, ctx.clock, ctx.taskId, "waiting", { type: "yield_human", nudgeDeadline });
      pushEffect(ctx, { kind: "task_asked", taskId: ctx.taskId, question: a.question });
      return { success: true, output: `task ${ctx.taskId} waiting on a human` };
    }),
  };
}

// The live self-editing checklist — Claude Tag's signature "first reply is a checklist it edits in
// place as it goes." One message per execution: the first call posts it, each subsequent call
// chat.update's the SAME message (id held in ctx.checklist, shared across the execution's turns).
function renderChecklist(items: { text: string; done: boolean }[]): string {
  return items.map((i) => `${i.done ? "✅" : "⬜️"} ${i.text}`).join("\n");
}
function checklistTool(ctx: ToolsetContext): DynamicTool {
  return {
    spec: {
      name: "checklist",
      description:
        "Post/update a live progress checklist for this piece of work — it edits ONE message in place. Most replies don't need one: reach for it only when the work is genuinely long and multi-step, with 2-4 high-level goals (what you're finding out, not which tools you'll run). Call it FIRST with the stages (all done:false), then flip each done as you finish. Input: { items: [{ text, done }] }.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
          items: {
            type: "array",
            items: { type: "object", additionalProperties: false, required: ["text", "done"], properties: { text: { type: "string" }, done: { type: "boolean" } } },
          },
        },
      },
    },
    run: gated(ctx, "checklist", async (args) => {
      const a = args as { items: { text: string; done: boolean }[] };
      if (!ctx.anchor) return { success: false, output: "no anchor for this turn" };
      const ref = ctx.checklist;
      if (!ref) return { success: false, output: "checklist is not available in this turn" };
      // Preferred rendering: native task cards on the execution's streamed message (the harness
      // provides renderChecklist when a stream is live). Falls back to one edited-in-place emoji
      // message only when no stream exists (e.g. a recovered task with no thread to stream into).
      const native = ctx.renderChecklist ? await ctx.renderChecklist(a.items) : false;
      if (!native) {
        const text = renderChecklist(a.items);
        if (ref.messageId && ctx.updateMessage) {
          await ctx.updateMessage(ctx.anchor.venueId, ref.messageId, text);
        } else {
          const result = await ctx.postMessage(ctx.anchor, text); // first call, or no edit support → (re)post
          ref.messageId = result.messageId;
        }
      }
      pushEffect(ctx, { kind: "checklist", items: a.items.length, done: a.items.filter((i) => i.done).length });
      return { success: true, output: `checklist: ${a.items.filter((i) => i.done).length}/${a.items.length} done` };
    }),
  };
}

// SPEC §8 — memory tools. §11 names exactly these three (no separate "correct" tool); a
// correction is memory_retract (optionally linking supersededBy) followed by memory_write, not a
// fourth tool. Every memory_retract call verifies the item actually belongs to ctx.identity.id
// BEFORE retracting it — memory IDs are opaque UUIDs, not chat-visible, but §7.1 isolation must be
// enforced at the storage/broker layer regardless of how unlikely guessing one is.
function memoryWriteTool(ctx: ToolsetContext): DynamicTool {
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
    run: gated(ctx, "memory_write", async (args) => {
      const a = args as { content: string; provenance?: unknown[]; tier?: MemoryTier };
      // SPEC §8.6: an interactive/distillation write is explicit or curated — core. An ambient
      // write is something merely overheard — it lands in recent at reduced standing.
      const tier = a.tier ?? (ctx.turnKind === "ambient" ? "recent" : "core");
      const item = writeMemory(ctx.db, ctx.clock, { id: crypto.randomUUID(), identityId: ctx.identity.id, content: a.content, provenance: a.provenance, tier });
      pushEffect(ctx, { kind: "memory_written", memoryId: item.id });
      return { success: true, output: JSON.stringify({ memoryId: item.id }) };
    }),
  };
}

function memoryRetractTool(ctx: ToolsetContext): DynamicTool {
  return {
    spec: {
      name: "memory_retract",
      description: "Retract a memory item (use search first to find its id). Input: { id, supersededBy? }.",
      inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" }, supersededBy: { type: "string" } } },
    },
    run: gated(ctx, "memory_retract", async (args) => {
      const a = args as { id: string; supersededBy?: string };
      const existing = queryMemory(ctx.db, ctx.identity.id, { includeRetracted: true }).find((m) => m.id === a.id);
      if (!existing) return { success: false, output: `not_found: no memory item ${a.id} for this identity` };
      retractMemory(ctx.db, ctx.clock, { id: a.id, supersededBy: a.supersededBy });
      pushEffect(ctx, { kind: "memory_retracted", memoryId: a.id });
      return { success: true, output: `retracted ${a.id}` };
    }),
  };
}

// SPEC §8.7 — the searchable floor: everything this identity has heard plus its memory (both
// tiers), one lexical search. Hits carry receipts (venue/ts/speaker/permalink) so a cited claim
// is evidence, not vibes.
function searchTool(ctx: ToolsetContext): DynamicTool {
  return {
    spec: {
      name: "search",
      description:
        "Search everything you've heard (full message history across your channels) and everything you remember (memory, both tiers). Hits carry venue, time, speaker, and a permalink — cite them. venueId/principalId filters narrow to messages. Input: { query, venueId?, principalId?, after?, before?, limit? } (after/before are ISO timestamps).",
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
    run: gated(ctx, "search", async (args) => {
      const a = args as { query: string; venueId?: string; principalId?: string; after?: string; before?: string; limit?: number };
      const hits = searchArchive(ctx.db, ctx.identity.id, a).map((h) => ({
        kind: h.kind,
        text: h.text.slice(0, 700),
        at: h.at,
        ...(h.venueId ? { venueId: h.venueId } : {}),
        ...(h.threadRootId ? { threadRootId: h.threadRootId } : {}),
        ...(h.principalId ? { principalId: h.principalId } : {}),
        ...(h.memoryId ? { memoryId: h.memoryId, tier: h.tier } : {}),
        ...(h.venueId && h.ts && ctx.permalink?.(h.venueId, h.ts) ? { permalink: ctx.permalink(h.venueId, h.ts) } : {}),
      }));
      return { success: true, output: JSON.stringify(hits) };
    }),
  };
}

// SPEC §8.6 — the distiller's demote/promote. Content is untouched; an archived item leaves the
// always-injected core but stays searchable, so curation never loses information.
function memoryTierTool(ctx: ToolsetContext): DynamicTool {
  return {
    spec: {
      name: "memory_tier",
      description: "Move a memory item between tiers: 'core' (always in mind), 'recent' (newly noticed, unvetted), 'archive' (searchable background). Input: { id, tier }.",
      inputSchema: { type: "object", additionalProperties: false, required: ["id", "tier"], properties: { id: { type: "string" }, tier: { type: "string", enum: ["core", "recent", "archive"] } } },
    },
    run: gated(ctx, "memory_tier", async (args) => {
      const a = args as { id: string; tier: MemoryTier };
      const existing = queryMemory(ctx.db, ctx.identity.id, { includeRetracted: true }).find((m) => m.id === a.id);
      if (!existing) return { success: false, output: `not_found: no memory item ${a.id} for this identity` };
      const item = setMemoryTier(ctx.db, ctx.clock, a.id, a.tier);
      pushEffect(ctx, { kind: "memory_tiered", memoryId: a.id, tier: item.tier });
      return { success: true, output: `${a.id} → ${item.tier}` };
    }),
  };
}

// SPEC §11's toolbox digest: built-ins grouped by registry, same shape as the integration
// registries. GROUPING ONLY — the empty specs carry no behavior; a tool's digest description
// comes from the DynamicTool actually built for the turn (buildToolbox), and a group can earn
// a `skill` here when its tools need a manual. BUILTIN_TOOL_NAME derives from this, so a new
// built-in must pick its registry home or the toolset tests fail.
export const BUILTIN_REGISTRIES: ToolRegistry[] = [
  { name: "tasks", tools: { task_create: {}, task_steer: {}, task_cancel: {}, task_confirm: {}, task_query: {} } },
  { name: "posting", tools: { reply: {}, react: {}, checklist: {} } },
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

function externalTools(ctx: ToolsetContext): DynamicTool[] {
  const tools: DynamicTool[] = [];
  for (const grant of ctx.identity.grants) {
    if (BUILTIN_TOOL_NAME.has(grant.tool)) continue; // built-ins (audit_query included) are constructed below, not granted specs
    const spec = ctx.catalog[grant.tool];
    tools.push({
      spec: {
        name: grant.tool,
        description: spec?.description ?? `granted external tool: ${grant.tool}`,
        inputSchema: spec?.inputSchema ?? { type: "object" },
      },
      run: gated(ctx, grant.tool, async (args) => {
        const impl = spec?.run;
        if (!impl) return { success: false, output: `no implementation registered for external tool ${grant.tool}` };
        return impl(args);
      }),
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
function auditQueryTool(ctx: ToolsetContext): DynamicTool | null {
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
    run: gated(ctx, "audit_query", async (args) => {
      const a = args as { sinceIso?: string; untilIso?: string; kind?: AuditKind; taskId?: string };
      const records = queryAudit(ctx.db, ctx.identity.id, a);
      return { success: true, output: JSON.stringify(records) };
    }),
  };
}

export function buildToolset(ctx: ToolsetContext): DynamicTool[] {
  const audit = auditQueryTool(ctx);
  // SPEC §11 "Expose exactly": per-kind restriction happens HERE, at registration — an
  // ambient turn genuinely has no task tools, not task tools that fail. The broker's
  // per-call decide() stays as defense in depth.
  return [
    taskCreateTool(ctx),
    taskSteerTool(ctx),
    taskCancelTool(ctx),
    taskConfirmTool(ctx),
    taskQueryTool(ctx),
    replyTool(ctx),
    reactTool(ctx),
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
  ].filter((t) => exposableForKind(t.spec.name, ctx.turnKind, ctx.catalog));
}
