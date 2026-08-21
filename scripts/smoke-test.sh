#!/usr/bin/env bash
# End-to-end check of a running oc-env container.
#
#   scripts/smoke-test.sh [base-url] [user:password]
#
# Defaults assume the basic-auth quick start on localhost:8080. With
# AUTH_MODE=google every gated route answers 302 to the sign-in page instead of
# 200, which this script reports as OK-redirected.
set -uo pipefail

BASE="${1:-http://localhost:8080}"
AUTH="${2:-opencode:changeme}"
CONTAINER="${CONTAINER:-oc-env}"

pass=0; fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; fail=$((fail+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

code() { curl -s -o /dev/null --max-time 15 -w '%{http_code}' -u "${AUTH}" "$1"; }

head_ "Gateway routes"
c=$(curl -s -o /dev/null --max-time 15 -w '%{http_code}' "${BASE}/healthz")
[[ "$c" == 200 ]] && ok "/healthz open without auth (200)" || bad "/healthz returned $c"

c=$(curl -s -o /dev/null --max-time 15 -w '%{http_code}' "${BASE}/")
case "$c" in
  401|302) ok "/ rejects unauthenticated requests ($c)" ;;
  *)       bad "/ returned $c without credentials — expected 401 or 302" ;;
esac

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

  down=$(docker exec "${CONTAINER}" pitchfork list 2>/dev/null | grep -vc running)
  [[ "$down" == 0 ]] && ok "every daemon is running" \
                     || { bad "$down daemon(s) not running"; docker exec "${CONTAINER}" pitchfork list; }

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

  docker exec "${CONTAINER}" test -w /tmp/fslock \
    && ok "/tmp/fslock is shared, so any user can run a supervisor" \
    || bad "/tmp/fslock is not writable by other users"

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
