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

# The reserved prefix and the paths under it are a contract the entrypoint
# publishes; read them rather than hardcoding, so this test fails for the right
# reason if one of them moves.
runtime_var() {
  docker exec "${CONTAINER}" sh -c "sed -n 's/^$1=//p' /run/agent-env/env" 2>/dev/null | tr -d '\r'
}
ENV_PREFIX=""; TTYD_PATH=""; DESKTOP_PATH=""; DUFS_PATH=""; HEALTH_PATH=""; USER_WEB_PATH=""
OPENCODE_ENABLE=""; PRIMARY_PORT=""
if command -v docker >/dev/null && docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  OPENCODE_ENABLE=$(runtime_var OPENCODE_ENABLE)
  USER_WEB_ENABLE=$(runtime_var USER_WEB_ENABLE)
  PRIMARY_PORT=$(runtime_var PRIMARY_PORT)
  ENV_PREFIX=$(runtime_var ENV_PREFIX)
  TTYD_PATH=$(runtime_var TTYD_PATH)
  DESKTOP_PATH=$(runtime_var DESKTOP_PATH)
  DUFS_PATH=$(runtime_var DUFS_PATH)
  HEALTH_PATH=$(runtime_var HEALTH_PATH)
  USER_WEB_PATH=$(runtime_var USER_WEB_PATH)
fi
ENV_PREFIX="${ENV_PREFIX:-~env}"
TTYD_PATH="${TTYD_PATH:-${ENV_PREFIX}/terminal}"
DESKTOP_PATH="${DESKTOP_PATH:-${ENV_PREFIX}/desktop}"
DUFS_PATH="${DUFS_PATH:-${ENV_PREFIX}/files}"
HEALTH_PATH="${HEALTH_PATH:-${ENV_PREFIX}/healthz}"
USER_WEB_PATH="${USER_WEB_PATH:-pitchfork}"
USER_WEB_ENABLE="${USER_WEB_ENABLE:-true}"
OPENCODE_ENABLE="${OPENCODE_ENABLE:-true}"
PRIMARY_PORT="${PRIMARY_PORT:-3000}"

head_ "Gateway routes"
c=$(curl -s -o /dev/null --max-time 15 -w '%{http_code}' "${BASE}/${HEALTH_PATH}")
[[ "$c" == 200 ]] && ok "/${HEALTH_PATH} open without auth (200)" \
                  || bad "/${HEALTH_PATH} returned $c"

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

for path in / "/${ENV_PREFIX}/" "/${TTYD_PATH}/" "/${DESKTOP_PATH}/vnc.html"; do
  c=$(code "${BASE}${path}")
  case "$c" in
    200) ok "${path} serves (200)" ;;
    302) ok "${path} redirects to sign-in (302)" ;;
    502) if [[ "${path}" == / && "${OPENCODE_ENABLE}" != true ]]; then
           ok "/ has no upstream yet and falls back to the index (502)"
         else
           bad "${path} returned $c"
         fi ;;
    *)   bad "${path} returned $c" ;;
  esac
done

head_ "Reserved prefix"
# The point of /${ENV_PREFIX}/: the environment answers for everything under it
# and for nothing above it, so whatever is at / owns its whole path space.

c=$(code "${BASE}/${ENV_PREFIX}/no-such-service")
case "$c" in
  404) ok "an unknown path under /${ENV_PREFIX}/ is answered here, not proxied (404)" ;;
  302) ok "an unknown path under /${ENV_PREFIX}/ hits the sign-in gate first (302)" ;;
  *)   bad "/${ENV_PREFIX}/no-such-service returned $c — it fell through to the primary service" ;;
esac

# Old squatted paths must now belong to whatever answers at /. Comparing bodies
# rather than status codes keeps this honest in every auth mode: under google
# both are the same 302, under basic both are the same app shell.
root_body=$(curl -s --max-time 15 -u "${AUTH}" "${BASE}/" | md5sum | cut -d' ' -f1)
for path in /terminal /desktop /files /img/logo.png; do
  body=$(curl -s --max-time 15 -u "${AUTH}" "${BASE}${path}" | md5sum | cut -d' ' -f1)
  [[ "${body}" == "${root_body}" ]] \
    && ok "${path} reaches the primary service, no longer squatted" \
    || bad "${path} does not match / — something still owns it"
