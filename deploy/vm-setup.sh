#!/usr/bin/env bash
# Provision:
#   ssh exe.dev new --name earshot-daemon --json --setup-script /dev/stdin < deploy/vm-setup.sh
#   ssh exe.dev integrations attach llm vm:earshot-daemon
set -e

mkdir -p "$HOME/.codex"
cat > "$HOME/.codex/config.toml" <<'EOF'
model_provider = "exe-llm"
model_reasoning_effort = "high"

[model_providers.exe-llm]
name = "exe-llm"
base_url = "https://llm.int.exe.xyz/v1"
requires_openai_auth = false
EOF

[ -x "$HOME/.bun/bin/bun" ] || curl -fsSL https://bun.sh/install | bash

touch "$HOME/.profile" && chmod 600 "$HOME/.profile"
grep -q '.bun/bin' "$HOME/.profile" 2>/dev/null || echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$HOME/.profile"
grep -q 'HOME/.profile' "$HOME/.bash_profile" 2>/dev/null || echo '[ -f "$HOME/.profile" ] && . "$HOME/.profile"' >> "$HOME/.bash_profile"

mkdir -p "$HOME/earshot" "$HOME/earshot-data"

echo "earshot-vm-setup done"
