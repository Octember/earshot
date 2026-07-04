import { spawn, type ChildProcess } from 'node:child_process'
import { CategorizedError } from './types'
import type { AgentEvent, CodexConfig, DynamicTool, RateLimits } from './types'

// §10.1: cap the line accumulation buffer so a monster line never OOMs the process.
const MAX_LINE_BYTES = 10 * 1024 * 1024 // 10 MB

// POSIX single-quote a string for a remote shell command.
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

type Json = Record<string, unknown>
interface Pending {
  resolve: (v: Json) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// Optional per-session credential hooks. Kept out of the generic runtime so a consuming project (bunion's
// bot git identity, say) can inject credentials without this file knowing anything about GitHub,
// SSH, or that project's Config. bunion passes a hook that mints a GH_TOKEN; tag passes none.
export interface SessionHooks {
  // Called before spawning codex. For a remote (host set) session, set up remote credential state (e.g. write a token
  // file on the VM). For a local session, return `{ env }` to merge into the child's environment. May throw to abort.
  beforeSpawn?(host: string | null): Promise<{ env?: Record<string, string> } | void>
  // Called once the session is initialized. Return a cleanup function (e.g. stop a token-refresh timer) run on stop().
  afterStart?(host: string | null): (() => void) | void
  // Transform the base environment a LOCAL codex child inherits — e.g. strip secret-looking vars so a prompt-injected
  // turn can't `echo $SLACK_BOT_TOKEN`. Applied before beforeSpawn's additions are merged. Omit → inherit process.env
  // unchanged (a session that spawns only on remote VMs, like bunion's, never reaches this).
  scrubEnv?(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv
}

// Minimal client for the Codex app-server JSON-RPC stream over stdio (newline-delimited JSON, NOT Content-Length).
// One subprocess + one thread per issue; turns run on the same thread. Server→client requests (tool calls,
// approvals, user-input) are answered inline so an unattended turn never stalls. Faithful to Symphony's AppServer.
export class AppServerSession {
  private codex: CodexConfig
  private tools: Map<string, DynamicTool>
  private onEvent: (e: AgentEvent) => void
  private hooks: SessionHooks | undefined
  private msgBuf = new Map<string, string>() // accumulates agent-message text deltas by itemId
  private proc: ChildProcess | null = null
  private buf = ''
  private nextId = 100
  private pending = new Map<number, Pending>()
  private turn: { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null
  private fatal: Error | null = null
  private hookCleanup: (() => void) | null = null
  private lastActivityAt = 0

  constructor(codex: CodexConfig, tools: DynamicTool[], onEvent: (e: AgentEvent) => void = () => {}, hooks?: SessionHooks) {
    this.codex = codex
    this.tools = new Map(tools.map((t) => [t.spec.name, t]))
    this.onEvent = onEvent
    this.hooks = hooks
  }

  // Wall-clock ms since the last JSON-RPC activity (message sent or received) — a process-liveness signal distinct
  // from turnTimeoutMs (total turn duration). A caller's stall watchdog can use it; callers that don't, ignore it.
  msSinceLastActivity(now: number = Date.now()): number {
    return now - this.lastActivityAt
  }

  async start(workspace: string, host: string | null = null): Promise<void> {
    // Local: bash `-lc` sources the login profile so codex is on PATH with its auth env. Remote: ssh into the worker
    // VM and run the same app-server in the VM's workspace — the JSON-RPC stream rides the ssh stdio pipe unchanged,
    // and a login shell (`exec $SHELL -lc`) puts codex on PATH there too.
    // Credential setup (if any) is delegated to the session hook: remote → it writes state on the VM and returns no
    // env (codex scrubs its exec env, so an inherited variable never reaches the agent's shells); local → it returns
    // `{ env }` merged into the child. A hook that throws surfaces loudly as a session error the caller retries.
    const spawnEnv = this.hooks?.beforeSpawn ? await this.hooks.beforeSpawn(host) : undefined
    // Local child env: process.env optionally scrubbed by the hook, plus any additions beforeSpawn returned. A remote
    // (ssh) session inherits nothing here — codex scrubs its exec env, so credentials ride the token file instead.
    let env: NodeJS.ProcessEnv | undefined
    if (!host) {
      const base = this.hooks?.scrubEnv ? this.hooks.scrubEnv(process.env) : process.env
      env = spawnEnv?.env ? { ...base, ...spawnEnv.env } : this.hooks?.scrubEnv ? base : undefined
    }
    const remoteCmd = `cd ${shq(workspace)} && exec "$SHELL" -lc ${shq(this.codex.command)}`
    const proc = host
      ? spawn('ssh', ['-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', host, remoteCmd], { stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn('bash', ['-lc', this.codex.command], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    proc.stdout?.on('data', (d: Buffer) => this.onData(d))
    // §10.3: stderr is diagnostic only — route it to a separate log path so it never contaminates the JSON parse.
    proc.stderr?.on('data', (d: Buffer) => this.onStderr(d))
    proc.on('exit', (code, signal) => {
      this.runHookCleanup()
      // §10.6: a clean zero-exit (codex itself terminated normally, with nothing pending) gets its OWN code —
      // distinct from `port_exit` (a real crash/abnormal exit) — so it does NOT count toward the caller's
      // worker-setup-failure streak; a deliberate stop() always SIGKILLs, so this branch is never the intentional
      // end-of-session shutdown, only codex deciding to exit on its own.
      const err = code === 0 && !signal
        ? new CategorizedError('codex_clean_exit', `codex app-server exited (0)`)
        : new CategorizedError('port_exit', `codex app-server exited (${code ?? signal})`)
      this.failAll(err)
    })
    proc.on('error', (e) => {
      // §10.6: ENOENT → the codex binary was not found.
      const isMissing = (e as NodeJS.ErrnoException).code === 'ENOENT'
      this.failAll(new CategorizedError(isMissing ? 'codex_not_found' : 'port_exit', e.message))
    })

    try {
      await this.request(
        'initialize',
        {
          capabilities: { experimentalApi: true },
          clientInfo: { name: 'agent-kit', title: 'agent-kit', version: '0.1.0' },
        },
        this.codex.initTimeoutMs, // cold codex boot on a fresh/loaded VM exceeds the steady-state read timeout — give the handshake room
      )
    } catch (e) {
      // §10.6: handshake timeout → response_timeout.
      const msg = e instanceof Error ? e.message : String(e)
      if (!(e instanceof CategorizedError) && msg.includes('timed out')) throw new CategorizedError('response_timeout', msg)
      throw e
    }
    this.notify('initialized', {})
    const cleanup = this.hooks?.afterStart?.(host)
    this.hookCleanup = typeof cleanup === 'function' ? cleanup : null
    this.onEvent({ event: 'session_started', ts: new Date().toISOString() })
  }

  async startThread(workspace: string): Promise<string> {
    const res = await this.request(
      'thread/start',
      {
        approvalPolicy: this.codex.approvalPolicy,
        sandbox: this.codex.threadSandbox,
        cwd: workspace,
        dynamicTools: [...this.tools.values()].map((t) => t.spec),
      },
      this.codex.initTimeoutMs, // thread setup on a cold/loaded VM exceeds the steady-state read timeout
    )
    const id = (res.thread as Json | undefined)?.id
    if (typeof id !== 'string') throw new CategorizedError('invalid_workspace_cwd', 'thread/start: missing thread id')
    return id
  }

  // Reopen an existing thread by id, loading its full prior history (reasoning + tool calls), so a fresh app-server
  // process continues the same conversation. The rollout must live in this machine's ~/.codex — i.e. resume runs on
  // the worker that originally ran the thread. cwd does not need to match the original.
  async resumeThread(threadId: string): Promise<string> {
    const res = await this.request('thread/resume', { threadId }, this.codex.initTimeoutMs) // resuming a big rollout on a cold VM exceeds the read timeout
    const id = (res.thread as Json | undefined)?.id
    if (typeof id !== 'string') throw new CategorizedError('invalid_workspace_cwd', 'thread/resume: missing thread id')
    return id
  }

  // Send one turn and resolve when it terminates (turn/completed). Rejects on turn/failed|cancelled, timeout, or
  // a dead subprocess. `sandbox` overrides the turn's sandbox policy (e.g. read-only for an operator chat turn).
  async runTurn(threadId: string, workspace: string, prompt: string, title: string, sandbox?: Json, model?: string | null, images?: string[]): Promise<void> {
    if (this.fatal) throw this.fatal
    // Arm the turn waiter BEFORE sending turn/start: a fast turn can stream turn/completed in the same stdout chunk
    // as the turn/start response, so the terminal event needs somewhere to land or it is lost and the turn hangs.
    const turnDone = new Promise<void>((resolve, reject) => {
      // §10.6: turn_timeout for turn-level timeout, not a generic Error.
      const timer = setTimeout(() => {
        this.turn = null
        reject(new CategorizedError('turn_timeout', 'turn timeout'))
      }, this.codex.turnTimeoutMs)
      this.turn = {
        resolve: () => {
          clearTimeout(timer)
          this.turn = null
          resolve()
        },
        reject: (e) => {
          clearTimeout(timer)
          this.turn = null
          reject(e)
        },
        timer,
      }
    })
    try {
      // §10.2: extract turn_id from the turn/start response and emit it so the caller can compose session_id.
      const res = await this.request(
        'turn/start',
        {
          threadId,
          input: [{ type: 'text', text: prompt }, ...(images ?? []).map((path) => ({ type: 'localImage', path }))],
          cwd: workspace,
          title,
          approvalPolicy: this.codex.approvalPolicy,
          sandboxPolicy: sandbox ?? this.codex.turnSandboxPolicy ?? DEFAULT_TURN_POLICY,
          ...(model ? { model } : {}),
        },
        this.codex.turnTimeoutMs,
      )
      // turn/start may return { turn: { id } } or a flat { id } depending on codex version — try both.
      const turnId = String((res.turn as Json | undefined)?.id ?? res.id ?? '')
      if (turnId) this.onEvent({ turnId, ts: new Date().toISOString() })
    } catch (e) {
      const t = this.turn
      this.turn = null
      if (t) clearTimeout(t.timer)
      throw e
    }
    await turnDone
  }

  stop(): void {
    this.runHookCleanup()
    try {
      this.proc?.kill('SIGKILL')
    } catch {
      // already gone
    }
  }

  // --- internals ---
  private runHookCleanup(): void {
    this.hookCleanup?.()
    this.hookCleanup = null
  }

  private request(method: string, params: Json, timeoutMs = this.codex.readTimeoutMs): Promise<Json> {
    if (this.fatal) return Promise.reject(this.fatal)
    const id = this.nextId++
    const p = new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
    this.send({ method, id, params })
    return p
  }

  private notify(method: string, params: Json): void {
    this.send({ method, params })
  }

  private send(msg: Json): void {
    this.lastActivityAt = Date.now()
    try {
      this.proc?.stdin?.write(JSON.stringify(msg) + '\n')
    } catch {
      // pipe closed; the exit handler will surface the fatal
    }
  }

  // §10.3: stderr is purely diagnostic — never feed it into the JSON-RPC parse path.
  private onStderr(d: Buffer): void {
    const lines = d.toString('utf8').split('\n')
    for (const line of lines) {
      const t = line.trim()
      if (t) this.onEvent({ log: `[stderr] ${t}` })
    }
  }

  private onData(d: Buffer): void {
    this.lastActivityAt = Date.now()
    this.buf += d.toString('utf8')
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      const t = line.trim()
      if (!t) continue
      let msg: Json
      try {
        msg = JSON.parse(t) as Json
      } catch {
        continue // partial / non-JSON line
      }
      this.handle(msg)
    }
    // §10.1: if the buffer has grown past 10 MB without a newline, the line is malformed/corrupt — drop it.
    if (this.buf.length > MAX_LINE_BYTES) {
      this.onEvent({ log: `[warn] app-server line buffer exceeded ${MAX_LINE_BYTES} bytes — dropping` })
      this.buf = ''
    }
  }

  private handle(msg: Json): void {
    this.onEvent({})
    const method = typeof msg.method === 'string' ? msg.method : null
    const id = typeof msg.id === 'number' ? msg.id : null

    if (method && id !== null) {
      void this.handleServerRequest(method, id, obj(msg.params))
      return
    }
    if (method) {
      this.handleNotification(method, obj(msg.params))
      return
    }
    if (id !== null) {
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      clearTimeout(p.timer)
      if ('error' in msg) p.reject(new Error(`rpc error: ${JSON.stringify(msg.error)}`))
      else p.resolve(obj(msg.result))
    }
  }

  private async handleServerRequest(method: string, id: number, params: Json): Promise<void> {
    if (method === 'item/tool/call') {
      await this.handleToolCall(id, params)
      return
    }
    const decision = autoApprove(method)
    if (decision) {
      // §10.4: emit a structured event so the caller can track auto-approved requests.
      this.onEvent({ event: 'approval_auto_approved', ts: new Date().toISOString(), log: `auto-approved: ${method}` })
      this.reply(id, { decision })
      return
    }
    if (method === 'item/tool/requestUserInput') {
      this.reply(id, { answers: answerUserInput(params) })
      return
    }
    // Any other input-required request → answer benignly so the turn never stalls (approval_policy: never).
    this.reply(id, {})
  }

  private async handleToolCall(id: number, params: Json): Promise<void> {
    const name = typeof params.tool === 'string' ? params.tool : typeof params.name === 'string' ? params.name : ''
    this.onEvent({ label: 'calling a tool', log: `⚙ ${name}` })
    const tool = this.tools.get(name)
    if (!tool) {
      // §10.4: emit a structured event so the caller can observe unsupported tool requests.
      this.onEvent({ event: 'unsupported_tool_call', ts: new Date().toISOString(), log: `unsupported tool: ${name}` })
      this.reply(id, toolResult(false, `Unsupported dynamic tool: ${name}`))
      return
    }
    try {
      const r = await tool.run(params.arguments ?? {})
      this.reply(id, toolResult(r.success, r.output))
    } catch (e) {
      this.reply(id, toolResult(false, e instanceof Error ? e.message : String(e)))
    }
  }

  private handleNotification(method: string, params: Json): void {
    if (method === 'turn/completed') {
      // §10.4: structured event for turn completion; extract rate limits if codex includes them.
      this.onEvent({ event: 'turn_completed', ts: new Date().toISOString(), ...extractRateLimits(params) })
      return void this.turn?.resolve()
    }
    if (method === 'turn/failed') {
      // §10.4 + §10.6: turn_failed structured event.
      this.onEvent({ event: 'turn_failed', ts: new Date().toISOString() })
      return void this.turn?.reject(new CategorizedError('turn_failed', 'turn failed'))
    }
    if (method === 'turn/cancelled') {
      this.onEvent({ event: 'turn_failed', ts: new Date().toISOString(), log: 'turn cancelled' })
      return void this.turn?.reject(new CategorizedError('turn_failed', 'turn cancelled'))
    }
    if (method === 'thread/tokenUsage/updated') {
      // `total` is the thread-cumulative usage for this session; the caller folds it into per-ticket/phase tallies.
      // §10.4/§13.3: also capture rate limits if codex bundles them here.
      const t = obj(obj(params.tokenUsage).total)
      return this.onEvent({ tokens: { total: numv(t.totalTokens), input: numv(t.inputTokens), output: numv(t.outputTokens), cached: numv(t.cachedInputTokens), reasoning: numv(t.reasoningOutputTokens) }, ...extractRateLimits(params) })
    }
    if (method === 'item/started') {
      const item = obj(params.item)
      switch (item.type) {
        case 'commandExecution': return this.onEvent({ label: cmdLabel(item), log: `$ ${cmdStr(item)}` })
        case 'reasoning': return this.onEvent({ label: 'thinking…' })
        case 'fileChange': return this.onEvent({ label: 'editing files', log: '✎ editing files' })
        case 'agentMessage':
          this.msgBuf.set(String(item.id ?? ''), '')
          return this.onEvent({ label: 'writing a reply…' })
        case 'mcpToolCall':
        case 'dynamicToolCall': return this.onEvent({ label: 'calling a tool' })
      }
      return
    }
    if (method === 'item/agentMessage/delta') {
      const id = String(params.itemId ?? '')
      const d = typeof params.textDelta === 'string' ? params.textDelta : ''
      const acc = (this.msgBuf.get(id) ?? '') + d
      this.msgBuf.set(id, acc)
      return this.onEvent({ stream: acc }) // emit the growing reply for realtime display; item/completed commits the final `● ` line
    }
    if (method === 'item/completed') {
      const item = obj(params.item)
      if (item.type === 'agentMessage') {
        const id = String(item.id ?? '')
        const text = typeof item.text === 'string' ? item.text : this.msgBuf.get(id) ?? ''
        this.msgBuf.delete(id)
        if (text.trim()) this.onEvent({ log: `● ${text.trim()}` })
      }
    }
  }

  private reply(id: number, result: Json): void {
    this.send({ id, result })
  }

  private failAll(e: Error): void {
    if (!this.fatal) this.fatal = e
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(e)
    }
    this.pending.clear()
    this.turn?.reject(e)
  }
}

function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {}
}

function numv(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function toolResult(success: boolean, output: string): Json {
  return { success, output, contentItems: [{ type: 'inputText', text: output }] }
}

function cmdStr(item: Json): string {
  const c = item.command
  const s = Array.isArray(c) ? c.map(String).join(' ') : typeof c === 'string' ? c : ''
  return s || '(command)'
}

function cmdLabel(item: Json): string {
  const s = cmdStr(item)
  return `run: ${s.length > 64 ? `${s.slice(0, 61)}…` : s}`
}

// Newer item/* approvals want `acceptForSession`; legacy exec/applyPatch approvals want `approved_for_session`.
function autoApprove(method: string): string | null {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return 'acceptForSession'
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') return 'approved_for_session'
  return null
}

function answerUserInput(params: Json): Json {
  const questions = Array.isArray(params.questions) ? (params.questions as Json[]) : []
  const answers: Json = {}
  for (const q of questions) {
    const qid = String(q.id ?? '')
    const labels = (Array.isArray(q.options) ? (q.options as Json[]) : []).map((o) => String(o.label ?? ''))
    const pick =
      labels.find((l) => l === 'Approve this Session') ??
      labels.find((l) => l === 'Approve Once') ??
      labels.find((l) => /^(approve|allow)/i.test(l)) ??
      'This is a non-interactive session. Operator input is unavailable.'
    answers[qid] = { answers: [pick] }
  }
  return answers
}

// §10.4/§13.3: extract rate-limit info from a codex notification payload, if present. codex may attach
// rate_limits / rateLimits on turn/* or token-usage events. Normalize to the RateLimits contract shape.
function extractRateLimits(params: Json): { rateLimits?: RateLimits } {
  const raw = params.rateLimits ?? params.rate_limits
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as Json
  // Prefer a `requests` window as the primary utilization signal; fall back to `tokens`.
  const window = (r.requests ?? r.tokens ?? r) as Json
  const limit = numv(window.limit)
  const remaining = numv(window.remaining)
  const usedPercent = limit > 0 ? Math.round(((limit - remaining) / limit) * 100) : null
  // `reset` may be an ISO timestamp or seconds-from-now integer.
  let resetsInSeconds: number | null = null
  const reset = window.reset ?? window.resetAt ?? r.resetsAt
  if (typeof reset === 'number') resetsInSeconds = reset
  else if (typeof reset === 'string') {
    const ms = Date.parse(reset)
    if (!isNaN(ms)) resetsInSeconds = Math.max(0, Math.round((ms - Date.now()) / 1000))
  }
  return { rateLimits: { usedPercent, resetsInSeconds, raw, at: Date.now() } }
}

// The agent runs its own git (fetch/commit/push) + gh. codex's workspace-write write-protects .git regardless of
// writableRoots, which breaks those, so turns default to full access to let the agent drive git itself. Safe to the
// extent the host is trusted — the proper containment is running in a disposable VM (the exedev path).
const DEFAULT_TURN_POLICY: Json = { type: 'dangerFullAccess' }
