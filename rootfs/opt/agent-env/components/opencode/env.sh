# Sourced by login shells. OPENCODE_SERVER comes from [env]; this adds the
# password the server generated for itself, so `opencode` and `opencode run`
# can talk to it from SSH or the browser terminal alike.
if [ -r "$HOME/.local/state/opencode/service.json" ]; then
  OPENCODE_SERVER_PASSWORD="$(jq -r '.password // empty' "$HOME/.local/state/opencode/service.json" 2>/dev/null)"
  export OPENCODE_SERVER_PASSWORD
fi
