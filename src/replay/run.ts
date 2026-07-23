// The replay run: the REAL Service (router, ear, wakes, ledger) reliving an incident's inbound
// traffic with real model calls, against a capture surface — nothing reaches Slack, external
// write tools record instead of executing, and reads are served from the snapshot itself.
import type { Database } from "bun:sqlite";
import type { SurfaceAdapter, RawMessage, PostResult, MessageFile } from "@bevyl-ai/agent-tools";
import { Service, type ServiceDeps } from "../service";
import { INTEGRATION_REGISTRIES, flattenRegistries, type ToolRegistry } from "../tools/catalog";
import { systemClock, type Clock } from "../ledger/clock";
import type { PolicyStore } from "../policy/load";
import type { Logger } from "../log";
import type { IncidentEvent } from "./incident";

export interface CapturedAction {
  at: string;
  kind: "post" | "reaction" | "external_tool";
  detail: Record<string, unknown>;
}

type ThreadMsg = { user: string | null; text: string; ts: string; files?: MessageFile[] };

// A surface that captures instead of delivering. Streaming methods are deliberately absent so
// every reply funnels through the plain-post fallback — one capture point, no stream bookkeeping.
// readThread serves the room as recorded: snapshot history seeded at construction, replayed
// messages appended as they're emitted.
class CaptureAdapter implements SurfaceAdapter {
  readonly captured: CapturedAction[] = [];
  private handlers: Array<(msg: RawMessage) => void> = [];
  private threads = new Map<string, ThreadMsg[]>();
  private nextId = 1;

  constructor(
    private clock: Clock,
    db: Database,
  ) {
    const rows = db
      .query("SELECT venue_id, thread_root_id, principal_id, payload FROM events WHERE kind IN ('addressed_message','observed_message') ORDER BY rowid")
      .all() as { venue_id: string | null; thread_root_id: string | null; principal_id: string | null; payload: string }[];
    for (const r of rows) {
      const p = JSON.parse(r.payload) as { text?: string; ts?: string; files?: MessageFile[] };
      if (!p.ts) continue;
      this.append(r.thread_root_id ?? p.ts, { user: r.principal_id, text: p.text ?? "", ts: p.ts, ...(p.files?.length ? { files: p.files } : {}) });
    }
  }

  private append(root: string, msg: ThreadMsg): void {
    const list = this.threads.get(root) ?? [];
    list.push(msg);
    this.threads.set(root, list);
  }

  async start(): Promise<void> {}
  stop(): void {}

  onMessage(handler: (msg: RawMessage) => void): void {
    this.handlers.push(handler);
  }

  emit(msg: RawMessage): void {
    this.append(msg.threadRootTs ?? msg.ts, { user: msg.principalId, text: msg.text, ts: msg.ts, ...(msg.files?.length ? { files: msg.files } : {}) });
    for (const h of this.handlers) h(msg);
  }

  async postMessage(venueId: string, threadRootTs: string | null, text: string): Promise<PostResult> {
    this.captured.push({ at: this.clock(), kind: "post", detail: { venueId, threadRootTs, text } });
    return { messageId: `replay-${this.nextId++}` };
  }

  async addReaction(venueId: string, messageId: string, emoji: string): Promise<void> {
    this.captured.push({ at: this.clock(), kind: "reaction", detail: { venueId, messageId, emoji } });
  }

  async readThread(_venueId: string, threadTs: string): Promise<ThreadMsg[]> {
    return this.threads.get(threadTs) ?? [];
  }

  async setTypingStatus(): Promise<void> {}
}

// The integration registries with their real specs but recording implementations: a write
// (any action-classed call) reports success without executing; a read reports itself
// unavailable — both are captured so the report shows what she reached for.
export function recordingRegistries(captured: CapturedAction[], clock: Clock): ToolRegistry[] {
  return INTEGRATION_REGISTRIES.map((r) => ({
    ...r,
    tools: Object.fromEntries(
      Object.entries(r.tools).map(([name, spec]) => [
        name,
        {
          ...spec,
          run: async (args: unknown) => {
            captured.push({ at: clock(), kind: "external_tool", detail: { tool: name, args } });
            const outward = (spec.actionClasses?.(args) ?? []).length > 0;
            return outward ? { success: true, output: "done" } : { success: false, output: "that lookup is not available right now" };
          },
        },
      ]),
    ),
  }));
}

