#!/usr/bin/env bun
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
import { log } from "./log";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { MessageEvent } from "@slack/types";
import type { UsersListResponse } from "@slack/web-api";
import { loadPolicy } from "./policy";

const HEARD_SUBTYPES = new Set<string | undefined>([
  undefined,
  "bot_message",
  "file_share",
  "thread_broadcast",
]);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

async function main(): Promise<void> {
  const botToken = requireEnv("SLACK_BOT_TOKEN");
  const appToken = requireEnv("SLACK_APP_TOKEN");
  const botUserId = requireEnv("SLACK_BOT_USER_ID");
  const policyPath = process.env.EARSHOT_POLICY ?? "./policy.yaml";
  const policy = loadPolicy(policyPath);

  const workspace = process.env.EARSHOT_WORKSPACE ?? join(homedir(), "earshot-workspace");
  mkdirSync(workspace, { recursive: true });

  const db = await openLedger(process.env.EARSHOT_DB ?? "./earshot.db");
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

  const service = new Service({
    db,
    policy,
    web,
    nameOf: (id) => names.get(id) ?? null,
    botPrincipalId: botUserId,
    cwd: workspace,
    tools: [
      linearGraphqlTool(),
      githubApiTool(),
      notionApiTool(),
      opsReadTool(),
      dbReadTool(),
      slackApiTool(
        "slack_api",
        botToken,
        "Any Slack Web API method with its documented arguments; raw response back. Posting and reacting go through reply and react.",
      ),
    ],
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

  watchFile(policyPath, { interval: 2000, persistent: false }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    try {
      service.policy = loadPolicy(policyPath);
      log.info("policy reloaded");
    } catch (error) {
      log.error("policy reload rejected — keeping last-known-good", { error: String(error) });
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("draining in-flight work", { signal });
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

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
