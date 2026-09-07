#!/usr/bin/env bun
import "reflect-metadata";
import { container } from "tsyringe";
import { watchFile } from "node:fs";
import { SocketModeClient } from "@slack/socket-mode";
import type { MessageEvent } from "@slack/types";
import { Earshot } from "./earshot";
import { log } from "./log";
import { POLICY, POLICY_PATH, loadPolicy } from "./policy";

const earshot = container.resolve(Earshot);
await earshot.start();

const socket = container.resolve(SocketModeClient);
socket.on("message", ({ event, ack }: { event: MessageEvent; ack: () => Promise<void> }) => {
  void ack();
  earshot.onInbound(event);
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

for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    log.info("service stopped", { signal });
    process.exit(0);
  });
process.on("unhandledRejection", (error) => {
  log.error("unhandled rejection", { error: String(error) });
});
