import { readFileSync } from "node:fs";
import { PolicyStore } from "./policy/load";

export const HELP = `earshot — a Slack-resident agent with a durable task ledger.

usage:
  earshot start     run the daemon: connect to Slack, drive tasks via codex, survive restarts
  earshot doctor    check codex login, env vars, and that the policy file validates

config (env):
  EARSHOT_DB            ledger path                (default ./earshot.db)
  EARSHOT_POLICY        policy YAML path           (default ./policy.yaml)
  SLACK_BOT_TOKEN   xoxb-...                   (required for start)
  SLACK_APP_TOKEN   xapp-... (Socket Mode)     (required for start)
  SLACK_BOT_USER_ID U...                       (required for start)
  SLACK_ADMIN_TOKEN xoxp-... (admin user, for slack_admin_api)
`;

export const dbPath = () => process.env.EARSHOT_DB ?? "./earshot.db";
export const policyPath = () => process.env.EARSHOT_POLICY ?? "./policy.yaml";

export function makeStore(): PolicyStore {
  return new PolicyStore(() => readFileSync(policyPath(), "utf8"));
}

export function requireEnv(name: string): string {
  const envValue = process.env[name];
  if (!envValue) {
    console.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return envValue;
}
