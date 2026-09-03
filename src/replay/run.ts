// Replay: real Service + capture surface; writes stubbed, reads from snapshot.
import type { Database } from "bun:sqlite";
import {
  SlackAdapter,
  type HistoryMessage,
  type PostResult,
  type RawMessage,
} from "@bevyl-ai/agent-tools";
import { Service } from "../service";
import type { ServiceDeps } from "../service-util";
import { INTEGRATION_REGISTRIES, flattenRegistries } from "../tools/catalog";
import type { ToolRegistry } from "../tools/catalog-types";
import { systemClock, type Clock } from "../ledger/clock";
import type { PolicyStore } from "../policy/load";
import type { Logger } from "../log";
import { inArray } from "drizzle-orm";
import { orm } from "../ledger/db";
import { events } from "../ledger/schema";
import { slackRegistry } from "../tools/slack-tools";

export interface CapturedAction {
  at: string;
  kind: "post" | "reaction" | "external_tool";
  detail: Record<string, unknown>;
}

type ThreadMsg = HistoryMessage;

// Capture surface over the real adapter: writes are captured, reads come from the snapshot,
// nothing reaches Slack (no token, no sockets, no streams).
class CaptureAdapter extends SlackAdapter {
  readonly captured: CapturedAction[] = [];
  private listeners: Array<(msg: RawMessage) => void> = [];
  private threads = new Map<string, ThreadMsg[]>();
  private roots = new Map<string, ThreadMsg[]>();
  private nextId = 1;

  constructor(
    private clock: Clock,
    db: Database,
  ) {
    super({ botToken: "", appToken: "", botUserId: "" });
    const rows = orm(db)
      .select({
        venueId: events.venueId,
        threadRootId: events.threadRootId,
        principalId: events.principalId,
        payload: events.payload,
      })
      .from(events)
      .where(inArray(events.kind, ["addressed_message", "observed_message"]))
      .orderBy(events.rowid)
      .all();
    for (const row of rows) {
      const payload = row.payload;
      const ts = payload.ts ?? "";
      if (!ts) continue;
      const files = payload.files;
      const msg: ThreadMsg = {
        user: row.principalId,
        text: payload.text,
        ts,
        ...(files ? { files } : {}),
      };
      this.append(row.threadRootId ?? ts, msg);
      if (!row.threadRootId && row.venueId) this.appendRoot(row.venueId, msg);
    }
  }

  private append(root: string, msg: ThreadMsg): void {
    const list = this.threads.get(root) ?? [];
    list.push(msg);
    this.threads.set(root, list);
  }

  private appendRoot(venueId: string, msg: ThreadMsg): void {
    const list = this.roots.get(venueId) ?? [];
    list.push(msg);
    this.roots.set(venueId, list);
  }

  override async start(): Promise<void> {}
  override stop(): void {}

  override onMessage(handler: (msg: RawMessage) => void): void {
    this.listeners.push(handler);
  }

  emit(msg: RawMessage): void {
    const entry: ThreadMsg = {
      user: msg.principalId,
      text: msg.text,
      ts: msg.ts,
      ...(msg.files?.length ? { files: msg.files } : {}),
    };
    this.append(msg.threadRootTs ?? msg.ts, entry);
    if (!msg.threadRootTs) this.appendRoot(msg.venueId, entry);
    for (const handler of this.listeners) handler(msg);
  }

  override async postMessage(
    venueId: string,
    threadRootTs: string | null,
    text: string,
  ): Promise<PostResult> {
    this.captured.push({ at: this.clock(), kind: "post", detail: { venueId, threadRootTs, text } });
    return { messageId: `replay-${this.nextId++}` };
  }

  override async addReaction(venueId: string, messageId: string, emoji: string): Promise<void> {
    this.captured.push({
      at: this.clock(),
      kind: "reaction",
      detail: { venueId, messageId, emoji },
    });
  }

  override async readHistory(venueId: string, limit = 20): Promise<ThreadMsg[]> {
    return (this.roots.get(venueId) ?? []).slice(-limit);
  }

  override async readThread(_venueId: string, threadTs: string, limit = 50): Promise<ThreadMsg[]> {
    return (this.threads.get(threadTs) ?? []).slice(-limit);
  }

  override async startStream(): Promise<null> {
    return null;
  }

  override async setSessionStatus(): Promise<void> {}

  override async downloadFile(): Promise<Uint8Array> {
    throw new Error("replay captures file metadata only");
  }
}

// Stub writes (capture success); run real reads.
export function recordingRegistries(
  registries: ToolRegistry[],
  captured: CapturedAction[],
  clock: Clock,
): ToolRegistry[] {
  return registries.map((registry) =>
    Object.assign({}, registry, {
      tools: Object.fromEntries(
        Object.entries(registry.tools).map(([name, spec]) => [
          name,
          {
            ...spec,
            tool: {
              spec: spec.tool!.spec,
              run: async (args: unknown) => {
                const outward = (spec.actionClasses?.(args) ?? []).length > 0;
                if (!outward)
                  return spec.tool
                    ? spec.tool.run(args)
                    : { success: false, output: "that lookup is not available right now" };
                captured.push({ at: clock(), kind: "external_tool", detail: { tool: name, args } });
                return {
                  success: true,
                  output: JSON.stringify({ success: true, note: "the write completed" }),
                };
              },
            },
          },
        ]),
      ),
    }),
  );
}

export interface ReplayOpts {
  db: Database;
  events: { rowid: number; receivedAt: string; message: RawMessage }[];
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
  const registries = recordingRegistries(
    [
      ...INTEGRATION_REGISTRIES,
      slackRegistry({ adapter, botToken: "", workspace: opts.workspace }),
    ],
    adapter.captured,
    clock,
  );
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
