# agent-env

[![docker](https://github.com/dtinth/agent-env/actions/workflows/docker.yml/badge.svg)](https://github.com/dtinth/agent-env/actions/workflows/docker.yml)

A ready-to-use Docker image that turns OpenCode v2 into a hosted, Google-authenticated
workstation.

![The agent-env desktop over noVNC: fastfetch, btop and a user-owned pitchfork daemon](desktop.png)

One container gives you:

| What | Where | Notes |
|---|---|---|
| **OpenCode v2 web UI + API** | `<PUBLIC_URL>/` | `opencode2 serve` |
| **OpenCode v2 TUI** in the browser | `<PUBLIC_URL>/terminal` | the real TUI, over ttyd |
| **XFCE desktop** in the browser | `<PUBLIC_URL>/desktop` | noVNC over x11vnc |
| **agent-browser dashboard** | `<DASHBOARD_PUBLIC_URL>` | own port; live browser viewports |
| **SSH + mosh** | port `22`, UDP `60000-60010` | key-based by default |
| **Google sign-in** in front of all of it | `<PUBLIC_URL>/oauth2/*` | oauth2-proxy behind Caddy |
| **mise** | `/opt/mise` | manages node and anything else you add |
| **a usable shell** | — | git, ripgrep, fd, jq, fastfetch, btop, ncdu, a compiler |
| **pitchfork** | PID 1, plus one per user | supervises it all; you get your own for your own daemons |
| **agent-browser + Chromium** | on the virtual display | headed, so you can watch it over noVNC |

Everything is configured with environment variables. Nothing needs to be baked
into a custom image.

---

## Quick start

Published images are on GHCR, built for `linux/amd64` and `linux/arm64`:

```bash
docker pull ghcr.io/dtinth/agent-env:latest
```

### Locally, with basic auth (no Google setup needed)

```bash
docker build -t agent-env .          # or use ghcr.io/dtinth/agent-env:latest

docker run -d --name agent-env --shm-size=2g \
  -p 8080:8080 -p 8081:8081 -p 2222:22 \
  -e AUTH_MODE=basic \
  -e GATEWAY_PASSWORD=changeme \
  -e PUBLIC_URL=http://localhost:8080 \
  -e SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v agent-env-workspace:/workspace \
  agent-env
```

Open <http://localhost:8080> and sign in as `opencode` / `changeme`.
Then <http://localhost:8080/terminal> for the TUI, and
<http://localhost:8080/desktop> for the desktop.

### For real, with Google sign-in

1. In [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials),
   create an **OAuth 2.0 Client ID** of type *Web application*.
2. Set its **Authorised redirect URI** to exactly `<PUBLIC_URL>/oauth2/callback`,
   e.g. `https://oc.example.com/oauth2/callback`.
3. Copy `.env.example` to `.env`, fill in the client ID/secret, `PUBLIC_URL`,
   and who is allowed in.
4. `docker compose up -d`

```bash
cp .env.example .env
$EDITOR .env
docker compose up -d
docker compose logs -f
```

`PUBLIC_URL` must be the URL users actually type, and it must match the
registered redirect URI. Terminate TLS in front of the container (a load
balancer, Cloudflare, Caddy/nginx on the host) and point it at port 8080.

---

## Authentication

`AUTH_MODE` picks the gate on the way in:

- **`google`** (default) — oauth2-proxy handles the sign-in; Caddy checks every
  request against it with `forward_auth`. Requires `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, and at least one of `ALLOWED_EMAILS` /
  `ALLOWED_EMAIL_DOMAINS`. The container **refuses to start** without an allow
  list, because otherwise any Google account on the internet could sign in.
- **`basic`** — HTTP basic auth (`GATEWAY_USER` / `GATEWAY_PASSWORD`). Good for
  local runs. A password is generated and printed to the log if you omit it.
- **`none`** — no gate at all. Only sane behind your own authenticating proxy.

Optionally restrict further by Google Workspace group with `GOOGLE_GROUPS`
(needs `GOOGLE_ADMIN_EMAIL` and a delegated service-account key).

`/healthz` is always reachable without auth, so load balancers can probe it.

### How the OpenCode server itself is protected

`opencode2 serve` has its own HTTP basic auth (user `opencode`, password from
`OPENCODE_SERVER_PASSWORD`). The gateway injects that credential on the way
through, so users authenticate once with Google and never see it. If you don't
set `OPENCODE_SERVER_PASSWORD`, one is generated and persisted in the
`opencode-config` volume. The same value is exported inside the container so the
`opencode2` CLI and TUI can talk to the server.

Only ports **8080**, **8081** and **22** listen on external interfaces.
The OpenCode server, VNC, websockify, ttyd, the dashboard and oauth2-proxy are
all bound to loopback.

### Who runs as what

pitchfork is PID 1 and therefore root — it has to be, to reap zombies, run sshd
and drop privileges for everything else. It drops them aggressively:

| Runs as | Processes |
|---|---|
| `root` | pitchfork (PID 1), sshd, the log forwarder, and the wrapper that starts the system D-Bus (`dbus-daemon` itself drops to `messagebus`) |
| `gateway` (system account, no shell, **no sudo**) | Caddy and oauth2-proxy |
| `dev` (uid 1000, passwordless sudo) | everything you actually work in — the OpenCode server, Xvfb, the whole XFCE desktop, x11vnc, websockify, ttyd, agent-browser and Chromium, plus your own pitchfork supervisor |

So **the desktop and everything in it runs as `dev`**, never root — open a
terminal on the noVNC desktop and you are `dev`, same as over SSH.

The two network-facing proxies get their own throwaway account precisely
*because* `dev` has passwordless sudo: a hole in the edge shouldn't hand over
root. Caddy carries `cap_net_bind_service`, so it can still bind a low
`GATEWAY_PORT` without being root.

`dev` has passwordless sudo, so you can install things inside the container
freely — the image prunes apt's package lists, so run `sudo apt-get update`
first:

```bash
sudo apt-get update && sudo apt-get install -y tmux
mise use -g python@3.13     # no sudo needed; mise is owned by dev
```
 That also means anyone who gets past the gateway has root in
the container — which is why the allow list is mandatory and why each person
should get their own container.

---

## Configuration

See [`.env.example`](.env.example) for the annotated list. The essentials:

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:8080` | External base URL; drives OAuth redirects |
| `AUTH_MODE` | `google` | `google` / `basic` / `none` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Required for `google` |
| `ALLOWED_EMAILS`, `ALLOWED_EMAIL_DOMAINS` | — | Who may sign in |
| `OAUTH2_PROXY_COOKIE_SECRET` | generated | Set it to survive restarts cleanly |
| `OPENCODE_SERVER_PASSWORD` | generated | OpenCode server credential |
| `OPENCODE_WORKDIR` | `/workspace` | Where the server and TUI start |
| `SSH_AUTHORIZED_KEYS` | — | Newline- or `;`-separated public keys |
| `SSH_PASSWORD` | — | Enables password auth (prefer keys) |
| `DESKTOP_ENABLE` | `true` | XFCE + noVNC |
| `DESKTOP_RESOLUTION` | `1920x1080x24` | Virtual display geometry, `WxH` or `WxHxD` |
| `TTYD_ENABLE` | `true` | Browser TUI at `/terminal` |
| `AB_DASHBOARD_ENABLE` | `true` | agent-browser dashboard on its own port |
| `MISE_TOOLS` | — | Extra global tools, e.g. `python@3.13 go@latest` |
| `USER_SUPERVISOR_ENABLE` | `true` | Run the dev user's own pitchfork at boot |
| `TZ`, `PUID`, `PGID` | `UTC`, `1000`, `1000` | Timezone and uid/gid remapping |

Every variable also accepts a `<NAME>_FILE` form pointing at a file, for Docker
or Kubernetes secrets:

```yaml
environment:
  GOOGLE_CLIENT_SECRET_FILE: /run/secrets/google_client_secret
```

### Three ways to give it the OAuth client secret

Pick whichever suits your deployment:

```bash
-e GOOGLE_CLIENT_SECRET=GOCSPX-...              # plain environment variable
-e GOOGLE_CLIENT_SECRET_FILE=/run/secrets/gcs   # read from a file at startup
-e OAUTH2_PROXY_CLIENT_SECRET=GOCSPX-...        # oauth2-proxy's own variable
```

With the first two, the entrypoint hands the value to oauth2-proxy as
`--client-secret-file` so it never shows up in `ps`. The third is a
passthrough: oauth2-proxy reads its own `OAUTH2_PROXY_*` variables directly, and
the entrypoint stays out of the way rather than overriding them with a flag.
`OAUTH2_PROXY_CLIENT_ID` and `OAUTH2_PROXY_COOKIE_SECRET` work the same way, and
any other `OAUTH2_PROXY_*` variable is inherited by the process too.

### Provider credentials for OpenCode

Either pass API keys as environment variables (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, …), or sign in interactively with `/connect` in the TUI — that
is persisted in the `opencode-state` volume and survives restarts.

You can also drop a config in without rebuilding:

```bash
-e OPENCODE_CONFIG_CONTENT='{"model":"anthropic/claude-opus-5"}'
# or mount one at /home/dev/.config/opencode/opencode.json
```

---

## Operating it

```bash
docker exec -it agent-env agent-env status      # state of every service
docker exec -it agent-env agent-env urls        # what this container serves
docker exec -it agent-env agent-env password    # the OpenCode server password
docker exec -it agent-env agent-env logs caddy  # follow one service
docker exec -it agent-env agent-env top         # pitchfork's interactive dashboard
docker exec -it agent-env agent-env config      # the rendered gateway config
docker exec -it agent-env agent-env daemons     # the rendered daemon definitions
docker exec -it agent-env agent-env restart opencode
docker exec -it agent-env agent-env tui         # attach the TUI from a shell
```

### Supervision

[pitchfork](https://pitchfork.jdx.dev) runs as PID 1 in its container mode, so
zombies are reaped and `docker stop` shuts every daemon down in order — a clean
exit takes a few seconds, well inside Docker's grace period.

Daemons declare what they need rather than guessing at timing:

```toml
[daemons.x11vnc]
run = "/opt/agent-env/bin/run-x11vnc"
depends = ["xvfb"]        # start ordering, resolved topologically
ready_port = 5900         # "up" means the port answers
retry = true
```

pitchfork captures each daemon's output into its own log store, which is what
`agent-env logs` reads. A small `zz-log-forward` daemon also streams everything to
PID 1's stdout, so `docker logs -f agent-env` and your log driver still see the lot,
prefixed with `[global/<daemon>]`.

Run `scripts/smoke-test.sh` against a live container to check the whole thing:

```bash
./scripts/smoke-test.sh http://localhost:8080 opencode:changeme
```

### Your own daemons

The system supervisor is root's and stays that way. You get a **second,
unprivileged pitchfork supervisor of your own** — its own state, socket and
logs — so `pitchfork` as `dev` means *your* daemons and can't touch the
container's:

```bash
$ cat >> ~/.config/pitchfork/config.toml <<'EOF'
[daemons.api]
run = "npm run dev"
dir = "/workspace/my-app"
ready_port = 3000
boot_start = true      # comes up with the container
retry = true
EOF

$ pitchfork start api          # or `pitchfork start -g` for all of them
$ pitchfork list
$ pitchfork logs -f api
$ pitchfork tui                # dashboard for your daemons
```

Project daemons are usually better off in a `pitchfork.toml` next to your code —
`/workspace/pitchfork.toml` is on a volume, so it survives a rebuild, and
`pitchfork start -l` starts everything in it.

`agent-env status` shows both tables at once. The `agent-env` commands that touch
system services sudo into root for you; `agent-env mine` lists just yours.

Set `USER_SUPERVISOR_ENABLE=false` if you don't want the user supervisor running
at boot — you can still start one on demand.

Two details worth knowing if you go poking at this:

- `/etc/pitchfork/config.toml` is deliberately left empty. pitchfork reads it as
  the system-wide config layer for *every* supervisor, and a root-only file
  there is fatal for an unprivileged one — so the system supervisor keeps its
  config in `/opt/agent-env/pitchfork` instead.
- `/tmp/fslock` is pre-created mode 1777. pitchfork locks there, and whichever
  supervisor started first would otherwise own the directory and shut everyone
  else out.

Over SSH, the toolchain is on `PATH` for interactive *and* non-interactive
sessions:

```bash
ssh -p 2222 dev@host
ssh -p 2222 dev@host 'opencode2 run "summarise this repo"'
```

### mosh

Better than SSH over a flaky connection — it survives roaming and suspend. The
client picks the UDP port, so pass a range the container publishes:

```bash
mosh -p 60000:60010 --ssh="ssh -p 2222" dev@host
```

The image `EXPOSE`s `60000-60010/udp` and compose publishes the same range
(`HOST_MOSH_PORTS` to change it). One port per concurrent session, so widen the
range if you want more than ten. `agent-env urls` prints the exact command.

### Volumes

| Path | Holds |
|---|---|
| `/workspace` | your code |
| `/home/dev/.local/share/opencode` | sessions, provider logins, repo cache |
| `/home/dev/.config/opencode` | OpenCode config, generated secrets |
| `/home/dev/.agent-browser` | agent-browser profiles and saved auth |
| `/home/dev/.config/pitchfork` | your own daemon definitions |

The mise toolchain lives in `/opt/mise`, deliberately outside `$HOME`, so
mounting volumes over the home directory can't hide it.

Mounting a host directory at `/workspace`? Set `PUID`/`PGID` to match its owner.

### The desktop

Geometry comes from the environment, either as one value or as parts:

```bash
-e DESKTOP_RESOLUTION=2560x1440x24   # WxH or WxHxD (depth 8/15/16/24/30)
-e DESKTOP_RESOLUTION=1600x900       # depth defaults to 24
# or, equivalently
-e DESKTOP_WIDTH=1600 -e DESKTOP_HEIGHT=900 -e DESKTOP_DEPTH=24
```

An unparseable value fails at startup with a message naming the expected form,
rather than leaving you with a dead display.

**Several people can watch and use the same desktop at once.** x11vnc runs with
`-shared -forever`, and websockify forks a process per browser, so viewers join
the session rather than kicking each other off. `scripts/smoke-test.sh` asserts
this by opening four concurrent RFB connections.

Resolution is fixed for the life of the display: Xvfb has no dynamic RandR
resizing, so noVNC's client-side scaling is what adapts to your window. Change
`DESKTOP_RESOLUTION` and `agent-env restart xvfb` (then `desktop`, `x11vnc`) for a
different geometry. Set `VNC_PASSWORD` for a second factor in front of the
desktop specifically, and `VNC_VIEW_ONLY=true` for a read-only session.

### agent-browser

Chromium is installed from Debian and wired up already, as **user-level
defaults** in `~/.agent-browser/config.json`:

```json
{
  "headed": true,
  "executablePath": "/usr/bin/chromium",
  "args": "--no-sandbox,--disable-dev-shm-usage,--disable-gpu"
}
```

So `agent-browser open example.com` is headed with no flags. It lives in the
config file rather than in `AGENT_BROWSER_*` environment variables on purpose —
agent-browser's precedence is

```
~/.agent-browser/config.json  <  ./agent-browser.json  <  AGENT_BROWSER_*  <  CLI flags
```

so env vars would sit *above* a project's own `agent-browser.json` and quietly
override it. As a config file it is a real default: override it per project, per
command, or for the whole container:

```bash
agent-browser --headed false snapshot          # one command
echo '{"headed": false}' > ./agent-browser.json # one project
docker run -e AGENT_BROWSER_HEADED=false ...    # whole container
```

Because it runs headed on display `:1`, you can open `/desktop` and *watch* the
browser work. The dashboard on port 8081 shows live viewports and the command
feed.

`--no-sandbox` is the default because Chromium's sandbox needs privileges most
container runtimes deny. If your runtime allows it, drop that flag and add a
Chromium seccomp profile instead.

Chromium needs a large `/dev/shm`: keep `--shm-size=2g` (compose already sets it).

---

## Notes and limits

- **OpenCode v2 is beta.** It installs as `opencode2` from
  `@opencode-ai/cli@beta`; the image pins the tag, not a version. Set the
  `OPENCODE_VERSION` build arg to pin an exact one, and `OPENCODE_DISABLE_AUTOUPDATE=1`
  is already set so the container never self-updates under you.
- **The dashboard needs its own port.** It's a Next.js app that serves assets
  from absolute paths, so it can't live under a path prefix like `/desktop` does.
  It gets port 8081 with the same authentication. Set `DASHBOARD_PUBLIC_URL` if
  your host port differs from the container's, or `AB_DASHBOARD_ENABLE=false` to
  turn it off.
- **Image size is ~3 GB.** Most of it is XFCE, Chromium, a compiler toolchain and
  the ~150 MB OpenCode binary. Drop `DESKTOP_ENABLE`-related packages from the
  Dockerfile if you don't need the desktop.
- **pitchfork's container mode is marked experimental** by its own docs. It has
  behaved correctly here — PID 1, reaping, ordered graceful shutdown — but that
  is the one component whose stability is self-declared as not guaranteed. The
  daemon definitions are plain TOML rendered by the entrypoint, so swapping in
  another supervisor is a contained change if you ever need to.
- **Single-tenant.** You work as `dev`, which has passwordless sudo — so anyone
  past the gate effectively has root in the container. Give each person their
  own container rather than sharing one.
- **Multi-arch.** Builds for `linux/amd64` and `linux/arm64`; all fetched
  binaries resolve per `TARGETARCH`.

### Building for both architectures

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t your-registry/agent-env:latest --push .
```

CI does this on native runners rather than under QEMU — `.github/workflows/docker.yml`
builds each architecture on its own runner (`ubuntu-latest` and `ubuntu-24.04-arm`),
pushes it to GHCR *by digest and untagged*, runs `scripts/smoke-test.sh` against
the pushed artifact, and only merges the digests into a tagged manifest list once
both pass. A failed test therefore can't leave a broken `:latest` behind. Pull
requests build and test without pushing, and a weekly run picks up new OpenCode
v2 beta builds.

---

## How it fits together

```
                    ┌─── container (pitchfork = PID 1) ──────────────┐
   browser ──8080──►│ Caddy ──forward_auth──► oauth2-proxy ──► Google│
                    │   │                                            │
                    │   ├─ /            ──► opencode2 serve  :4096   │
                    │   ├─ /terminal    ──► ttyd :7681 ──► TUI       │
                    │   ├─ /desktop     ──► websockify :6080         │
                    │   │                     └─ x11vnc :5900 ──► Xvfb :1 ──► XFCE
                    │   └─ /healthz                                  │
                    │                                                │
   browser ──8081──►│ Caddy (same auth) ──► agent-browser dash :4848 │
   ssh    ────22───►│ sshd ──► dev                                   │
                    └────────────────────────────────────────────────┘
```

`Xvfb :1` also backs headed Chromium, which is why agent-browser sessions show
up on the noVNC desktop.

## Layout

```
Dockerfile                          image definition
docker-compose.yml                  ports, volumes, health check
.env.example                        every setting, annotated
rootfs/usr/local/bin/entrypoint.sh  validates config, renders the Caddyfile and
                                    the pitchfork daemons, then exec's PID 1
rootfs/usr/local/bin/agent-env         operator helper
rootfs/opt/agent-env/bin/run-*         one launcher per service, including the
                                    dev user's own nested supervisor
scripts/smoke-test.sh               end-to-end check of a running container
```

Services are enabled or omitted by the entrypoint when it renders
`/etc/pitchfork/config.toml`, so disabling one means it never starts rather than
starting and idling.