done

# The daemons UI cannot be nested (pitchfork validates its web path as one
# segment), so the prefix redirects to it instead. That redirect is the only
# reason /${ENV_PREFIX}/ is a complete index of the environment.
if [ "${auth_mode}" != google ] && [ "${USER_WEB_ENABLE}" = true ]; then
  loc=$(curl -s -o /dev/null --max-time 15 -u "${AUTH}" -w '%{redirect_url}' \
        "${BASE}/${ENV_PREFIX}/daemons")
  [[ "${loc}" == *"/${USER_WEB_PATH}" ]] \
    && ok "/${ENV_PREFIX}/daemons redirects to /${USER_WEB_PATH}" \
    || bad "/${ENV_PREFIX}/daemons redirected to '${loc}', expected /${USER_WEB_PATH}"
fi

# /img/logo.png is hardcoded absolute in pitchfork's bundle. It is scoped by
# Referer so it cannot shadow the same path in a user's own app — the loop above
# proves the fallthrough, this proves the UI still gets its logo.
if [ "${auth_mode}" != google ] && [ "${USER_WEB_ENABLE}" = true ]; then
  ctype=$(curl -s -o /dev/null --max-time 15 -u "${AUTH}" -w '%{content_type}' \
          -H "Referer: ${BASE}/${USER_WEB_PATH}" "${BASE}/img/logo.png")
  [[ "${ctype}" == image/* ]] \
    && ok "/img/logo.png serves pitchfork's logo when the daemons UI asks (${ctype})" \
    || bad "/img/logo.png returned ${ctype:-nothing} for the daemons UI"
fi

if [ "${auth_mode}" != none ]; then
  c=$(curl -s -o /dev/null --max-time 15 -w '%{http_code}' "${BASE}/${ENV_PREFIX}/")
  [[ "$c" == 401 || "$c" == 302 ]] \
    && ok "the environment index is behind the gateway auth ($c)" \
    || bad "/${ENV_PREFIX}/ answered $c without credentials"
fi

head_ "Primary service at /"
if command -v docker >/dev/null && docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  # The OpenCode server's own basic-auth credential is injected at /. It exists
  # to reach OpenCode and nothing else, so if / is ever pointed at someone's own
  # application that header must not follow it there.
  inj=$(docker exec "${CONTAINER}" grep -c 'header_up Authorization' /etc/caddy/Caddyfile 2>/dev/null | head -1)
  inj="${inj:-0}"
  if [ "${OPENCODE_ENABLE}" = true ]; then
    [[ "${inj}" -ge 1 ]] \
      && ok "the OpenCode credential is injected at / (${inj})" \
      || bad "no Authorization injection at / — the OpenCode server will reject requests"
  else
    [[ "${inj}" -eq 0 ]] \
      && ok "no credential is injected at / while OpenCode is off" \
      || bad "${inj} Authorization injection(s) would leak the OpenCode credential into another app"
  fi

  # The healthcheck has to follow the configuration: an unconditional probe of
  # the OpenCode port marks an OpenCode-off container unhealthy forever.
  docker exec "${CONTAINER}" /opt/agent-env/bin/healthcheck >/dev/null 2>&1 \
    && ok "the healthcheck passes with OPENCODE_ENABLE=${OPENCODE_ENABLE}" \
    || bad "the healthcheck fails with OPENCODE_ENABLE=${OPENCODE_ENABLE}"
fi

# Behind google auth every one of these bounces to sign-in before it can reach a
# service, so they would be testing the gate rather than the routing.
if [ "${OPENCODE_ENABLE}" != true ] && [ "${auth_mode}" != google ]; then
  # Nothing is listening on PRIMARY_PORT yet, so / should explain itself rather
  # than show a bare 502. Caddy keeps the error status, which is honest — the
  # body is what matters here.
  body=$(curl -s --max-time 15 -u "${AUTH}" "${BASE}/")
  grep -q 'proxies to port' <<<"${body}" \
    && ok "/ falls back to the environment index while nothing is on ${PRIMARY_PORT}" \
    || bad "/ did not fall back to the index: ${body:0:80}"

  if command -v docker >/dev/null && docker inspect "${CONTAINER}" >/dev/null 2>&1; then
    # And a real server on that port takes / over, without touching the prefix.
    docker exec -u dev "${CONTAINER}" sh -c 'cat > /tmp/smoke-primary.py <<PY
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b=b"SMOKE-PRIMARY "+self.path.encode()
        self.send_response(200); self.send_header("Content-Length",str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def log_message(self,*a): pass
http.server.HTTPServer(("127.0.0.1",'"${PRIMARY_PORT}"'),H).serve_forever()
PY' 2>/dev/null
    docker exec -u dev -d "${CONTAINER}" python3 /tmp/smoke-primary.py 2>/dev/null
    for _ in $(seq 1 15); do
      curl -s --max-time 5 -u "${AUTH}" "${BASE}/" | grep -q SMOKE-PRIMARY && break
      sleep 1
    done

    grep -q 'SMOKE-PRIMARY /' <<<"$(curl -s --max-time 15 -u "${AUTH}" "${BASE}/")" \
      && ok "a server on ${PRIMARY_PORT} takes over /" \
      || bad "a server on ${PRIMARY_PORT} did not take over /"

    grep -q 'SMOKE-PRIMARY /deep/app/route' <<<"$(curl -s --max-time 15 -u "${AUTH}" "${BASE}/deep/app/route")" \
      && ok "it owns the whole path space below /" \
      || bad "a nested app route did not reach the primary service"

    # The point of the reserved prefix: an app at / cannot take it.
    grep -q 'agent-env' <<<"$(curl -s --max-time 15 -u "${AUTH}" "${BASE}/${ENV_PREFIX}/")" \
      && ok "/${ENV_PREFIX}/ still belongs to the environment with an app at /" \
      || bad "/${ENV_PREFIX}/ was captured by the primary service"

    docker exec "${CONTAINER}" sh -c 'pkill -f "[s]moke-primary.py"; rm -f /tmp/smoke-primary.py' 2>/dev/null || true

    # /${USER_WEB_PATH} is reserved only while the daemons dashboard is actually
    # rendered. With it off that path is the primary service's like any other,
    # so it has to fall back the same way instead of showing a bare 502.
    if [ "${USER_WEB_ENABLE}" != true ]; then
      grep -q 'proxies to port' <<<"$(curl -s --max-time 15 -u "${AUTH}" "${BASE}/${USER_WEB_PATH}")" \
        && ok "/${USER_WEB_PATH} falls back like any primary path while the dashboard is off" \
        || bad "/${USER_WEB_PATH} is still excluded from the fallback though nothing routes it"
    fi
  fi
fi

# Read out of the rendered config rather than over HTTP, so it holds in every
# auth mode: ttyd exists to run the OpenCode TUI, and with no server to attach
# to it would sit on a connect loop instead of giving you a usable terminal.
if [ "${OPENCODE_ENABLE}" != true ] \
   && command -v docker >/dev/null && docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  ttyd_cmd=$(docker exec "${CONTAINER}" \
    sed -n 's/^TTYD_COMMAND = "\(.*\)"/\1/p' /opt/agent-env/pitchfork/config.toml 2>/dev/null | tr -d '\r')
  [[ "${ttyd_cmd}" == shell ]] \
    && ok "the browser terminal falls back to a login shell" \
    || bad "TTYD_COMMAND is '${ttyd_cmd:-unset}', expected shell"
fi

head_ "Published configuration"
# Everything downstream of /run/agent-env/env compares against literal true or
# false: the healthcheck, the `agent-env` helper, this suite. The entrypoint
# accepts 1/yes/on/enabled as well, so publishing the raw value desynchronises
# every reader from what it actually decided — OPENCODE_ENABLE=1 starts the
# server and injects its credential while a reader concludes it is off and
# stops probing it.
if command -v docker >/dev/null && docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  noncanon=$(docker exec "${CONTAINER}" sh -c \
    "grep -E '^[A-Z_]+_ENABLE=' /run/agent-env/env | grep -vE '=(true|false)$'" 2>/dev/null || true)
  [[ -z "${noncanon}" ]] \
    && ok "every published *_ENABLE flag is a literal true or false" \
    || bad "non-canonical flags would desync the healthcheck and helper: ${noncanon//$'\n'/, }"
fi

# An oversized *_FILE variable used to take the container out entirely: the
# entrypoint exported the whole file, which pushed one variable past the
# kernel's per-string limit and made every later exec fail with "Argument list
# too long" — pointing at whichever command ran next rather than at the
# variable. Only asserted when the caller actually passed one, so a plain local
# run skips it; CI sets it on the OpenCode-off container, which costs nothing
# extra. Reaching this point at all means the container came up.
#
# Both greps read from a variable rather than a pipe on purpose: this script
# runs under `set -o pipefail`, and `grep -q` exits at the first match, so
# `docker logs | grep -q` SIGPIPEs the producer and the pipeline reports
# failure even when the pattern matched.
if command -v docker >/dev/null && docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  cfg_env=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${CONTAINER}" 2>/dev/null || true)
  if grep -q '^SMOKE_OVERSIZE_FILE=' <<<"${cfg_env}"; then
    container_logs=$(docker logs "${CONTAINER}" 2>&1 || true)
    grep -q 'over the .*-byte limit for a file secret' <<<"${container_logs}" \
      && ok "an oversized *_FILE is refused by name instead of bricking the container" \
      || bad "no size-limit warning for SMOKE_OVERSIZE_FILE — the guard did not run"
  fi
fi

head_ "Readiness probes"
# A ready_http that never passes is invisible for one probe window and then
# restarts the daemon forever. Moving /healthz under the reserved prefix broke
# exactly this once already, so check every probe on its own terms: the URL the
# supervisor will actually fetch, with no credentials, since it has none.
if command -v docker >/dev/null && docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  probes=$(docker exec "${CONTAINER}" sh -c \
    "grep -o 'ready_http = { url = \"[^\"]*\"' /opt/agent-env/pitchfork/config.toml \
     | sed 's/.*url = \"//; s/\"$//'" 2>/dev/null | tr -d '\r')
  if [[ -z "${probes}" ]]; then
    bad "no ready_http probes found in the generated config — did the format change?"
  else
    while read -r url; do
      [[ -n "${url}" ]] || continue
      c=$(docker exec "${CONTAINER}" curl -s -o /dev/null --max-time 10 -w '%{http_code}' "${url}")
      [[ "$c" == 200 ]] \
        && ok "readiness probe ${url} passes unauthenticated (200)" \
        || bad "readiness probe ${url} answered $c — that daemon will restart-loop"
    done <<<"${probes}"
  fi

  # And prove it stayed up: a daemon caught in the loop shows as errored or
  # flips back to running a moment later.
  state=$(docker exec -e PITCHFORK_STATE_DIR=/var/lib/pitchfork \
            -e PITCHFORK_CONFIG_DIR=/opt/agent-env/pitchfork \
            "${CONTAINER}" pitchfork list 2>/dev/null | grep -E '^global/caddy' || true)
  grep -q running <<<"${state}" \
    && ok "caddy is running, not cycling (${state//  */})" \
    || bad "caddy is not running: ${state:-not listed}"
