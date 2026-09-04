#!/usr/bin/env bun
import { systemClock } from "./ledger/clock";
import { openLedger } from "./ledger/db";
import { mkdirSync, watchFile } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  dbReadTool,
  githubApiTool,
  linearGraphqlTool,
  notionApiTool,
  opsReadTool,
  slackApiTool,
} from "@bevyl-ai/agent-tools";
import { Service } from "./service";
import { createLogger } from "./log";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { MessageEvent } from "@slack/types";
import type { UsersListResponse } from "@slack/web-api";
import { loadPolicy } from "./policy";
import { makeCodexSessionFactory } from "./main-codex";

const HELP = `earshot — a Slack-resident agent with a durable task ledger.

usage:
  earshot start     run the daemon: connect to Slack, drive tasks via codex, survive restarts
  earshot doctor    check codex login, env vars, and that the policy file validates

config (env):
  EARSHOT_DB            ledger path                (default ./earshot.db)
  EARSHOT_POLICY        policy YAML path           (default ./policy.yaml)
  SLACK_BOT_TOKEN   xoxb-...                   (required for start)
  SLACK_APP_TOKEN   xapp-... (Socket Mode)     (required for start)
  SLACK_BOT_USER_ID U...                       (required for start)
`;

const dbPath = () => process.env.EARSHOT_DB ?? "./earshot.db";
const policyPath = () => process.env.EARSHOT_POLICY ?? "./policy.yaml";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

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

  const policy = loadPolicy(policyPath());

  const workspace = process.env.EARSHOT_WORKSPACE ?? join(homedir(), "earshot-workspace");
  mkdirSync(workspace, { recursive: true });

  const db = await openLedger(dbPath());
  const log = createLogger();
  const web = new WebClient(botToken);
  const names = new Map<string, string>();
  for await (const page of web.paginate("users.list", { limit: 200 })) {
    for (const member of (page as UsersListResponse).members ?? []) {
      const name = [member.profile?.display_name, member.profile?.real_name, member.name].find(
        Boolean,
      );
      if (member.id && name) names.set(member.id, name);
    }
  }

  const tools = [
    linearGraphqlTool(),
    githubApiTool(),
    notionApiTool(),
    opsReadTool(),
    dbReadTool(),
    slackApiTool(
      "slack_api",
      botToken,
      "Call a Slack Web API method as yourself with its documented arguments; the raw response comes back. Input: { method, args? }. conversations.replies { channel, ts } reads a thread beyond what you were shown; users.info { user } names an id. To send a file: files.getUploadURLExternal { filename, length }, POST the bytes to the upload_url from your shell, then files.completeUploadExternal { files: [{ id }], channel_id, thread_ts? }. Posting and reacting go through reply and react so your turn knows what it said.",
    ),
  ];

  const service = new Service({
    db,
    clock: systemClock,
    policy,
    web,
    nameOf: (id) => names.get(id) ?? null,
    botPrincipalId: botUserId,
    cwd: workspace,
    tools,
    sessionFactory: makeCodexSessionFactory(log),
    log,
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

  watchFile(policyPath(), { interval: 2000, persistent: false }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    try {
      service.policy = loadPolicy(policyPath());
      log.info("policy reloaded");
    } catch (error) {
      log.error("policy reload rejected — keeping last-known-good", { error: String(error) });
    }
  });

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("draining in-flight work", { signal: sig });
    void socket.disconnect();
    await service.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (error) => {
    log.error("unhandled rejection", { error: String(error) });
  });
}

async function cmdDoctor(): Promise<void> {
  const codexOk = await codexReady();
  console.log(`${codexOk ? "ok      " : "MISSING "}codex logged in`);
  for (const envName of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_BOT_USER_ID"]) {
    console.log(`${process.env[envName] ? "ok      " : "MISSING "}${envName}`);
  }
  try {
    loadPolicy(policyPath());
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
