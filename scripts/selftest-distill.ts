// Self-test for distillation: inject an OBSERVED (non-mention) message, force a distillation
// sweep, and print the resulting memory — proving observed chatter becomes durable memory via a
// real codex distillation turn. No socket, no human needed.
//   bun run scripts/selftest-distill.ts
import { openLedger } from "../src/ledger/db";
import { systemClock } from "../src/ledger/clock";
import { PolicyStore, fileSource } from "../src/policy/load";
import { queryMemory } from "../src/ledger/memory";
import { Service } from "../src/service";
import { createLogger } from "../src/log";
import { SlackAdapter } from "../src/adapter/slack";
import { AppServerSession } from "../src/turn-runner/app-server";
import type { DynamicTool } from "../src/turn-runner/types";

const botToken = process.env.SLACK_BOT_TOKEN!;
const appToken = process.env.SLACK_APP_TOKEN!;
const botUserId = process.env.SLACK_BOT_USER_ID!;

const db = openLedger(":memory:");
const clock = systemClock;
const log = createLogger();
const store = new PolicyStore(fileSource(process.env.TAG_POLICY ?? "./policy.yaml"), { knownTools: new Set(["audit_query", "read_channel"]) });
const adapter = new SlackAdapter({ botToken, appToken, botUserId }, () => {});

let n = 0;
const service = new Service({
  db,
  clock,
  policyStore: store,
  adapter,
  botPrincipalId: botUserId,
  cwd: process.env.TAG_WORKSPACE ?? require("path").join(require("os").homedir(), "tag-workspace"),
  newId: () => `${Date.now().toString(36)}-${n++}`,
  sessionFactory: (tools: DynamicTool[], onEvent) => new AppServerSession(tools, onEvent ?? (() => {})),
  logger: log,
});

const identityId = store.current().identities[0]!.id;

// Inject two observed (non-mention) messages, as if overheard in a channel the bot is in.
for (const [i, text] of [
  "heads up: the staging deploy pipeline uses GitHub Actions and takes about 8 minutes",
  "reminder, Priya owns the billing service and prefers PRs under 400 lines",
].entries()) {
  service.ingest({
    venueId: "C_OBSERVED",
    venueKind: "channel",
    principalId: "U_TEAM",
    isBot: false,
    text,
    ts: `${Date.now() / 1000 + i}`,
    threadRootTs: null,
    mentionsBotId: false,
    deliveryId: `obs-${Date.now()}-${i}`,
  });
}

console.log("[distill] injected 2 observed messages; forcing a distillation sweep...");
service.distillNow(identityId);
await service.idle();

const mem = queryMemory(db, identityId);
console.log(`[distill] memory now has ${mem.length} item(s):`);
for (const m of mem) console.log(`  • ${m.content}`);
process.exit(0);
