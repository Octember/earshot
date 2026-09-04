#!/usr/bin/env bun
import { systemClock } from "./ledger/clock";
import { openLedger } from "./ledger/db";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { INTEGRATION_REGISTRIES } from "./tools/catalog";
import { slackRegistry } from "./tools/slack-tools";
import { PolicyValidationFailedError } from "./policy/load";
import { Service } from "./service";
import { createLogger } from "./log";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { MessageEvent } from "@slack/types";
import type { UsersListResponse } from "@slack/web-api";
import { HELP, dbPath, makeStore, policyPath, requireEnv } from "./main-config";
import { makeCodexSessionFactory } from "./main-codex";

const HEARD_SUBTYPES = new Set<string | undefined>([
  undefined,
  "bot_message",
  "file_share",
  "thread_broadcast",
]);

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

  const db = await openLedger(dbPath());
  const clock = systemClock;
  const log = createLogger();
  const web = new WebClient(botToken);
  const auth = await web.auth.test();
  const workspaceUrl = (auth.url ?? "").replace(/\/$/, "");
  const permalink = (venueId: string, ts: string) =>
    `${workspaceUrl}/archives/${venueId}/p${ts.replace(".", "")}`;
  const names = new Map<string, string>();
  for await (const page of web.paginate("users.list", { limit: 200 })) {
    for (const member of (page as UsersListResponse).members ?? []) {
      const name = [member.profile?.display_name, member.profile?.real_name, member.name].find(
        Boolean,
      );
      if (member.id && name) names.set(member.id, name);
    }
  }

  const slack = slackRegistry({
    web,
    permalink,
    adminToken: process.env.SLACK_ADMIN_TOKEN,
    workspace,
  });
  const registries = [...INTEGRATION_REGISTRIES, slack];

  let counter = 0;
  const service = new Service({
    db,
    clock,
    policyStore: store,
    web,
    nameOf: (id) => names.get(id) ?? null,
    permalink,
    botPrincipalId: botUserId,
    cwd: workspace,
    registries,
    newId: () => `${Date.now().toString(36)}-${(counter++).toString(36)}`,
    sessionFactory: makeCodexSessionFactory(log),
    logger: log,
    heartbeatMs: 1000,
  });

  await service.start();
  const socket = new SocketModeClient({ appToken });
  socket.on("message", ({ event, ack }: { event: MessageEvent; ack: () => Promise<void> }) => {
    void ack();
    if (HEARD_SUBTYPES.has(event.subtype)) service.onInbound(event);
  });
  socket.on("error", (error: unknown) => {
    log.error("socket", { error: String(error) });
  });
  await socket.start();

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
    void socket.disconnect();
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

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "";
  switch (cmd) {
    case "start":
      return cmdStart();
    case "doctor":
      return cmdDoctor();
    default:
      console.log(HELP);
  }
}

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
