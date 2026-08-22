#!/usr/bin/env bash
# agent-env entrypoint: validate configuration, render the gateway and daemon
# definitions, then hand over to pitchfork as PID 1.
set -euo pipefail

log()  { printf '\033[1;34m[agent-env]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[agent-env] WARN\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[agent-env] ERROR\033[0m %s\n' "$*" >&2; exit 1; }

USER_NAME="${USER_NAME:-dev}"
USER_HOME="/home/${USER_NAME}"
# Unprivileged account for caddy and oauth2-proxy.
GATEWAY_USER_NAME="${GATEWAY_USER_NAME:-gateway}"
GATEWAY_GROUP="${GATEWAY_GROUP:-gateway}"
RUN_DIR=/run/agent-env

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Any FOO_FILE variable is read into FOO, so secrets can come from files or
# Docker/Kubernetes secret mounts instead of the environment.
expand_file_secrets() {
  local name value target
  while IFS='=' read -r name value; do
    [[ "${name}" == *_FILE ]] || continue
    target="${name%_FILE}"
    [[ -n "${target}" ]] || continue
    [[ -r "${value}" ]] || { warn "${name}=${value} is not readable, ignoring"; continue; }
    export "${target}=$(< "${value}")"
    log "loaded ${target} from ${value}"
  done < <(env)
}

is_true() {
  case "${1,,}" in
    1|true|yes|on|enable|enabled) return 0 ;;
    *) return 1 ;;
  esac
}

rand_secret() { head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }

url_host() { sed -E 's#^[a-zA-Z]+://##; s#/.*$##' <<<"$1"; }

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
expand_file_secrets

export TZ="${TZ:-UTC}"
if [[ -e "/usr/share/zoneinfo/${TZ}" ]]; then
  ln -snf "/usr/share/zoneinfo/${TZ}" /etc/localtime
  echo "${TZ}" > /etc/timezone
fi

GATEWAY_PORT="${GATEWAY_PORT:-8080}"
# Optional interface restriction. Left empty, the gateway listens on every
# interface and serves any Host header.
GATEWAY_BIND="${GATEWAY_BIND:-}"
AUTH_MODE="${AUTH_MODE:-google}"
PUBLIC_URL="${PUBLIC_URL:-http://localhost:${GATEWAY_PORT}}"
PUBLIC_URL="${PUBLIC_URL%/}"

OPENCODE_PORT="${OPENCODE_PORT:-4096}"
OPENCODE_WORKDIR="${OPENCODE_WORKDIR:-/workspace}"

SSH_ENABLE="${SSH_ENABLE:-true}"
SSH_PORT="${SSH_PORT:-22}"

DESKTOP_ENABLE="${DESKTOP_ENABLE:-true}"
DESKTOP_RESOLUTION="${DESKTOP_RESOLUTION:-1920x1080x24}"
DESKTOP_DISPLAY="${DESKTOP_DISPLAY:-:1}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"

TTYD_ENABLE="${TTYD_ENABLE:-true}"
TTYD_PORT="${TTYD_PORT:-7681}"
TTYD_WRITABLE="${TTYD_WRITABLE:-true}"

USER_SUPERVISOR_ENABLE="${USER_SUPERVISOR_ENABLE:-true}"
# pitchfork's own web UI, served by the user's supervisor. It can start, stop
# and restart daemons, stream their logs and edit the config, so it sits behind
# the gateway's auth like everything else.
USER_WEB_ENABLE="${USER_WEB_ENABLE:-true}"
USER_WEB_PORT="${USER_WEB_PORT:-4747}"
USER_WEB_PATH="${USER_WEB_PATH:-pitchfork}"

# dufs: a file manager for the workspace, run by the user's own supervisor.
DUFS_ENABLE="${DUFS_ENABLE:-true}"
DUFS_PORT="${DUFS_PORT:-5000}"
DUFS_PATH="${DUFS_PATH:-files}"
DUFS_ROOT="${DUFS_ROOT:-${OPENCODE_WORKDIR}}"

# Generated identity that must outlive the container: SSH host keys today.
AGENT_ENV_STATE_DIR="${AGENT_ENV_STATE_DIR:-/var/lib/agent-env}"
# The X display's access cookie. Without it, every local account — including
# the shell-less `gateway` one that fronts the internet — can drive the desktop
# and inject keystrokes into the dev user's terminal.
XAUTHORITY_FILE="${XAUTHORITY_FILE:-${USER_HOME}/.Xauthority}"

AB_DASHBOARD_ENABLE="${AB_DASHBOARD_ENABLE:-true}"
AB_DASHBOARD_PORT="${AB_DASHBOARD_PORT:-4848}"
# The dashboard is a Next.js app that serves its assets from absolute paths, so
# it cannot live under a path prefix. It gets its own gateway port instead,
# behind the same authentication.
DASHBOARD_GATEWAY_PORT="${DASHBOARD_GATEWAY_PORT:-8081}"
if [[ -z "${DASHBOARD_PUBLIC_URL:-}" ]]; then
  DASHBOARD_PUBLIC_URL="$(sed -E "s#^([a-zA-Z]+://[^/:]+).*#\1#" <<<"${PUBLIC_URL}"):${DASHBOARD_GATEWAY_PORT}"
fi
DASHBOARD_PUBLIC_URL="${DASHBOARD_PUBLIC_URL%/}"

OAUTH2_PROXY_PORT="${OAUTH2_PROXY_PORT:-4180}"

# The system supervisor keeps its config outside /etc/pitchfork. pitchfork
# always reads /etc/pitchfork/config.toml as the system-wide layer, and a
# root-only file there is fatal for an unprivileged supervisor — leaving that
# path empty is what lets the dev user run a nested supervisor of their own.
export PITCHFORK_STATE_DIR=/var/lib/pitchfork
export PITCHFORK_CONFIG_DIR=/opt/agent-env/pitchfork

