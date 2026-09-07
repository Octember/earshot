#!/usr/bin/env bun
import "reflect-metadata";
import { container } from "tsyringe";
import { watchFile } from "node:fs";
import { SocketModeClient } from "@slack/socket-mode";
import type { MessageEvent } from "@slack/types";
import { log } from "./log";
import { POLICY, POLICY_PATH, loadPolicy } from "./policy";
import { Service } from "./service";

const HEARD_SUBTYPES = new Set<string | undefined>([
  undefined,
  "bot_message",
  "file_share",
  "thread_broadcast",
]);

const service = container.resolve(Service);
await service.start();

const socket = container.resolve(SocketModeClient);
socket.on("message", ({ event, ack }: { event: MessageEvent; ack: () => Promise<void> }) => {
  void ack();
  if (HEARD_SUBTYPES.has(event.subtype)) service.onInbound(event);
});
socket.on("error", (error: unknown) => {
  log.error("socket", { error: String(error) });
});
await socket.start();

const policyPath = container.resolve(POLICY_PATH);
watchFile(policyPath, { interval: 2000, persistent: false }, (curr, prev) => {
  if (curr.mtimeMs === prev.mtimeMs) return;
  try {
    Object.assign(container.resolve(POLICY), loadPolicy(policyPath));
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
  await container.dispose();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (error) => {
  log.error("unhandled rejection", { error: String(error) });
});
