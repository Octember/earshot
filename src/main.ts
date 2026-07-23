#!/usr/bin/env bun
// earshot — CLI entrypoint / composition root. Wires the real SlackAdapter + real codex
// AppServerSession into the Service and runs it as a supervised daemon. Kept thin: all logic
// lives in tested library modules; this file only assembles them and owns the process lifecycle
// (env resolution, SIGTERM/SIGINT, the db handle).
import { mkdirSync } from "node:fs";
import { INTEGRATION_REGISTRIES, flattenRegistries, type ToolRegistry } from "./tools/catalog";
import { homedir } from "node:os";
import { join } from "node:path";
import { openLedger } from "./ledger/db";
import { systemClock } from "./ledger/clock";
import { PolicyStore, fileSource, PolicyValidationFailedError } from "./policy/load";
import { Service } from "./service";
import { createLogger } from "./log";
import { runtimeSnapshot } from "./status";
import { SlackAdapter } from "@bevyl-ai/agent-tools";
import { AppServerSession, scrubSecrets } from "@bevyl-ai/agent-tools";
import { DEFAULT_CODEX_CONFIG } from "./turn-runner/types";
import type { DynamicTool } from "./turn-runner/types";

const HELP = `earshot — a Slack-resident agent with a durable task ledger.

usage:
  earshot start     run the daemon: connect to Slack, drive tasks via codex, survive restarts
  earshot doctor    check codex login, env vars, and that the policy file validates
  earshot status    one-shot snapshot: open tasks + running executions per identity
  earshot replay    relive a recorded incident from a ledger snapshot with real model calls,
                    against a captured room (nothing reaches Slack). See: earshot replay --help

config (env):
  EARSHOT_DB            ledger path                (default ./earshot.db)
  EARSHOT_POLICY        policy YAML path           (default ./policy.yaml)
  SLACK_BOT_TOKEN   xoxb-...                   (required for start)
  SLACK_APP_TOKEN   xapp-... (Socket Mode)     (required for start)
  SLACK_BOT_USER_ID U...                       (required for start)
`;

const dbPath = () => process.env.EARSHOT_DB ?? "./earshot.db";
const policyPath = () => process.env.EARSHOT_POLICY ?? "./policy.yaml";

// External tools an identity may be granted must be known to policy validation. The built-in
// toolset (task_*, memory_*, reply, set_wake) is never "granted" (SPEC §11); audit_query is the
// one built-in that IS grant-gated (§15). read_channel/read_thread are named here as literals
// (their registry lives in cmdStart, closed over the live adapter) because validate/status run
// makeStore with no adapter; the integration names derive from the registries.
const KNOWN_TOOLS = new Set(["audit_query", "read_channel", "read_thread", ...INTEGRATION_REGISTRIES.flatMap((r) => Object.keys(r.tools))]);

