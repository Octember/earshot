// The runtime-agnostic contract shared by every codex-app-server agent (bunion, tag, …): the tool shape, the event
// stream a session emits, the codex settings a session needs, and the categorized-error class. Nothing here knows
// about Linear, GitHub, PRs, or any one project's domain — those live in the consuming project. Keeping this the
// single source means the two projects can't silently drift the way two hand-copied definitions do.

// A categorized failure carrying a STABLE `code` (Symphony §10.6 / §11.4 normalized error categories) so callers can
// route/label by failure class instead of string-matching free-text messages.
export class CategorizedError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CategorizedError'
  }
}

// The coding agent's latest rate-limit snapshot (Symphony §4.1.8 / §13.3). The upstream codex payload evolves, so
// `raw` carries it verbatim; the summary fields are best-effort for display/backpressure.
export interface RateLimits {
  usedPercent: number | null // primary window utilization 0–100, if known
  resetsInSeconds: number | null // seconds until the primary window resets, if known
  raw: unknown // the full codex rate-limit payload
  at: number // ms epoch the snapshot was captured
}

// Per-turn token usage, from codex's thread/tokenUsage/updated notification (its thread-cumulative `total`).
export interface TokenCounts {
  total: number
  input: number
  output: number
  cached: number
  reasoning: number
}

// What an app-server session reports up on each step: progress + the rolling token total.
export interface AgentEvent {
  turn?: number
  label?: string
  log?: string
  tokens?: TokenCounts
  threadId?: string // emitted once when the agent's codex thread is created or resumed
  turnId?: string // codex turn id — composes session_id = `${threadId}-${turnId}` (Symphony §4.2 / §10.2)
  event?: string // structured event type: session_started, turn_completed, turn_failed, approval_auto_approved, … (§10.4)
  stream?: string // EPHEMERAL growing agent-message text (realtime streaming); NOT persisted
  ts?: string // ISO-8601 UTC timestamp of the event (§10.4)
  rateLimits?: RateLimits // latest coding-agent rate-limit snapshot, when codex reports one
}

// The codex-app-server settings a session needs (command, sandbox policies, timeouts).
export interface CodexConfig {
  command: string
  approvalPolicy: string // "never" → auto-approve; passed through to the app-server
  threadSandbox: string // thread/start.params.sandbox (a STRING)
  turnSandboxPolicy: Record<string, unknown> | null // turn/start.params.sandboxPolicy (an OBJECT)
  turnTimeoutMs: number
  readTimeoutMs: number
  initTimeoutMs: number // separate, generous timeout for the cold codex-boot `initialize` handshake
  stallTimeoutMs: number
}

// A host-side dynamic tool offered to the agent over the app-server (e.g. ops_read, db_read, linear_graphql).
export interface DynamicTool {
  spec: { name: string; description: string; inputSchema: Record<string, unknown> }
  run(args: unknown): Promise<{ success: boolean; output: string }>
}
