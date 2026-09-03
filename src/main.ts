#!/usr/bin/env bun
import type { Database } from "bun:sqlite";
import { and, count, eq, gt, isNull, lte, type SQL } from "drizzle-orm";
import { systemClock, type Clock } from "./ledger/clock";
import { openLedger, orm } from "./ledger/db";
import { executions, tasks, timers } from "./ledger/schema";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { INTEGRATION_REGISTRIES } from "./tools/catalog";
import { slackRegistry } from "./tools/slack-tools";
import { PolicyValidationFailedError } from "./policy/load";
import { Service } from "./service";
import { createLogger } from "./log";
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
    adapter,
    botToken,
    adminToken: process.env.SLACK_ADMIN_TOKEN,
    workspace,
  });
  const registries = [...INTEGRATION_REGISTRIES, slack];

  let counter = 0;
  const service = new Service({
    db,
    clock,
    policyStore: store,
    adapter,
    botPrincipalId: botUserId,
    cwd: workspace,
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
        new Response(JSON.stringify(runtimeSnapshot(db, clock), null, 2), {
          headers: { "content-type": "application/json" },
        }),
    });
    log.info("status surface listening", { port: statusPort });
  }

  try {
    const { watchFile } = await import("node:fs");
    watchFile(policyPath(), { interval: 2000, persistent: false }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) service.reloadPolicy();
    });
  } catch {}

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
  const snap = runtimeSnapshot(db, systemClock);

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
        `${identity.identityId}: ${identity.open} open, ${identity.running} running, ${identity.waitingHuman} waiting(human), ${identity.waitingTimer} waiting(timer), ${identity.parked} parked`,
      );
    }
    console.log(`timers: ${snap.timersDue} due, ${snap.timersPending} pending`);
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

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });

function taskCount(db: Database, identityId: string, ...conds: SQL[]): number {
  return (
    orm(db)
      .select({ c: count() })
      .from(tasks)
      .where(and(eq(tasks.identityId, identityId), ...conds))
      .get()?.c ?? 0
  );
}

export function runtimeSnapshot(db: Database, clock: Clock) {
  const now = clock();
  const idRows = orm(db)
    .selectDistinct({ identityId: tasks.identityId })
    .from(tasks)
    .orderBy(tasks.identityId)
    .all();

  const identities = idRows.map(({ identityId }) => ({
    identityId,
    open: taskCount(db, identityId, eq(tasks.status, "open")),
    active: taskCount(db, identityId, eq(tasks.status, "active")),
    running:
      orm(db)
        .select({ c: count() })
        .from(executions)
        .innerJoin(tasks, eq(tasks.id, executions.taskId))
        .where(and(eq(executions.status, "running"), eq(tasks.identityId, identityId)))
        .get()?.c ?? 0,
    waitingHuman: taskCount(
      db,
      identityId,
      eq(tasks.status, "waiting"),
      eq(tasks.waitingOn, "human"),
    ),
    waitingTimer: taskCount(
      db,
      identityId,
      eq(tasks.status, "waiting"),
      eq(tasks.waitingOn, "timer"),
    ),
    parked: taskCount(db, identityId, eq(tasks.status, "parked")),
  }));

  const timersDue =
    orm(db)
      .select({ c: count() })
      .from(timers)
      .where(and(isNull(timers.firedAt), lte(timers.dueAt, now)))
      .get()?.c ?? 0;
  const timersPending =
    orm(db)
      .select({ c: count() })
      .from(timers)
      .where(and(isNull(timers.firedAt), gt(timers.dueAt, now)))
      .get()?.c ?? 0;

  return {
    at: now,
    identities,
    timersDue,
    timersPending,
  };
}
