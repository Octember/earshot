#!/usr/bin/env bash
# Starts the earshot daemon on an exe.dev VM with the standard VM layout. Bun auto-loads ~/earshot/.env
# (Slack tokens). Invoked detached (setsid) for the live start, and by the @reboot cron entry.
set -e
export PATH="$HOME/.bun/bin:$PATH"
export EARSHOT_DB="${EARSHOT_DB:-$HOME/earshot-data/earshot.db}"
export EARSHOT_POLICY="${EARSHOT_POLICY:-$HOME/earshot/policy.yaml}"
cd "$HOME/earshot"
exec bun run src/main.ts start
