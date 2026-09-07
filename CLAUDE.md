# CLAUDE.md

## What this repo is

A Docker image that turns OpenCode v2 into a hosted, Google-authenticated
workstation. The moving parts:

- `Dockerfile` — the image. Debian trixie, XFCE + noVNC, Chromium, mise, and
  four fetched static binaries (pitchfork, ttyd, oauth2-proxy, caddy).
- `rootfs/` — everything baked into the image's filesystem. The entrypoint is
  `rootfs/usr/local/bin/entrypoint.sh`; it validates configuration, renders the
  Caddyfile and the pitchfork daemon definitions, then execs pitchfork as PID 1.
- `scripts/smoke-test.sh` — end-to-end check against a *running* container.
- `setup.ts` / `setup_test.ts` — the Deno deployment wizard. `deno task check`
  and `deno task test` cover these; they need no container.
- `.github/workflows/docker.yml` — builds per-arch, smoke-tests each, then
  publishes.

## Running the smoke test

It tests a live container, so it needs the image built and running first. CI
runs it twice, and both are worth reproducing — the second covers a
configuration the first cannot reach:

```bash
docker build -t agent-env:smoke .

password="ci-$(openssl rand -hex 12)"
docker run -d --name agent-env --shm-size=2g \
  -p 8080:8080 -p 8081:8081 -p 2222:22 \
  -e AUTH_MODE=basic -e "GATEWAY_PASSWORD=${password}" \
  -e PUBLIC_URL=http://localhost:8080 \
  -e DASHBOARD_PUBLIC_URL=http://localhost:8081 \
  agent-env:smoke

# Wait for the image's own HEALTHCHECK before testing anything. Give up on
# unhealthy or exited rather than spinning — that is how a bad run presents,
# and the logs are the whole diagnosis.
for _ in $(seq 1 60); do
  state=$(docker inspect -f '{{.State.Health.Status}}/{{.State.Status}}' agent-env)
  case "${state}" in
    healthy/*) break ;;
    unhealthy/*|*/exited|*/dead)
      docker logs agent-env 2>&1 | tail -60; exit 1 ;;
  esac
  sleep 5
done
[ "$(docker inspect -f '{{.State.Health.Status}}' agent-env)" = healthy ] || {
  echo "timed out waiting for healthy"; docker logs agent-env 2>&1 | tail -60; exit 1; }

CONTAINER=agent-env ./scripts/smoke-test.sh http://localhost:8080 "opencode:${password}"
```

The second run is the same with `-e OPENCODE_ENABLE=false -e
AB_DASHBOARD_ENABLE=false` on a different port and container name — see the
`Smoke test with OpenCode off` step in `.github/workflows/docker.yml`.

Expect a clean run to report roughly 71 checks (OpenCode on) and 73 (OpenCode
off), 0 failed. A full build from cold cache takes ~10 minutes; the container
reaches healthy in well under a minute.

---

## Claude Code on the web / cloud remote sessions

These sessions run in an ephemeral Firecracker VM behind an HTTPS-intercepting
egress proxy. Three things bite in that environment, all of them environmental
rather than repo bugs. None of the workarounds below should be committed.

### 1. The Docker daemon is not running

The `docker` CLI is installed but nothing started `dockerd`. Start it before
anything else:

```bash
nohup dockerd > /tmp/dockerd.log 2>&1 &
until docker info >/dev/null 2>&1; do sleep 1; done
```

### 2. The build fails on TLS: "self-signed certificate in certificate chain"

Outbound HTTPS is transparently re-terminated by the agent proxy, so build
containers see a certificate they do not trust. The first `curl` in the
Dockerfile — the pitchfork/ttyd/oauth2-proxy/caddy layer — fails with
`curl: (60)`. The apt layer *succeeds*, because Debian's repositories are
plain HTTP, which makes the failure look arch- or release-specific when it is
not.

The fix (documented in `/root/.ccr/README.md`) is to trust the proxy CA in the
build, without editing the repo's Dockerfile. Build from a generated copy:

```bash
cp /root/.ccr/ca-bundle.crt ./ccr-ca-bundle.crt   # must be inside the build context

sed '\#rm -rf /var/lib/apt/lists/\*#a\
\
COPY ccr-ca-bundle.crt /usr/local/share/ca-certificates/ccr-agent-proxy.crt\
RUN update-ca-certificates\
ARG SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt\
ARG NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt\
ARG DENO_CERT=/etc/ssl/certs/ca-certificates.crt' Dockerfile > /tmp/Dockerfile.ccr

docker build -f /tmp/Dockerfile.ccr -t agent-env:smoke .

rm -f ccr-ca-bundle.crt   # afterwards — never commit it
```

Placing it directly after the apt layer keeps that layer's cache and gets the
CA in before the first HTTPS fetch. `ca-certificates` is installed by the apt
layer, so `update-ca-certificates` cannot run any earlier.

Never disable TLS verification and never unset `HTTPS_PROXY` to get around
this. A 403/407 from the proxy is an egress-policy denial, not a certificate
problem — report the blocked host instead of retrying.

### 3. Use `ARG`, not `ENV`, for those CA variables

`ENV SSL_CERT_FILE=...` persists into the final image, where the entrypoint's
`expand_file_secrets` (`rootfs/usr/local/bin/entrypoint.sh`) reads *any*
`*_FILE` variable and re-exports its file's contents as the name minus the
suffix — so `SSL_CERT_FILE` turns into a ~228KB `SSL_CERT`.

`ARG` avoids it: BuildKit exposes `ARG`s to `RUN` instructions but does not
persist them into the image, which is exactly the scope wanted here. The CA is
only needed while fetching things at build time.

Since it is now bounded (see below) an oversized value is skipped with a
warning rather than breaking the container, so this is no longer fatal — but
`ARG` is still right, because `SSL_CERT` was never a variable anyone wanted.

#### If you see `Argument list too long`

Before the size guard landed, an oversized `*_FILE` bricked startup, and the
only clue was:

```
/usr/local/bin/entrypoint.sh: line 61: /usr/bin/ln: Argument list too long
```

That line is the `ln -snf` for `/etc/localtime`. It has nothing to do with
timezones — it is simply the first `exec` after the environment grew past
`MAX_ARG_STRLEN`, so chasing it is a dead end. `expand_file_secrets` now
measures the file first and skips anything over 64KiB with a warning naming
the variable:

```
[agent-env] WARN SSL_CERT_FILE=... is 456896 bytes, over the 65536-byte limit
for a file secret; not exporting SSL_CERT
```

If you meet the old error on an older image, that is the cause. The bound is
`FILE_SECRET_MAX_BYTES`, and the OpenCode-off CI run passes an oversized
`*_FILE` so the regression cannot come back quietly.

### Housekeeping

- Writable disk is a fixed per-session allowance, and the built image is ~3.9GB.
  `docker system prune` and removing stale images frees it if writes start
  failing with "no space left on device" while `df` still shows low usage.
- The container, the image and the daemon do not survive the session. Anything
  worth keeping must be committed and pushed.
- `deno` is not preinstalled, so `deno task check` / `deno task test` need it
  installed first — they are unrelated to the smoke test and need no container.
