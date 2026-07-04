// Proves the liveness placeholder end-to-end with REAL codex: inject one addressed message through
// the full service, and print the exact sequence a Slack surface would see — an instant "…on it…"
// post, then chat.update's into the real reply. No Slack workspace needed.
//   bun run scripts/selftest-liveness.ts
import { openLedger } from "../src/ledger/db";
import { systemClock } from "../src/ledger/clock";
import { PolicyStore, fileSource } from "../src/policy/load";
import { Service } from "../src/service";
import { createLogger } from "../src/log";
import { AppServerSession } from "@bevyl/agent-kit";
import { DEFAULT_CODEX_CONFIG } from "../src/turn-runner/types";
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
    this.events.push(`POST      → ${JSON.stringify(text)}`);
    return { messageId: String(this.n++) };
  }
  async updateMessage(_v: string, id: string, text: string) { this.events.push(`EDIT #${id} → ${JSON.stringify(text)}`); }
  async addReaction() {}
  // Native streaming — the one reply path.
  async startStream(_v: string, threadTs: string, recipient: string): Promise<{ messageId: string } | null> {
    const id = `strm-${this.n++}`;
    this.events.push(`START     → thread=${threadTs} recipient=${recipient} (${id})`);
    return { messageId: id };
  }
  async appendStream(_v: string, id: string, delta: string) { this.events.push(`APPEND ${id} → ${JSON.stringify(delta)}`); }
  async stopStream(_v: string, id: string) { this.events.push(`STOP  ${id}`); }
}

const botUserId = process.env.SLACK_BOT_USER_ID ?? "BOTX";
const db = openLedger(":memory:");
const store = new PolicyStore(fileSource(process.env.EARSHOT_POLICY ?? "./policy.yaml"), { knownTools: new Set(["audit_query", "read_channel"]) });
const adapter = new CapturingAdapter();
let n = 0;
const service = new Service({
  db, clock: systemClock, policyStore: store, adapter, botPrincipalId: botUserId,
  cwd: process.env.EARSHOT_WORKSPACE ?? `${process.env.HOME}/earshot-workspace`,
  newId: () => `${Date.now().toString(36)}-${n++}`,
  sessionFactory: (tools: DynamicTool[], onEvent?: (e: AgentEvent) => void) => new AppServerSession(DEFAULT_CODEX_CONFIG, tools, onEvent ?? (() => {})),
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

console.log("\n[liveness] native Slack streaming API calls, in order:");
for (const e of adapter.events) console.log("  " + e);

const startedFirst = adapter.events[0]?.startsWith("START");
const appended = adapter.events.some((e) => e.startsWith("APPEND"));
const stopped = adapter.events.some((e) => e.startsWith("STOP"));
const ok = startedFirst && appended && stopped;
console.log(`\n[liveness] RESULT: ${ok ? "PASS — stream started up front, tokens appended live, stream closed" : "FAIL — stream sequence incomplete"}`);
process.exit(ok ? 0 : 1);
