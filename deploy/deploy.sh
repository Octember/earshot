#!/usr/bin/env bash
set -euo pipefail
HOST=${1:-tag-daemon.exe.xyz}
REF=${2:-origin/main}
git fetch -q origin
git archive "$REF" src drizzle package.json bun.lock tsconfig.json deploy/policy.yaml | ssh "$HOST" '
  export XDG_RUNTIME_DIR=/run/user/$(id -u)
  cd ~/earshot
  rm -rf src.new && mkdir src.new && tar -x -C src.new
  rm -rf src drizzle && mv src.new/src src && mv src.new/drizzle drizzle && mv src.new/package.json package.json && mv src.new/bun.lock bun.lock && mv src.new/tsconfig.json tsconfig.json
  mv src.new/deploy/policy.yaml policy.yaml && rm -rf src.new
  ~/.bun/bin/bun install --production >/dev/null 2>&1
  systemctl --user restart earshot
  sleep 6
  journalctl --user -u earshot --since "30 seconds ago" --no-pager | grep -E "service started|error" | tail -3
'
