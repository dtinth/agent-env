# Sourced by login shells. Points the OpenCode CLI at the real server (not the
# preset's proxy on PRIMARY_PORT), with its generated password, so `opencode` and
# `opencode run` find it from SSH or the browser terminal alike.
export OPENCODE_SERVER="http://127.0.0.1:4096"
if [ -r "$HOME/.local/state/opencode/service.json" ]; then
  OPENCODE_SERVER_PASSWORD="$(jq -r '.password // empty' "$HOME/.local/state/opencode/service.json" 2>/dev/null)"
  export OPENCODE_SERVER_PASSWORD
fi
