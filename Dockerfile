# syntax=docker/dockerfile:1.7
#
# agent-env — a ready-to-use OpenCode v2 workstation image.
#
#   * OpenCode v2 API + web server (`opencode2 serve`)
#   * SSH server
#   * XFCE desktop on a virtual display, reachable over noVNC
#   * ttyd, serving the real OpenCode v2 TUI in the browser
#   * Google sign-in (oauth2-proxy) in front of all of it, via Caddy
#   * mise as the language/tool manager
#   * agent-browser + system Chromium, wired to the virtual display
#
FROM debian:trixie-slim

ARG TARGETARCH

# Pinned versions for the components we fetch outside apt.
ARG OPENCODE_VERSION=beta
ARG AGENT_BROWSER_VERSION=latest
ARG NODE_VERSION=24
ARG TTYD_VERSION=1.7.7
ARG PITCHFORK_VERSION=2.22.0
ARG OAUTH2_PROXY_VERSION=7.15.4
ARG CADDY_VERSION=2.11.4

ARG USER_NAME=dev
ARG USER_UID=1000
ARG USER_GID=1000

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# ---------------------------------------------------------------------------
# Base system: dev tooling, SSH, X11 + XFCE, noVNC, Chromium.
# ---------------------------------------------------------------------------
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      # core
      ca-certificates curl wget gnupg git git-lfs jq unzip zip xz-utils bzip2 \
      sudo procps psmisc iproute2 iputils-ping net-tools \
      less nano vim-tiny ripgrep fd-find bash-completion locales tzdata libcap2-bin \
      fastfetch btop ncdu \
      build-essential pkg-config libssl-dev zlib1g-dev \
      # ssh
      openssh-server openssh-client mosh \
      # x11 / desktop
      xvfb x11vnc x11-utils x11-xserver-utils xauth \
      dbus dbus-x11 dbus-daemon dbus-system-bus-common dbus-user-session \
      xfce4-session xfwm4 xfdesktop4 xfce4-panel xfce4-terminal xfce4-appfinder \
      xfce4-settings thunar mousepad \
      # web vnc
      novnc websockify \
      # fonts
      fonts-noto-core fonts-noto-color-emoji fonts-dejavu-core \
      # browser for agent-browser
      chromium chromium-sandbox \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Third-party static binaries (pitchfork, ttyd, oauth2-proxy, caddy).
# ---------------------------------------------------------------------------
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) TTYD_ARCH=x86_64; GO_ARCH=amd64; RUST_ARCH=x86_64 ;; \
      arm64) TTYD_ARCH=aarch64; GO_ARCH=arm64; RUST_ARCH=aarch64 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    \
    curl -fsSL "https://github.com/jdx/pitchfork/releases/download/v${PITCHFORK_VERSION}/pitchfork-${RUST_ARCH}-unknown-linux-gnu.tar.gz" \
      | tar -xz -C /usr/local/bin pitchfork; \
    chmod +x /usr/local/bin/pitchfork; \
    \
    curl -fsSL -o /usr/local/bin/ttyd \
      "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${TTYD_ARCH}"; \
    chmod +x /usr/local/bin/ttyd; \
    \
    curl -fsSL -o /tmp/oauth2-proxy.tar.gz \
      "https://github.com/oauth2-proxy/oauth2-proxy/releases/download/v${OAUTH2_PROXY_VERSION}/oauth2-proxy-v${OAUTH2_PROXY_VERSION}.linux-${GO_ARCH}.tar.gz"; \
    tar -xzf /tmp/oauth2-proxy.tar.gz -C /tmp; \
    mv /tmp/oauth2-proxy-v${OAUTH2_PROXY_VERSION}.linux-${GO_ARCH}/oauth2-proxy /usr/local/bin/oauth2-proxy; \
    chmod +x /usr/local/bin/oauth2-proxy; \
    \
    curl -fsSL -o /tmp/caddy.tar.gz \
      "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${GO_ARCH}.tar.gz"; \
    tar -xzf /tmp/caddy.tar.gz -C /tmp caddy; \
    mv /tmp/caddy /usr/local/bin/caddy; \
    chmod +x /usr/local/bin/caddy; \
    \
    rm -rf /tmp/oauth2-proxy* /tmp/caddy*; \
    pitchfork --version; ttyd --version; oauth2-proxy --version; caddy version

# ---------------------------------------------------------------------------
# mise (installed system-wide, shims exposed on PATH for every login shell).
# ---------------------------------------------------------------------------
ENV MISE_DATA_DIR=/opt/mise \
    MISE_CONFIG_DIR=/etc/mise \
    MISE_STATE_DIR=/opt/mise/state \
    MISE_CACHE_DIR=/opt/mise/cache \
    MISE_YES=1

RUN curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh \
    && mkdir -p /opt/mise /etc/mise \
    && mise --version

# ---------------------------------------------------------------------------
# Unprivileged user.
# ---------------------------------------------------------------------------
RUN set -eux; \
    groupadd -g "${USER_GID}" "${USER_NAME}"; \
    useradd -m -u "${USER_UID}" -g "${USER_GID}" -s /bin/bash "${USER_NAME}"; \
    usermod -aG audio,video "${USER_NAME}"; \
    echo "${USER_NAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-${USER_NAME}; \
    chmod 0440 /etc/sudoers.d/90-${USER_NAME}; \
    visudo -cf /etc/sudoers.d/90-${USER_NAME}; \
    mkdir -p /workspace && chown "${USER_UID}:${USER_GID}" /workspace; \
    \
    # The two network-facing proxies get their own unprivileged, shell-less
    # account. It deliberately has no sudo, so a hole in the edge does not
    # hand over the dev user's root.
    groupadd --system gateway; \
    useradd --system --gid gateway --no-create-home \
            --shell /usr/sbin/nologin gateway