mkdir -p "${RUN_DIR}" "${PITCHFORK_CONFIG_DIR}" "${PITCHFORK_STATE_DIR}"
chmod 755 "${RUN_DIR}"

# pitchfork takes a lock under /tmp/fslock. Whoever starts first would
# otherwise create it root-owned and 0755, locking every other user out of
# running their own supervisor.
install -d -m 1777 /tmp/fslock

# ---------------------------------------------------------------------------
# User / uid remapping and home directory seeding
# ---------------------------------------------------------------------------
CURRENT_UID="$(id -u "${USER_NAME}")"
CURRENT_GID="$(id -g "${USER_NAME}")"
PUID="${PUID:-${CURRENT_UID}}"
PGID="${PGID:-${CURRENT_GID}}"

if [[ "${PGID}" != "${CURRENT_GID}" ]]; then
  log "remapping group ${USER_NAME}: ${CURRENT_GID} -> ${PGID}"
  groupmod -o -g "${PGID}" "${USER_NAME}"
fi
if [[ "${PUID}" != "${CURRENT_UID}" ]]; then
  log "remapping user ${USER_NAME}: ${CURRENT_UID} -> ${PUID}"
  usermod -o -u "${PUID}" "${USER_NAME}"
fi

export XDG_RUNTIME_DIR="/run/user/${PUID}"
mkdir -p "${XDG_RUNTIME_DIR}"
chown "${PUID}:${PGID}" "${XDG_RUNTIME_DIR}"
chmod 700 "${XDG_RUNTIME_DIR}"

