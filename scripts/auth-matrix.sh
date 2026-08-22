#!/usr/bin/env bash
# Boot the image once per way of supplying the gateway's secrets, and check
# oauth2-proxy actually comes up.
#
#   scripts/auth-matrix.sh [image]
#
# The smoke suite cannot see this class of bug: it tests one running container,
# while these are mistakes in how the entrypoint *renders* configuration for a
# particular combination of inputs. A branch here once skipped the
# --cookie-secret-file flag for values given as OAUTH2_PROXY_COOKIE_SECRET,
# which a later change then unset — so oauth2-proxy got neither.
set -uo pipefail

IMAGE="${1:-agent-env:latest}"
NAME="auth-matrix-$$"
SECRET="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"

pass=0; fail=0
cleanup() { docker rm -f "${NAME}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

try() {
  local label="$1"; shift
  docker rm -f "${NAME}" >/dev/null 2>&1
  docker run -d --name "${NAME}" --shm-size=1g \
    -e AUTH_MODE=google -e ALLOWED_EMAILS=me@example.com \
    -e PUBLIC_URL=https://example.invalid \
    -e DESKTOP_ENABLE=false -e AB_DASHBOARD_ENABLE=false -e DUFS_ENABLE=false \
    "$@" "${IMAGE}" >/dev/null 2>&1

  local ready=0 i
  for i in $(seq 1 24); do
    if docker logs "${NAME}" 2>&1 | grep -q "oauth2-proxy ready"; then ready=1; break; fi
    if ! docker inspect -f '{{.State.Running}}' "${NAME}" 2>/dev/null | grep -q true; then break; fi
    sleep 2
  done

  if [[ "${ready}" == 1 ]]; then
    printf '  \033[32m✓\033[0m %s\n' "${label}"; pass=$((pass+1))
  else
    printf '  \033[31m✗\033[0m %s\n' "${label}"; fail=$((fail+1))
    docker logs "${NAME}" 2>&1 | grep -iE "invalid configuration|missing setting|ERROR" | head -3 | sed 's/^/      /'
  fi
  docker rm -f "${NAME}" >/dev/null 2>&1
}

printf '\n\033[1mWays of supplying the gateway secrets\033[0m\n'
try "GOOGLE_* only, cookie secret generated" \
  -e GOOGLE_CLIENT_ID=a.apps.googleusercontent.com -e GOOGLE_CLIENT_SECRET=GOCSPX-a
try "GOOGLE_* plus OAUTH2_PROXY_COOKIE_SECRET" \
  -e GOOGLE_CLIENT_ID=a.apps.googleusercontent.com -e GOOGLE_CLIENT_SECRET=GOCSPX-a \
  -e "OAUTH2_PROXY_COOKIE_SECRET=${SECRET}"
try "OAUTH2_PROXY_* only" \
  -e OAUTH2_PROXY_CLIENT_ID=b.apps.googleusercontent.com -e OAUTH2_PROXY_CLIENT_SECRET=GOCSPX-b \
  -e "OAUTH2_PROXY_COOKIE_SECRET=${SECRET}"
try "secret from a file, cookie from the environment" \
  -e GOOGLE_CLIENT_ID=a.apps.googleusercontent.com -e GOOGLE_CLIENT_SECRET_FILE=/etc/hostname \
  -e "OAUTH2_PROXY_COOKIE_SECRET=${SECRET}"

printf '\n\033[1mRefusals\033[0m\n'
out=$(docker run --rm --name "${NAME}" -e AUTH_MODE=google -e GOOGLE_CLIENT_ID=a \
      -e GOOGLE_CLIENT_SECRET=b -e ALLOWED_EMAILS=me@example.invalid \
      -e PUBLIC_URL=https://example.invalid -e OAUTH2_PROXY_COOKIE_SECRET=tooshort \
      "${IMAGE}" 2>&1 | grep -c "needs 16, 24 or 32" || true)
[[ "${out}" -ge 1 ]] && { printf '  \033[32m✓\033[0m a wrong-length cookie secret is rejected by name\n'; pass=$((pass+1)); } \
                     || { printf '  \033[31m✗\033[0m a wrong-length cookie secret was not caught\n'; fail=$((fail+1)); }

out=$(docker run --rm --name "${NAME}" -e AUTH_MODE=google -e GOOGLE_CLIENT_ID=a \
      -e GOOGLE_CLIENT_SECRET=b -e PUBLIC_URL=https://example.invalid \
      "${IMAGE}" 2>&1 | grep -c "requires ALLOWED_EMAILS" || true)
[[ "${out}" -ge 1 ]] && { printf '  \033[32m✓\033[0m a missing allow list refuses to start\n'; pass=$((pass+1)); } \
                     || { printf '  \033[31m✗\033[0m a missing allow list did not refuse\n'; fail=$((fail+1)); }

printf '\n  %d passed, %d failed\n\n' "${pass}" "${fail}"
[[ "${fail}" == 0 ]]
