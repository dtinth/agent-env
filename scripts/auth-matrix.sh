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

# Boot with the given environment and wait for oauth2-proxy to report ready.
# $1 is the label, the rest are docker run arguments; every case supplies its
# own AUTH_MODE and allow list, since those are half of what is under test.
try() {
  local label="$1"; shift
  docker rm -f "${NAME}" >/dev/null 2>&1
  docker run -d --name "${NAME}" --shm-size=1g \
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

GOOGLE=(-e AUTH_MODE=google -e ALLOWED_EMAILS=me@example.com)
GITHUB=(-e AUTH_MODE=github)

printf '\n\033[1mWays of supplying the gateway secrets\033[0m\n'
try "GOOGLE_* only, cookie secret generated" "${GOOGLE[@]}" \
  -e GOOGLE_CLIENT_ID=a.apps.googleusercontent.com -e GOOGLE_CLIENT_SECRET=GOCSPX-a
try "GOOGLE_* plus OAUTH2_PROXY_COOKIE_SECRET" "${GOOGLE[@]}" \
  -e GOOGLE_CLIENT_ID=a.apps.googleusercontent.com -e GOOGLE_CLIENT_SECRET=GOCSPX-a \
  -e "OAUTH2_PROXY_COOKIE_SECRET=${SECRET}"
try "OAUTH2_PROXY_* only" "${GOOGLE[@]}" \
  -e OAUTH2_PROXY_CLIENT_ID=b.apps.googleusercontent.com -e OAUTH2_PROXY_CLIENT_SECRET=GOCSPX-b \
  -e "OAUTH2_PROXY_COOKIE_SECRET=${SECRET}"
try "secret from a file, cookie from the environment" "${GOOGLE[@]}" \
  -e GOOGLE_CLIENT_ID=a.apps.googleusercontent.com -e GOOGLE_CLIENT_SECRET_FILE=/etc/hostname \
  -e "OAUTH2_PROXY_COOKIE_SECRET=${SECRET}"

printf '\n\033[1mGitHub sign-in\033[0m\n'
try "GITHUB_* with a user allow list" "${GITHUB[@]}" \
  -e GITHUB_CLIENT_ID=Iv1.aaaaaaaaaaaaaaaa -e GITHUB_CLIENT_SECRET=ghs-a \
  -e GITHUB_USERS=octocat
try "GITHUB_* restricted to an org and teams" "${GITHUB[@]}" \
  -e GITHUB_CLIENT_ID=Iv1.aaaaaaaaaaaaaaaa -e GITHUB_CLIENT_SECRET=ghs-a \
  -e GITHUB_ORG=acme -e "GITHUB_TEAM=eng, ops" \
  -e "OAUTH2_PROXY_COOKIE_SECRET=${SECRET}"
try "GITHUB_* narrowed by email as well" "${GITHUB[@]}" \
  -e GITHUB_CLIENT_ID=Iv1.aaaaaaaaaaaaaaaa -e GITHUB_CLIENT_SECRET_FILE=/etc/hostname \
  -e GITHUB_ORG=acme -e ALLOWED_EMAIL_DOMAINS=example.com
try "OAUTH2_PROXY_* only, GitHub provider" "${GITHUB[@]}" \
  -e OAUTH2_PROXY_CLIENT_ID=Iv1.bbbbbbbbbbbbbbbb -e OAUTH2_PROXY_CLIENT_SECRET=ghs-b \
  -e GITHUB_USERS=octocat -e "OAUTH2_PROXY_COOKIE_SECRET=${SECRET}"
try "GITHUB_* by email alone, no account restriction" "${GITHUB[@]}" \
  -e GITHUB_CLIENT_ID=Iv1.aaaaaaaaaaaaaaaa -e GITHUB_CLIENT_SECRET=ghs-a \
  -e ALLOWED_EMAILS=me@example.com

# The rendered flags, rather than whether it booted. oauth2-proxy starts
# happily with a scope that cannot complete a sign-in, and with an allow list
# that allows everybody — neither shows up as a failure to come up.
printf '\n\033[1mWhat GitHub mode actually renders\033[0m\n'
args_for() {
  docker rm -f "${NAME}" >/dev/null 2>&1
  docker run -d --name "${NAME}" --shm-size=1g \
    -e PUBLIC_URL=https://example.invalid \
    -e DESKTOP_ENABLE=false -e AB_DASHBOARD_ENABLE=false -e DUFS_ENABLE=false \
    -e AUTH_MODE=github -e GITHUB_CLIENT_ID=Iv1.a -e GITHUB_CLIENT_SECRET=ghs-a \
    "$@" "${IMAGE}" >/dev/null 2>&1
  local i
  for i in $(seq 1 24); do
    if docker exec "${NAME}" test -r /run/agent-env/oauth2-proxy.args 2>/dev/null; then
      docker exec "${NAME}" cat /run/agent-env/oauth2-proxy.args; break
    fi
    docker inspect -f '{{.State.Running}}' "${NAME}" 2>/dev/null | grep -q true || break
    sleep 2
  done
  docker rm -f "${NAME}" >/dev/null 2>&1
}

check() {
  local label="$1" haystack="$2" needle="$3"
  if grep -qxF -- "${needle}" <<<"${haystack}"; then
    printf '  \033[32m✓\033[0m %s\n' "${label}"; pass=$((pass+1))
  else
    printf '  \033[31m✗\033[0m %s (no %s)\n' "${label}" "${needle}"; fail=$((fail+1))
  fi
}
refute() {
  local label="$1" haystack="$2" needle="$3"
  if grep -qxF -- "${needle}" <<<"${haystack}"; then
    printf '  \033[31m✗\033[0m %s (found %s)\n' "${label}" "${needle}"; fail=$((fail+1))
  else
    printf '  \033[32m✓\033[0m %s\n' "${label}"; pass=$((pass+1))
  fi
}

# EnrichSession reads /user/orgs and /user/teams on every sign-in, whether or
# not an org is configured, and both need read:org. A username-only deployment
# without it gets a callback that fails after the user has already consented.
out=$(args_for -e GITHUB_USERS=octocat)
check "a username-only allow list still asks for read:org" \
  "${out}" "--scope=user:email read:org"
check "a username-only allow list restricts by user" \
  "${out}" "--github-user=octocat"
check "with no email rule, every address is acceptable" \
  "${out}" "--email-domain=*"

# An email rule is the boundary here, so the wildcard would dissolve it.
out=$(args_for -e ALLOWED_EMAIL_DOMAINS=example.com)
refute "an email rule is not widened to every address" \
  "${out}" "--email-domain=*"
check "an email rule is passed through" "${out}" "--email-domain=example.com"

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

out=$(docker run --rm --name "${NAME}" -e AUTH_MODE=github -e GITHUB_CLIENT_ID=a \
      -e GITHUB_CLIENT_SECRET=b -e PUBLIC_URL=https://example.invalid \
      "${IMAGE}" 2>&1 | grep -c "AUTH_MODE=github requires GITHUB_USERS" || true)
[[ "${out}" -ge 1 ]] && { printf '  \033[32m✓\033[0m GitHub with no allow list refuses to start\n'; pass=$((pass+1)); } \
                     || { printf '  \033[31m✗\033[0m GitHub with no allow list did not refuse\n'; fail=$((fail+1)); }

out=$(docker run --rm --name "${NAME}" -e AUTH_MODE=github -e GITHUB_USERS=octocat \
      -e PUBLIC_URL=https://example.invalid \
      "${IMAGE}" 2>&1 | grep -c "requires GITHUB_CLIENT_ID" || true)
[[ "${out}" -ge 1 ]] && { printf '  \033[32m✓\033[0m GitHub with no client ID names the variable it wants\n'; pass=$((pass+1)); } \
                     || { printf '  \033[31m✗\033[0m GitHub with no client ID did not name the variable\n'; fail=$((fail+1)); }

# A list that is punctuation only renders no restriction at all, and with the
# email wildcard that is an open door rather than a locked one. It has to be
# refused where an empty list is, not counted as an allow list.
out=$(docker run --rm --name "${NAME}" -e AUTH_MODE=github -e GITHUB_CLIENT_ID=a \
      -e GITHUB_CLIENT_SECRET=b -e "GITHUB_USERS=, ," -e "ALLOWED_EMAILS= " \
      -e PUBLIC_URL=https://example.invalid \
      "${IMAGE}" 2>&1 | grep -c "AUTH_MODE=github requires GITHUB_USERS" || true)
[[ "${out}" -ge 1 ]] && { printf '  \033[32m✓\033[0m an allow list of only separators is refused, not obeyed\n'; pass=$((pass+1)); } \
                     || { printf '  \033[31m✗\033[0m an allow list of only separators was accepted\n'; fail=$((fail+1)); }

out=$(docker run --rm --name "${NAME}" -e AUTH_MODE=google -e GOOGLE_CLIENT_ID=a \
      -e GOOGLE_CLIENT_SECRET=b -e "ALLOWED_EMAILS=," -e "ALLOWED_EMAIL_DOMAINS= " \
      -e PUBLIC_URL=https://example.invalid \
      "${IMAGE}" 2>&1 | grep -c "requires ALLOWED_EMAILS" || true)
[[ "${out}" -ge 1 ]] && { printf '  \033[32m✓\033[0m the same holds for Google\n'; pass=$((pass+1)); } \
                     || { printf '  \033[31m✗\033[0m Google accepted an allow list of only separators\n'; fail=$((fail+1)); }

printf '\n  %d passed, %d failed\n\n' "${pass}" "${fail}"
[[ "${fail}" == 0 ]]
