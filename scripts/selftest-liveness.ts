// Proves the liveness placeholder end-to-end with REAL codex: inject one addressed message through
// the full service, and print the exact sequence a Slack surface would see — an instant "…on it…"
// post, then chat.update's into the real reply. No Slack workspace needed.
//   bun run scripts/selftest-liveness.ts
import { openLedger } from "../src/ledger/db";
import { systemClock } from "../src/ledger/clock";
import { PolicyStore, fileSource } from "../src/policy/load";
import { Service } from "../src/service";
import { createLogger } from "../src/log";
import { AppServerSession } from "../src/turn-runner/app-server";
import type { DynamicTool, AgentEvent } from "../src/turn-runner/types";
import type { SurfaceAdapter, PostResult, RawMessage } from "../src/adapter/types";

class CapturingAdapter implements SurfaceAdapter {
  events: string[] = [];
  private handlers: ((m: RawMessage) => void)[] = [];
  private n = 1;
  async start() {}
  stop() {}
  onMessage(h: (m: RawMessage) => void) { this.handlers.push(h); }
  emit(m: RawMessage) { for (const h of this.handlers) h(m); }
  async postMessage(_v: string, _t: string | null, text: string): Promise<PostResult> {
    this.events.push(`POST    → ${JSON.stringify(text)}`);
    return { messageId: String(this.n++) };
  }
  async updateMessage(_v: string, id: string, text: string) { this.events.push(`EDIT #${id} → ${JSON.stringify(text)}`); }
  async addReaction() {}
  async setTypingStatus(_v: string, _t: string | null, status: string) { this.events.push(`STATUS  → ${JSON.stringify(status)}`); }
}

const botUserId = process.env.SLACK_BOT_USER_ID ?? "BOTX";
const db = openLedger(":memory:");
const store = new PolicyStore(fileSource(process.env.TAG_POLICY ?? "./policy.yaml"), { knownTools: new Set(["audit_query", "read_channel"]) });
const adapter = new CapturingAdapter();
let n = 0;
const service = new Service({
  db, clock: systemClock, policyStore: store, adapter, botPrincipalId: botUserId,
  cwd: process.env.TAG_WORKSPACE ?? `${process.env.HOME}/tag-workspace`,
  newId: () => `${Date.now().toString(36)}-${n++}`,
  sessionFactory: (tools: DynamicTool[], onEvent?: (e: AgentEvent) => void) => new AppServerSession(tools, onEvent ?? (() => {})),
  logger: createLogger(),
});

await service.start();
adapter.events.length = 0; // ignore startup noise

console.log("[liveness] injecting one addressed message...");
adapter.emit({
  venueId: "C_TEST", venueKind: "channel", principalId: "U_TESTER", isBot: false,
  text: `<@${botUserId}> what's 2+2? one word.`, ts: "1.0", threadRootTs: "root-1", mentionsBotId: true, deliveryId: "d1",
});
await service.idle();

console.log("\n[liveness] what Slack would have seen, in order:");
for (const e of adapter.events) console.log("  " + e);

const first = adapter.events.find((e) => e.startsWith("POST"));
const placeholderFirst = first?.includes("on it");
console.log(`\n[liveness] RESULT: ${placeholderFirst ? "PASS — instant placeholder shown before the reply landed" : "FAIL — no placeholder before the reply"}`);
process.exit(placeholderFirst ? 0 : 1);
