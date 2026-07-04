# Deploying earshot

`earshot` is one Bun process, one SQLite file, zero external services. Deploying it is: install Bun,
point it at a policy file + Slack secrets, and run `earshot start` under a supervisor that restarts it
and sends SIGTERM on stop. This runbook covers first-time setup through backup/rollback.

There is nothing to "deploy to exe.dev" — exe.dev is the Codex *auth gateway* the `codex` CLI
routes through. `earshot` runs wherever you put it (your Mac, a Linux VM) and drives Codex through the
already-authenticated CLI.

---

## 1. Prerequisites

- **Bun** (the runtime): https://bun.sh — `curl -fsSL https://bun.sh/install | bash`
- **Codex CLI**, logged in: `codex login status` should print `Logged in ...`. This is what bills
  to the ChatGPT/Codex plan; earshot never calls the Claude/Anthropic API.
- **A Slack app** in Socket Mode with the scopes below.

Verify prerequisites at any time with:

```sh
earshot doctor
```

It checks: codex logged in, the three Slack env vars present, and that the policy file validates.

---

## 2. Slack app setup (one time)

In https://api.slack.com/apps → your app:

1. **Socket Mode** → enable. Generate an **App-Level Token** (`xapp-...`, scope
   `connections:write`) → this is `SLACK_APP_TOKEN`.
2. **OAuth & Permissions → Bot Token Scopes**, add: `chat:write`, `reactions:write`,
   `channels:history`, `groups:history`, `im:history`, `mpim:history`.
3. **Event Subscriptions** → enable → **Subscribe to bot events**: `message.channels`,
   `message.groups`, `message.im`, `message.mpim`. **Do not** add `app_mention` — earshot detects
   mentions from message text; subscribing to both double-delivers every mention.
4. **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-...`) → `SLACK_BOT_TOKEN`.
5. Get the bot's own user id (`U...`): `curl -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
   https://slack.com/api/auth.test | jq -r .user_id` → `SLACK_BOT_USER_ID`.
6. Invite the bot to the channels it should serve: `/invite @your-bot` (DMs work automatically if
   `default_dm_identity` is set in policy).

Treat all tokens as secrets. If one is ever pasted somewhere shared, rotate it (reinstall the app
for a fresh bot token; regenerate the app-level token under Basic Information).

---

## 3. Configuration

**Secrets** — put the three Slack tokens in `.env` at the repo root (gitignored, `chmod 600`):

```sh
cat > .env << 'EOF'
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_USER_ID=U...
EOF
chmod 600 .env
```

Bun auto-loads `.env` from the working directory, so no wrapper is needed. (systemd users can use
`EnvironmentFile=` instead — same KEY=VALUE format.)

**Policy** — copy the example and edit it:

```sh
cp deploy/policy.example.yaml policy.yaml
```

Fill in your operator user id, the identities, their channel IDs, and budgets. Secrets in policy
are `$VAR` indirections only (validated present, never printed). Run `earshot doctor` to confirm it
validates before starting.

**Paths** (env, all optional):

| var                | default          | meaning                          |
|--------------------|------------------|----------------------------------|
| `EARSHOT_DB`           | `./earshot.db`       | the SQLite ledger file           |
| `EARSHOT_POLICY`       | `./policy.yaml`  | the policy file                  |
| `EARSHOT_STATUS_PORT`  | (off)            | if set, serve a read-only JSON status endpoint on this port |

---

## 4. Run it

**Foreground (dev):**

```sh
earshot start          # or: bun run src/main.ts start
```

**As a supervised service:**

- **macOS (launchd):** edit the paths in `deploy/com.earshot.daemon.plist`, then
  ```sh
  cp deploy/com.earshot.daemon.plist ~/Library/LaunchAgents/
  launchctl load ~/Library/LaunchAgents/com.earshot.daemon.plist
  ```
  Stop/reload: `launchctl unload ...` / `launchctl load ...` (sends SIGTERM → graceful drain).

- **Linux (systemd):** edit paths/User in `deploy/earshot.service`, then
  ```sh
  sudo cp deploy/earshot.service /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl enable --now earshot
  ```
  `systemctl restart earshot` / `stop earshot` send SIGTERM; `TimeoutStopSec=180` lets in-flight work drain
  before SIGKILL.

On boot the service runs **restart recovery** (SPEC §14.2): any task left `active` by a prior
process is marked interrupted and redispatched (or parked past the interruption bound), so nothing
dangles and no work is lost across restarts.

---

## 5. Operate

- **Status:** `earshot status` (human) or `earshot status --json` (machine). Shows per-identity
  open/running/waiting/parked counts, spend this month, and timers due/pending. With
  `EARSHOT_STATUS_PORT` set, the same snapshot is served at `http://localhost:$PORT/`.
- **Logs:** structured JSON lines on stdout — the supervisor captures them (launchd →
  `StandardOutPath`; systemd → `journalctl -u earshot`). Each line carries `identity_id` and, where
  applicable, `task_id`/`turn_id`/`anchor`. Secret-looking fields are redacted.
- **"What did we do / spend?":** answerable from the audit log — grant an identity the
  `audit_query` tool and ask it in-chat, or query the `audit` table directly.
- **Live policy reload (§16.2):** edit `policy.yaml` while running — earshot watches the file and
  reloads. An invalid edit is rejected and the last-known-good policy stays live (see the
  `policy reload rejected` log line). In-flight turns finish under their start-time policy; grant
  revocations apply at the next tool call.

---

## 6. Backup & restore

The entire durability layer is one file (`$EARSHOT_DB`). Back it up WAL-safely with SQLite's online
backup (safe while running):

```sh
sqlite3 "$EARSHOT_DB" ".backup '/backups/earshot-$(date +%F).db'"
```

A daily cron is plenty for a homebrew deploy. **Restore** = stop the service, copy a backup over
`$EARSHOT_DB`, start again — restart recovery self-heals any `active` tasks in the restored file.

---

## 7. Rollback

`earshot` is a git checkout. To roll back a bad deploy: `git checkout <good-sha>`, restart the service.
The ledger schema is migration-versioned and forward-only — a newer db opened by an older build
refuses to start (rather than corrupting), so roll the code back to the version that matches the
db, or restore a pre-migration db backup.

---

## 8. First-run checklist

1. `bun install` (dev deps only; runtime has zero deps)
2. `earshot doctor` → all `ok`
3. `.env` with the three Slack tokens, `chmod 600`
4. `policy.yaml` from the example, edited + validating
5. bot invited to its channels
6. `earshot start` → look for `service started` in the logs
7. mention the bot in a channel → it acks/replies; `earshot status` shows the activity
8. install the supervisor unit; confirm it survives a `restart`
