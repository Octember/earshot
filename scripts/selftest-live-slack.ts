// The definitive end-to-end: REAL SlackAdapter + REAL codex + the full Service. Posts a parent
// message to a channel, injects an addressed mention in its thread, and lets the service stream the
// reply LIVE into that thread via chat.startStream — exactly what a real @mention does. You should
// see the reply stream in, in the channel.
//   TAG_TEST_CHANNEL=C... TAG_TEST_RECIPIENT=U... bun run scripts/selftest-live-slack.ts
import { openLedger } from "../src/ledger/db";
import { systemClock } from "../src/ledger/clock";
import { PolicyStore, fileSource } from "../src/policy/load";
import { Service } from "../src/service";
import { createLogger } from "../src/log";
import { SlackAdapter } from "../src/adapter/slack";
import { AppServerSession } from "../src/turn-runner/app-server";
import type { DynamicTool, AgentEvent } from "../src/turn-runner/types";

const CH = process.env.TAG_TEST_CHANNEL!;
const RECIPIENT = process.env.TAG_TEST_RECIPIENT!;
const botToken = process.env.SLACK_BOT_TOKEN!;
const appToken = process.env.SLACK_APP_TOKEN!;
const botUserId = process.env.SLACK_BOT_USER_ID!;

const db = openLedger(":memory:");
const store = new PolicyStore(fileSource(process.env.TAG_POLICY ?? "./policy.yaml"), { knownTools: new Set(["audit_query", "read_channel"]) });
const adapter = new SlackAdapter({ botToken, appToken, botUserId }, (l) => console.log("[slack]", l));
let n = 0;
const service = new Service({
  db, clock: systemClock, policyStore: store, adapter, botPrincipalId: botUserId,
  cwd: process.env.TAG_WORKSPACE ?? `${process.env.HOME}/tag-workspace`,
  newId: () => `${Date.now().toString(36)}-${n++}`,
  sessionFactory: (tools: DynamicTool[], onEvent?: (e: AgentEvent) => void) => new AppServerSession(tools, onEvent ?? (() => {})),
  logger: createLogger(),
});

await service.start(); // connects sockets + caches team_id via auth.test
await new Promise((r) => setTimeout(r, 1500)); // let auth.test land the team id

const parent = await adapter.postMessage(CH, null, "🧪 live end-to-end streaming test — reply streams below 👇");
console.log("[e2e] parent ts:", parent.messageId);

console.log("[e2e] injecting an addressed mention in that thread; expect: shimmer → task card → streamed answer...");
service.ingest({
  venueId: CH, venueKind: "channel", principalId: RECIPIENT, isBot: false,
  text: process.env.TAG_TEST_PROMPT ?? `<@${botUserId}> first call the task_query tool to check your open tasks, then tell me in one short sentence what makes streaming replies feel good.`,
  ts: parent.messageId, threadRootTs: parent.messageId, mentionsBotId: true, deliveryId: `e2e-${parent.messageId}`,
});
await service.idle();

console.log("[e2e] done — check the thread in Slack. Draining...");
await service.stop();
process.exit(0);
