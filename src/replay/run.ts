// Replay: real Service + capture surface; writes stubbed, reads from snapshot.
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
import { parseEventPayload } from "../schemas/event-payload";
import { parseToolArgs, zodInputSchema } from "../schemas/tool";
import { ReadChannelArgsSchema, ReadThreadArgsSchema } from "../schemas/tools";

export interface CapturedAction {
  at: string;
  kind: "post" | "reaction" | "external_tool";
  detail: Record<string, unknown>;
}

type ThreadMsg = { user: string | null; text: string; ts: string; files?: MessageFile[] };

// Capture surface (no streaming — all replies via plain post).
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
    for (const row of rows) {
      const payload = parseEventPayload(row.payload);
      const ts = payload.ts ?? "";
      if (!ts) continue;
      const files = messageFiles(row.payload, payload.files);
      this.append(row.threadRootId ?? ts, {
        user: row.principalId,
        text: payload.text,
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
    this.append(msg.threadRootTs ?? msg.ts, {
      user: msg.principalId,
      text: msg.text,
      ts: msg.ts,
      ...(msg.files?.length ? { files: msg.files } : {}),
    });
    for (const handler of this.handlers) handler(msg);
  }

  async postMessage(
    venueId: string,
    threadRootTs: string | null,
    text: string,
  ): Promise<PostResult> {
    this.captured.push({ at: this.clock(), kind: "post", detail: { venueId, threadRootTs, text } });
    return { messageId: `replay-${this.nextId++}` };
  }

  async addReaction(venueId: string, messageId: string, emoji: string): Promise<void> {
    this.captured.push({
      at: this.clock(),
      kind: "reaction",
      detail: { venueId, messageId, emoji },
    });
  }

  async readThread(_venueId: string, threadTs: string): Promise<ThreadMsg[]> {
    return this.threads.get(threadTs) ?? [];
  }

  async setTypingStatus(): Promise<void> {}
}

// Stub writes (capture success); run real reads.
export function recordingRegistries(captured: CapturedAction[], clock: Clock): ToolRegistry[] {
  return INTEGRATION_REGISTRIES.map((registry) =>
    Object.assign({}, registry, {
      tools: Object.fromEntries(
        Object.entries(registry.tools).map(([name, spec]) => [
          name,
          {
            ...spec,
            run: async (args: unknown) => {
              const outward = (spec.actionClasses?.(args) ?? []).length > 0;
              if (!outward)
                return spec.run
                  ? spec.run(args)
                  : { success: false, output: "that lookup is not available right now" };
              captured.push({ at: clock(), kind: "external_tool", detail: { tool: name, args } });
              return {
                success: true,
                output: JSON.stringify({ success: true, note: "the write completed" }),
              };
            },
          },
        ]),
      ),
    }),
  );
}

// Snapshot-backed read_channel / read_thread (same names as live slack registry).
function snapshotSlackRegistry(db: Database): ToolRegistry {
  const messages = (conds: SQL[], limit: number) =>
    orm(db)
      .select({ principalId: events.principalId, payload: events.payload })
      .from(events)
      .where(and(inArray(events.kind, ["addressed_message", "observed_message"]), ...conds))
      .orderBy(desc(sql`${events}.rowid`))
      .limit(limit)
      .all()
      .toReversed()
      .map((row) => {
        const payload = parseEventPayload(row.payload);
        return {
          user: row.principalId,
          text: payload.text,
          ts: payload.ts ?? "",
        };
      });
  return {
    name: "slack",
    skill:
      "Beyond the thread in front of you: pull a channel's recent history on demand, then open any conversation it roots.",
    tools: {
      read_channel: {
        description:
          "Read recent messages from a Slack channel. Input: { channel, limit? } — channel as <#C…> link or id.",
        inputSchema: zodInputSchema(ReadChannelArgsSchema),
        run: async (args: unknown) => {
          const parsed = parseToolArgs(ReadChannelArgsSchema, args);
          if ("success" in parsed) return parsed;
          const channel = parsed.data.channel.replaceAll(/^<#|[|>].*$/g, "");
          if (!channel) return { success: false, output: "read_channel needs a { channel }" };
          return {
            success: true,
            output: JSON.stringify(
              messages(
                [eq(events.venueId, channel), isNull(events.threadRootId)],
                Math.min(parsed.data.limit ?? 20, 100),
              ),
            ),
          };
        },
      },
      read_thread: {
        description: "Read a Slack thread's replies. Input: { channel, thread_ts, limit? }.",
        inputSchema: zodInputSchema(ReadThreadArgsSchema),
        run: async (args: unknown) => {
          const parsed = parseToolArgs(ReadThreadArgsSchema, args);
          if ("success" in parsed) return parsed;
          const { thread_ts, limit } = parsed.data;
          return {
            success: true,
            output: JSON.stringify(
              messages([eq(events.threadRootId, thread_ts)], Math.min(limit ?? 50, 200)),
            ),
          };
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

// Feed incident at recorded pacing; db must already be rewound.
export async function runReplay(opts: ReplayOpts): Promise<CapturedAction[]> {
  const clock = opts.clock ?? systemClock;
  const out =
    opts.out ??
    ((line: string) => {
      console.log(line);
    });
  const speed = opts.speed ?? 1;
  const adapter = new CaptureAdapter(clock, opts.db);
  const registries = [
    ...recordingRegistries(adapter.captured, clock),
    snapshotSlackRegistry(opts.db),
  ];
  let nextId = 0;
  const service = new Service({
    db: opts.db,
    clock,
    policyStore: opts.policyStore,
    adapter,
    botPrincipalId: opts.botPrincipalId,
    cwd: opts.workspace,
    catalog: flattenRegistries(registries),
    registries,
    newId: () => `replay-${Date.now().toString(36)}-${(nextId++).toString(36)}`,
    sessionFactory: opts.sessionFactory,
    ...(opts.logger ? { logger: opts.logger } : {}),
    heartbeatMs: 1000,
  });
  await service.start();
  const firstReceivedMs = Date.parse(opts.events[0]!.receivedAt);
  const started = Date.now();
  for (const event of opts.events) {
    const wait = started + (Date.parse(event.receivedAt) - firstReceivedMs) / speed - Date.now();
    if (wait > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, wait);
      });
    }
    const where = `${event.message.venueId}${event.message.threadRootTs ? ` thread=${event.message.threadRootTs}` : ""}`;
    out(
      `⟳ ${event.receivedAt} [${where}] <${event.message.principalId ?? "?"}>: ${event.message.text.slice(0, 120)}`,
    );
    adapter.emit(event.message);
  }
  await service.idle();
  await service.stop();
  return adapter.captured;
}
