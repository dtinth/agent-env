#!/usr/bin/env bash
# End-to-end check of a running agent-env container.
#
#   scripts/smoke-test.sh [base-url] [user:password]
#
# Defaults assume the basic-auth quick start on localhost:8080. With
# AUTH_MODE=google every gated route answers 302 to the sign-in page instead of
# 200, which this script reports as OK-redirected.
set -uo pipefail

BASE="${1:-http://localhost:8080}"
AUTH="${2:-opencode:changeme}"
CONTAINER="${CONTAINER:-agent-env}"

pass=0; fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; fail=$((fail+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

code() { curl -s -o /dev/null --max-time 15 -w '%{http_code}' -u "${AUTH}" "$1"; }

# The image deliberately keeps PITCHFORK_* out of its environment so that an
# unprivileged shell gets its own supervisor. `docker exec` therefore inherits
# HOME=/home/dev, and root's pitchfork would resolve to the dev user's state
# directory and fail on permissions. Point it at the system supervisor, the way
# the agent-env helper does.
sys_pitchfork() {
  docker exec \
    -e PITCHFORK_STATE_DIR=/var/lib/pitchfork \
    -e PITCHFORK_CONFIG_DIR=/opt/agent-env/pitchfork \
    "${CONTAINER}" pitchfork "$@"
}

# AUTH_MODE=none is a legitimate deployment — behind tailscale serve, say —
# where an unauthenticated 200 is correct rather than a hole. Ask the container
# which mode it is in rather than guessing from the response.
auth_mode=""
if command -v docker >/dev/null && docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  auth_mode=$(docker exec "${CONTAINER}" sh -c \
    'sed -n "s/^AUTH_MODE=//p" /run/agent-env/env' 2>/dev/null | tr -d "\r")
fi

head_ "Gateway routes"
c=$(curl -s -o /dev/null --max-time 15 -w '%{http_code}' "${BASE}/healthz")
[[ "$c" == 200 ]] && ok "/healthz open without auth (200)" || bad "/healthz returned $c"

c=$(curl -s -o /dev/null --max-time 15 -w '%{http_code}' "${BASE}/")
if [ "${auth_mode}" = none ]; then
  [[ "$c" == 200 ]] && ok "/ serves without credentials, as AUTH_MODE=none asks ($c)" \
                    || bad "/ returned $c with auth disabled — expected 200"
else
  case "$c" in
    401|302) ok "/ rejects unauthenticated requests ($c)" ;;
    *)       bad "/ returned $c without credentials — expected 401 or 302" ;;
  esac
fi

for path in / /terminal/ /desktop/vnc.html; do
  c=$(code "${BASE}${path}")
  case "$c" in
    200) ok "${path} serves (200)" ;;
    302) ok "${path} redirects to sign-in (302)" ;;
    *)   bad "${path} returned $c" ;;
  esac
done

head_ "VNC websocket (browser path)"
# --http1.1 matters over TLS: curl would otherwise negotiate HTTP/2, where
# `Connection: Upgrade` is not a thing, and the request would arrive upstream as
# a plain GET and 404. Browsers open wss:// over HTTP/1.1, which is what this
# imitates.
c=$(curl -s -o /dev/null --max-time 6 --http1.1 -w '%{http_code}' -u "${AUTH}" \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
      -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
      "${BASE}/desktop/websockify")
[[ "$c" == 101 ]] && ok "websockify upgrade (101 Switching Protocols)" \
                  || bad "websockify upgrade returned $c"

if command -v docker >/dev/null && docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  head_ "Inside the container (${CONTAINER})"

  p1=$(docker exec "${CONTAINER}" ps -p 1 -o args= 2>/dev/null)
  [[ "$p1" == *pitchfork* ]] && ok "pitchfork is PID 1 (${p1})" \
                             || bad "PID 1 is not pitchfork: ${p1}"

  daemons=$(sys_pitchfork list 2>/dev/null || true)
  if [[ -z "${daemons}" ]]; then
    bad "could not list the system daemons at all"
  else
    down=$(grep -vc running <<<"${daemons}")
    [[ "$down" == 0 ]] && ok "all $(grep -c . <<<"${daemons}") system daemons are running" \
                       || { bad "$down daemon(s) not running"; printf '%s\n' "${daemons}"; }
  fi

  geom=$(docker exec "${CONTAINER}" bash -lc 'xdpyinfo -display :1 2>/dev/null | grep -m1 dimensions')
  [[ -n "$geom" ]] && ok "X display up (${geom## })" || bad "no X display on :1"

  # Several viewers must be able to share the desktop at once.
  docker exec "${CONTAINER}" python3 - <<'PY' && ok "4 simultaneous VNC clients accepted" \
                                              || bad "VNC does not accept concurrent clients"
