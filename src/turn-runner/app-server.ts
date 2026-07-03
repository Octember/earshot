// SPEC §11 — Turn Runner / Agent Runtime Integration. Minimal client for the Codex app-server
// JSON-RPC stream over stdio (newline-delimited JSON, not Content-Length). Adapted from bunion's
// AppServerSession (~/dev/bunion/src/codex/app-server.ts) — same protocol, stripped of
// bunion-specific concerns (remote ssh workers, Linear/github tools): tag is one process with no
// remote workers (CLAUDE.md non-negotiable #2).
import { spawn, type ChildProcess } from "node:child_process";
import { CategorizedError, DEFAULT_CODEX_CONFIG, type AgentEvent, type AgentRuntimeSession, type CodexConfig, type DynamicTool } from "./types";

const MAX_LINE_BYTES = 10 * 1024 * 1024; // cap line accumulation so a monster line never OOMs the process

type Json = Record<string, unknown>;
interface Pending {
  resolve: (v: Json) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AppServerSession implements AgentRuntimeSession {
  private cfg: CodexConfig;
  private tools: Map<string, DynamicTool>;
  private onEvent: (e: AgentEvent) => void;
  private msgBuf = new Map<string, string>();
  private proc: ChildProcess | null = null;
  private buf = "";
  private nextId = 100;
  private pending = new Map<number, Pending>();
  private turn: { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private fatal: Error | null = null;
  private lastActivityAt = 0;

  constructor(tools: DynamicTool[], onEvent: (e: AgentEvent) => void = () => {}, cfg: Partial<CodexConfig> = {}) {
    this.cfg = { ...DEFAULT_CODEX_CONFIG, ...cfg };
    this.tools = new Map(tools.map((t) => [t.spec.name, t]));
    this.onEvent = onEvent;
  }

  // Wall-clock ms since the last JSON-RPC activity (message sent or received). SPEC §6.3's
  // stall_timeout_ms is about NO activity, distinct from turnTimeoutMs (total turn duration).
  msSinceLastActivity(now: number = Date.now()): number {
    return now - this.lastActivityAt;
  }

  async start(cwd: string): Promise<void> {
    // Scrub secrets from the environment codex inherits — otherwise a prompt-injected turn could
    // `echo $SLACK_BOT_TOKEN` and exfiltrate credentials. The daemon still holds them in its own
    // process env; the codex child just doesn't. (SPEC §10.6: secrets never in turn context.)
    const proc = spawn("bash", ["-lc", this.cfg.command], { cwd, env: scrubSecrets(process.env), stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stdout?.on("data", (d: Buffer) => this.onData(d));
    proc.stderr?.on("data", (d: Buffer) => this.onStderr(d));
    proc.on("exit", (code, signal) => {
      const err =
        code === 0 && !signal
          ? new CategorizedError("codex_clean_exit", "codex app-server exited (0)")
          : new CategorizedError("port_exit", `codex app-server exited (${code ?? signal})`);
      this.failAll(err);
    });
    proc.on("error", (e) => {
      const isMissing = (e as NodeJS.ErrnoException).code === "ENOENT";
      this.failAll(new CategorizedError(isMissing ? "codex_not_found" : "port_exit", e.message));
    });

    try {
      await this.request(
        "initialize",
        { capabilities: { experimentalApi: true }, clientInfo: { name: "tag", title: "tag", version: "0.1.0" } },
        this.cfg.initTimeoutMs,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!(e instanceof CategorizedError) && msg.includes("timed out")) throw new CategorizedError("response_timeout", msg);
      throw e;
    }
    this.notify("initialized", {});
    this.onEvent({ event: "session_started", ts: new Date().toISOString() });
  }

  async startThread(cwd: string): Promise<string> {
    const res = await this.request(
      "thread/start",
      { approvalPolicy: this.cfg.approvalPolicy, sandbox: this.cfg.threadSandbox, cwd, dynamicTools: [...this.tools.values()].map((t) => t.spec) },
      this.cfg.initTimeoutMs,
    );
    const id = (res.thread as Json | undefined)?.id;
    if (typeof id !== "string") throw new CategorizedError("invalid_workspace_cwd", "thread/start: missing thread id");
    return id;
  }

  async resumeThread(threadId: string): Promise<string> {
    const res = await this.request("thread/resume", { threadId }, this.cfg.initTimeoutMs);
    const id = (res.thread as Json | undefined)?.id;
    if (typeof id !== "string") throw new CategorizedError("invalid_workspace_cwd", "thread/resume: missing thread id");
    return id;
  }

  async runTurn(threadId: string, cwd: string, prompt: string, title: string): Promise<void> {
    if (this.fatal) throw this.fatal;
    const turnDone = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turn = null;
        reject(new CategorizedError("turn_timeout", "turn timeout"));
      }, this.cfg.turnTimeoutMs);
      this.turn = {
        resolve: () => {
          clearTimeout(timer);
          this.turn = null;
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          this.turn = null;
          reject(e);
        },
        timer,
      };
    });
    try {
      const res = await this.request(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: prompt }],
          cwd,
          title,
          approvalPolicy: this.cfg.approvalPolicy,
          sandboxPolicy: this.cfg.turnSandboxPolicy ?? DEFAULT_TURN_POLICY,
        },
        this.cfg.turnTimeoutMs,
      );
      const turnId = String((res.turn as Json | undefined)?.id ?? res.id ?? "");
      if (turnId) this.onEvent({ turnId, ts: new Date().toISOString() });
    } catch (e) {
      const t = this.turn;
      this.turn = null;
      if (t) clearTimeout(t.timer);
      throw e;
    }
    await turnDone;
  }

  stop(): void {
    try {
      this.proc?.kill("SIGKILL");
    } catch {
      // already gone
    }
  }

  // --- internals ---
  private markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  private request(method: string, params: Json, timeoutMs = this.cfg.readTimeoutMs): Promise<Json> {
    if (this.fatal) return Promise.reject(this.fatal);
    const id = this.nextId++;
    const p = new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.send({ method, id, params });
    return p;
  }

  private notify(method: string, params: Json): void {
    this.send({ method, params });
  }

  private send(msg: Json): void {
    this.markActivity();
    try {
      this.proc?.stdin?.write(JSON.stringify(msg) + "\n");
    } catch {
      // pipe closed; the exit handler will surface the fatal
    }
  }

  private onStderr(d: Buffer): void {
    for (const line of d.toString("utf8").split("\n")) {
      const t = line.trim();
      if (t) this.onEvent({ log: `[stderr] ${t}` });
    }
  }

  private onData(d: Buffer): void {
    this.markActivity();
    this.buf += d.toString("utf8");
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const t = line.trim();
      if (!t) continue;
      let msg: Json;
      try {
        msg = JSON.parse(t) as Json;
      } catch {
        continue; // partial / non-JSON line
      }
      this.handle(msg);
    }
    if (this.buf.length > MAX_LINE_BYTES) {
      this.onEvent({ log: `[warn] app-server line buffer exceeded ${MAX_LINE_BYTES} bytes — dropping` });
      this.buf = "";
    }
  }

  private handle(msg: Json): void {
    const method = typeof msg.method === "string" ? msg.method : null;
    const id = typeof msg.id === "number" ? msg.id : null;

    if (method && id !== null) {
      void this.handleServerRequest(method, id, obj(msg.params));
      return;
    }
    if (method) {
      this.handleNotification(method, obj(msg.params));
      return;
    }
    if (id !== null) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if ("error" in msg) p.reject(new Error(`rpc error: ${JSON.stringify(msg.error)}`));
      else p.resolve(obj(msg.result));
    }
  }

  private async handleServerRequest(method: string, id: number, params: Json): Promise<void> {
    if (method === "item/tool/call") {
      await this.handleToolCall(id, params);
      return;
    }
    const decision = autoApprove(method);
    if (decision) {
      this.onEvent({ event: "approval_auto_approved", ts: new Date().toISOString(), log: `auto-approved: ${method}` });
      this.reply(id, { decision });
      return;
    }
    if (method === "item/tool/requestUserInput") {
      this.reply(id, { answers: answerUserInput(params) });
      return;
    }
    this.reply(id, {});
  }

  private async handleToolCall(id: number, params: Json): Promise<void> {
    const name = typeof params.tool === "string" ? params.tool : typeof params.name === "string" ? params.name : "";
    this.onEvent({ label: "calling a tool", log: `⚙ ${name}` });
    const tool = this.tools.get(name);
    if (!tool) {
      this.onEvent({ event: "unsupported_tool_call", ts: new Date().toISOString(), log: `unsupported tool: ${name}` });
      this.reply(id, toolResult(false, `Unsupported dynamic tool: ${name}`));
      return;
    }
    try {
      const r = await tool.run(params.arguments ?? {});
      this.reply(id, toolResult(r.success, r.output));
    } catch (e) {
      this.reply(id, toolResult(false, e instanceof Error ? e.message : String(e)));
    }
  }

  private handleNotification(method: string, params: Json): void {
    if (method === "turn/completed") {
      this.onEvent({ event: "turn_completed", ts: new Date().toISOString() });
      return void this.turn?.resolve();
    }
    if (method === "turn/failed") {
      this.onEvent({ event: "turn_failed", ts: new Date().toISOString() });
      return void this.turn?.reject(new CategorizedError("turn_failed", "turn failed"));
    }
    if (method === "turn/cancelled") {
      this.onEvent({ event: "turn_failed", ts: new Date().toISOString(), log: "turn cancelled" });
      return void this.turn?.reject(new CategorizedError("turn_failed", "turn cancelled"));
    }
    if (method === "thread/tokenUsage/updated") {
      const t = obj(obj(params.tokenUsage).total);
      return this.onEvent({ tokens: { total: numv(t.totalTokens), input: numv(t.inputTokens), output: numv(t.outputTokens), cached: numv(t.cachedInputTokens), reasoning: numv(t.reasoningOutputTokens) } });
    }
    if (method === "item/started") {
      const item = obj(params.item);
      switch (item.type) {
        case "commandExecution":
          return this.onEvent({ label: cmdLabel(item), log: `$ ${cmdStr(item)}` });
        case "reasoning":
          return this.onEvent({ label: "thinking…" });
        case "fileChange":
          return this.onEvent({ label: "editing files", log: "✎ editing files" });
        case "agentMessage":
          this.msgBuf.set(String(item.id ?? ""), "");
          return this.onEvent({ label: "writing a reply…" });
        case "mcpToolCall":
        case "dynamicToolCall":
          return this.onEvent({ label: "calling a tool" });
      }
      return;
    }
    if (method === "item/agentMessage/delta") {
      const id = String(params.itemId ?? "");
      const d = typeof params.textDelta === "string" ? params.textDelta : "";
      const acc = (this.msgBuf.get(id) ?? "") + d;
      this.msgBuf.set(id, acc);
      return this.onEvent({ stream: acc });
    }
    if (method === "item/completed") {
      const item = obj(params.item);
      if (item.type === "agentMessage") {
        const id = String(item.id ?? "");
        const text = typeof item.text === "string" ? item.text : (this.msgBuf.get(id) ?? "");
        this.msgBuf.delete(id);
        if (text.trim()) this.onEvent({ log: `● ${text.trim()}` });
      }
    }
  }

  private reply(id: number, result: Json): void {
    this.send({ id, result });
  }

  private failAll(e: Error): void {
    if (!this.fatal) this.fatal = e;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    this.turn?.reject(e);
  }
}