// read_channel / read_thread served from the snapshot's own events, mirroring main.ts's live
// slack registry (same names, so existing grants validate and expose them identically).
export function snapshotSlackRegistry(db: Database): ToolRegistry {
  const messages = (where: string, params: string[], limit: number) =>
    db
      .query(
        `SELECT venue_id, thread_root_id, principal_id, payload FROM events
         WHERE kind IN ('addressed_message','observed_message') AND ${where} ORDER BY rowid DESC LIMIT ?`,
      )
      .all(...params, limit)
      .reverse()
      .map((row) => {
        const r = row as { principal_id: string | null; payload: string };
        const p = JSON.parse(r.payload) as { text?: string; ts?: string };
        return { user: r.principal_id, text: p.text ?? "", ts: p.ts ?? "" };
      });
  return {
    name: "slack",
    skill: "Beyond the thread in front of you: pull a channel's recent history on demand, then open any conversation it roots.",
    tools: {
      read_channel: {
        description: "Read recent messages from a Slack channel. Input: { channel, limit? } — channel as <#C…> link or id.",
        inputSchema: { type: "object", additionalProperties: false, required: ["channel"], properties: { channel: { type: "string" }, limit: { type: "number" } } },
        run: async (args: unknown) => {
          const a = (args ?? {}) as { channel?: string; limit?: number };
          const venueId = a.channel?.replace(/^<#|[|>].*$/g, "");
          if (!venueId) return { success: false, output: "read_channel needs a { channel }" };
          return { success: true, output: JSON.stringify(messages("venue_id = ? AND thread_root_id IS NULL", [venueId], Math.min(a.limit ?? 20, 100))) };
        },
      },
      read_thread: {
        description: "Read a Slack thread's replies. Input: { channel, thread_ts, limit? }.",
        inputSchema: { type: "object", additionalProperties: false, required: ["channel", "thread_ts"], properties: { channel: { type: "string" }, thread_ts: { type: "string" }, limit: { type: "number" } } },
        run: async (args: unknown) => {
          const a = (args ?? {}) as { channel?: string; thread_ts?: string; limit?: number };
          if (!a.channel || !a.thread_ts) return { success: false, output: "read_thread needs { channel, thread_ts }" };
          return { success: true, output: JSON.stringify(messages("thread_root_id = ?", [a.thread_ts], Math.min(a.limit ?? 50, 200))) };
        },
      },
    },
  };
}

export interface ReplayOpts {
  db: Database;
  events: IncidentEvent[];
  policyStore: PolicyStore;
  sessionFactory: ServiceDeps["sessionFactory"];
  workspace: string;
  botPrincipalId: string;
  speed?: number; // 1 = recorded pacing (truest to mid-turn races); N compresses gaps N-fold
  clock?: Clock;
  logger?: Logger;
  out?: (line: string) => void;
}

// Feed the incident through a fresh Service at recorded pacing and return everything she did.
// The db must already be rewound (incident.ts) — this function only relives and captures.
export async function runReplay(opts: ReplayOpts): Promise<CapturedAction[]> {
  const clock = opts.clock ?? systemClock;
  const out = opts.out ?? ((line: string) => console.log(line));
  const speed = opts.speed ?? 1;
  const adapter = new CaptureAdapter(clock, opts.db);
  const registries = [...recordingRegistries(adapter.captured, clock), snapshotSlackRegistry(opts.db)];
  let n = 0;
  const service = new Service({
    db: opts.db,
    clock,
    policyStore: opts.policyStore,
    adapter,
    botPrincipalId: opts.botPrincipalId,
    cwd: opts.workspace,
    catalog: flattenRegistries(registries),
    registries,
    newId: () => `replay-${Date.now().toString(36)}-${(n++).toString(36)}`,
    sessionFactory: opts.sessionFactory,
    ...(opts.logger ? { logger: opts.logger } : {}),
    heartbeatMs: 1000,
  });
  await service.start();
  const t0 = Date.parse(opts.events[0]!.receivedAt);
  const started = Date.now();
  for (const e of opts.events) {
    const wait = started + (Date.parse(e.receivedAt) - t0) / speed - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const where = `${e.message.venueId}${e.message.threadRootTs ? ` thread=${e.message.threadRootTs}` : ""}`;
    out(`⟳ ${e.receivedAt} [${where}] <${e.message.principalId ?? "?"}>: ${e.message.text.slice(0, 120)}`);
    adapter.emit(e.message);
  }
  await service.idle();
  await service.stop();
  return adapter.captured;
}