function makeStore(): PolicyStore {
  return new PolicyStore(fileSource(policyPath()), { knownTools: KNOWN_TOOLS });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

async function cmdStart(): Promise<void> {
  const botToken = requireEnv("SLACK_BOT_TOKEN");
  const appToken = requireEnv("SLACK_APP_TOKEN");
  const botUserId = requireEnv("SLACK_BOT_USER_ID");

  let store: PolicyStore;
  try {
    store = makeStore();
  } catch (e) {
    if (e instanceof PolicyValidationFailedError) {
      console.error("policy validation failed:\n" + e.message);
      process.exit(1);
    }
    throw e;
  }

  // The agent's codex sessions run here — a dedicated, empty scratch dir, NOT earshot's source tree
  // (so an ambiguous request can't run/modify earshot's own code). Override with EARSHOT_WORKSPACE.
  const workspace = process.env.EARSHOT_WORKSPACE ?? join(homedir(), "earshot-workspace");
  mkdirSync(workspace, { recursive: true });

  const db = openLedger(dbPath());
  const clock = systemClock;
  const log = createLogger(); // structured JSON lines to stdout (§15)
  const adapter = new SlackAdapter({ botToken, appToken, botUserId }, (line) => log.info("slack", { line }));

  // External tools an identity can be granted (KNOWN_TOOLS gates policy validation). The slack
  // registry needs the live adapter, so it's assembled here rather than in the static catalog.
  // read_channel lets the agent pull another channel's recent history on demand ("summarize
  // #bug-reports"). No action classes → a plain read, allowed without confirmation.
  const slackRegistry: ToolRegistry = {
    name: "slack",
    skill:
      "Beyond the thread in front of you: pull a channel's recent history on demand, then open any conversation it roots. " +
      "Reach for these when someone points you at a channel or you need the surrounding discussion, not just what you overheard.",
    tools: {
    read_channel: {
      run: async (args: unknown) => {
        const a = (args ?? {}) as { channel?: string; limit?: number };
        if (!a.channel) return { success: false, output: "read_channel needs a { channel } — mention it as #channel so its id resolves" };
        try {
          const msgs = await adapter.readHistory(a.channel, Math.min(a.limit ?? 20, 100));
          return { success: true, output: JSON.stringify(msgs) };
        } catch (e) {
          return { success: false, output: e instanceof Error ? e.message : String(e) };
        }
      },
      description: "Read recent messages from a Slack channel (with permalinks for citing). Only channel-root messages — a message with reply_count > 0 roots a thread; pull its replies with read_thread. Input: { channel, limit? } — channel as <#C…> link or id.",
      inputSchema: { type: "object", additionalProperties: false, required: ["channel"], properties: { channel: { type: "string" }, limit: { type: "number" } } },
    },
    read_thread: {
      run: async (args: unknown) => {
        const a = (args ?? {}) as { channel?: string; thread_ts?: string; limit?: number };
        if (!a.channel || !a.thread_ts) return { success: false, output: "read_thread needs { channel, thread_ts } — thread_ts is the root message's ts from read_channel" };
        try {
          const msgs = await adapter.readThread(a.channel, a.thread_ts, Math.min(a.limit ?? 50, 200));
          return { success: true, output: JSON.stringify(msgs) };
        } catch (e) {
          return { success: false, output: e instanceof Error ? e.message : String(e) };
        }
      },
      description: "Read a Slack thread's replies (with permalinks for citing). Input: { channel, thread_ts, limit? } — thread_ts is the root message's ts, as returned by read_channel.",
      inputSchema: { type: "object", additionalProperties: false, required: ["channel", "thread_ts"], properties: { channel: { type: "string" }, thread_ts: { type: "string" }, limit: { type: "number" } } },
    },
    },
  };
  // Linear / GitHub / Notion (kit transports at read/write grain) + the adapter-backed slack
  // registry. ONE list: the broker catalog, KNOWN_TOOLS, and the toolbox digest all derive from it.
  const registries = [...INTEGRATION_REGISTRIES, slackRegistry];
  const catalog = flattenRegistries(registries);

  let counter = 0;
  const service = new Service({
    db,
    clock,
    policyStore: store,
    adapter,
    botPrincipalId: botUserId,
    cwd: workspace, // a scratch dir, never earshot's source tree
    catalog,
    registries,
    newId: () => `${Date.now().toString(36)}-${(counter++).toString(36)}`,
    sessionFactory: makeCodexSessionFactory(log),
    logger: log,
    heartbeatMs: 1000,
  });

  await service.start();

  // Optional read-only status surface (§15 RECOMMENDED) — enabled only when EARSHOT_STATUS_PORT is set.
  const statusPort = process.env.EARSHOT_STATUS_PORT ? Number(process.env.EARSHOT_STATUS_PORT) : null;
  if (statusPort) {
    Bun.serve({
      port: statusPort,
      fetch: () => new Response(JSON.stringify(runtimeSnapshot(db, clock, store.current().budget.timezone), null, 2), { headers: { "content-type": "application/json" } }),
    });
    log.info("status surface listening", { port: statusPort });
  }

  // Live policy reload (§16.2): re-read on file change; PolicyStore keeps last-known-good on
  // error. watchFile (stat polling), NOT watch: editors and sed -i replace the file by rename,
  // which orphans an inotify watch on the old inode after the first edit — polling follows the
  // path, so every subsequent edit still reloads.
  try {
    const { watchFile } = await import("node:fs");
    watchFile(policyPath(), { interval: 2000, persistent: false }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) service.reloadPolicy();
    });
  } catch {
    // no watch available (e.g. file missing) — reload is best-effort, not required to run
  }

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[main] ${sig} — draining in-flight work...`);
    await service.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (e) => console.error("[main] unhandled rejection:", e));
}

// The one real codex wiring, shared by start and replay — a replay that drives a different
// session factory than production would test the wrong bot. overrides carry a task tier's
// model/effort (policy.models): codex accepts -c config overrides ahead of the subcommand, so
// each worker session runs on its tier while the resident mind stays on the runtime default.
function makeCodexSessionFactory(log: ReturnType<typeof createLogger>) {
  return (tools: DynamicTool[], onEvent?: (e: import("./turn-runner/types").AgentEvent) => void, overrides?: { model?: string; effort?: string }) => {
    const flags = [overrides?.model ? `-c model=${JSON.stringify(overrides.model)}` : "", overrides?.effort ? `-c model_reasoning_effort=${JSON.stringify(overrides.effort)}` : ""]
      .filter(Boolean)
      .join(" ");
    const config = flags ? { ...DEFAULT_CODEX_CONFIG, command: `codex ${flags} app-server` } : DEFAULT_CODEX_CONFIG;
    return new AppServerSession(config, tools, onEvent ?? ((e) => e.log && log.info("codex", { line: e.log })), { scrubEnv: scrubSecrets });
  };
}

const REPLAY_HELP = `earshot replay — relive a recorded incident with real model calls, captured room.

usage:
  earshot replay --db <snapshot.db> --from <iso> --to <iso> [--venue C…] [--speed N]

