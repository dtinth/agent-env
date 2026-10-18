# Sourced by login shells. Points the OpenCode CLI at the preset's server, with
# its generated password, so `opencode` and `opencode run` find it from SSH or
# the browser terminal alike. PRIMARY_PORT is exported by the caller.
export OPENCODE_SERVER="http://127.0.0.1:${PRIMARY_PORT}"
if [ -r "$HOME/.local/state/opencode/service.json" ]; then
  OPENCODE_SERVER_PASSWORD="$(jq -r '.password // empty' "$HOME/.local/state/opencode/service.json" 2>/dev/null)"
  export OPENCODE_SERVER_PASSWORD
fi
