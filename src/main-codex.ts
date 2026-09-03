import { DEFAULT_CODEX_CONFIG } from "./turn-runner/types";
import type { AgentEvent, DynamicTool } from "@bevyl-ai/agent-tools";
import { AppServerSession } from "@bevyl-ai/agent-tools";
import type { createLogger } from "./log";

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

function allowlistEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(
    CODEX_ENV_ALLOWLIST.filter((envName) => env[envName] !== undefined).map((envName) => [
      envName,
      env[envName],
    ]),
  );
}

export function makeCodexSessionFactory(log: ReturnType<typeof createLogger>) {
  return (
    tools: DynamicTool[],
    onEvent?: (agentEvent: AgentEvent) => void,
    overrides?: { model?: string; effort?: string },
  ) => {
    const flags = [
      overrides?.model ? `-c model=${JSON.stringify(overrides.model)}` : "",
      overrides?.effort ? `-c model_reasoning_effort=${JSON.stringify(overrides.effort)}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const config = flags
      ? { ...DEFAULT_CODEX_CONFIG, command: `codex ${flags} app-server` }
      : DEFAULT_CODEX_CONFIG;
    return new AppServerSession(
      config,
      tools,
      onEvent ??
        ((agentEvent) => {
          if (agentEvent.log) log.info("codex", { line: agentEvent.log });
        }),
      { scrubEnv: allowlistEnv },
    );
  };
}
