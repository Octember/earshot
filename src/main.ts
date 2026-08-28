#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { INTEGRATION_REGISTRIES, flattenRegistries } from "./tools/catalog";
import { slackRegistry } from "./tools/slack";
import { openLedger } from "./ledger/db";
import { systemClock } from "./ledger/clock";
import { PolicyValidationFailedError } from "./policy/load";
import { Service } from "./service";
import { createLogger } from "./log";
import { runtimeSnapshot } from "./status";
import { SlackAdapter } from "@bevyl-ai/agent-tools";
import { HELP, dbPath, makeStore, policyPath, requireEnv } from "./main-config";
import { makeCodexSessionFactory } from "./main-codex";
import { cmdReplay } from "./main-replay";

async function cmdStart(): Promise<void> {
  const botToken = requireEnv("SLACK_BOT_TOKEN");
  const appToken = requireEnv("SLACK_APP_TOKEN");
  const botUserId = requireEnv("SLACK_BOT_USER_ID");

  let store;
  try {
    store = makeStore();
  } catch (error) {
    if (error instanceof PolicyValidationFailedError) {
      console.error("policy validation failed:\n" + error.message);
      process.exit(1);
    }
    throw error;
  }

  const workspace = process.env.EARSHOT_WORKSPACE ?? join(homedir(), "earshot-workspace");
  mkdirSync(workspace, { recursive: true });

  const db = openLedger(dbPath());
  const clock = systemClock;
  const log = createLogger();
  const adapter = new SlackAdapter({ botToken, appToken, botUserId }, (line) => {
    log.info("slack", { line });
  });

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

  const statusPort = process.env.EARSHOT_STATUS_PORT
    ? Number(process.env.EARSHOT_STATUS_PORT)
    : null;
  if (statusPort) {
    Bun.serve({
      port: statusPort,
      fetch: () =>
        new Response(
          JSON.stringify(runtimeSnapshot(db, clock, store.current().budget.timezone), null, 2),
          { headers: { "content-type": "application/json" } },
        ),
    });
    log.info("status surface listening", { port: statusPort });
  }

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
    console.log(
      `MISSING policy — ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
  }
}

async function codexReady(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["codex", "login", "status"], { stdout: "pipe", stderr: "pipe" });
    return (await proc.exited) === 0;
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
    // no policy — UTC is fine for a read-only snapshot
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
    console.log(
      `timers: ${snap.timersDue} due, ${snap.timersPending} pending · global spend this month: $${snap.globalSpendThisMonth.toFixed(2)}`,
    );
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
