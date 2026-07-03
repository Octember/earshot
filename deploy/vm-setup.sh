#!/usr/bin/env bash
# tag VM setup — runs once on first boot of an exe.dev VM (passed to `exe.dev new --setup-script`).
# Makes a fresh VM ready to run the tag daemon: keyless codex via the exe-llm gateway + bun. The
# tag code + secrets are NOT baked in here — they're rsync'd over after boot (tag is a private
# daemon, not a github-cloned repo), then started. Mirrors bunion/provisioning/vm-setup.sh for the
# codex + bun parts.
#
# Provision (from your laptop):
#   ssh exe.dev new --name tag-daemon --json --setup-script /dev/stdin < deploy/vm-setup.sh
#   ssh exe.dev integrations attach llm vm:tag-daemon      # keyless codex via the exe-llm gateway
set -e

# 1. Keyless codex via the exe-llm gateway (same as bunion's workers — no API key on the VM).
mkdir -p "$HOME/.codex"
cat > "$HOME/.codex/config.toml" <<'EOF'
model_provider = "exe-llm"
model_reasoning_effort = "high"

[model_providers.exe-llm]
name = "exe-llm"
base_url = "https://llm.int.exe.xyz/v1"
requires_openai_auth = false
EOF

# 2. bun (the base image ships codex but not bun; tag is bun-based).
[ -x "$HOME/.bun/bin/bun" ] || curl -fsSL https://bun.sh/install | bash

# 3. PATH for codex's `bash -lc` subprocesses and for running tag. codex sources ~/.bash_profile;
#    make it source ~/.profile where bun lives.
touch "$HOME/.profile" && chmod 600 "$HOME/.profile"
grep -q '.bun/bin' "$HOME/.profile" 2>/dev/null || echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$HOME/.profile"
grep -q 'HOME/.profile' "$HOME/.bash_profile" 2>/dev/null || echo '[ -f "$HOME/.profile" ] && . "$HOME/.profile"' >> "$HOME/.bash_profile"

# 4. Where the daemon lives + its ledger. Code + .env + policy.yaml arrive via rsync after boot.
mkdir -p "$HOME/tag" "$HOME/tag-data"

echo "tag-vm-setup done"
