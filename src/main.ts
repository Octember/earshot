#!/usr/bin/env bun
// earshot CLI — composition root (SlackAdapter + Codex → Service).
import { mkdirSync } from "node:fs";
import { INTEGRATION_REGISTRIES, flattenRegistries } from "./tools/catalog";
import { slackRegistry, SLACK_TOOL_NAMES } from "./tools/slack";
import { homedir } from "node:os";
import { join } from "node:path";
import { openLedger } from "./ledger/db";
import { systemClock } from "./ledger/clock";
import { PolicyStore, fileSource, PolicyValidationFailedError } from "./policy/load";
import { Service } from "./service";
import { createLogger } from "./log";
import { runtimeSnapshot } from "./status";
import { SlackAdapter } from "@bevyl-ai/agent-tools";
import { AppServerSession } from "@bevyl-ai/agent-tools";
import { DEFAULT_CODEX_CONFIG } from "./turn-runner/types";
import type { DynamicTool } from "./turn-runner/types";
import { isRecord } from "./guard";

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
  SLACK_ADMIN_TOKEN xoxp-... (admin user)      (optional: enables emoji_set)
`;

const dbPath = () => process.env.EARSHOT_DB ?? "./earshot.db";
const policyPath = () => process.env.EARSHOT_POLICY ?? "./policy.yaml";

// Built-in toolset is never granted; audit_query + slack/integration names are.
const KNOWN_TOOLS = new Set(["audit_query", ...SLACK_TOOL_NAMES, ...INTEGRATION_REGISTRIES.flatMap((registry) => Object.keys(registry.tools))]);

function makeStore(): PolicyStore {
  return new PolicyStore(fileSource(policyPath()), { knownTools: KNOWN_TOOLS });
}

function requireEnv(name: string): string {
  const envValue = process.env[name];
  if (!envValue) {
    console.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return envValue;
}

async function cmdStart(): Promise<void> {
  const botToken = requireEnv("SLACK_BOT_TOKEN");
  const appToken = requireEnv("SLACK_APP_TOKEN");
  const botUserId = requireEnv("SLACK_BOT_USER_ID");

  let store: PolicyStore;
  try {
    store = makeStore();
  } catch (error) {
    if (error instanceof PolicyValidationFailedError) {
      console.error("policy validation failed:\n" + error.message);
      process.exit(1);
    }
    throw error;
  }

  // Dedicated scratch cwd — not earshot's source tree. Override: EARSHOT_WORKSPACE.
  const workspace = process.env.EARSHOT_WORKSPACE ?? join(homedir(), "earshot-workspace");
  mkdirSync(workspace, { recursive: true });

  const db = openLedger(dbPath());
  const clock = systemClock;
  const log = createLogger();
  const adapter = new SlackAdapter({ botToken, appToken, botUserId }, (line) => {
    log.info("slack", { line });
  });

  // Slack registry needs live adapter + tokens; integrations are static.
  const slack = slackRegistry({
    readHistory: (channel, limit) => adapter.readHistory(channel, limit),
    readThread: (channel, threadTs, limit) => adapter.readThread(channel, threadTs, limit),
    downloadFile: (url) => adapter.downloadFile(url),
    botToken,
    adminToken: process.env.SLACK_ADMIN_TOKEN,
    workspace,
  });
  const registries = [...INTEGRATION_REGISTRIES, slack];
  const catalog = flattenRegistries(registries);

  let counter = 0;
  const service = new Service({
    db,
    clock,
    policyStore: store,
    adapter,
    botPrincipalId: botUserId,
    cwd: workspace,
    catalog,
    registries,
    newId: () => `${Date.now().toString(36)}-${(counter++).toString(36)}`,
    sessionFactory: makeCodexSessionFactory(log),
    logger: log,
    heartbeatMs: 1000,
  });

  await service.start();

  const statusPort = process.env.EARSHOT_STATUS_PORT ? Number(process.env.EARSHOT_STATUS_PORT) : null;
  if (statusPort) {
    Bun.serve({
      port: statusPort,
      fetch: () => new Response(JSON.stringify(runtimeSnapshot(db, clock, store.current().budget.timezone), null, 2), { headers: { "content-type": "application/json" } }),
    });
    log.info("status surface listening", { port: statusPort });
  }

  // watchFile (stat poll), not watch: rename-replace editors orphan inotify watches.
  try {
    const { watchFile } = await import("node:fs");
    watchFile(policyPath(), { interval: 2000, persistent: false }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) service.reloadPolicy();
    });
  } catch {
    // reload best-effort
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
  process.on("unhandledRejection", (error) => {
    console.error("[main] unhandled rejection:", error);
  });
}

// Shared by start + replay. Allowlist child env (not name-pattern scrub). Tier overrides via -c.
const CODEX_ENV_ALLOWLIST = ["PATH", "HOME", "SHELL", "TERM", "LANG", "LC_ALL", "USER", "TMPDIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "SSL_CERT_FILE", "NO_PROXY", "HTTP_PROXY", "HTTPS_PROXY"];
function allowlistEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(CODEX_ENV_ALLOWLIST.filter((envName) => env[envName] !== undefined).map((envName) => [envName, env[envName]]));
}

function makeCodexSessionFactory(log: ReturnType<typeof createLogger>) {
  return (tools: DynamicTool[], onEvent?: (agentEvent: import("./turn-runner/types").AgentEvent) => void, overrides?: { model?: string; effort?: string }) => {
    const flags = [overrides?.model ? `-c model=${JSON.stringify(overrides.model)}` : "", overrides?.effort ? `-c model_reasoning_effort=${JSON.stringify(overrides.effort)}` : ""]
      .filter(Boolean)
      .join(" ");
    const config = flags ? { ...DEFAULT_CODEX_CONFIG, command: `codex ${flags} app-server` } : DEFAULT_CODEX_CONFIG;
    return new AppServerSession(config, tools, onEvent ?? ((agentEvent) => {
      if (agentEvent.log) log.info("codex", { line: agentEvent.log });
    }), { scrubEnv: allowlistEnv });
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

function replayArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function replayShow(kind: string, detail: unknown): string {
  return `  ${kind}: ${JSON.stringify(detail)}`;
}

async function cmdReplay(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(REPLAY_HELP);
    return;
  }
  const snapshot = replayArg("db");
  const from = replayArg("from");
  const endTs = replayArg("to");
  if (!snapshot || !from || !endTs) {
    console.log(REPLAY_HELP);
    process.exit(1);
  }
  const { loadIncident, originalActions, rewindLedger } = await import("./replay/incident");
  const { runReplay } = await import("./replay/run");
  const { copyFileSync } = await import("node:fs");

  const workspace = replayArg("workspace") ?? "./replay-workspace";
  mkdirSync(workspace, { recursive: true });
  const copy = join(workspace, "replay.db");
  copyFileSync(snapshot, copy); // rewind is destructive — never open the snapshot itself
  const db = openLedger(copy);
  const store = makeStore();
  const log = createLogger();

  const venue = replayArg("venue");
  const events = loadIncident(db, { fromIso: from, toIso: endTs, ...(venue ? { venueId: venue } : {}) });
  if (events.length === 0) {
    console.error("no surface messages in that window");
    process.exit(1);
  }
  const original = originalActions(db, from, endTs);
  const rewound = rewindLedger(db, events[0]!.rowid, from);
  console.log(
    `rewound to ${from}: ${rewound.events} events, ${rewound.turns} turns, ${rewound.itemsDeleted}+${rewound.itemsReopened} attention items, ` +
      `${rewound.tasks} tasks, ${rewound.timers} timers cleared` +
      (rewound.memoriesInWindow ? ` (caveat: ${rewound.memoriesInWindow} memories written in-window stay — no edit history to rewind)` : ""),
  );
  console.log(`replaying ${events.length} messages at speed ${replayArg("speed") ?? "1"}…\n`);

  const captured = await runReplay({
    db,
    events,
    policyStore: store,
    sessionFactory: makeCodexSessionFactory(log),
    workspace,
    botPrincipalId: replayArg("bot-id") ?? process.env.SLACK_BOT_USER_ID ?? "UREPLAY",
    speed: Number(replayArg("speed") ?? "1"),
    logger: log,
  });

  console.log("\n=== originally ===");
  for (const turn of original) {
    for (const effect of turn.effects) {
      const kind = isRecord(effect) && typeof effect.kind === "string" ? effect.kind : "?";
      console.log(replayShow(kind, effect));
    }
  }
  console.log("\n=== in replay ===");
  for (const capture of captured) console.log(replayShow(capture.kind, capture.detail));
  db.close();
}

async function cmdDoctor(): Promise<void> {
  const codexOk = await codexReady();
  console.log(`${codexOk ? "ok      " : "MISSING "}codex logged in`);
  for (const envName of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_BOT_USER_ID"]) {
    console.log(`${process.env[envName] ? "ok      " : "MISSING "}${envName}`);
  }
  try {
    makeStore();
    console.log(`ok      policy validates (${policyPath()})`);
  } catch (error) {
    console.log(`MISSING policy — ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
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
    for (const identity of snap.identities) {
      console.log(
        `${identity.identityId}: ${identity.open} open, ${identity.running} running, ${identity.waitingHuman} waiting(human), ${identity.waitingTimer} waiting(timer), ${identity.parked} parked · $${identity.spendThisMonth.toFixed(2)} this month`,
      );
    }
    console.log(`timers: ${snap.timersDue} due, ${snap.timersPending} pending · global spend this month: $${snap.globalSpendThisMonth.toFixed(2)}`);
  }
  db.close();
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "";
  switch (cmd) {
    case "start":
      return cmdStart();
    case "doctor":
      return cmdDoctor();
    case "status":
      cmdStatus();
      return;
    case "replay":
      return cmdReplay();
    default:
      console.log(HELP);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
