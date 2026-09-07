# Deploying earshot

One Bun process, one SQLite file, zero external services. Slack is the message store, the codex
workspace is the memory, SQLite holds the task ledger.

## Prerequisites

- **Bun**: `curl -fsSL https://bun.sh/install | bash`
- **Codex CLI**, logged in (`codex login status`). Bills to the ChatGPT plan; earshot never calls the
  Anthropic API.
- **A Slack app** in Socket Mode:
  1. Socket Mode → enable; generate an app-level token (`xapp-…`, scope `connections:write`) →
     `SLACK_APP_TOKEN`.
  2. Bot token scopes: `chat:write`, `reactions:write`, `channels:history`, `groups:history`,
     `im:history`, `mpim:history`, `files:read`, `users:read`, `assistant:write`.
  3. Event subscriptions → bot events: `message.channels`, `message.groups`, `message.im`,
     `message.mpim`. Not `app_mention` (mentions are read from message text; both would
     double-deliver).
  4. Install → bot user OAuth token (`xoxb-…`) → `SLACK_BOT_TOKEN`. The bot's own user id
     (`auth.test` → `user_id`) → `SLACK_BOT_USER_ID`.
  5. `/invite` the bot to the channels it serves.

## Configuration

`.env` beside the checkout (Bun loads it; `chmod 600`):

```sh
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_USER_ID=U...
```

Policy: `deploy/policy.yaml` is the live one and ships with each deploy. Identities, their venues,
per-channel standing instructions, timeouts, and model tiers live there. A policy that fails
validation stops the daemon at boot with the reason; a bad edit while running is rejected and the
last-known-good stays live.

| env                 | default               |
| ------------------- | --------------------- |
| `EARSHOT_DB`        | `./earshot.db`        |
| `EARSHOT_POLICY`    | `./policy.yaml`       |
| `EARSHOT_WORKSPACE` | `~/earshot-workspace` |

## Run

```sh
bun run src/main.ts
```

Supervised: `deploy/earshot.service` (systemd, `--user` on the VM). SIGTERM drains in-flight wakes
before exit. On boot, any task left `active` by the previous process is reopened (or failed past
the interruption bound).

## Deploy to the VM

```sh
bash deploy/deploy.sh tag-daemon.exe.xyz origin/main
```

Ships `src`, `package.json`, `bun.lock`, and `deploy/policy.yaml`, runs `bun install --production`,
restarts the unit, and tails the log. Provisioning a fresh VM: `deploy/vm-setup.sh`.

## Schema changes

The ledger schema is `src/ledger/schema.ts` (drizzle); DDL is generated only for a fresh file, and
a file whose `schema_version` disagrees with the build refuses to open. A DDL change means: stop the
service, `.backup` the db, hand-alter it, bump `SCHEMA_VERSION`, deploy. See the memory note
"pinned schema, no migrations".

## Operate

- Logs: JSON lines on stdout, `journalctl --user -u earshot` on the VM. Secret-looking fields are
  redacted.
- Backup: `sqlite3 "$EARSHOT_DB" ".backup earshot.db.pre-last"` (safe while running).
- Rollback: deploy an older ref with `deploy.sh`; restore the backup if the schema moved.
