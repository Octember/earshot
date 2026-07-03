// Self-test: drive the FULL inbound pipeline (router → interactive turn → real codex → streaming
// reply) with a synthetic message, posting to a real Slack channel — so the streaming reply can be
// verified without a human sending anything. Uses the real SlackAdapter for outbound (HTTP only;
// the socket is never started, so it won't compete with the running daemon).
//   bun run scripts/selftest-slack.ts <channelId> "<message text>"
import { openLedger } from "../src/ledger/db";
import { systemClock } from "../src/ledger/clock";
import { PolicyStore, fileSource } from "../src/policy/load";
import { Service } from "../src/service";
import { createLogger } from "../src/log";
import { SlackAdapter } from "../src/adapter/slack";
import { AppServerSession } from "../src/turn-runner/app-server";
import type { DynamicTool } from "../src/turn-runner/types";
import type { RawMessage } from "../src/adapter/types";

const channel = process.argv[2];
const text = process.argv[3] ?? "write a two-line haiku about a helpful slack bot";
if (!channel) {
  console.error("usage: bun run scripts/selftest-slack.ts <channelId> \"<message>\"");
  process.exit(1);
}

const botToken = process.env.SLACK_BOT_TOKEN!;
const appToken = process.env.SLACK_APP_TOKEN!;
const botUserId = process.env.SLACK_BOT_USER_ID!;

const db = openLedger(":memory:");
const clock = systemClock;
const log = createLogger();
const store = new PolicyStore(fileSource(process.env.TAG_POLICY ?? "./policy.yaml"), { knownTools: new Set(["audit_query", "read_channel"]) });
const adapter = new SlackAdapter({ botToken, appToken, botUserId }, (l) => log.info("slack", { line: l }));

const catalog = {
  read_channel: {
    run: async (args: unknown) => {
      const a = (args ?? {}) as { channel?: string; limit?: number };
      if (!a.channel) return { success: false, output: "read_channel needs a { channel }" };
      try {
        return { success: true, output: JSON.stringify(await adapter.readHistory(a.channel, Math.min(a.limit ?? 20, 100))) };
      } catch (e) {
        return { success: false, output: e instanceof Error ? e.message : String(e) };
      }
    },
  },
};

let n = 0;
const service = new Service({
  db,
  clock,
  policyStore: store,
  adapter,
  botPrincipalId: botUserId,
  cwd: process.env.TAG_WORKSPACE ?? require("path").join(require("os").homedir(), "tag-workspace"),
  catalog,
  newId: () => `${Date.now().toString(36)}-${n++}`,
  sessionFactory: (tools: DynamicTool[], onEvent) => new AppServerSession(tools, onEvent ?? (() => {})),
  logger: log,
  // no heartbeatMs — we only exercise the interactive path; no adapter.start() so no socket.
});

const msg: RawMessage = {
  venueId: channel,
  venueKind: "channel",
  principalId: "U_SELFTEST",
  isBot: false,
  text: `<@${botUserId}> ${text}`,
  ts: `${Date.now() / 1000}`,
  threadRootTs: null,
  mentionsBotId: true,
  deliveryId: `selftest-${Date.now()}`,
};

console.log(`[selftest] injecting into ${channel}: "${text}"`);
service.ingest(msg);
await service.idle();
console.log("[selftest] done — check the channel for the streamed reply.");
process.exit(0);
