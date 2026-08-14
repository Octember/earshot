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
import { messageFiles, type IncidentEvent } from "./incident";
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { orm } from "../ledger/db";
import { events } from "../ledger/schema";
import { isRecord } from "../guard";

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
    const rows = orm(db)
      .select({
        venueId: events.venueId,
        threadRootId: events.threadRootId,
        principalId: events.principalId,
        payload: events.payload,
      })
      .from(events)
      .where(inArray(events.kind, ["addressed_message", "observed_message"]))
      .orderBy(sql`${events}.rowid`)
      .all();
    for (const r of rows) {
      const p = isRecord(r.payload) ? r.payload : {};
      const ts = typeof p.ts === "string" ? p.ts : "";
      if (!ts) continue;
      const files = messageFiles(p.files);
      this.append(r.threadRootId ?? ts, {
        user: r.principalId,
        text: typeof p.text === "string" ? p.text : "",
        ts,
        ...(files ? { files } : {}),
      });
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

// The integration registries with writes stubbed and reads real. A write (any action-classed
// call) is captured and reports success without executing; a read runs its actual
// implementation — the grain contract already guarantees reads are side-effect-free, and a
// replay where she cannot look anything up distorts her far more than reads answering with
// today's world instead of the incident's (first run: failed lookups produced a duplicate
// ticket and a fabricated "I checked").
export function recordingRegistries(captured: CapturedAction[], clock: Clock): ToolRegistry[] {
  return INTEGRATION_REGISTRIES.map((r) => ({
    ...r,
    tools: Object.fromEntries(
      Object.entries(r.tools).map(([name, spec]) => [
        name,
        {
          ...spec,
          run: async (args: unknown) => {
            const outward = (spec.actionClasses?.(args) ?? []).length > 0;
            if (!outward) return spec.run ? spec.run(args) : { success: false, output: "that lookup is not available right now" };
            captured.push({ at: clock(), kind: "external_tool", detail: { tool: name, args } });
            return { success: true, output: JSON.stringify({ success: true, note: "the write completed" }) };
          },
        },
      ]),
    ),
  }));
}

// read_channel / read_thread served from the snapshot's own events, mirroring main.ts's live
// slack registry (same names, so existing grants validate and expose them identically).
export function snapshotSlackRegistry(db: Database): ToolRegistry {
  const messages = (conds: SQL[], limit: number) =>
    orm(db)
      .select({ principalId: events.principalId, payload: events.payload })
      .from(events)
      .where(and(inArray(events.kind, ["addressed_message", "observed_message"]), ...conds))
      .orderBy(desc(sql`${events}.rowid`))
      .limit(limit)
      .all()
      .toReversed()
      .map((r) => {
        const p = isRecord(r.payload) ? r.payload : {};
        return { user: r.principalId, text: typeof p.text === "string" ? p.text : "", ts: typeof p.ts === "string" ? p.ts : "" };
      });
  return {
    name: "slack",
    skill: "Beyond the thread in front of you: pull a channel's recent history on demand, then open any conversation it roots.",
    tools: {
      read_channel: {
        description: "Read recent messages from a Slack channel. Input: { channel, limit? } — channel as <#C…> link or id.",
        inputSchema: { type: "object", additionalProperties: false, required: ["channel"], properties: { channel: { type: "string" }, limit: { type: "number" } } },
        run: async (args: unknown) => {
          const a = isRecord(args) ? args : {};
          const channel = typeof a.channel === "string" ? a.channel : "";
          const venueId = channel.replace(/^<#|[|>].*$/g, "");
          if (!venueId) return { success: false, output: "read_channel needs a { channel }" };
          return { success: true, output: JSON.stringify(messages([eq(events.venueId, venueId), isNull(events.threadRootId)], Math.min(typeof a.limit === "number" ? a.limit : 20, 100))) };
        },
      },
      read_thread: {
        description: "Read a Slack thread's replies. Input: { channel, thread_ts, limit? }.",
        inputSchema: { type: "object", additionalProperties: false, required: ["channel", "thread_ts"], properties: { channel: { type: "string" }, thread_ts: { type: "string" }, limit: { type: "number" } } },
        run: async (args: unknown) => {
          const a = isRecord(args) ? args : {};
          const channel = typeof a.channel === "string" ? a.channel : "";
          const threadTs = typeof a.thread_ts === "string" ? a.thread_ts : "";
          if (!channel || !threadTs) return { success: false, output: "read_thread needs { channel, thread_ts }" };
          return { success: true, output: JSON.stringify(messages([eq(events.threadRootId, threadTs)], Math.min(typeof a.limit === "number" ? a.limit : 50, 200))) };
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
