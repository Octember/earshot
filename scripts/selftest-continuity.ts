// Direct probe of codex thread continuity — the mechanism behind interactive resume. Proves (or
// disproves) that a codex thread resumed in a FRESH app-server process still carries the prior
// conversation, exactly as the service relies on. No Slack, no ledger — just the runtime.
//   bun run scripts/selftest-continuity.ts
import { AppServerSession } from "@bevyl/agent-kit";
import { DEFAULT_CODEX_CONFIG } from "../src/turn-runner/types";
import type { AgentEvent } from "../src/turn-runner/types";

const cwd = process.env.EARSHOT_WORKSPACE ?? `${process.env.HOME}/earshot-workspace`;

// Capture the agent's final message the way service.runInteractiveTurn does: codex answers via its
// agent message, surfaced as an e.log line starting with "● " (final) and/or e.stream deltas.
function capture(): { onEvent: (e: AgentEvent) => void; text: () => string } {
  let text = "";
  return {
    onEvent: (e: AgentEvent) => {
      if (typeof e.stream === "string" && e.stream.trim()) text = e.stream;
      if (e.log && e.log.startsWith("● ")) text = e.log.slice(2).trim();
    },
    text: () => text,
  };
}

async function runOne(threadId: string | null, prompt: string): Promise<{ threadId: string; reply: string }> {
  const cap = capture();
  const session = new AppServerSession(DEFAULT_CODEX_CONFIG, [], cap.onEvent);
  await session.start(cwd);
  const id = threadId ? await session.resumeThread(threadId) : await session.startThread(cwd);
  await session.runTurn(id, cwd, prompt, "continuity-probe");
  // give any trailing final-message event a tick to land before we kill the process
  await new Promise((r) => setTimeout(r, 250));
  const reply = cap.text();
  session.stop();
  return { threadId: id, reply };
}

console.log(`[continuity] cwd=${cwd}`);
const first = await runOne(null, "Remember this: the magic word is BANANA. Reply with just 'ok'.");
console.log(`[continuity] turn 1 thread=${first.threadId}`);
console.log(`[continuity] turn 1 reply: ${first.reply}`);

console.log("[continuity] --- fresh process, resuming the same thread ---");
const second = await runOne(first.threadId, "What is the magic word I told you a moment ago? Reply with just the word.");
console.log(`[continuity] turn 2 reply: ${second.reply}`);

const remembered = /banana/i.test(second.reply);
console.log(`\n[continuity] RESULT: ${remembered ? "PASS — codex resumed the conversation" : "FAIL — context did NOT carry across processes"}`);
process.exit(remembered ? 0 : 1);
