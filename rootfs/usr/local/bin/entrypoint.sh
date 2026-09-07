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
#
# The pattern is deliberately generic, which means it also matches variables
# that were never meant as secrets — SSL_CERT_FILE is the obvious one, and it
# usually points at a CA bundle a couple of hundred kilobytes long. Exporting
# one of those puts a single variable past the kernel's per-string limit
# (MAX_ARG_STRLEN, 128KiB), and from then on every exec in this script dies
# with "Argument list too long", naming whichever command happened to run next
# rather than the variable that caused it. So bound it here, where the name is
# still known. Nothing this image legitimately reads from a file comes close:
# passwords, cookie secrets, OAuth client secrets and authkeys are all well
# under a kilobyte.
FILE_SECRET_MAX_BYTES="${FILE_SECRET_MAX_BYTES:-65536}"

expand_file_secrets() {
  local name value target size
  while IFS='=' read -r name value; do
    [[ "${name}" == *_FILE ]] || continue
    target="${name%_FILE}"
    [[ -n "${target}" ]] || continue
    [[ -r "${value}" ]] || { warn "${name}=${value} is not readable, ignoring"; continue; }
    size=$(stat -Lc %s "${value}" 2>/dev/null) || size=0
    if (( size > FILE_SECRET_MAX_BYTES )); then
      # Skipped rather than fatal, matching the unreadable case just above: a
      # value this size was never a usable secret, and refusing to boot would
      # take out a container whose SSL_CERT_FILE is set for its real purpose.
      warn "${name}=${value} is ${size} bytes, over the ${FILE_SECRET_MAX_BYTES}-byte limit for a file secret; not exporting ${target}"
      continue
    fi
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

# /run/agent-env/env is read by programs that cannot reasonably reimplement
# is_true — the healthcheck, the `agent-env` helper, the test suite. Publishing
# the raw value silently desynchronises them from what the entrypoint actually
# decided: OPENCODE_ENABLE=1 starts the server and injects its credential, while
# a reader comparing against "true" concludes it is off and stops probing it.
# Write what the flag resolved to, never what was typed.
canon() { if is_true "${1:-}"; then echo true; else echo false; fi; }

rand_secret() { head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }

url_host() { sed -E 's#^[a-zA-Z]+://##; s#/.*$##' <<<"$1"; }

# A comma-separated allow list, with the whitespace and the empty entries taken
# out: `a, ,b,` becomes `a,b` and `,` becomes nothing at all. Allow lists are
# counted before they are rendered, and a value that renders no restriction has
# to read as empty at the point it is counted — see the auth gate below.
clean_list() {
  local item out=""
  local -a items=()
  IFS=',' read -ra items <<<"${1:-}"
  for item in "${items[@]}"; do
    item="$(tr -d '[:space:]' <<<"${item}")"
    [[ -n "${item}" ]] || continue
    out+="${out:+,}${item}"
  done
  printf '%s' "${out}"
}

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

# OpenCode is the default occupant of /, not a requirement of the image. With it
# off, / proxies to PRIMARY_PORT instead — whatever the workspace is running —
# and falls back to the environment index when nothing is listening there.
OPENCODE_ENABLE="${OPENCODE_ENABLE:-true}"
OPENCODE_PORT="${OPENCODE_PORT:-4096}"
OPENCODE_WORKDIR="${OPENCODE_WORKDIR:-/workspace}"
# Where / points when OpenCode is off. 3000 is what Next, Rails, Vite preview and
# most `npm start` templates pick, so the default is right more often than not.
PRIMARY_PORT="${PRIMARY_PORT:-3000}"

SSH_ENABLE="${SSH_ENABLE:-true}"
SSH_PORT="${SSH_PORT:-22}"

# Everything this image serves for itself lives under one reserved prefix, so
# whatever answers at / keeps its entire path space. Not configurable on
# purpose: it is a documented contract, and a knob here would only make the
# README wrong. The `~` keeps it clear of any path a real application routes.
ENV_PREFIX='~env'

DESKTOP_ENABLE="${DESKTOP_ENABLE:-true}"
DESKTOP_RESOLUTION="${DESKTOP_RESOLUTION:-1920x1080x24}"
DESKTOP_DISPLAY="${DESKTOP_DISPLAY:-:1}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"

TTYD_ENABLE="${TTYD_ENABLE:-true}"
TTYD_PORT="${TTYD_PORT:-7681}"
TTYD_WRITABLE="${TTYD_WRITABLE:-true}"
# ttyd and dufs are told their own prefix so their UIs work under one; noVNC is
# not, because the gateway strips the prefix before proxying to it.
TTYD_PATH="${ENV_PREFIX}/terminal"
DESKTOP_PATH="${ENV_PREFIX}/desktop"
HEALTH_PATH="${ENV_PREFIX}/healthz"

USER_SUPERVISOR_ENABLE="${USER_SUPERVISOR_ENABLE:-true}"
# pitchfork's own web UI, served by the user's supervisor. It can start, stop
# and restart daemons, stream their logs and edit the config, so it sits behind
# the gateway's auth like everything else.
#
# This is the one part of the environment that cannot move under ENV_PREFIX:
# pitchfork validates PITCHFORK_WEB_PATH as a single [A-Za-z0-9_-] segment and
# bakes it into a <base href>, so a nested prefix is rejected outright. It keeps
# a top-level path, and ${ENV_PREFIX}/daemons redirects to it so the reserved
# prefix stays the one address worth documenting.
USER_WEB_ENABLE="${USER_WEB_ENABLE:-true}"
USER_WEB_PORT="${USER_WEB_PORT:-4747}"
USER_WEB_PATH="${USER_WEB_PATH:-pitchfork}"

# dufs: a file manager for the workspace, run by the user's own supervisor.
DUFS_ENABLE="${DUFS_ENABLE:-true}"
DUFS_PORT="${DUFS_PORT:-5000}"
DUFS_PATH="${DUFS_PATH:-${ENV_PREFIX}/files}"
DUFS_ROOT="${DUFS_ROOT:-${OPENCODE_WORKDIR}}"

# A rootless Docker engine for the dev user, so an agent can bring up a
# database or any other container without the host's docker socket. Off by
# default: it only works if the host relaxed this container's sandbox, and
# doing that weakens the isolation the rest of this image is built on.
DOCKER_ROOTLESS_ENABLE="${DOCKER_ROOTLESS_ENABLE:-false}"
DOCKER_ROOTLESS_DATA_ROOT="${DOCKER_ROOTLESS_DATA_ROOT:-${USER_HOME}/.local/share/docker}"
DOCKER_ROOTLESS_HOST="unix://${XDG_RUNTIME_DIR:-/run/user/${USER_UID:-1000}}/docker.sock"

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

# ---------------------------------------------------------------------------
# Rootless Docker preflight.
#
# A rootless daemon needs things a default container does not get. Each of
# these failed for us with an error that named none of them — a bare "exit
# status 127", or newuidmap reporting EPERM — so check up front and say
# exactly which docker run flag is missing rather than crash-looping a daemon.
# ---------------------------------------------------------------------------
docker_rootless_preflight() {
  local missing=()

  if ! grep -q "^${USER_NAME}:" /etc/subuid 2>/dev/null; then
    warn "no /etc/subuid range for ${USER_NAME}; containers could not map their own users"
    return 1
  fi

  # newuidmap is setuid-root, so its euid stops matching the owner of the user
  # namespace it is mapping. That loses the kernel's "namespace owner holds all
  # capabilities in it" shortcut, and the check falls through to CAP_SYS_ADMIN
  # in the initial user namespace, which docker drops by default.
  local capbnd
  capbnd="$(sed -n 's/^CapBnd:\s*//p' /proc/self/status)"
  (( (0x${capbnd:-0} >> 21) & 1 )) || missing+=("--cap-add SYS_ADMIN")

  # runc joins a session keyring for every container it starts, and keyctl is
  # not in docker's default seccomp allow list. The daemon comes up fine
  # without this; it is the containers it runs that fail, with "unable to join
  # session keyring", so it is worth catching here rather than at first use.
  [[ "$(sed -n 's/^Seccomp:\s*//p' /proc/self/status)" == 0 ]] \
    || missing+=("--security-opt seccomp=unconfined")

  # slirp4netns gives the daemon its own network namespace, and builds a tap
  # device to do it.
  [[ -c /dev/net/tun ]] || missing+=("--device /dev/net/tun")

  # dockerd-rootless.sh turns on IP forwarding inside its network namespace.
  # /proc/sys is read-only in a stock container, so that write fails.
  [[ -w /proc/sys/net/ipv4/ip_forward ]] || missing+=("--security-opt systempaths=unconfined")

  if (( ${#missing[@]} )); then
    warn "DOCKER_ROOTLESS_ENABLE is set, but this container was not started with:"
    local flag
    for flag in "${missing[@]}"; do warn "    ${flag}"; done
    warn "Rootless Docker is disabled. Add those to your docker run / compose"
    warn "service and recreate the container. See 'Docker inside the container'"
    warn "in the README for what each one is for."
    return 1
  fi
  return 0
}

if is_true "${DOCKER_ROOTLESS_ENABLE}"; then
  if docker_rootless_preflight; then
    log "rootless Docker enabled for ${USER_NAME} (data root ${DOCKER_ROOTLESS_DATA_ROOT})"
  else
    DOCKER_ROOTLESS_ENABLE=false
  fi
fi

# The readiness probe addresses the socket explicitly instead of relying on
# DOCKER_HOST reaching it. The CLI does *not* fall back to
# $XDG_RUNTIME_DIR/docker.sock, so a probe that depends on the environment is
# one that can silently never pass — and pitchfork answers a probe that never
# passes by restarting the daemon, which stops every container it was running.
pf_docker=""
if is_true "${DOCKER_ROOTLESS_ENABLE}"; then
  pf_docker="
[daemons.dockerd]
run = \"/opt/agent-env/bin/run-dockerd-rootless\"
dir = \"${USER_HOME}\"
ready_cmd = { run = \"docker -H ${DOCKER_ROOTLESS_HOST} version >/dev/null 2>&1\", timeout = \"120s\" }
retry = true
boot_start = true
"
fi

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
pf_opencode=""
if is_true "${OPENCODE_ENABLE}"; then
  pf_opencode="
[daemons.opencode]
run = \"/opt/agent-env/bin/run-opencode\"
dir = \"${OPENCODE_WORKDIR}\"
ready_port = { port = ${OPENCODE_PORT}, timeout = \"120s\" }
retry = true
boot_start = true
"
fi

cat > "${pf_block}" <<BLOCK
${pf_begin}
# Keep your own daemons above this block: in TOML, anything following a table
# header belongs to that table.
${pf_opencode}${pf_dufs}${pf_docker}${pf_end}
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
GATEWAY_BASIC_B64=""
OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-}"
if is_true "${OPENCODE_ENABLE}"; then
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
fi

# Make the runtime configuration discoverable to shells and to `agent-env`.
{
  echo "GATEWAY_PORT=${GATEWAY_PORT}"
  echo "PUBLIC_URL=${PUBLIC_URL}"
  echo "AUTH_MODE=${AUTH_MODE}"
  echo "ENV_PREFIX=${ENV_PREFIX}"
  echo "TTYD_PATH=${TTYD_PATH}"
  echo "DESKTOP_PATH=${DESKTOP_PATH}"
  echo "DUFS_PATH=${DUFS_PATH}"
  echo "HEALTH_PATH=${HEALTH_PATH}"
  echo "USER_WEB_PATH=${USER_WEB_PATH}"
  echo "USER_WEB_ENABLE=$(canon "${USER_WEB_ENABLE}")"
  echo "OPENCODE_ENABLE=$(canon "${OPENCODE_ENABLE}")"
  echo "OPENCODE_PORT=${OPENCODE_PORT}"
  echo "PRIMARY_PORT=${PRIMARY_PORT}"
  echo "OPENCODE_WORKDIR=${OPENCODE_WORKDIR}"
  echo "SSH_PORT=${SSH_PORT}"
  echo "DESKTOP_DISPLAY=${DESKTOP_DISPLAY}"
  echo "AB_DASHBOARD_PORT=${AB_DASHBOARD_PORT}"
  echo "AB_DASHBOARD_ENABLE=$(canon "${AB_DASHBOARD_ENABLE}")"
  echo "DASHBOARD_PUBLIC_URL=${DASHBOARD_PUBLIC_URL}"
  echo "DESKTOP_ENABLE=$(canon "${DESKTOP_ENABLE}")"
  echo "TTYD_ENABLE=$(canon "${TTYD_ENABLE}")"
  echo "SSH_ENABLE=$(canon "${SSH_ENABLE}")"
  echo "USER_NAME=${USER_NAME}"
  echo "DOCKER_ROOTLESS_ENABLE=$(canon "${DOCKER_ROOTLESS_ENABLE}")"
} > "${RUN_DIR}/env"

cat > /etc/profile.d/99-agent-env.sh <<EOF
export OPENCODE_SERVER_PASSWORD='${OPENCODE_SERVER_PASSWORD}'
export OPENCODE_SERVER='http://127.0.0.1:${OPENCODE_PORT}'
export DISPLAY='${DESKTOP_DISPLAY}'
export XAUTHORITY='${XAUTHORITY_FILE}'
export XDG_RUNTIME_DIR='${XDG_RUNTIME_DIR}'
EOF
if is_true "${DOCKER_ROOTLESS_ENABLE}"; then
  # Point the CLI at the user's own daemon. Without this `docker` looks for
  # /var/run/docker.sock, which is root's and is not there.
  echo "export DOCKER_HOST='${DOCKER_ROOTLESS_HOST}'" >> /etc/profile.d/99-agent-env.sh
fi
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
if is_true "${DOCKER_ROOTLESS_ENABLE}"; then
  echo "DOCKER_HOST=${DOCKER_ROOTLESS_HOST}" >> /etc/environment
fi
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
  google|github)
    # Both modes are the same gate — oauth2-proxy in front of Caddy — differing
    # only in the provider, the credentials it reads and what an allow list can
    # be written against. Everything below the provider switch is shared.
    AUTH_PROVIDER="${AUTH_MODE,,}"

    case "${AUTH_PROVIDER}" in
      google) client_id_var=GOOGLE_CLIENT_ID; client_secret_var=GOOGLE_CLIENT_SECRET ;;
      github) client_id_var=GITHUB_CLIENT_ID; client_secret_var=GITHUB_CLIENT_SECRET ;;
    esac

    # oauth2-proxy reads its own OAUTH2_PROXY_* variables directly, so accept
    # either those or the friendlier per-provider names.
    client_id="${!client_id_var:-${OAUTH2_PROXY_CLIENT_ID:-}}"
    # Whichever spelling carries it, the secret goes to oauth2-proxy by file —
    # so it is out of the process list and out of every daemon's environment,
    # and there is only one path to get wrong.
    client_secret="${!client_secret_var:-${OAUTH2_PROXY_CLIENT_SECRET:-}}"
    [[ -n "${client_id}" ]] \
      || die "AUTH_MODE=${AUTH_PROVIDER} requires ${client_id_var} (or OAUTH2_PROXY_CLIENT_ID)"
    [[ -n "${client_secret}" ]] \
      || die "AUTH_MODE=${AUTH_PROVIDER} requires ${client_secret_var} (or OAUTH2_PROXY_CLIENT_SECRET)"

    # Every allow list is normalised before it is counted, because these are
    # the values that decide whether there is a gate at all. `GITHUB_USERS=,`
    # is non-empty as a string and renders no restriction whatsoever, so
    # counting the raw value would accept it as an allow list and then, with
    # --email-domain=* below, hand the container to any GitHub account there
    # is. Count what will actually be rendered, not what was typed.
    allowed_emails="$(clean_list "${ALLOWED_EMAILS:-}")"
    allowed_email_domains="$(clean_list "${ALLOWED_EMAIL_DOMAINS:-}")"
    github_users="$(clean_list "${GITHUB_USERS:-}")"
    github_org="$(clean_list "${GITHUB_ORG:-}")"
    github_team="$(clean_list "${GITHUB_TEAM:-}")"

    # Refuse an open door before doing any other work.
    case "${AUTH_PROVIDER}" in
      google)
        if [[ -z "${allowed_emails}" && -z "${allowed_email_domains}" ]]; then
          die "AUTH_MODE=google requires ALLOWED_EMAILS and/or ALLOWED_EMAIL_DOMAINS, otherwise any Google account on the internet could sign in"
        fi
        ;;
      github)
        # GitHub's allow list is normally written against accounts rather than
        # addresses, so any of five things counts as one.
        if [[ -z "${github_users}" && -z "${github_org}" && -z "${github_team}" \
              && -z "${allowed_emails}" && -z "${allowed_email_domains}" ]]; then
          die "AUTH_MODE=github requires GITHUB_USERS, GITHUB_ORG, GITHUB_TEAM, ALLOWED_EMAILS or ALLOWED_EMAIL_DOMAINS, otherwise any GitHub account on the internet could sign in"
        fi
        ;;
    esac

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
      --provider="${AUTH_PROVIDER}"
      --http-address="127.0.0.1:${OAUTH2_PROXY_PORT}"
      --reverse-proxy=true
      --client-id="${client_id}"
      --redirect-url="${PUBLIC_URL}/oauth2/callback"
      --upstream="static://202"
      --set-xauthrequest=true
      --skip-provider-button=true
      --cookie-secure="${cookie_secure}"
      --cookie-expire="${AUTH_SESSION_TTL:-168h}"
      --cookie-refresh="${AUTH_SESSION_REFRESH:-1h}"
      --whitelist-domain="$(url_host "${PUBLIC_URL}")"
      --silence-ping-logging=true
      # Only Caddy talks to oauth2-proxy, so only loopback may supply
      # X-Forwarded-* headers.
      --trusted-proxy-ip="127.0.0.1/32"
      --trusted-proxy-ip="::1/128"
    )

    # Allow post-login redirects back to the dashboard's own origin.
    if is_true "${AB_DASHBOARD_ENABLE}"; then
      OAUTH2_ARGS+=(--whitelist-domain="$(url_host "${DASHBOARD_PUBLIC_URL}")")
    fi

    # A cleaned list to one repeated flag.
    add_list_args() {
      local flag="$1" item
      local -a _items=()
      IFS=',' read -ra _items <<<"$2"
      for item in "${_items[@]}"; do
        [[ -n "${item}" ]] && OAUTH2_ARGS+=("${flag}=${item}")
      done
      return 0
    }

    if [[ -n "${allowed_email_domains}" ]]; then
      add_list_args --email-domain "${allowed_email_domains}"
    fi

    if [[ -n "${allowed_emails}" ]]; then
      emails_file="${RUN_DIR}/authenticated-emails"
      tr ',' '\n' <<<"${allowed_emails}" > "${emails_file}"
      chmod 644 "${emails_file}"
      OAUTH2_ARGS+=(--authenticated-emails-file="${emails_file}")
    fi

    case "${AUTH_PROVIDER}" in
      google)
        OAUTH2_ARGS+=(--scope="openid email profile")

        # Optional Google Workspace group restriction.
        if [[ -n "${GOOGLE_GROUPS:-}" ]]; then
          [[ -n "${GOOGLE_ADMIN_EMAIL:-}" ]] || die "GOOGLE_GROUPS requires GOOGLE_ADMIN_EMAIL"
          [[ -n "${GOOGLE_SERVICE_ACCOUNT_JSON:-}" ]] || die "GOOGLE_GROUPS requires GOOGLE_SERVICE_ACCOUNT_JSON (path to the key file)"
          add_list_args --google-group "$(clean_list "${GOOGLE_GROUPS}")"
          OAUTH2_ARGS+=(
            --google-admin-email="${GOOGLE_ADMIN_EMAIL}"
            --google-service-account-json="${GOOGLE_SERVICE_ACCOUNT_JSON}"
          )
        fi
        ;;

      github)
        [[ -n "${github_org}" ]] && OAUTH2_ARGS+=(--github-org="${github_org}")
        # One flag, comma-separated, and it is the whole list: with no
        # GITHUB_ORG the entries have to be spelled `org:team`.
        [[ -n "${github_team}" ]] && OAUTH2_ARGS+=(--github-team="${github_team}")
        [[ -n "${github_users}" ]] && add_list_args --github-user "${github_users}"

        # oauth2-proxy validates the account's email regardless of which
        # GitHub check let it in, and with no email rule of our own that
        # validation would reject everybody. The account restrictions above
        # are the boundary in that case — the check that refused to start
        # guarantees there is one — so say every address is acceptable.
        if [[ -z "${allowed_emails}" && -z "${allowed_email_domains}" ]]; then
          OAUTH2_ARGS+=(--email-domain='*')
        fi

        # The provider's own default, and it has to be: EnrichSession reads
        # /user/orgs and /user/teams on every sign-in, before it looks at any
        # restriction and whether or not one is configured, and both need
        # read:org. Narrowing this to user:email breaks the callback for every
        # deployment — including one restricted only by username or by email.
        OAUTH2_ARGS+=(--scope="user:email read:org")
        ;;
    esac

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
    die "unknown AUTH_MODE='${AUTH_MODE}' (expected: google, github, basic or none)"
    ;;
