import {
  AppServerSession,
  type AgentEvent,
  type CodexConfig,
  type DynamicTool,
} from "@bevyl-ai/agent-tools";
import type { Logger } from "./log";

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

const DEFAULT_CODEX_CONFIG: CodexConfig = {
  command: "codex app-server",
  approvalPolicy: "never",
  threadSandbox: "workspace-write",
  turnSandboxPolicy: null,
  turnTimeoutMs: 10 * 60 * 1000,
  readTimeoutMs: 30_000,
  initTimeoutMs: 60_000,
  stallTimeoutMs: 5 * 60 * 1000,
};

export function makeCodexSessionFactory(log: Logger) {
  return (
    tools: DynamicTool[],
    onEvent?: (agentEvent: AgentEvent) => void,
    overrides?: {
      model?: string | undefined;
      effort?: string | undefined;
      turnTimeoutMs?: number | undefined;
    },
  ) => {
    const flags = [
      overrides?.model ? `-c model=${JSON.stringify(overrides.model)}` : "",
      overrides?.effort ? `-c model_reasoning_effort=${JSON.stringify(overrides.effort)}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return new AppServerSession(
      {
        ...DEFAULT_CODEX_CONFIG,
        ...(flags ? { command: `codex ${flags} app-server` } : {}),
        ...(overrides?.turnTimeoutMs ? { turnTimeoutMs: overrides.turnTimeoutMs } : {}),
      },
      tools,
      onEvent ??
        ((agentEvent) => {
          if (agentEvent.log) log.info("codex", { line: agentEvent.log });
        }),
      {
        scrubEnv: (env) =>
          Object.fromEntries(
            CODEX_ENV_ALLOWLIST.filter((name) => env[name] !== undefined).map((name) => [
              name,
              env[name],
            ]),
          ),
      },
    );
  };
}
