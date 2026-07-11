// End-to-end continuity probe through the FULL service path with REAL codex — the honest test of
// "does a follow-up message remember the previous one?". Wires a Service with a capturing fake
// surface + the real AppServerSession, injects two addressed messages on the SAME anchor, and
// checks the second reply recalls a fact only stated in the first.
//   bun run scripts/selftest-service-continuity.ts
import { openLedger } from "../src/ledger/db";
import { systemClock } from "../src/ledger/clock";
import { PolicyStore, fileSource } from "../src/policy/load";
import { Service } from "../src/service";
import { createLogger } from "../src/log";
import { AppServerSession } from "@bevyl-ai/agent-tools";
import { DEFAULT_CODEX_CONFIG } from "../src/turn-runner/types";
import type { DynamicTool, AgentEvent } from "../src/turn-runner/types";
import type { SurfaceAdapter, PostResult, RawMessage } from "../src/adapter/types";

// A surface that captures posts instead of hitting Slack.
class CapturingAdapter implements SurfaceAdapter {
  posts: { venueId: string; threadRootTs: string | null; text: string }[] = [];
  private handlers: ((m: RawMessage) => void)[] = [];
  private n = 1;
  async start() {}
  stop() {}
  onMessage(h: (m: RawMessage) => void) { this.handlers.push(h); }
  emit(m: RawMessage) { for (const h of this.handlers) h(m); }
  async postMessage(venueId: string, threadRootTs: string | null, text: string): Promise<PostResult> {
    this.posts.push({ venueId, threadRootTs, text });
    return { messageId: String(this.n++) };
  }
  async updateMessage(_v: string, _m: string, _t: string) {}
  async addReaction() {}
  // Native streaming — replies come through here now, not postMessage.
  streams: { messageId: string; text: string }[] = [];
  async startStream(_v: string, _t: string, _r: string): Promise<{ messageId: string } | null> {
    const messageId = `strm-${this.n++}`;
    this.streams.push({ messageId, text: "" });
    return { messageId };
  }
  async appendStream(_v: string, messageId: string, delta: string) {
    const s = this.streams.find((x) => x.messageId === messageId);
    if (s) s.text += delta;
  }
  async stopStream() {}
  lastStreamText() { return this.streams.at(-1)?.text ?? ""; }
}

const botUserId = process.env.SLACK_BOT_USER_ID ?? "BOTX";
const db = openLedger(":memory:");
const store = new PolicyStore(fileSource(process.env.EARSHOT_POLICY ?? "./policy.yaml"), { knownTools: new Set(["audit_query", "read_channel"]) });
const adapter = new CapturingAdapter();
const log = createLogger();

let n = 0;
const service = new Service({
  db, clock: systemClock, policyStore: store, adapter,
  botPrincipalId: botUserId,
  cwd: process.env.EARSHOT_WORKSPACE ?? `${process.env.HOME}/earshot-workspace`,
  newId: () => `${Date.now().toString(36)}-${n++}`,
  sessionFactory: (tools: DynamicTool[], onEvent?: (e: AgentEvent) => void) => new AppServerSession(DEFAULT_CODEX_CONFIG, tools, onEvent ?? (() => {})),
  logger: log,
});

await service.start();

const ANCHOR = { venueId: "C_TEST", threadRootTs: "root-1" }; // one stable anchor for both messages
function inject(text: string, ts: string) {
  adapter.emit({
    venueId: ANCHOR.venueId, venueKind: "channel", principalId: "U_TESTER", isBot: false,
    text, ts, threadRootTs: ANCHOR.threadRootTs, mentionsBotId: true, deliveryId: `d-${ts}`,
  });
}

console.log("[svc-continuity] turn 1: stating a fact...");
inject(`<@${botUserId}> Remember this for later: the project codename is HALIBUT. Just reply 'got it'.`, "100.1");
await service.idle();
console.log(`[svc-continuity] reply 1: ${adapter.lastStreamText() || "(no reply)"}`);
adapter.streams.length = 0; // isolate turn 2's stream

console.log("[svc-continuity] turn 2: same thread, asking for the fact back...");
inject(`<@${botUserId}> What was the project codename I just gave you? Reply with only the word.`, "100.2");
await service.idle();
const reply2 = adapter.lastStreamText();
console.log(`[svc-continuity] reply 2: ${reply2}`);

const ok = /halibut/i.test(reply2);
console.log(`\n[svc-continuity] RESULT: ${ok ? "PASS — the follow-up remembered across turns" : "FAIL — no continuity through the service path"}`);
process.exit(ok ? 0 : 1);
