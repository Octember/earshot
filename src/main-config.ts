import { readFileSync } from "node:fs";
import { INTEGRATION_REGISTRIES } from "./tools/catalog";
import { SLACK_TOOL_NAMES } from "./tools/slack-names";
import { PolicyStore } from "./policy/load";

export const HELP = `earshot — a Slack-resident agent with a durable task ledger.

usage:
  earshot start     run the daemon: connect to Slack, drive tasks via codex, survive restarts
  earshot doctor    check codex login, env vars, and that the policy file validates
  earshot status    one-shot snapshot: open tasks + running executions per identity
  earshot replay    relive a recorded incident from a ledger snapshot with real model calls,
                    against a captured room (nothing reaches Slack). See: earshot replay --help

config (env):
  EARSHOT_DB            ledger path                (default ./earshot.db)
  EARSHOT_POLICY        policy YAML path           (default ./policy.yaml)
  SLACK_BOT_TOKEN   xoxb-...                   (required for start)
  SLACK_APP_TOKEN   xapp-... (Socket Mode)     (required for start)
  SLACK_BOT_USER_ID U...                       (required for start)
  SLACK_ADMIN_TOKEN xoxp-... (admin user)      (optional: enables emoji_set)
`;

export const dbPath = () => process.env.EARSHOT_DB ?? "./earshot.db";
export const policyPath = () => process.env.EARSHOT_POLICY ?? "./policy.yaml";

const KNOWN_TOOLS = new Set([
  "audit_query",
  ...SLACK_TOOL_NAMES,
  ...INTEGRATION_REGISTRIES.flatMap((registry) => Object.keys(registry.tools)),
]);

export function makeStore(): PolicyStore {
  return new PolicyStore(() => readFileSync(policyPath(), "utf8"), { knownTools: KNOWN_TOOLS });
}

export function requireEnv(name: string): string {
  const envValue = process.env[name];
  if (!envValue) {
    console.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return envValue;
}
