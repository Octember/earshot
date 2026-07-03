#!/usr/bin/env bash
# Starts the tag daemon on an exe.dev VM with the standard VM layout. Bun auto-loads ~/tag/.env
# (Slack tokens). Invoked detached (setsid) for the live start, and by the @reboot cron entry.
set -e
export PATH="$HOME/.bun/bin:$PATH"
export TAG_DB="${TAG_DB:-$HOME/tag-data/tag.db}"
export TAG_POLICY="${TAG_POLICY:-$HOME/tag/policy.yaml}"
cd "$HOME/tag"
exec bun run src/main.ts start