esac

# ---------------------------------------------------------------------------
# Caddyfile
# ---------------------------------------------------------------------------
# The environment's own index, served at /${ENV_PREFIX}/. Rendered from the same
# flags the gateway is, so it can only ever list what is actually routed.
render_env_index() {
  local d=/opt/agent-env/web
  mkdir -p "${d}"

  svc() {
    printf '      <li><a class="svc" href="%s"><b>%s</b><span>%s</span></a></li>\n' "$1" "$2" "$3"
  }

  {
    cat <<'HTMLHEAD'
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agent-env</title>
<style>
  :root { color-scheme: light dark;
    --fg:#111; --muted:#666; --bg:#fafafa; --card:#fff; --line:#e4e4e4; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e8; --muted:#9a9a9a; --bg:#0d0d0d; --card:#171717; --line:#2b2b2b; }
  }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:34rem; margin:0 auto; padding:3rem 1.25rem; }
  h1 { font-size:1.05rem; margin:0 0 .3rem; }
  p.sub { margin:0 0 1.75rem; color:var(--muted); font-size:.875rem; }
  ul { list-style:none; margin:0; padding:0; display:grid; gap:.5rem; }
  a.svc { display:block; padding:.8rem 1rem; background:var(--card); color:inherit;
    border:1px solid var(--line); border-radius:.5rem; text-decoration:none; }
  a.svc:hover { border-color:var(--muted); }
  a.svc b { display:block; font-weight:600; font-size:.95rem; }
  a.svc span { color:var(--muted); font-size:.82rem; }
  footer { margin-top:2rem; color:var(--muted); font-size:.8rem; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.925em; }
</style>
HTMLHEAD

    # This page is also what / falls back to when nothing is listening on
    # PRIMARY_PORT, so it has to make sense read from either address.
    if is_true "${OPENCODE_ENABLE}"; then
      cat <<EOF
<main>
  <h1>agent-env</h1>
  <p class="sub">Everything this environment serves for itself is under
    <code>/${ENV_PREFIX}/</code>. <code>/</code> is OpenCode.</p>
  <ul>
      <li><a class="svc" href="/"><b>OpenCode</b><span>The v2 web UI and API, at /</span></a></li>
EOF
    else
      cat <<EOF
<main>
  <h1>agent-env</h1>
  <p class="sub">Everything this environment serves for itself is under
    <code>/${ENV_PREFIX}/</code>. <code>/</code> proxies to port
    <code>${PRIMARY_PORT}</code> — start something there and it shows up at
    <code>/</code>. With nothing listening, you land here.</p>
  <ul>
EOF
    fi

    if is_true "${TTYD_ENABLE}"; then
      if is_true "${OPENCODE_ENABLE}"; then
        svc "/${TTYD_PATH}/" "Terminal" "The OpenCode TUI, over a websocket"
      else
        svc "/${TTYD_PATH}/" "Terminal" "A login shell, over a websocket"
      fi
    fi
    is_true "${DESKTOP_ENABLE}" \
      && svc "/${DESKTOP_PATH}/" "Desktop" "XFCE on a virtual display, over noVNC"
    is_true "${DUFS_ENABLE}" \
      && svc "/${DUFS_PATH}/" "Files" "Browse, upload and download the workspace"
    if is_true "${USER_SUPERVISOR_ENABLE}" && is_true "${USER_WEB_ENABLE}"; then
      svc "/${USER_WEB_PATH}" "Daemons" "Start, stop and tail your own background processes"
    fi
    is_true "${AB_DASHBOARD_ENABLE}" \
      && svc "${DASHBOARD_PUBLIC_URL}" "Browser dashboard" "Live agent-browser viewports and activity"

    cat <<HTMLFOOT
  </ul>
  <footer>Health: <code>/${HEALTH_PATH}</code></footer>
</main>
HTMLFOOT
  } > "${d}/index.html"

  chmod 644 "${d}/index.html"
  log "environment index written to ${d}/index.html"
}