fi

head_ "VNC websocket (browser path)"
# --http1.1 matters over TLS: curl would otherwise negotiate HTTP/2, where
# `Connection: Upgrade` is not a thing, and the request would arrive upstream as
# a plain GET and 404. Browsers open wss:// over HTTP/1.1, which is what this
# imitates.
if [ "${auth_mode}" != google ]; then
  c=$(curl -s -o /dev/null --max-time 6 --http1.1 -w '%{http_code}' -u "${AUTH}" \
        -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
        -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
        "${BASE}/${DESKTOP_PATH}/websockify")
  [[ "$c" == 101 ]] && ok "websockify upgrade (101 Switching Protocols)" \
                    || bad "websockify upgrade returned $c"
fi

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
  if [ "${OPENCODE_ENABLE}" = true ]; then
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
  else
    grep -qE "opencode" <<<"${user_daemons}" \
      && bad "opencode is defined despite OPENCODE_ENABLE=false: ${user_daemons}" \
      || ok "no opencode daemon is defined while disabled"
  fi

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

  if [ "${OPENCODE_ENABLE}" = true ]; then

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
  fi

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

  c=$(code "${BASE}/${DUFS_PATH}/")
  case "$c" in
    200) ok "/${DUFS_PATH}/ lists the workspace (200)" ;;
    302) ok "/${DUFS_PATH}/ redirects to sign-in (302)" ;;
    *)   bad "/${DUFS_PATH}/ returned $c" ;;
  esac

  if [ "${auth_mode}" != none ]; then
    c=$(curl -s -o /dev/null --max-time 15 -w '%{http_code}' "${BASE}/${DUFS_PATH}/")
    [[ "$c" == 401 || "$c" == 302 ]] && ok "the file manager is behind the gateway auth ($c)" \
                                     || bad "/${DUFS_PATH}/ answered $c without credentials"
  fi

  # Upload and delete are the point of it; check the file really lands as dev.
  if [ "${auth_mode}" != google ]; then
  probe="smoke-upload-$$.txt"
  put=$(curl -s -o /dev/null --max-time 20 -w '%{http_code}' -u "${AUTH}" \
        --data-binary 'smoke' -X PUT "${BASE}/${DUFS_PATH}/${probe}")
  owner=$(docker exec "${CONTAINER}" stat -c '%U' "/workspace/${probe}" 2>/dev/null || echo none)
  del=$(curl -s -o /dev/null --max-time 20 -w '%{http_code}' -u "${AUTH}" -X DELETE "${BASE}/${DUFS_PATH}/${probe}")
  docker exec "${CONTAINER}" rm -f "/workspace/${probe}" 2>/dev/null || true
  if [[ "${put}" =~ ^20 ]] && [[ "${owner}" == dev ]] && [[ "${del}" =~ ^2 ]]; then
    ok "upload and delete work, and files are written as dev"
  else
    bad "file round trip failed (PUT ${put}, owner ${owner}, DELETE ${del})"
  fi
  fi

  # --allow-symlink is deliberately not set, so a symlink must not escape root.
  docker exec -u dev "${CONTAINER}" sh -c 'ln -sfn /etc /workspace/smoke-escape' 2>/dev/null || true
  esc=$(code "${BASE}/${DUFS_PATH}/smoke-escape/passwd")
  docker exec -u dev "${CONTAINER}" rm -f /workspace/smoke-escape 2>/dev/null || true
  [[ "${esc}" == 404 || "${esc}" == 403 || "${esc}" == 302 ]] \
    && ok "a symlink cannot escape the served root (${esc})" \
    || bad "symlink escaped the served root: ${esc}"

  head_ "pitchfork web UI"
  if [ "${USER_WEB_ENABLE}" != true ]; then
    c=$(code "${BASE}/${USER_WEB_PATH}")
    # Not routed, so the path is the primary service's — 200/502 both mean it
    # fell through, which is the point. It must not be serving a dashboard.
    grep -q 'pitchfork' <<<"$(curl -s --max-time 15 -u "${AUTH}" "${BASE}/${USER_WEB_PATH}")" \
      && bad "/${USER_WEB_PATH} still serves a dashboard though USER_WEB_ENABLE=false" \
      || ok "/${USER_WEB_PATH} is not routed while the dashboard is off ($c)"
  else
  c=$(code "${BASE}/${USER_WEB_PATH}")
  case "$c" in
    200) ok "/${USER_WEB_PATH} serves the daemon dashboard (200)" ;;
    302) ok "/${USER_WEB_PATH} redirects to sign-in (302)" ;;
    *)   bad "/${USER_WEB_PATH} returned $c" ;;
  esac
  # The Referer is load-bearing: without it this path belongs to whatever is at
  # /, which answers 200 for anything and would make this pass for free.
  c=$(curl -s -o /dev/null --max-time 15 -u "${AUTH}" -w '%{http_code}' \
      -H "Referer: ${BASE}/${USER_WEB_PATH}" "${BASE}/img/logo.png")
  [[ "$c" == 200 || "$c" == 302 ]] && ok "its logo resolves through the gateway ($c)" \
                                   || bad "logo returned $c"
  if [ "${auth_mode}" != none ]; then
    c=$(curl -s -o /dev/null --max-time 15 -w '%{http_code}' "${BASE}/${USER_WEB_PATH}")
    [[ "$c" == 401 || "$c" == 302 ]] && ok "the dashboard is behind the gateway auth ($c)" \
                                     || bad "/${USER_WEB_PATH} answered $c without credentials"
  fi
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

  head_ "Rootless Docker"

  # Opt-in, and the checks differ completely between the two states: enabled it
  # must actually work, disabled it must be genuinely absent rather than
  # half-started.
  docker_rootless=$(docker exec "${CONTAINER}" sh -c \
    'sed -n "s/^DOCKER_ROOTLESS_ENABLE=//p" /run/agent-env/env' 2>/dev/null | tr -d "\r")

  # The binaries ship either way; only the daemon is conditional.
  for bin in dockerd rootlesskit dockerd-rootless.sh; do
    docker exec "${CONTAINER}" sh -c "command -v ${bin} >/dev/null" \
      && ok "${bin} present in the image" || bad "${bin} missing"
  done
  docker exec -u dev "${CONTAINER}" bash -lc 'docker compose version' >/dev/null 2>&1 \
    && ok "the compose plugin resolves ($(docker exec -u dev "${CONTAINER}" bash -lc 'docker compose version --short' 2>/dev/null | tr -d '\r'))" \
    || bad "docker compose is not available"

  if [ "${docker_rootless}" = true ]; then
    grep -qE "dockerd +running" <<<"${user_daemons}" \
      && ok "dockerd runs in the dev user's supervisor" \
      || bad "dockerd is not running under dev: ${user_daemons:-none}"

    # It must be the user's daemon, not a second root one.
    grep -q "dockerd" <<<"${sys_daemons}" \
      && bad "dockerd is a system daemon — it should belong to dev" \
      || ok "dockerd is not in the root supervisor"

    info=$(docker exec -u dev "${CONTAINER}" bash -lc 'docker info 2>/dev/null')
    grep -q "rootless" <<<"${info}" \
      && ok "the daemon reports itself rootless" \
      || bad "docker info does not report rootless mode"

    # The whole point of the subuid range: a container's own users must map to
    # distinct host uids, or images like postgres cannot drop privileges.
    dockerd_pid=$(docker exec "${CONTAINER}" pgrep -f "dockerd --data-root" | head -1)
    if [[ -n "${dockerd_pid}" ]]; then
      ranges=$(docker exec "${CONTAINER}" sh -c "wc -l < /proc/${dockerd_pid}/uid_map" 2>/dev/null | tr -d '\r')
      [[ "${ranges:-0}" -ge 2 ]] \
        && ok "the daemon's userns maps a subuid range (${ranges} ranges)" \
        || bad "the daemon's userns has only ${ranges:-0} uid range — newuidmap did not run"
    else
      bad "could not find the rootless dockerd process"
    fi

    # Image data belongs on the home volume, not the container filesystem.
    root=$(docker exec -u dev "${CONTAINER}" bash -lc \
      'docker info --format "{{.DockerRootDir}}" 2>/dev/null' | tr -d '\r')
    case "${root}" in
      /home/dev/*) ok "image storage is on the home volume (${root})" ;;
      *)           bad "docker root dir is '${root:-unknown}', so pulled images are lost on recreate" ;;
    esac

    # The daemon's own readiness probe must be satisfiable from a bare
    # environment. It is not if it leans on DOCKER_HOST: the CLI does not fall
    # back to $XDG_RUNTIME_DIR/docker.sock, so the probe would never pass and
    # pitchfork would restart the daemon every couple of minutes, stopping
    # whatever it was running. That failure looks exactly like "my database
    # keeps dying", so check the probe rather than the symptom.
    sock=$(docker exec -u dev "${CONTAINER}" bash -lc 'echo "${DOCKER_HOST}"' | tr -d '\r')
    docker exec -u dev "${CONTAINER}" env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/dev \
      sh -c "docker -H ${sock} version >/dev/null 2>&1" \
      && ok "the readiness probe passes with no environment to lean on" \
      || bad "the readiness probe needs env that pitchfork will not give it — the daemon will restart-loop"

    # A shell must find the daemon without being told where it is.
    dh=$(docker exec -u dev "${CONTAINER}" bash -lc 'echo "${DOCKER_HOST:-unset}"' | tr -d '\r')
    [[ "${dh}" == unix://* ]] && ok "DOCKER_HOST points at the user's socket (${dh})" \
                              || bad "DOCKER_HOST is '${dh}'"
  else
    ok "rootless Docker is off by default (DOCKER_ROOTLESS_ENABLE=${docker_rootless:-unset})"
    grep -qE "dockerd" <<<"${user_daemons}" \
      && bad "dockerd is defined even though the feature is disabled" \
      || ok "no dockerd daemon is defined while disabled"
  fi

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