The snapshot is COPIED into the workspace and rewound to the window start; the original file is
never touched. Inbound messages replay at recorded pacing (--speed N compresses gaps N-fold;
speed 1 is truest to mid-turn races). Replies, reactions, and external tool calls are captured
and printed against what she originally did — nothing reaches Slack, Linear, GitHub, or Notion.

needs: codex logged in, EARSHOT_POLICY (or ./policy.yaml), and the workspace dirs codex-trusted.
  --db         path to a ledger snapshot (scp it from the live box first)
  --from/--to  ISO-8601 UTC window bounds, e.g. 2026-07-23T12:00:00Z
  --venue      only replay messages from one venue id
  --speed      gap compression factor (default 1)
  --workspace  scratch dir for the replay's codex sessions (default ./replay-workspace)
  --bot-id     bot principal id (default SLACK_BOT_USER_ID, else UREPLAY)
`;

async function cmdReplay(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(REPLAY_HELP);
    return;
  }
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const snapshot = arg("db");
  const from = arg("from");
  const to = arg("to");
  if (!snapshot || !from || !to) {
    console.log(REPLAY_HELP);
    process.exit(1);
  }
  const { loadIncident, originalActions, rewindLedger } = await import("./replay/incident");
  const { runReplay } = await import("./replay/run");
  const { copyFileSync } = await import("node:fs");

  const workspace = arg("workspace") ?? "./replay-workspace";
  mkdirSync(workspace, { recursive: true });
  const copy = join(workspace, "replay.db");
  copyFileSync(snapshot, copy); // rewind is destructive — never open the snapshot itself
  const db = openLedger(copy);
  const store = makeStore();
  const log = createLogger();

  const venue = arg("venue");
  const events = loadIncident(db, { fromIso: from, toIso: to, ...(venue ? { venueId: venue } : {}) });
  if (events.length === 0) {
    console.error("no surface messages in that window");
    process.exit(1);
  }
  const original = originalActions(db, from, to);
  const rewound = rewindLedger(db, events[0]!.rowid, from);
  console.log(
    `rewound to ${from}: ${rewound.events} events, ${rewound.turns} turns, ${rewound.itemsDeleted}+${rewound.itemsReopened} attention items, ` +
      `${rewound.tasks} tasks, ${rewound.timers} timers cleared` +
      (rewound.memoriesInWindow ? ` (caveat: ${rewound.memoriesInWindow} memories written in-window stay — no edit history to rewind)` : ""),
  );
  console.log(`replaying ${events.length} messages at speed ${arg("speed") ?? "1"}…\n`);

  const captured = await runReplay({
    db,
    events,
    policyStore: store,
    sessionFactory: makeCodexSessionFactory(log),
    workspace,
    botPrincipalId: arg("bot-id") ?? process.env.SLACK_BOT_USER_ID ?? "UREPLAY",
    speed: Number(arg("speed") ?? "1"),
    logger: log,
  });

  const show = (kind: string, detail: unknown) => `  ${kind}: ${JSON.stringify(detail)}`;
  console.log("\n=== originally ===");
  for (const t of original) for (const e of t.effects as { kind?: string }[]) console.log(show(e.kind ?? "?", e));
  console.log("\n=== in replay ===");
  for (const c of captured) console.log(show(c.kind, c.detail));
  db.close();
}

async function cmdDoctor(): Promise<void> {
  const codexOk = await codexReady();
  console.log(`${codexOk ? "ok      " : "MISSING "}codex logged in`);
  for (const v of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_BOT_USER_ID"]) {
    console.log(`${process.env[v] ? "ok      " : "MISSING "}${v}`);
  }
  try {
    makeStore();
    console.log(`ok      policy validates (${policyPath()})`);
  } catch (e) {
    console.log(`MISSING policy — ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  }
}

async function codexReady(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["codex", "login", "status"], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

function cmdStatus(): void {
  const db = openLedger(dbPath());
  let timezone = "UTC";
  try {
    timezone = makeStore().current().budget.timezone;
  } catch {
    // no policy — UTC is a fine default for a read-only snapshot
  }
  const snap = runtimeSnapshot(db, systemClock, timezone);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(snap, null, 2));
    db.close();
    return;
  }

  if (snap.identities.length === 0) {
    console.log("no tasks yet");
  } else {
    for (const i of snap.identities) {
      console.log(
        `${i.identityId}: ${i.open} open, ${i.running} running, ${i.waitingHuman} waiting(human), ${i.waitingTimer} waiting(timer), ${i.parked} parked · $${i.spendThisMonth.toFixed(2)} this month`,
      );
    }
    console.log(`timers: ${snap.timersDue} due, ${snap.timersPending} pending · global spend this month: $${snap.globalSpendThisMonth.toFixed(2)}`);
  }
  db.close();
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case "start":
      return cmdStart();
    case "doctor":
      return cmdDoctor();
    case "status":
      return cmdStatus();
    case "replay":
      return cmdReplay();
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