render_env_index

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
      google|github)
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
    case "${AUTH_MODE,,}" in google|github) ;; *) return 0 ;; esac
    cat <<EOF

		# oauth2-proxy owns the sign-in endpoints. Deliberately NOT under
		# /${ENV_PREFIX}/: this is the path the registered redirect URI already
		# points at, and moving it would invalidate every existing OAuth client
		# configuration for no gain.
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
# Main entrance.
#
# Everything this image serves for itself is under /${ENV_PREFIX}/, so the
# handler at / owns its whole path space and can be given away to whatever the
# workspace is running. Two things sit outside the prefix, both deliberately:
# /oauth2/* (see below) and /${USER_WEB_PATH}* (pitchfork validates its web path
# as a single path segment, so it cannot be nested).
# ---------------------------------------------------------------------------
:${GATEWAY_PORT} {
${BIND_DIRECTIVE}	route {
		handle /${HEALTH_PATH} {
			respond "ok" 200
		}
EOF

    emit_oauth_endpoints

    echo
    echo "		route {"
    emit_auth_gate "${PUBLIC_URL}"

    cat <<EOF

			# The environment's index: what is running and where to find it.
			redir /${ENV_PREFIX} /${ENV_PREFIX}/
			handle /${ENV_PREFIX}/ {
				root * /opt/agent-env/web
				rewrite * /index.html
				file_server
			}
EOF

    if is_true "${DESKTOP_ENABLE}"; then
      cat <<EOF

			# noVNC resolves its websocket relative to the page it was loaded
			# from, so the default lands on /${DESKTOP_PATH}/websockify. It is
			# not told the prefix; handle_path strips it before proxying.
			redir /${DESKTOP_PATH} /${DESKTOP_PATH}/
			handle /${DESKTOP_PATH}/ {
				redir * /${DESKTOP_PATH}/vnc.html?autoconnect=true&resize=remote
			}
			handle_path /${DESKTOP_PATH}/* {
				reverse_proxy 127.0.0.1:${NOVNC_PORT}
			}
EOF
    fi

    if is_true "${TTYD_ENABLE}"; then
      cat <<EOF

			# ttyd is told its own --base-path, so pass the path through rather
			# than stripping it.
			redir /${TTYD_PATH} /${TTYD_PATH}/
			handle /${TTYD_PATH}/* {
				reverse_proxy 127.0.0.1:${TTYD_PORT}
			}
EOF
    fi

    if is_true "${DUFS_ENABLE}"; then
      cat <<EOF

			# dufs is told its prefix with --path-prefix, so pass the path
			# through rather than stripping it.
			redir /${DUFS_PATH} /${DUFS_PATH}/
			handle /${DUFS_PATH}/* {
				reverse_proxy 127.0.0.1:${DUFS_PORT}
			}
EOF
    fi

    if is_true "${USER_SUPERVISOR_ENABLE}" && is_true "${USER_WEB_ENABLE}"; then
      cat <<EOF

			# pitchfork's web UI for the user's own daemons. It cannot live
			# under /${ENV_PREFIX}/ — PITCHFORK_WEB_PATH is validated as a
			# single [A-Za-z0-9_-] segment and baked into a <base href> — so it
			# keeps a top-level path and the prefix redirects to it. Its
			# document is at /${USER_WEB_PATH} with no trailing slash, so a
			# stray slash goes back to it.
			redir /${ENV_PREFIX}/daemons /${USER_WEB_PATH}
			redir /${ENV_PREFIX}/daemons/ /${USER_WEB_PATH}
			redir /${USER_WEB_PATH}/ /${USER_WEB_PATH}
			handle /${USER_WEB_PATH}* {
				reverse_proxy 127.0.0.1:${USER_WEB_PORT}
			}

			# Its logo is a hard-coded absolute /img/logo.png in the JS bundle,
			# which ignores the <base href> and escapes the prefix. That is a
			# path a real application may well want, so it is matched only when
			# the request came from the daemons UI; everything else asking for
			# /img/logo.png falls through to whatever is at /. If a referrer
			# policy strips the path, the daemons UI loses its logo and nothing
			# else — the right way for this to fail.
			@${USER_WEB_PATH}_logo {
				path /img/logo.png
				expression {http.request.header.Referer}.contains("/${USER_WEB_PATH}")
			}
			handle @${USER_WEB_PATH}_logo {
				rewrite * /${USER_WEB_PATH}/img/logo.png
				reverse_proxy 127.0.0.1:${USER_WEB_PORT}
			}
EOF
    fi

    cat <<EOF

			# Nothing else under the reserved prefix exists. Answer for it here
			# rather than letting it fall through, so / never sees a request
			# that was addressed to the environment.
			handle /${ENV_PREFIX}/* {
				respond "no such service — see /${ENV_PREFIX}/ for what this environment serves" 404
			}
EOF
    if is_true "${OPENCODE_ENABLE}"; then
      cat <<EOF

			# Everything else: the OpenCode v2 web UI and API. The server's own
			# basic-auth credential is injected here so users never see it.
			# The injection is bound to OpenCode and must never follow / to anything
			# else: it would hand a credential to someone's own application, and
			# break anything that does its own Authorization.
			handle {
				reverse_proxy 127.0.0.1:${OPENCODE_PORT} {
					header_up Authorization "Basic ${GATEWAY_BASIC_B64}"
				}
			}
		}
	}
}
EOF
    else
      # Reserved paths are excluded from the fallback so a genuinely dead
      # service surfaces as 502. /${USER_WEB_PATH} is only reserved when the
      # dashboard is actually rendered; otherwise it is the primary service's.
      local err_exclude="/${ENV_PREFIX}/*"
      if is_true "${USER_SUPERVISOR_ENABLE}" && is_true "${USER_WEB_ENABLE}"; then
        err_exclude="${err_exclude} /${USER_WEB_PATH}*"
      fi
      cat <<EOF

			# / belongs to the workspace. Nothing is injected here — the OpenCode
			# credential exists to reach the OpenCode server, and sending it
			# anywhere else would leak it into someone else's application.
			handle {
				reverse_proxy 127.0.0.1:${PRIMARY_PORT}
			}
		}
	}

	# Nothing listening on ${PRIMARY_PORT} yet? Show the index instead of a bare
	# 502, so an empty workstation explains itself. Caddy comes here only for
	# errors it generates — a refused connection — so an app that is up and
	# answering 502 itself still shows its own error, which is what you want
	# while debugging it.
	#
	# Scoped away from the reserved prefix deliberately: a dufs or ttyd that is
	# genuinely down has to surface as 502, not be papered over with an index.
	handle_errors 502 {
		@primary not path ${err_exclude}
		handle @primary {
			root * /opt/agent-env/web
			rewrite * /index.html
			file_server
		}
		handle {
			respond "{err.status_code} {err.status_text}" {err.status_code}
		}
	}
}
EOF
    fi

    if is_true "${AB_DASHBOARD_ENABLE}"; then
      cat <<EOF

# ---------------------------------------------------------------------------
# agent-browser observability dashboard, on its own port because it serves its
# assets from absolute paths and its reverse-proxy scheme is origin-based.
#
# Same hostname as the main entrance, different port — so the oauth2-proxy
# session cookie, which is host-scoped and ignores the port, covers both and
# only one redirect URI is ever registered with Google. This port has no
# reserved prefix: the dashboard owns all of it.
# ---------------------------------------------------------------------------
:${DASHBOARD_GATEWAY_PORT} {
${BIND_DIRECTIVE}	route {
		handle /${HEALTH_PATH} {
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
TTYD_PATH = "${TTYD_PATH}"
DUFS_PATH = "${DUFS_PATH}"
AB_DASHBOARD_PORT = "${AB_DASHBOARD_PORT}"
EOF

    # Must stay directly under [env]: in TOML everything after a table header
    # belongs to that table, and emit_daemon opens [daemons.*] below.
    if ! is_true "${OPENCODE_ENABLE}"; then
      printf 'TTYD_COMMAND = "shell"\n'
    fi
    if is_true "${DOCKER_ROOTLESS_ENABLE}"; then
      printf 'DOCKER_HOST = "%s"\n' "${DOCKER_ROOTLESS_HOST}"
      printf 'DOCKER_ROOTLESS_DATA_ROOT = "%s"\n' "${DOCKER_ROOTLESS_DATA_ROOT}"
      if [[ -n "${DOCKER_ROOTLESS_ARGS:-}" ]]; then
        printf 'DOCKER_ROOTLESS_ARGS = "%s"\n' "${DOCKER_ROOTLESS_ARGS}"
      fi
    fi

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
    case "${AUTH_MODE,,}" in google|github)
      emit_daemon oauth2-proxy "/opt/agent-env/bin/run-oauth2-proxy" \
        "user = \"${GATEWAY_USER_NAME}\"" \
        'retry = true' \
        "ready_http = { url = \"http://127.0.0.1:${OAUTH2_PROXY_PORT}/ping\", timeout = \"60s\" }"
      caddy_deps='depends = ["oauth2-proxy"]'
      ;;
    esac

    emit_daemon caddy "/usr/local/bin/caddy run --config /etc/caddy/Caddyfile" \
      "user = \"${GATEWAY_USER_NAME}\"" \
      "${caddy_deps}" \
      'retry = true' \
      'env = { HOME = "/var/lib/caddy", XDG_CONFIG_HOME = "/var/lib/caddy", XDG_DATA_HOME = "/var/lib/caddy" }' \
      "ready_http = { url = \"http://127.0.0.1:${GATEWAY_PORT}/${HEALTH_PATH}\", timeout = \"60s\" }"

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
if is_true "${OPENCODE_ENABLE}"; then
  log " OpenCode v2 : $(su -s /bin/bash -c 'opencode2 --version' "${USER_NAME}" 2>/dev/null || echo unknown)"
else
  log " primary     : / proxies to 127.0.0.1:${PRIMARY_PORT} (OpenCode is off)"
fi
log " gateway     : ${PUBLIC_URL}  (listening on ${GATEWAY_BIND:-0.0.0.0}:${GATEWAY_PORT})"
log " auth mode   : ${AUTH_MODE}"
log " index       : ${PUBLIC_URL}/${ENV_PREFIX}/"
if is_true "${TTYD_ENABLE}"; then
  if is_true "${OPENCODE_ENABLE}"; then
    log " TUI         : ${PUBLIC_URL}/${TTYD_PATH}/"
  else
    log " terminal    : ${PUBLIC_URL}/${TTYD_PATH}/  (login shell)"
  fi
fi
is_true "${DESKTOP_ENABLE}"     && log " desktop     : ${PUBLIC_URL}/${DESKTOP_PATH}/"
is_true "${AB_DASHBOARD_ENABLE}" && log " browser dash: ${DASHBOARD_PUBLIC_URL}"
if is_true "${USER_SUPERVISOR_ENABLE}" && is_true "${USER_WEB_ENABLE}"; then
  log " daemons     : ${PUBLIC_URL}/${USER_WEB_PATH}"
fi
is_true "${DUFS_ENABLE}" && log " files       : ${PUBLIC_URL}/${DUFS_PATH}/"
is_true "${DOCKER_ROOTLESS_ENABLE}" && log " docker      : rootless, as ${USER_NAME} (docker compose available)"
is_true "${SSH_ENABLE}"         && log " ssh         : ${USER_NAME}@<host> -p ${SSH_PORT}"
log " workspace   : ${OPENCODE_WORKDIR}"
log "----------------------------------------------------------------"

# The gateway's credentials are in root-owned files by now, and oauth2-proxy
# reads them from there. Leaving them in the environment would hand them to every
# daemon — including the OpenCode server, whose whole job is running code the
# agent was asked to run. A prompt injection or a hostile postinstall could then
# read them straight out of /proc/self/environ.
unset GOOGLE_CLIENT_SECRET GOOGLE_CLIENT_SECRET_FILE \
      GITHUB_CLIENT_SECRET GITHUB_CLIENT_SECRET_FILE \
      GATEWAY_PASSWORD GATEWAY_PASSWORD_FILE \
      OAUTH2_PROXY_COOKIE_SECRET OAUTH2_PROXY_CLIENT_SECRET

# exec keeps PID 1, which is what pitchfork's container mode needs.
exec "$@"
