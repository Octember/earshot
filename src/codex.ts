import {
  AppServerSession,
  maybeRotateGateway,
  type DynamicTool,
  type CodexConfig,
} from "@bevyl-ai/agent-tools";
import { inject, singleton } from "tsyringe";
import { log } from "./log";
import type { Task } from "./ledger/schema";
import { POLICY, type Policy } from "./policy";

const CODEX_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "USER",
  "TMPDIR",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "SSL_CERT_FILE",
  "NO_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
];

const DEFAULTS: CodexConfig = {
  command: "codex app-server",
  approvalPolicy: "never",
  threadSandbox: "workspace-write",
  turnSandboxPolicy: null,
  turnTimeoutMs: 10 * 60 * 1000,
  readTimeoutMs: 30_000,
  initTimeoutMs: 60_000,
  stallTimeoutMs: 5 * 60 * 1000,
};

@singleton()
export class Codex {
  constructor(@inject(POLICY) private readonly policy: Policy) {}

  resident(tools: DynamicTool[]): AppServerSession {
    const { turns } = this.policy;
    return this.session("codex", tools, {
      turnTimeoutMs: turns.interactive_timeout_ms,
      stallTimeoutMs: turns.stall_timeout_ms,
    });
  }

  ear(tools: DynamicTool[]): AppServerSession {
    const { turns, models } = this.policy;
    return this.session("ear", tools, {
      ...models.low,
      turnTimeoutMs: turns.interactive_timeout_ms,
      stallTimeoutMs: turns.stall_timeout_ms,
    });
  }

  worker(tools: DynamicTool[], tier: Task["tier"]): AppServerSession {
    const { executions, models } = this.policy;
    return this.session("worker", tools, {
      ...models[tier],
      stallTimeoutMs: executions.stall_timeout_ms,
    });
  }

  private session(
    label: string,
    tools: DynamicTool[],
    opts: {
      model?: string | undefined;
      effort?: string | undefined;
      turnTimeoutMs?: number | undefined;
      stallTimeoutMs?: number | undefined;
    },
  ): AppServerSession {
    const flags = [
      opts.model ? `-c model=${JSON.stringify(opts.model)}` : "",
      opts.effort ? `-c model_reasoning_effort=${JSON.stringify(opts.effort)}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return new AppServerSession(
      {
        ...DEFAULTS,
        ...(flags ? { command: `codex ${flags} app-server` } : {}),
        ...(opts.turnTimeoutMs ? { turnTimeoutMs: opts.turnTimeoutMs } : {}),
        ...(opts.stallTimeoutMs ? { stallTimeoutMs: opts.stallTimeoutMs } : {}),
      },
      tools,
      (agentEvent) => {
        if (agentEvent.log) log.info(label, { line: agentEvent.log });
      },
      {
        onTurnError: (error) => {
          maybeRotateGateway({ reason: error instanceof Error ? error.message : String(error) });
        },
        scrubEnv: (env) =>
          Object.fromEntries(
            CODEX_ENV_ALLOWLIST.filter((name) => env[name] !== undefined).map((name) => [
              name,
              env[name],
            ]),
          ),
      },
    );
  }
}
