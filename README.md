# agent-env

[![docker](https://github.com/dtinth/agent-env/actions/workflows/docker.yml/badge.svg)](https://github.com/dtinth/agent-env/actions/workflows/docker.yml)

A Docker image that turns an agent workstation into a hosted, sign-in-protected
service: a desktop, a terminal, a file manager, SSH, a browser. Each of those is
a [component](docs/components.md) you can turn on or off; add the `opencode` one
to run [OpenCode](https://opencode.ai) as its agent, or bring your own.

![The agent-env desktop over noVNC](desktop.png)

Behind one sign-in (Google, GitHub or basic auth) you get:

- **`/`**: your app, or OpenCode's web UI with the `opencode` component
- **`/~env/terminal`**, **`/~env/desktop`**, **`/~env/files`**: a shell, an XFCE desktop and a file manager in the browser
- **`/pitchfork`**: a dashboard for your own daemons
- **SSH and mosh**, plus agent-browser with a headed Chromium you can watch on the desktop

## Quick start

Set it up in the browser at [dtinth.github.io/agent-env](https://dtinth.github.io/agent-env/),
or in a terminal (Node 22.18+, nothing else to install):

```bash
git clone https://github.com/dtinth/agent-env && cd agent-env
node setup.ts --out ~/agent-env-deploy
```

Either way you get a `compose.yaml` and `.env` for the image on GHCR
(`ghcr.io/dtinth/agent-env`, amd64 and arm64). Run it again later to upgrade;
your answers and secrets are kept.

Or try it locally with basic auth:

```bash
docker run -d --name agent-env --shm-size=2g \
  -p 127.0.0.1:8080:8080 -p 127.0.0.1:2222:22 \
  -e AUTH_MODE=basic \
  -e PUBLIC_URL=http://localhost:8080 \
  -e AGENT_ENV_COMPONENTS=opencode,desktop,terminal,files \
  -v agent-env-workspace:/workspace -v agent-env-home:/home/dev \
  -v agent-env-state:/var/lib/agent-env \
  ghcr.io/dtinth/agent-env
```

The ports are bound to this machine only. A password is generated and printed
by `docker logs agent-env`; sign in at <http://localhost:8080> as `dev` with it.
<http://localhost:8080/~env/> lists everything the environment serves.

## Things to know

- **Everything behind the gate is root-capable** (`dev` has passwordless sudo). Use a
  sign-in allow list, and give each person their own container.
- **Mount `/workspace`, `/home/dev` and `/var/lib/agent-env`.** Without them,
  recreating the container loses your code, the agent's setup and the SSH host keys.
- **Everything is configured with environment variables**; [`.env.example`](.env.example)
  lists them all, annotated. Any variable also accepts a `<NAME>_FILE` form for secrets.
- **`AGENT_ENV_COMPONENTS` picks what runs.** Unset, it is `desktop,terminal,files`;
  setting it replaces that list. [docs/components.md](docs/components.md) lists the
  built-in components and shows how to write and install your own.
- **Only ports 8080 (web) and 22 (SSH) listen externally**, plus 445 with the `smb`
  component. Terminate TLS in front of 8080.

## Everything else

How authentication, components, supervision, volumes, toolchains, rootless Docker, the
desktop and the rest work is in [AGENTS.md](AGENTS.md), which is written for people
and agents changing this repository but is the full reference.
