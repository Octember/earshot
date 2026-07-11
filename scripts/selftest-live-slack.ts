// The definitive end-to-end: REAL SlackAdapter + REAL codex + the full Service. Posts a parent
// message to a channel, injects an addressed mention in its thread, and lets the service stream the
// reply LIVE into that thread via chat.startStream — exactly what a real @mention does. You should
// see the reply stream in, in the channel.
//   EARSHOT_TEST_CHANNEL=C... EARSHOT_TEST_RECIPIENT=U... bun run scripts/selftest-live-slack.ts
import { openLedger } from "../src/ledger/db";
import { integrationCatalog, INTEGRATION_TOOL_NAMES } from "../src/tools/catalog";
import { systemClock } from "../src/ledger/clock";
import { PolicyStore, fileSource } from "../src/policy/load";
import { Service } from "../src/service";
import { createLogger } from "../src/log";
import { SlackAdapter } from "@bevyl-ai/agent-tools";
import { AppServerSession } from "@bevyl-ai/agent-tools";
import { DEFAULT_CODEX_CONFIG } from "../src/turn-runner/types";
import type { DynamicTool, AgentEvent } from "../src/turn-runner/types";

const CH = process.env.EARSHOT_TEST_CHANNEL!;
const RECIPIENT = process.env.EARSHOT_TEST_RECIPIENT!;
const botToken = process.env.SLACK_BOT_TOKEN!;
const appToken = process.env.SLACK_APP_TOKEN!;
const botUserId = process.env.SLACK_BOT_USER_ID!;

const db = openLedger(":memory:");
const store = new PolicyStore(fileSource(process.env.EARSHOT_POLICY ?? "./policy.yaml"), { knownTools: new Set(["audit_query", "read_channel", ...INTEGRATION_TOOL_NAMES]) });
const adapter = new SlackAdapter({ botToken, appToken, botUserId }, (l) => console.log("[slack]", l));
let n = 0;
const service = new Service({
  db, clock: systemClock, policyStore: store, adapter, botPrincipalId: botUserId,
  cwd: process.env.EARSHOT_WORKSPACE ?? `${process.env.HOME}/earshot-workspace`,
  newId: () => `${Date.now().toString(36)}-${n++}`,
  sessionFactory: (tools: DynamicTool[], onEvent?: (e: AgentEvent) => void) => new AppServerSession(DEFAULT_CODEX_CONFIG, tools, onEvent ?? (() => {})),
  logger: createLogger(),
  // Same external-tool catalog main.ts wires — without it, granted tools have no implementation.
  catalog: {
    read_channel: {
      run: async (args: unknown) => {
        const a = (args ?? {}) as { channel?: string; limit?: number };
        if (!a.channel) return { success: false, output: "read_channel needs a { channel }" };
        try {
          const msgs = await adapter.readHistory(a.channel, Math.min(a.limit ?? 20, 100));
          return { success: true, output: JSON.stringify(msgs) };
        } catch (e) {
          return { success: false, output: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    ...integrationCatalog(),
  },
});

await service.start(); // connects sockets + caches team_id via auth.test
await new Promise((r) => setTimeout(r, 1500)); // let auth.test land the team id

const parent = await adapter.postMessage(CH, null, "🧪 live end-to-end streaming test — reply streams below 👇");
console.log("[e2e] parent ts:", parent.messageId);

console.log("[e2e] injecting an addressed mention in that thread; expect: shimmer → task card → streamed answer...");
service.ingest({
  venueId: CH, venueKind: "channel", principalId: RECIPIENT, isBot: false,
  text: process.env.EARSHOT_TEST_PROMPT ?? `<@${botUserId}> first call the task_query tool to check your open tasks, then tell me in one short sentence what makes streaming replies feel good.`,
  ts: parent.messageId, threadRootTs: parent.messageId, mentionsBotId: true, deliveryId: `e2e-${parent.messageId}`,
});
await service.idle();

console.log("[e2e] done — check the thread in Slack. Draining...");
await service.stop();
process.exit(0);