import socket, sys, threading, time
res = {}
def c(n):
    try:
        s = socket.create_connection(("127.0.0.1", 5900), timeout=10)
        assert s.recv(12).startswith(b"RFB ")
        s.sendall(b"RFB 003.008\n")
        t = s.recv(s.recv(1)[0])
        assert 1 in t
        s.sendall(b"\x01")
        assert s.recv(4) == b"\x00\x00\x00\x00"
        s.sendall(b"\x01")                    # ClientInit, shared
        assert len(s.recv(24)) == 24
        res[n] = True
        time.sleep(4)
        s.close()
    except Exception:
        res[n] = False
ts = [threading.Thread(target=c, args=(i,)) for i in range(4)]
for t in ts: t.start(); time.sleep(0.3)
time.sleep(2)
sys.exit(0 if sum(res.values()) == 4 else 1)
PY

  head_ "Users and privileges"

  desktop_user=$(docker exec "${CONTAINER}" ps -eo user=,args= | awk '/xfce4-session/ {print $1; exit}')
  [[ "${desktop_user:-}" == "dev" ]] && ok "desktop session runs as dev, not root" \
                                     || bad "desktop session user is '${desktop_user:-none}'"

  caddy_user=$(docker exec "${CONTAINER}" ps -eo user=,args= | awk '/caddy run/ {print $1; exit}')
  [[ "${caddy_user:-}" == "gateway" ]] && ok "caddy runs as the unprivileged gateway user" \
                                       || bad "caddy runs as '${caddy_user:-none}'"

  docker exec -u dev "${CONTAINER}" sudo -n true 2>/dev/null \
    && ok "dev has passwordless sudo" || bad "dev cannot sudo without a password"

  docker exec -u gateway "${CONTAINER}" sudo -n true 2>/dev/null \
    && bad "gateway can sudo — it should not be able to" \
    || ok "gateway has no sudo"

  head_ "Nested user supervisor"

  sup=$(docker exec "${CONTAINER}" ps -eo user=,args= | grep -c 'supervisor run')
  [[ "$sup" -ge 2 ]] && ok "two supervisors: system (root) and user (dev)" \
                     || bad "expected 2 supervisors, found ${sup}"

  # The dev supervisor must be reachable as dev, and must not expose system daemons.
  if docker exec -u dev "${CONTAINER}" bash -lc 'pitchfork list >/dev/null 2>&1'; then
    ok "dev can reach their own supervisor"
  else
    bad "dev cannot reach their own supervisor"
  fi

  isolation=$(docker exec -u dev "${CONTAINER}" bash -lc 'pitchfork stop caddy 2>&1' || true)
  if grep -q "not found" <<<"${isolation}"; then
    ok "dev's supervisor cannot see system daemons"
  else
    bad "dev's supervisor can reach system daemons: ${isolation}"
  fi

  # Runtime state must not live on the home volume: a state file describing a
  # previous container's PIDs stops the supervisor starting at all.
  usd=$(docker exec -u dev "${CONTAINER}" bash -lc 'echo "$PITCHFORK_STATE_DIR"' 2>/dev/null | tr -d '\r')
  case "${usd}" in
    /home/*) bad "the user supervisor keeps runtime state on the home volume (${usd})" ;;
    "")      bad "PITCHFORK_STATE_DIR is unset for dev" ;;
    *)       ok "user supervisor state is outside the home volume (${usd})" ;;
  esac

  docker exec "${CONTAINER}" test -w /tmp/fslock \
    && ok "/tmp/fslock is shared, so any user can run a supervisor" \
    || bad "/tmp/fslock is not writable by other users"

  # The OpenCode server belongs to the user, not to root. Checked against a
  # listing we know is real, so an error cannot masquerade as absence.
  sys_daemons=$(sys_pitchfork list 2>/dev/null || true)
  if [[ -z "${sys_daemons}" ]]; then
    bad "could not read the root supervisor's daemons"
  elif grep -q "opencode" <<<"${sys_daemons}"; then
    bad "opencode is still a system daemon"
  else
    ok "opencode is not in the root supervisor"
  fi

  user_daemons=$(docker exec -u dev "${CONTAINER}" bash -lc 'pitchfork list' 2>/dev/null || true)
  grep -qE "opencode +running" <<<"${user_daemons}" \
    && ok "opencode runs in the dev user's own supervisor" \
    || bad "opencode is not running under dev: ${user_daemons:-none}"

  # ...and its parent really is that supervisor, not PID 1.
  parent=$(docker exec "${CONTAINER}" bash -c '
    pid=$(pgrep -f "opencode2 serve" | head -1)
    while [ -n "$pid" ] && [ "$pid" != 1 ]; do
      args=$(ps -o args= -p "$pid")
      case "$args" in *"supervisor run"*) echo "$args"; exit 0 ;; esac
      pid=$(ps -o ppid= -p "$pid" | tr -d " ")
    done' 2>/dev/null || true)
  case "${parent}" in
    *--container*) bad "opencode hangs off the root supervisor (${parent})" ;;
    *supervisor\ run*) ok "opencode's supervisor is the unprivileged one" ;;
    *) bad "could not trace opencode to a supervisor: ${parent:-none}" ;;
  esac

  head_ "X display access"

  # The gateway account fronts the internet; if it can drive the display it can
  # type into the dev user's terminal and inherit their sudo.
  gw=$(docker exec -u gateway "${CONTAINER}" sh -c 'xdpyinfo -display :1 2>&1' || true)
  grep -qiE "authorization required|unable to open display" <<<"${gw}" \
    && ok "the gateway account cannot reach the display" \
    || bad "gateway reached the X display: ${gw:0:60}"

  dv=$(docker exec -u dev "${CONTAINER}" sh -c 'unset XAUTHORITY; xdpyinfo -display :1 2>&1' || true)
  grep -q "name of display" <<<"${dv}" \
    && ok "dev reaches it with no XAUTHORITY set (cookie is in \$HOME)" \
    || bad "dev cannot reach the display: ${dv:0:60}"

  docker exec -u dev "${CONTAINER}" bash -lc 'agent-env x-cookie' 2>/dev/null | grep -q MIT-MAGIC-COOKIE \
    && ok "the cookie can be read out for a forwarded display" \
    || bad "agent-env x-cookie produced no cookie"

  head_ "Credentials"

  # A secret passed with -e stays in the container config, but it must not
  # reach the daemons — the OpenCode server runs code the agent was asked to run.
  leak=$(docker exec -u dev "${CONTAINER}" sh -c '
    p=$(pgrep -f "opencode2 serve" | head -1)
    if [ -z "$p" ]; then echo no-process; exit 0; fi
    tr "\0" "\n" < /proc/$p/environ |
      grep -cE "^(GOOGLE_CLIENT_SECRET|GATEWAY_PASSWORD|OAUTH2_PROXY_COOKIE_SECRET)=" || true
  ' 2>/dev/null || true)
  case "${leak}" in
    0)  ok "gateway credentials are absent from the OpenCode server's environment" ;;
    no-process) bad "the OpenCode server is not running, so nothing was checked" ;;
    "") bad "could not read the OpenCode server's environment" ;;
    *)  bad "${leak} gateway credential(s) visible to the agent's own process" ;;
  esac

  head_ "Persistence"

  # Tools the agent declares must outlive the container, so the declarations
  # have to sit in the home directory rather than the image.
  mcd=$(docker exec -u dev "${CONTAINER}" bash -lc 'echo "$MISE_CONFIG_DIR"' 2>/dev/null | tr -d '\r')
  case "${mcd}" in
    /home/dev/*) ok "mise declarations go to the home directory (${mcd})" ;;
    *)           bad "MISE_CONFIG_DIR is '${mcd:-unset}', so 'mise use -g' would not persist" ;;
  esac

  # ...while the image keeps owning its own toolchain, so updates land.
  docker exec "${CONTAINER}" grep -q node /etc/mise/config.toml 2>/dev/null \
    && ok "the image still declares its own toolchain in /etc/mise" \
    || bad "/etc/mise/config.toml no longer declares the image toolchain"

  head_ "Toolchain"

  locked=$(docker exec "${CONTAINER}" python3 -c '
import tomllib
with open("/etc/mise/mise.lock", "rb") as fh:
    print(tomllib.load(fh)["tools"]["node"][0]["version"])' 2>/dev/null || true)
  running=$(docker exec -u dev "${CONTAINER}" bash -lc 'node --version' 2>/dev/null | tr -d 'v\r')
  if [[ -z "${locked}" ]]; then
    bad "no /etc/mise/mise.lock, so the build is not pinned or checksum-verified"
  elif [[ "${locked}" == "${running}" ]]; then
    ok "node matches the lockfile (${running})"
  else
    bad "node is ${running:-unknown} but the lockfile says ${locked}"
  fi

  # Interactive shells get the full activation; non-interactive ones must not,
  # since there is no prompt for the hook and shims already resolve versions.
  act=$(docker exec -u dev "${CONTAINER}" bash -ic 'echo "${MISE_SHELL:-no}"' 2>/dev/null | tr -d '\r')
  [[ "${act}" == bash ]] && ok "interactive shells activate mise (project env and hooks work)" \
                         || bad "interactive shell did not activate mise: '${act}'"
  noact=$(docker exec -u dev "${CONTAINER}" bash -c 'echo "${MISE_SHELL:-no}"' 2>/dev/null | tr -d '\r')
  [[ "${noact}" == no ]] && ok "non-interactive shells use shims alone" \
                         || bad "non-interactive shell activated mise: '${noact}'"

  # An untrusted repo config must not be able to inject env into a shell.
  docker exec -u dev "${CONTAINER}" bash -c '
    mkdir -p /tmp/untrusted && printf "[env]\nSMOKE_INJECTED = \"yes\"\n" > /tmp/untrusted/mise.toml' 2>/dev/null
  inj=$(docker exec -u dev -w /tmp/untrusted "${CONTAINER}" bash -ic 'echo "${SMOKE_INJECTED:-no}"' 2>/dev/null | tr -d '\r')
  [[ "${inj}" == no ]] && ok "an untrusted mise.toml cannot set env in a shell" \
                       || bad "untrusted mise.toml injected env: '${inj}'"

  head_ "SSH host keys"

  keydir=$(docker exec "${CONTAINER}" sh -c 'ls /var/lib/agent-env/ssh/ 2>/dev/null | tr "\n" " "' || true)
  grep -q "ssh_host_ed25519_key" <<<"${keydir}" \
    && ok "host keys live in the state directory, not the image" \
    || bad "no host keys in /var/lib/agent-env/ssh: ${keydir:-none}"

  docker exec "${CONTAINER}" sh -c 'ls /etc/ssh/ssh_host_* >/dev/null 2>&1' \
    && bad "the image still carries host keys in /etc/ssh" \
    || ok "/etc/ssh has no baked-in host keys"

  head_ "File manager"

  grep -qE "dufs +running" <<<"${user_daemons}" \
    && ok "dufs runs in the dev user's supervisor" \
    || bad "dufs is not running under dev: ${user_daemons:-none}"

  c=$(code "${BASE}/files/")
  case "$c" in
    200) ok "/files/ lists the workspace (200)" ;;
    302) ok "/files/ redirects to sign-in (302)" ;;
    *)   bad "/files/ returned $c" ;;
  esac

  if [ "${auth_mode}" != none ]; then
    c=$(curl -s -o /dev/null --max-time 15 -w '%{http_code}' "${BASE}/files/")
    [[ "$c" == 401 || "$c" == 302 ]] && ok "the file manager is behind the gateway auth ($c)" \
                                     || bad "/files/ answered $c without credentials"
  fi

  # Upload and delete are the point of it; check the file really lands as dev.
  probe="smoke-upload-$$.txt"
  put=$(curl -s -o /dev/null --max-time 20 -w '%{http_code}' -u "${AUTH}" \
        --data-binary 'smoke' -X PUT "${BASE}/files/${probe}")
  owner=$(docker exec "${CONTAINER}" stat -c '%U' "/workspace/${probe}" 2>/dev/null || echo none)
  del=$(curl -s -o /dev/null --max-time 20 -w '%{http_code}' -u "${AUTH}" -X DELETE "${BASE}/files/${probe}")
  docker exec "${CONTAINER}" rm -f "/workspace/${probe}" 2>/dev/null || true
  if [[ "${put}" =~ ^20 ]] && [[ "${owner}" == dev ]] && [[ "${del}" =~ ^2 ]]; then
    ok "upload and delete work, and files are written as dev"
  else
    bad "file round trip failed (PUT ${put}, owner ${owner}, DELETE ${del})"
  fi

  # --allow-symlink is deliberately not set, so a symlink must not escape root.
  docker exec -u dev "${CONTAINER}" sh -c 'ln -sfn /etc /workspace/smoke-escape' 2>/dev/null || true
  esc=$(code "${BASE}/files/smoke-escape/passwd")
  docker exec -u dev "${CONTAINER}" rm -f /workspace/smoke-escape 2>/dev/null || true
  [[ "${esc}" == 404 || "${esc}" == 403 || "${esc}" == 302 ]] \
    && ok "a symlink cannot escape the served root (${esc})" \
    || bad "symlink escaped the served root: ${esc}"

  head_ "pitchfork web UI"
  c=$(code "${BASE}/pitchfork")
  case "$c" in
    200) ok "/pitchfork serves the daemon dashboard (200)" ;;
    302) ok "/pitchfork redirects to sign-in (302)" ;;
    *)   bad "/pitchfork returned $c" ;;
  esac
  c=$(code "${BASE}/img/logo.png")
  [[ "$c" == 200 || "$c" == 302 ]] && ok "its logo resolves through the gateway ($c)" \
                                   || bad "logo returned $c"
  if [ "${auth_mode}" != none ]; then
    c=$(curl -s -o /dev/null --max-time 15 -w '%{http_code}' "${BASE}/pitchfork")
    [[ "$c" == 401 || "$c" == 302 ]] && ok "the dashboard is behind the gateway auth ($c)" \
                                     || bad "/pitchfork answered $c without credentials"
  fi

  head_ "agent-browser"

  cfg=$(docker exec -u dev "${CONTAINER}" cat /home/dev/.agent-browser/config.json 2>/dev/null)
  grep -q '"headed": true' <<<"${cfg}" \
    && ok "headed is a user-level default in ~/.agent-browser/config.json" \
    || bad "headed default missing from agent-browser config: ${cfg}"

  # A default, not an override: env vars sit above project configs, so they
  # must not be pre-set for us.
  envset=$(docker exec -u dev "${CONTAINER}" bash -lc 'echo "${AGENT_BROWSER_HEADED:-unset}"')
  [[ "${envset}" == "unset" ]] && ok "AGENT_BROWSER_HEADED not forced in the environment" \
                               || bad "AGENT_BROWSER_HEADED is pre-set to '${envset}'"

  # And prove it: a plain `open` must launch a visible browser, not a headless one.
  docker exec -u dev "${CONTAINER}" bash -lc \
    'agent-browser close --all >/dev/null 2>&1; agent-browser open about:blank >/dev/null 2>&1' || true
  chrome_args=$(docker exec "${CONTAINER}" ps -eo args= | grep -m1 "[c]hromium" || true)
  if [[ -n "${chrome_args}" ]] && ! grep -q -- "--headless" <<<"${chrome_args}"; then
    ok "plain \`agent-browser open\` launched a headed Chromium"
  else
    bad "Chromium did not launch headed (args: ${chrome_args:-none})"
  fi

  for tool in fastfetch btop ncdu; do
    docker exec "${CONTAINER}" sh -c "command -v ${tool} >/dev/null" \
      && ok "${tool} installed" || bad "${tool} missing"
  done

  head_ "mosh"
  docker exec "${CONTAINER}" sh -c 'command -v mosh-server >/dev/null' \
    && ok "mosh-server present ($(docker exec "${CONTAINER}" sh -c 'mosh-server --version 2>&1 | head -1'))" \
    || bad "mosh-server missing"

  head_ "Logging"
  logs=$(docker logs "${CONTAINER}" 2>&1 | grep -c '^\[global/')
  [[ "$logs" -gt 0 ]] && ok "daemon output reaches docker logs (${logs} lines)" \
                      || bad "no daemon output in docker logs"
fi

head_ "Result"
printf '  %d passed, %d failed\n\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