// Remove secret-looking vars (Slack tokens, api keys, ...) from the env handed to the codex
// child, so a compromised/injected turn can't read them out of its own environment.
const SECRET_ENV = /token|secret|password|api[_-]?key|credential/i;
function scrubSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k)) out[k] = v;
  return out;
}

function obj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

function numv(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function toolResult(success: boolean, output: string): Json {
  return { success, output, contentItems: [{ type: "inputText", text: output }] };
}

function cmdStr(item: Json): string {
  const c = item.command;
  const s = Array.isArray(c) ? c.map(String).join(" ") : typeof c === "string" ? c : "";
  return s || "(command)";
}

function cmdLabel(item: Json): string {
  const s = cmdStr(item);
  return `run: ${s.length > 64 ? `${s.slice(0, 61)}…` : s}`;
}

function autoApprove(method: string): string | null {
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") return "acceptForSession";
  if (method === "execCommandApproval" || method === "applyPatchApproval") return "approved_for_session";
  return null;
}

function answerUserInput(params: Json): Json {
  const questions = Array.isArray(params.questions) ? (params.questions as Json[]) : [];
  const answers: Json = {};
  for (const q of questions) {
    const qid = String(q.id ?? "");
    const labels = (Array.isArray(q.options) ? (q.options as Json[]) : []).map((o) => String(o.label ?? ""));
    const pick =
      labels.find((l) => l === "Approve this Session") ??
      labels.find((l) => l === "Approve Once") ??
      labels.find((l) => /^(approve|allow)/i.test(l)) ??
      "This is a non-interactive session. Operator input is unavailable.";
    answers[qid] = { answers: [pick] };
  }
  return answers;
}

// tag identities drive their own tools (git-adjacent or otherwise) directly via granted tools, not
// through codex's own sandboxed exec, so turns default to full access — the real containment is
// the grant/scope/confirmation gate (policy/broker.ts), not the sandbox.
const DEFAULT_TURN_POLICY: Json = { type: "dangerFullAccess" };
