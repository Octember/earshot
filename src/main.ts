#!/usr/bin/env bun
// earshot — CLI entrypoint / composition root. Wires the real SlackAdapter + real codex
// AppServerSession into the Service and runs it as a supervised daemon. Kept thin: all logic
// lives in tested library modules; this file only assembles them and owns the process lifecycle
// (env resolution, SIGTERM/SIGINT, the db handle).
import { mkdirSync } from "node:fs";
import { integrationCatalog, INTEGRATION_TOOL_NAMES } from "./tools/catalog";
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
// one built-in that IS grant-gated (§15). A real deployment adds its external tool names here.
const KNOWN_TOOLS = new Set(["audit_query", "read_channel", "read_thread", ...INTEGRATION_TOOL_NAMES]);

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

  // External tools an identity can be granted (KNOWN_TOOLS gates policy validation). read_channel
  // lets the agent pull another channel's recent history on demand ("summarize #bug-reports"). No
  // action classes → a plain read, allowed without confirmation.
  const catalog = {
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
    // Linear / GitHub / Notion — kit transports + earshot's action-class policy (writes = outward).
    ...integrationCatalog(),
  };

  let counter = 0;
  const service = new Service({
    db,
    clock,
    policyStore: store,
    adapter,
    botPrincipalId: botUserId,
    cwd: workspace, // a scratch dir, never earshot's source tree
    catalog,
    newId: () => `${Date.now().toString(36)}-${(counter++).toString(36)}`,
    // The Service supplies a per-turn onEvent (for streaming); fall back to logging when absent.
    sessionFactory: (tools: DynamicTool[], onEvent) => new AppServerSession(DEFAULT_CODEX_CONFIG, tools, onEvent ?? ((e) => e.log && log.info("codex", { line: e.log })), { scrubEnv: scrubSecrets }),
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
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