RUN chown -R "${USER_UID}:${USER_GID}" /opt/mise /etc/mise

ENV USER_NAME=${USER_NAME} \
    HOME=/home/${USER_NAME} \
    PATH=/opt/mise/shims:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin

# ---------------------------------------------------------------------------
# Node (via mise) + OpenCode v2 + agent-browser, installed as the user.
# ---------------------------------------------------------------------------
USER ${USER_NAME}
WORKDIR /home/${USER_NAME}

RUN set -eux; \
    mise use -g "node@${NODE_VERSION}"; \
    mise x -- node --version; \
    mise x -- npm install -g "@opencode-ai/cli@${OPENCODE_VERSION}" "agent-browser@${AGENT_BROWSER_VERSION}"; \
    mise reshim; \
    \
    # Both packages ship every platform's prebuilt binary; keep only ours.
    npm_root="$(mise x -- npm root -g)"; \
    case "$(uname -m)" in \
      x86_64) ab_keep="agent-browser-linux-x64" ;; \
      aarch64) ab_keep="agent-browser-linux-arm64" ;; \
      *) ab_keep="" ;; \
    esac; \
    if [ -n "${ab_keep}" ]; then \
      find "${npm_root}/agent-browser/bin" -maxdepth 1 -type f -name 'agent-browser-*' \
        ! -name "${ab_keep}" -delete; \
    fi; \
    find "${npm_root}/@opencode-ai/cli/node_modules/@opencode-ai" -maxdepth 1 -type d \
      -name '*-musl*' -exec rm -rf {} +; \
    \
    # npm's cache is pure build residue.
    mise x -- npm cache clean --force >/dev/null 2>&1 || true; \
    rm -rf "${HOME}/.npm" "${HOME}/.cache" /opt/mise/cache; \
    \
    opencode2 --version; \
    agent-browser --version

USER root

# ---------------------------------------------------------------------------
# Runtime scripts, service launchers and shell integration.
# ---------------------------------------------------------------------------
COPY rootfs/ /

RUN set -eux; \
    chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/agent-env /opt/agent-env/bin/*; \
    mkdir -p /var/run/sshd /run/dbus /var/lib/caddy /var/lib/pitchfork /opt/agent-env/pitchfork; \
    chown -R gateway:gateway /var/lib/caddy; \
    # Lets the unprivileged gateway user bind low ports if GATEWAY_PORT is one.
    setcap cap_net_bind_service=+ep /usr/local/bin/caddy || true; \
    install -d -m 1777 /tmp/.X11-unix /tmp/.ICE-unix; \
    mkdir -p /home/${USER_NAME}/.config/opencode \
             /home/${USER_NAME}/.local/share/opencode \
             /home/${USER_NAME}/.local/share/agent-browser \
             /home/${USER_NAME}/.agent-browser \
             /home/${USER_NAME}/.ssh \
             /home/${USER_NAME}/Desktop; \
    chmod 700 /home/${USER_NAME}/.ssh; \
    printf '%s\n' \
      '{' \
      '  "headed": true,' \
      '  "executablePath": "/usr/bin/chromium",' \
      '  "args": "--no-sandbox,--disable-dev-shm-usage,--disable-gpu"' \
      '}' > /home/${USER_NAME}/.agent-browser/config.json; \
    chown -R ${USER_UID}:${USER_GID} /home/${USER_NAME}; \
    # A skeleton of just the state dirs, so mounting empty volumes over them
    # still behaves like a fresh install.
    mkdir -p /opt/agent-env/skel; \
    for p in .bashrc .profile .config .local .agent-browser; do \
      [ -e "/home/${USER_NAME}/$p" ] || continue; \
      cp -a "/home/${USER_NAME}/$p" /opt/agent-env/skel/; \
    done; \
    du -sh /opt/agent-env/skel

# ---------------------------------------------------------------------------
# Default runtime configuration. Everything here is overridable with -e.
# ---------------------------------------------------------------------------
ENV TZ=UTC \
    GATEWAY_PORT=8080 \
    AUTH_MODE=google \
    PUBLIC_URL=http://localhost:8080 \
    OPENCODE_PORT=4096 \
    OPENCODE_WORKDIR=/workspace \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    SSH_ENABLE=true \
    SSH_PORT=22 \
    DESKTOP_ENABLE=true \
    DESKTOP_RESOLUTION=1920x1080x24 \
    DESKTOP_DISPLAY=:1 \
    TTYD_ENABLE=true \
    TTYD_WRITABLE=true \
    AB_DASHBOARD_ENABLE=true \
    AB_DASHBOARD_PORT=4848 \
    DASHBOARD_GATEWAY_PORT=8081 \
    USER_SUPERVISOR_ENABLE=true \
    USER_WEB_ENABLE=true \
    USER_WEB_PORT=4747 \
    USER_WEB_PATH=pitchfork \
    DISPLAY=:1 \
    CHROME_BIN=/usr/bin/chromium \
    XDG_RUNTIME_DIR=/run/user/1000

# 8080/8081 gateway, 22 ssh, 60000-60010/udp mosh
EXPOSE 8080 8081 22 60000-60010/udp

# The gateway answers /healthz itself, so that alone would not tell us whether
# the OpenCode server — a daemon of the user's supervisor — is actually up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD ["bash", "-c", "curl -fsS http://127.0.0.1:${GATEWAY_PORT}/healthz >/dev/null && exec 3<>/dev/tcp/127.0.0.1/${OPENCODE_PORT}"]

# entrypoint.sh renders configuration and then exec's the CMD, so pitchfork
# ends up as PID 1 with its own zombie reaper and signal forwarding.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["pitchfork", "supervisor", "run", "--container", "--boot"]