# The home directory is expected to be a volume, so that a tool the agent
# installs into it is still there after the container is recreated. Docker seeds
# a *named* volume from the image, but a bind mount arrives empty — so copy in
# anything missing, without touching what is already there.
if [[ -d /opt/agent-env/skel ]]; then
  shopt -s dotglob nullglob
  for src in /opt/agent-env/skel/*; do
    dst="${USER_HOME}/$(basename "${src}")"
    [[ -e "${dst}" ]] && continue
    cp -a "${src}" "${dst}" 2>/dev/null || true
  done
  shopt -u dotglob nullglob
fi

mkdir -p "${OPENCODE_WORKDIR}" \
         "${USER_HOME}/.ssh" \
         "${USER_HOME}/.config/opencode" \
         "${USER_HOME}/.local/share/opencode" \
         "${USER_HOME}/.local/share/agent-browser" \
         "${USER_HOME}/.cache"
chmod 700 "${USER_HOME}/.ssh"

# Reconciling ownership of a large mounted workspace can be slow, so it is
# opt-out via CHOWN_WORKSPACE=false.
chown "${PUID}:${PGID}" "${USER_HOME}" || true
for d in .ssh .config .local .cache .agent-browser Desktop; do
  [[ -e "${USER_HOME}/${d}" ]] && chown -R "${PUID}:${PGID}" "${USER_HOME}/${d}" || true
done
if is_true "${CHOWN_WORKSPACE:-true}"; then
  chown "${PUID}:${PGID}" "${OPENCODE_WORKDIR}" || true
fi

# Anything the agent installs into the home directory — a tool in ~/.local/bin,
# a dotfile, a provider login — is only as durable as this directory.
if ! mountpoint -q "${USER_HOME}" 2>/dev/null; then
  warn "${USER_HOME} is not a mount, so installed tools, dotfiles and provider"
  warn "logins are lost when this container is recreated on a new image."
  warn "Mount a volume there to keep them:  -v agent-env-home:${USER_HOME}"
fi

# The OpenCode server is the thing you are here to use, not part of the
# plumbing, so it belongs to you rather than to root: your own supervisor runs
# it, and you can restart it, read its logs and drive it from the pitchfork web
# UI without sudo.
#
# Its definition lives in a managed block that is rewritten on every start, so
# an existing config volume picks up changes to it. Everything outside the block
# is yours and is left alone.
user_pf_config="${USER_HOME}/.config/pitchfork/config.toml"
mkdir -p "$(dirname "${user_pf_config}")"

if [[ ! -e "${user_pf_config}" ]]; then
  cat > "${user_pf_config}" <<'SEED'
# Your own daemons, run by your own pitchfork supervisor.
#
#   pitchfork start <name>       start one of the daemons defined here
#   pitchfork list               what you have running
#   pitchfork logs -f <name>     follow its output
#   pitchfork tui                a dashboard in the terminal
#
# These are separate from the container's system services — run
# `agent-env status` for those. Daemons with boot_start = true come up when the
# container does.
#
# Add yours above the managed block at the end of this file. Project daemons are
# often better off in a pitchfork.toml next to your code; /workspace/pitchfork.toml
# is on a volume, so it survives a rebuild.
#
# [daemons.api]
# run = "npm run dev"
# dir = "/workspace/my-app"
# ready_port = 3000
# boot_start = true
# retry = true
SEED
fi

rm -rf "${USER_HOME}/.local/state/pitchfork"

pf_dufs=""
if is_true "${DUFS_ENABLE}"; then
  pf_dufs="
[daemons.dufs]
run = \"/opt/agent-env/bin/run-dufs\"
dir = \"${DUFS_ROOT}\"
ready_port = ${DUFS_PORT}
retry = true
boot_start = true
"
fi

pf_begin="# >>> agent-env managed — rewritten on every start, edits here are lost >>>"
pf_end="# <<< agent-env managed <<<"
pf_block="${RUN_DIR}/opencode-daemon.toml"
cat > "${pf_block}" <<BLOCK
${pf_begin}
# Keep your own daemons above this block: in TOML, anything following a table
# header belongs to that table.
[daemons.opencode]
run = "/opt/agent-env/bin/run-opencode"
dir = "${OPENCODE_WORKDIR}"
ready_port = { port = ${OPENCODE_PORT}, timeout = "120s" }
retry = true
boot_start = true
${pf_dufs}${pf_end}
BLOCK

python3 - "${user_pf_config}" "${pf_block}" "${pf_begin}" "${pf_end}" <<'MERGE'
import pathlib, sys

cfg, blk, begin, end = sys.argv[1:5]
path = pathlib.Path(cfg)
block = pathlib.Path(blk).read_text().rstrip("\n") + "\n"

kept, inside = [], False
for line in (path.read_text().splitlines(keepends=True) if path.exists() else []):
    stripped = line.strip()
    if stripped == begin:
        inside = True
        continue
    if stripped == end:
        inside = False
        continue
    if not inside:
        kept.append(line)

body = "".join(kept).rstrip("\n")
path.write_text(f"{body}\n\n{block}" if body else block)
MERGE

chown -R "${PUID}:${PGID}" "$(dirname "${user_pf_config}")"

# ---------------------------------------------------------------------------
# OpenCode server password (also authenticates CLI/TUI clients)
# ---------------------------------------------------------------------------
if [[ -z "${OPENCODE_SERVER_PASSWORD:-}" ]]; then
  pw_file="${USER_HOME}/.config/opencode/.server-password"
  if [[ -s "${pw_file}" ]]; then
    OPENCODE_SERVER_PASSWORD="$(< "${pw_file}")"
  else
    OPENCODE_SERVER_PASSWORD="$(rand_secret)"
    printf '%s' "${OPENCODE_SERVER_PASSWORD}" > "${pw_file}"
    chown "${PUID}:${PGID}" "${pw_file}"
    chmod 600 "${pw_file}"
    log "generated an OpenCode server password (persisted in ${pw_file})"
  fi
fi
export OPENCODE_SERVER_PASSWORD
GATEWAY_BASIC_B64="$(printf 'opencode:%s' "${OPENCODE_SERVER_PASSWORD}" | base64 -w0)"

# Make the runtime configuration discoverable to shells and to `agent-env`.
{
  echo "GATEWAY_PORT=${GATEWAY_PORT}"
  echo "PUBLIC_URL=${PUBLIC_URL}"
  echo "AUTH_MODE=${AUTH_MODE}"
  echo "OPENCODE_PORT=${OPENCODE_PORT}"
  echo "OPENCODE_WORKDIR=${OPENCODE_WORKDIR}"
  echo "SSH_PORT=${SSH_PORT}"
  echo "DESKTOP_DISPLAY=${DESKTOP_DISPLAY}"
  echo "AB_DASHBOARD_PORT=${AB_DASHBOARD_PORT}"
  echo "AB_DASHBOARD_ENABLE=${AB_DASHBOARD_ENABLE}"
  echo "DASHBOARD_PUBLIC_URL=${DASHBOARD_PUBLIC_URL}"
  echo "DESKTOP_ENABLE=${DESKTOP_ENABLE}"
  echo "TTYD_ENABLE=${TTYD_ENABLE}"
  echo "SSH_ENABLE=${SSH_ENABLE}"
  echo "USER_NAME=${USER_NAME}"
} > "${RUN_DIR}/env"

cat > /etc/profile.d/99-agent-env.sh <<EOF
export OPENCODE_SERVER_PASSWORD='${OPENCODE_SERVER_PASSWORD}'
export OPENCODE_SERVER='http://127.0.0.1:${OPENCODE_PORT}'
export DISPLAY='${DESKTOP_DISPLAY}'
export XAUTHORITY='${XAUTHORITY_FILE}'
export XDG_RUNTIME_DIR='${XDG_RUNTIME_DIR}'
EOF
chmod 644 /etc/profile.d/99-agent-env.sh

# /etc/profile is only read by login shells, and Debian's ~/.bashrc bails out
# early when non-interactive — so `ssh host <command>` would see none of this.
# pam_env reads /etc/environment for every PAM session, including that one.
cat > /etc/environment <<EOF
PATH=/opt/mise/shims:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin
MISE_DATA_DIR=/opt/mise
MISE_CONFIG_DIR=${USER_HOME}/.config/mise
MISE_STATE_DIR=/opt/mise/state
MISE_CACHE_DIR=/opt/mise/cache
DISPLAY=${DESKTOP_DISPLAY}
XAUTHORITY=${XAUTHORITY_FILE}
XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR}
OPENCODE_SERVER=http://127.0.0.1:${OPENCODE_PORT}
OPENCODE_SERVER_PASSWORD=${OPENCODE_SERVER_PASSWORD}
EOF
chmod 644 /etc/environment

# Root shells manage the system supervisor; everyone else gets their own, so
# `pitchfork` as dev means "my daemons" and never touches the system ones.
cat > /etc/profile.d/20-pitchfork.sh <<EOF
if [ "\$(id -u)" = 0 ]; then
  export PITCHFORK_STATE_DIR=/var/lib/pitchfork
  export PITCHFORK_CONFIG_DIR=/opt/agent-env/pitchfork
else
  # Your own supervisor. Its config is on the home volume; its runtime state is
  # not, so that recreating the container cannot resurrect stale PIDs.
  export PITCHFORK_STATE_DIR="\${XDG_RUNTIME_DIR:-/run/user/\$(id -u)}/pitchfork"
  unset PITCHFORK_CONFIG_DIR
fi
EOF
chmod 644 /etc/profile.d/20-pitchfork.sh

# ---------------------------------------------------------------------------
# X display access
#
# Xvfb with no -auth accepts every local account, so the shell-less `gateway`
# account fronting the internet could attach to the desktop and type into the
# dev user's terminal. A cookie limits the display to whoever can read the file:
# the dev user, and anyone they hand it to.
# ---------------------------------------------------------------------------
setup_xauth() {
  rm -f "${XAUTHORITY_FILE}" "${XAUTHORITY_FILE}-c" "${XAUTHORITY_FILE}-l"

  # Run as the owning user: xauth writes lock files beside the target, and
  # root-owned locks in the user's home would stop them managing it later —
  # which they need to do to read the cookie out for a remote display.
  # xauth normalises ":1" to "<host>/unix:1", the form a local client resolves
  # the display to, so one entry covers both spellings.
  setpriv --reuid "${PUID}" --regid "${PGID}" --init-groups --inh-caps=-all \
    env HOME="${USER_HOME}" \
    xauth -f "${XAUTHORITY_FILE}" add "${DESKTOP_DISPLAY}" MIT-MAGIC-COOKIE-1 "$(mcookie)"
  chmod 600 "${XAUTHORITY_FILE}"
  # Inherited by PID 1 and therefore by every daemon that draws on the display.
  export XAUTHORITY="${XAUTHORITY_FILE}"
  log "display ${DESKTOP_DISPLAY} is cookie-protected (${XAUTHORITY_FILE})"
}

if is_true "${DESKTOP_ENABLE}"; then
  setup_xauth
fi

# ---------------------------------------------------------------------------
# SSH
# ---------------------------------------------------------------------------
setup_ssh() {
  # Host keys live outside the image so that pulling a new one does not change
  # this deployment's identity, and so that no two deployments share a key.
  local key_dir="${AGENT_ENV_STATE_DIR}/ssh"
  install -d -m 0700 -o root -g root "${key_dir}"

  local generated=0 type key
  for type in ed25519 rsa; do
    key="${key_dir}/ssh_host_${type}_key"
    if [[ ! -s "${key}" ]]; then
      ssh-keygen -q -t "${type}" -f "${key}" -N '' -C "agent-env host key" </dev/null
      generated=1
    fi
  done
  chmod 600 "${key_dir}"/ssh_host_*_key
  chmod 644 "${key_dir}"/ssh_host_*_key.pub

  if (( generated )); then
    log "generated SSH host keys in ${key_dir}"
    if ! mountpoint -q "${AGENT_ENV_STATE_DIR}" 2>/dev/null; then
      warn "${AGENT_ENV_STATE_DIR} is not a mount, so these host keys die with this"
      warn "container and clients will see a changed-key warning after any update."
      warn "Mount a volume there to keep them:  -v agent-env-state:${AGENT_ENV_STATE_DIR}"
    fi
  else
    log "reusing the SSH host keys in ${key_dir}"
  fi
  log "host key fingerprint: $(ssh-keygen -lf "${key_dir}/ssh_host_ed25519_key.pub" | awk '{print $2}')"

  local keys="${SSH_AUTHORIZED_KEYS:-}"
  if [[ -n "${keys}" ]]; then
    # Accept keys separated by newlines or semicolons.
    printf '%s\n' "${keys}" | tr ';' '\n' | sed '/^[[:space:]]*$/d' \
      > "${USER_HOME}/.ssh/authorized_keys"
    chown "${PUID}:${PGID}" "${USER_HOME}/.ssh/authorized_keys"
    chmod 600 "${USER_HOME}/.ssh/authorized_keys"
    log "installed $(wc -l < "${USER_HOME}/.ssh/authorized_keys") SSH authorized key(s)"
  fi

  local password_auth=no
  if [[ -n "${SSH_PASSWORD:-}" ]]; then
    echo "${USER_NAME}:${SSH_PASSWORD}" | chpasswd
    password_auth=yes
    warn "SSH password authentication is enabled for user '${USER_NAME}'"
  fi

  cat > /etc/ssh/sshd_config.d/00-agent-env.conf <<EOF
Port ${SSH_PORT}
HostKey ${key_dir}/ssh_host_ed25519_key
HostKey ${key_dir}/ssh_host_rsa_key
PermitRootLogin no
PasswordAuthentication ${password_auth}
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers ${USER_NAME}
X11Forwarding yes
PrintMotd no
AcceptEnv LANG LC_* TERM COLORTERM
ClientAliveInterval 30
ClientAliveCountMax 4
EOF

  if [[ ! -s "${USER_HOME}/.ssh/authorized_keys" && "${password_auth}" == "no" ]]; then
    warn "SSH is enabled but has no credentials: set SSH_AUTHORIZED_KEYS or SSH_PASSWORD"
  fi
}

if is_true "${SSH_ENABLE}"; then
  setup_ssh
fi

# ---------------------------------------------------------------------------
# Auth gate
# ---------------------------------------------------------------------------
GATEWAY_BASIC_HASH=""
declare -a OAUTH2_ARGS=()

case "${AUTH_MODE,,}" in
  google)
    # oauth2-proxy reads its own OAUTH2_PROXY_* variables directly, so accept
    # either those or the friendlier GOOGLE_* names.
    [[ -n "${GOOGLE_CLIENT_ID:-}" || -n "${OAUTH2_PROXY_CLIENT_ID:-}" ]] \
      || die "AUTH_MODE=google requires GOOGLE_CLIENT_ID (or OAUTH2_PROXY_CLIENT_ID)"
    [[ -n "${GOOGLE_CLIENT_SECRET:-}" || -n "${OAUTH2_PROXY_CLIENT_SECRET:-}" ]] \
      || die "AUTH_MODE=google requires GOOGLE_CLIENT_SECRET (or OAUTH2_PROXY_CLIENT_SECRET)"

    if [[ -z "${ALLOWED_EMAILS:-}" && -z "${ALLOWED_EMAIL_DOMAINS:-}" ]]; then
      die "AUTH_MODE=google requires ALLOWED_EMAILS and/or ALLOWED_EMAIL_DOMAINS, otherwise any Google account on the internet could sign in"
    fi

    # Set when the operator supplied the cookie secret through oauth2-proxy's
    # own variable; we then leave it in the environment untouched.
    # Either spelling may carry these. Whichever it is, the value goes to
    # oauth2-proxy by file — so it is out of the process list and out of every
    # daemon's environment, and there is only one path to get wrong.
    client_secret="${GOOGLE_CLIENT_SECRET:-${OAUTH2_PROXY_CLIENT_SECRET:-}}"

    cookie_secret="${OAUTH2_PROXY_COOKIE_SECRET:-}"
    if [[ -z "${cookie_secret}" ]]; then
      # Reused across restarts so existing sessions survive.
      secret_file="${USER_HOME}/.config/opencode/.cookie-secret"
      if [[ -s "${secret_file}" ]]; then
        cookie_secret="$(< "${secret_file}")"
      else
        cookie_secret="$(rand_secret)"
        printf '%s' "${cookie_secret}" > "${secret_file}"
        chown "${PUID}:${PGID}" "${secret_file}"; chmod 600 "${secret_file}"
        log "generated an OAuth cookie secret (persisted in ${secret_file})"
      fi
    fi

    # oauth2-proxy accepts only 16, 24 or 32 bytes, and says so in a way that
    # sends people looking in the wrong place. Check it here instead.
    cookie_bytes="$(printf '%s' "${cookie_secret}" | python3 -c '
import base64, sys
raw = sys.stdin.buffer.read().strip()
for decode in (base64.urlsafe_b64decode, base64.b64decode):
    try:
        pad = raw + b"=" * (-len(raw) % 4)
        print(len(decode(pad)))
        break
    except Exception:
        continue
else:
    print(len(raw))' 2>/dev/null || printf '%s' "${#cookie_secret}")"
    case "${cookie_bytes}" in
      16|24|32) ;;
      *) die "the OAuth cookie secret decodes to ${cookie_bytes} bytes; oauth2-proxy needs 16, 24 or 32.
       Generate one with:  head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '='" ;;
    esac

    cookie_secure=false
    [[ "${PUBLIC_URL}" == https://* ]] && cookie_secure=true
    if [[ "${cookie_secure}" == "false" && "${PUBLIC_URL}" != http://localhost* && "${PUBLIC_URL}" != http://127.0.0.1* ]]; then
      warn "PUBLIC_URL is not https, so session cookies will be sent in cleartext"
    fi

    OAUTH2_ARGS=(
      --provider=google
      --http-address="127.0.0.1:${OAUTH2_PROXY_PORT}"
      --reverse-proxy=true
      --client-id="${GOOGLE_CLIENT_ID:-${OAUTH2_PROXY_CLIENT_ID}}"
      --redirect-url="${PUBLIC_URL}/oauth2/callback"
      --upstream="static://202"
      --set-xauthrequest=true
      --skip-provider-button=true
      --cookie-secure="${cookie_secure}"
      --cookie-expire="${AUTH_SESSION_TTL:-168h}"
      --cookie-refresh="${AUTH_SESSION_REFRESH:-1h}"
      --whitelist-domain="$(url_host "${PUBLIC_URL}")"
      --silence-ping-logging=true
      --scope="openid email profile"
      # Only Caddy talks to oauth2-proxy, so only loopback may supply
      # X-Forwarded-* headers.
      --trusted-proxy-ip="127.0.0.1/32"
      --trusted-proxy-ip="::1/128"
    )

    # Allow post-login redirects back to the dashboard's own origin.
    if is_true "${AB_DASHBOARD_ENABLE}"; then
      OAUTH2_ARGS+=(--whitelist-domain="$(url_host "${DASHBOARD_PUBLIC_URL}")")
    fi

    if [[ -n "${ALLOWED_EMAIL_DOMAINS:-}" ]]; then
      IFS=',' read -ra _domains <<<"${ALLOWED_EMAIL_DOMAINS}"
      for d in "${_domains[@]}"; do
        d="$(tr -d '[:space:]' <<<"${d}")"
        [[ -n "${d}" ]] && OAUTH2_ARGS+=(--email-domain="${d}")
      done
    fi

    if [[ -n "${ALLOWED_EMAILS:-}" ]]; then
      emails_file="${RUN_DIR}/authenticated-emails"
      tr ',' '\n' <<<"${ALLOWED_EMAILS}" | tr -d '[:blank:]' | sed '/^$/d' > "${emails_file}"
      chmod 644 "${emails_file}"
      OAUTH2_ARGS+=(--authenticated-emails-file="${emails_file}")
    fi

    # Optional Google Workspace group restriction.
    if [[ -n "${GOOGLE_GROUPS:-}" ]]; then
      [[ -n "${GOOGLE_ADMIN_EMAIL:-}" ]] || die "GOOGLE_GROUPS requires GOOGLE_ADMIN_EMAIL"
      [[ -n "${GOOGLE_SERVICE_ACCOUNT_JSON:-}" ]] || die "GOOGLE_GROUPS requires GOOGLE_SERVICE_ACCOUNT_JSON (path to the key file)"
      IFS=',' read -ra _groups <<<"${GOOGLE_GROUPS}"
      for g in "${_groups[@]}"; do
        g="$(tr -d '[:space:]' <<<"${g}")"
        [[ -n "${g}" ]] && OAUTH2_ARGS+=(--google-group="${g}")
      done
      OAUTH2_ARGS+=(
        --google-admin-email="${GOOGLE_ADMIN_EMAIL}"
        --google-service-account-json="${GOOGLE_SERVICE_ACCOUNT_JSON}"
      )
    fi

    # Both by file, always — see where they were resolved above.
    write_gateway_secret() {
      local path="${RUN_DIR}/$1"
      printf '%s' "$2" > "${path}"
      chmod 640 "${path}"
      chown root:"${GATEWAY_GROUP}" "${path}"
    }
    write_gateway_secret client-secret "${client_secret}"
    write_gateway_secret cookie-secret "${cookie_secret}"
    OAUTH2_ARGS+=(
      --client-secret-file="${RUN_DIR}/client-secret"
      --cookie-secret-file="${RUN_DIR}/cookie-secret"
    )
    log "gateway secrets passed by file, so they stay out of the process list"

    # Written one argument per line rather than interpolated into a shell
    # string, so values containing shell metacharacters cannot break quoting.
    printf '%s\n' "${OAUTH2_ARGS[@]}" > "${RUN_DIR}/oauth2-proxy.args"
    chmod 640 "${RUN_DIR}/oauth2-proxy.args"
    chown root:"${GATEWAY_GROUP}" "${RUN_DIR}/oauth2-proxy.args"
    ;;

  basic)
    GATEWAY_USER="${GATEWAY_USER:-opencode}"
    if [[ -z "${GATEWAY_PASSWORD:-}" ]]; then
      GATEWAY_PASSWORD="$(rand_secret)"
      log "AUTH_MODE=basic with no GATEWAY_PASSWORD set; generated one for this boot:"
      log "    username: ${GATEWAY_USER}"
      log "    password: ${GATEWAY_PASSWORD}"
    fi
    GATEWAY_BASIC_HASH="$(caddy hash-password --plaintext "${GATEWAY_PASSWORD}")"
    ;;

  none)
    warn "AUTH_MODE=none — the gateway on port ${GATEWAY_PORT} is UNAUTHENTICATED."
    warn "Only use this behind your own authenticating proxy, or on a private network."
    ;;

  *)
    die "unknown AUTH_MODE='${AUTH_MODE}' (expected: google, basic or none)"
    ;;
esac

# ---------------------------------------------------------------------------
# Caddyfile
# ---------------------------------------------------------------------------
render_caddyfile() {
  local f=/etc/caddy/Caddyfile
  mkdir -p /etc/caddy

  local BIND_DIRECTIVE=""
  [[ -n "${GATEWAY_BIND}" ]] && BIND_DIRECTIVE="	bind ${GATEWAY_BIND}
"

  # Emits the authentication gate for one site block. $1 is the origin that
  # unauthenticated visitors are sent back to after signing in.
  emit_auth_gate() {
    local origin="$1"
    case "${AUTH_MODE,,}" in
      google)
        cat <<EOF
			forward_auth 127.0.0.1:${OAUTH2_PROXY_PORT} {
				uri /oauth2/auth
				copy_headers X-Auth-Request-User X-Auth-Request-Email X-Auth-Request-Preferred-Username

				@unauthorized status 401 403
				handle_response @unauthorized {
					redir * ${PUBLIC_URL}/oauth2/start?rd=${origin}{http.request.orig_uri}
				}
			}
EOF
        ;;
      basic)
        cat <<EOF
			basic_auth {
				${GATEWAY_USER} ${GATEWAY_BASIC_HASH}
			}
EOF
        ;;
    esac
  }

  emit_oauth_endpoints() {
    [[ "${AUTH_MODE,,}" == "google" ]] || return 0
    cat <<EOF

		# oauth2-proxy owns the sign-in endpoints.
		handle /oauth2/* {
			reverse_proxy 127.0.0.1:${OAUTH2_PROXY_PORT} {
				header_up X-Real-IP {remote_host}
			}
		}
EOF
  }

  {
    cat <<EOF
{
	admin off
	auto_https off
	log {
		output stderr
		format console
		level ${GATEWAY_LOG_LEVEL:-INFO}
	}
}

# ---------------------------------------------------------------------------
# Main entrance: OpenCode v2 web UI + API, the TUI, and the noVNC desktop.
# ---------------------------------------------------------------------------
:${GATEWAY_PORT} {
${BIND_DIRECTIVE}	route {
		handle /healthz {
			respond "ok" 200
		}
EOF

    emit_oauth_endpoints

    echo
    echo "		route {"
    emit_auth_gate "${PUBLIC_URL}"

    if is_true "${DESKTOP_ENABLE}"; then
      cat <<EOF

			# noVNC desktop. noVNC resolves its websocket path relative to the
			# page it was loaded from, so the default lands on /desktop/websockify.
			redir /desktop /desktop/
			handle /desktop/ {
				redir * /desktop/vnc.html?autoconnect=true&resize=remote
			}
			handle_path /desktop/* {
				reverse_proxy 127.0.0.1:${NOVNC_PORT}
			}
EOF
    fi

    if is_true "${TTYD_ENABLE}"; then
      cat <<EOF

			# OpenCode v2 TUI over ttyd, which serves its own /terminal base path.
			redir /terminal /terminal/
			handle /terminal/* {
				reverse_proxy 127.0.0.1:${TTYD_PORT}
			}
EOF
    fi

    if is_true "${DUFS_ENABLE}"; then
      cat <<EOF

			# dufs, the workspace file manager. It is told its prefix with
			# --path-prefix, so pass the path through rather than stripping it.
			redir /${DUFS_PATH} /${DUFS_PATH}/
			handle /${DUFS_PATH}/* {
				reverse_proxy 127.0.0.1:${DUFS_PORT}
			}
EOF
    fi

    if is_true "${USER_SUPERVISOR_ENABLE}" && is_true "${USER_WEB_ENABLE}"; then
      cat <<EOF

			# pitchfork's web UI for the user's own daemons, including the
			# OpenCode server. It is told to serve under this prefix, so pass
			# the path through rather than stripping it. Its document lives at
			# /${USER_WEB_PATH} with no trailing slash and carries a
			# <base href="/${USER_WEB_PATH}/">, so a stray slash goes back to it.
			redir /${USER_WEB_PATH}/ /${USER_WEB_PATH}
			handle /${USER_WEB_PATH}* {
				reverse_proxy 127.0.0.1:${USER_WEB_PORT}
			}

			# Its logo is requested from an absolute /img/logo.png, which
			# ignores the <base href> and so escapes the prefix. Send that one
			# path to where the file actually is.
			handle /img/logo.png {
				rewrite * /${USER_WEB_PATH}/img/logo.png
				reverse_proxy 127.0.0.1:${USER_WEB_PORT}
			}
EOF
    fi

    cat <<EOF

			# Everything else: the OpenCode v2 web UI and API. The server's own
			# basic-auth credential is injected here so users never see it.
			handle {
				reverse_proxy 127.0.0.1:${OPENCODE_PORT} {
					header_up Authorization "Basic ${GATEWAY_BASIC_B64}"
				}
			}
		}
	}
}
EOF

    if is_true "${AB_DASHBOARD_ENABLE}"; then
      cat <<EOF

# ---------------------------------------------------------------------------
# agent-browser observability dashboard, on its own port because it serves its
# assets from absolute paths.
# ---------------------------------------------------------------------------
:${DASHBOARD_GATEWAY_PORT} {
${BIND_DIRECTIVE}	route {
		handle /healthz {
			respond "ok" 200
		}
EOF
      emit_oauth_endpoints
      echo
      echo "		route {"
      emit_auth_gate "${DASHBOARD_PUBLIC_URL}"
      cat <<EOF

			handle {
				reverse_proxy 127.0.0.1:${AB_DASHBOARD_PORT}
			}
		}
	}
}
EOF
    fi
  } > "${f}"

  chmod 640 "${f}"
  chown root:"${GATEWAY_GROUP}" "${f}"
  caddy fmt --overwrite "${f}" >/dev/null 2>&1 || true
  caddy validate --config "${f}" >/dev/null 2>&1 \
    || { caddy validate --config "${f}"; die "generated Caddyfile is invalid (see above)"; }
  log "gateway configuration written to ${f}"
}

render_caddyfile

# ---------------------------------------------------------------------------
# mise: optional extra global tools
# ---------------------------------------------------------------------------
# Tool *installs* live in /opt/mise, part of the image, so they do not survive
# being recreated on a new image — but the declarations do, in the home volume.
# Rebuild from them so a tool the agent installed is still there afterwards.
if [[ -s "${USER_HOME}/.config/mise/config.toml" ]]; then
  log "restoring mise tools declared in ${USER_HOME}/.config/mise/config.toml"
  setpriv --reuid "${PUID}" --regid "${PGID}" --init-groups --inh-caps=-all \
    env HOME="${USER_HOME}" MISE_CONFIG_DIR="${USER_HOME}/.config/mise" \
    mise install --yes >/dev/null 2>&1 \
    || warn "some mise tools could not be reinstalled (offline?); run 'mise install' to retry"
fi

if [[ -n "${MISE_TOOLS:-}" ]]; then
  log "installing mise tools: ${MISE_TOOLS}"
  # shellcheck disable=SC2086
  gosu_run() { setpriv --reuid "${PUID}" --regid "${PGID}" --init-groups --inh-caps=-all "$@"; }
  gosu_run env HOME="${USER_HOME}" mise use -g ${MISE_TOOLS} \
    || warn "mise failed to install one or more of: ${MISE_TOOLS}"
  gosu_run env HOME="${USER_HOME}" mise reshim || true
fi

# ---------------------------------------------------------------------------
# Daemon definitions for pitchfork
#
# pitchfork runs as PID 1 in container mode. `depends` + `ready_*` replace the
# hand-rolled wait loops a flat supervisor needs, so each service only starts
# once the things it needs are actually accepting connections.
# ---------------------------------------------------------------------------
render_pitchfork() {
  local f="${PITCHFORK_CONFIG_DIR}/config.toml"

  # One daemon block. $1 name, $2 run command, rest = extra TOML lines.
  emit_daemon() {
    local name="$1" run="$2"; shift 2
    printf '\n[daemons.%s]\n' "${name}"
    printf 'run = "%s"\n' "${run}"
    printf 'boot_start = true\n'
    local line
    for line in "$@"; do printf '%s\n' "${line}"; done
  }

  {
    cat <<EOF
# Generated by /usr/local/bin/entrypoint.sh — edits here are lost on restart.

[settings.supervisor]
container = true

[settings.general]
log_level = "${PITCHFORK_LOG_LEVEL:-info}"

[settings.logs]
# The container's log driver stamps its own timestamps.
timestamp = false

# Inherited by every daemon below.
[env]
HOME = "${USER_HOME}"
USER = "${USER_NAME}"
DISPLAY = "${DESKTOP_DISPLAY}"
XAUTHORITY = "${XAUTHORITY_FILE}"
XDG_RUNTIME_DIR = "${XDG_RUNTIME_DIR}"
TZ = "${TZ}"
OPENCODE_SERVER_PASSWORD = "${OPENCODE_SERVER_PASSWORD}"
OPENCODE_PORT = "${OPENCODE_PORT}"
OPENCODE_WORKDIR = "${OPENCODE_WORKDIR}"
DESKTOP_DISPLAY = "${DESKTOP_DISPLAY}"
DESKTOP_RESOLUTION = "${DESKTOP_RESOLUTION}"
VNC_PORT = "${VNC_PORT}"
NOVNC_PORT = "${NOVNC_PORT}"
TTYD_PORT = "${TTYD_PORT}"
TTYD_WRITABLE = "${TTYD_WRITABLE}"
AB_DASHBOARD_PORT = "${AB_DASHBOARD_PORT}"
EOF

    if is_true "${SSH_ENABLE}"; then
      emit_daemon sshd "/usr/sbin/sshd -D -e" \
        'retry = true' \
        "ready_port = ${SSH_PORT}"
    fi

    if is_true "${DESKTOP_ENABLE}"; then
      emit_daemon dbus "/opt/agent-env/bin/run-dbus" \
        'retry = true' \
        'ready_cmd = "test -S /run/dbus/system_bus_socket"'

      emit_daemon xvfb "/opt/agent-env/bin/run-xvfb" \
        "user = \"${USER_NAME}\"" \
        'retry = true' \
        "ready_cmd = { run = \"xdpyinfo -display ${DESKTOP_DISPLAY} >/dev/null 2>&1\", timeout = \"60s\" }"

      emit_daemon desktop "/opt/agent-env/bin/run-desktop" \
        "user = \"${USER_NAME}\"" \
        "dir = \"${USER_HOME}\"" \
        'depends = ["xvfb", "dbus"]' \
        'retry = true'

      emit_daemon x11vnc "/opt/agent-env/bin/run-x11vnc" \
        "user = \"${USER_NAME}\"" \
        'depends = ["xvfb"]' \
        'retry = true' \
        "ready_port = ${VNC_PORT}"

      emit_daemon novnc "/opt/agent-env/bin/run-novnc" \
        "user = \"${USER_NAME}\"" \
        'depends = ["x11vnc"]' \
        'retry = true' \
        "ready_port = ${NOVNC_PORT}"
    fi

    if is_true "${TTYD_ENABLE}"; then
      emit_daemon ttyd "/opt/agent-env/bin/run-ttyd" \
        "user = \"${USER_NAME}\"" \
        "dir = \"${OPENCODE_WORKDIR}\"" \
        'retry = true' \
        "ready_port = ${TTYD_PORT}"
    fi

    if is_true "${AB_DASHBOARD_ENABLE}"; then
      emit_daemon agent-browser-dashboard "/opt/agent-env/bin/run-ab-dashboard" \
        "user = \"${USER_NAME}\"" \
        "dir = \"${OPENCODE_WORKDIR}\"" \
        'retry = true' \
        "ready_http = { url = \"http://127.0.0.1:${AB_DASHBOARD_PORT}/\", timeout = \"60s\" }"
    fi

    # Caddy is a proxy: it does not need its upstreams to exist at startup, and
    # opencode now lives in another supervisor entirely.
    local caddy_deps=''
    if [[ "${AUTH_MODE,,}" == "google" ]]; then
      emit_daemon oauth2-proxy "/opt/agent-env/bin/run-oauth2-proxy" \
        "user = \"${GATEWAY_USER_NAME}\"" \
        'retry = true' \
        "ready_http = { url = \"http://127.0.0.1:${OAUTH2_PROXY_PORT}/ping\", timeout = \"60s\" }"
      caddy_deps='depends = ["oauth2-proxy"]'
    fi

    emit_daemon caddy "/usr/local/bin/caddy run --config /etc/caddy/Caddyfile" \
      "user = \"${GATEWAY_USER_NAME}\"" \
      "${caddy_deps}" \
      'retry = true' \
      'env = { HOME = "/var/lib/caddy", XDG_CONFIG_HOME = "/var/lib/caddy", XDG_DATA_HOME = "/var/lib/caddy" }' \
      "ready_http = { url = \"http://127.0.0.1:${GATEWAY_PORT}/healthz\", timeout = \"60s\" }"

    if is_true "${USER_SUPERVISOR_ENABLE}"; then
      local user_sup_ready="ready_cmd = { run = \"true\", timeout = \"5s\" }"
      if is_true "${USER_WEB_ENABLE}"; then
        user_sup_ready="ready_port = { port = ${USER_WEB_PORT}, timeout = \"60s\" }"
      fi
      emit_daemon user-supervisor "/opt/agent-env/bin/run-user-supervisor" \
        "user = \"${USER_NAME}\"" \
        "dir = \"${OPENCODE_WORKDIR}\"" \
        'retry = true' \
        "${user_sup_ready}" \
        "env = { PITCHFORK_STATE_DIR = \"${XDG_RUNTIME_DIR}/pitchfork\" }"
    fi

    # pitchfork captures each daemon's output into its own log store rather than
    # the container's stdout. This forwards the lot to PID 1's stdout so
    # `docker logs` and the container log driver still see everything.
    emit_daemon zz-log-forward \
      "exec pitchfork logs --follow --raw >/proc/1/fd/1 2>/proc/1/fd/2" \
      'retry = true'
  } > "${f}"

  chmod 600 "${f}"
  log "daemon definitions written to ${f}"
}

render_pitchfork

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
log "----------------------------------------------------------------"
log " OpenCode v2 : $(su -s /bin/bash -c 'opencode2 --version' "${USER_NAME}" 2>/dev/null || echo unknown)"
log " gateway     : ${PUBLIC_URL}  (listening on ${GATEWAY_BIND:-0.0.0.0}:${GATEWAY_PORT})"
log " auth mode   : ${AUTH_MODE}"
is_true "${TTYD_ENABLE}"        && log " TUI         : ${PUBLIC_URL}/terminal"
is_true "${DESKTOP_ENABLE}"     && log " desktop     : ${PUBLIC_URL}/desktop"
is_true "${AB_DASHBOARD_ENABLE}" && log " browser dash: ${DASHBOARD_PUBLIC_URL}"
if is_true "${USER_SUPERVISOR_ENABLE}" && is_true "${USER_WEB_ENABLE}"; then
  log " daemons     : ${PUBLIC_URL}/${USER_WEB_PATH}"
fi
is_true "${DUFS_ENABLE}" && log " files       : ${PUBLIC_URL}/${DUFS_PATH}"
is_true "${SSH_ENABLE}"         && log " ssh         : ${USER_NAME}@<host> -p ${SSH_PORT}"
log " workspace   : ${OPENCODE_WORKDIR}"
log "----------------------------------------------------------------"

# The gateway's credentials are in root-owned files by now, and oauth2-proxy
# reads them from there. Leaving them in the environment would hand them to every
# daemon — including the OpenCode server, whose whole job is running code the
# agent was asked to run. A prompt injection or a hostile postinstall could then
# read them straight out of /proc/self/environ.
unset GOOGLE_CLIENT_SECRET GOOGLE_CLIENT_SECRET_FILE \
      GATEWAY_PASSWORD GATEWAY_PASSWORD_FILE \
      OAUTH2_PROXY_COOKIE_SECRET OAUTH2_PROXY_CLIENT_SECRET

# exec keeps PID 1, which is what pitchfork's container mode needs.
exec "$@"
