# Components

A component is one thing your environment can run: the desktop, the browser
terminal, OpenCode, an SMB file share, or something of your own. You choose which
of the built-in ones run, and you can add your own without building a new image.

## Choosing the built-in components

The image comes with these:

| Name | What it gives you |
|---|---|
| `desktop` | An XFCE desktop in the browser, at `/~env/desktop` |
| `desktop-selkies` | The same desktop over [Selkies](https://selkies.io) instead, with audio (a prototype). Use it in place of `desktop`, not as well; the page needs HTTPS or `localhost`. |
| `terminal` | A shell in the browser, at `/~env/terminal` |
| `files` | A file manager for the workspace, at `/~env/files` |
| `opencode` | OpenCode's web UI, at `/`. Connect a provider with `/connect` in the UI. |
| `docker` | Your own Docker engine inside the container. The host has to allow it with extra flags; see [Docker inside the container](../AGENTS.md#docker-inside-the-container). |
| `smb` | The workspace as an SMB share, for the iPad Files app or Finder. Sign in as `dev`; the password and the address to connect to are on the `/~env/` page. |

The `smb` password is generated the first time it starts and kept from then on.
To choose your own, set `SMB_PASSWORD` in your compose file. On a tailnet it is
reachable as is. Elsewhere the configurator does not publish port 445, so forward
it to the container yourself, on a network you trust; never on a public address.

Choose them with one setting in your compose file:

```yaml
environment:
  AGENT_ENV_COMPONENTS: opencode,terminal,files,smb
```

If you don't set it, you get `desktop,terminal,files`.

This setting lists every built-in component you want; any built-in one not on it
does not run. To add one to the defaults, write the defaults out with it:
`desktop,terminal,files,smb`. The configurator writes this line for you.

Changes take effect when the container is recreated (`docker compose up -d`).

SSH, sign-in, and the `/~env/` index page are always there.

## Adding your own

Components you write yourself are not listed in `AGENT_ENV_COMPONENTS`. Once
installed, they run every time the container starts, until you uninstall them.

A component is a folder containing a file called `agent-env-component.toml`.
Install it from inside that folder:

```bash
cd ~/src/my-app
agent-env component install .
```

It starts right away; nothing needs restarting. Keep the folder wherever you
like, such as a git checkout in your home directory, and edit it in place.
Installed components stay installed when you recreate the container.

```bash
agent-env component list               # what is installed, and whether it is running
agent-env component uninstall my-app   # stop it and remove it
agent-env component check .            # find problems without installing
```

`uninstall` stops the component's daemons and takes away its web page and
commands. It leaves your folder alone. Tools it installed stay installed but are
no longer updated; remove one with `mise uninstall <tool>`. (If a
[startup script](#setting-things-up-when-the-container-starts) installs the
component, take it out of the script too, or it comes back.)

After editing a component, run `install` again from its folder: it applies the
changes and restarts the daemons whose definition changed. If you only changed
your app's own code, `pitchfork restart` the daemon instead. With nothing changed,
`install` does nothing, so it is safe to repeat. Installing a *different* folder under a name that is already installed
is refused; add `--force` to replace the old one (its daemons are stopped first).
The names of the built-in components are reserved.

## Writing a component

Here is a complete component that runs a small Python web app and shows it at
`<your URL>/~env/my-app`:

```
my-app/
├── agent-env-component.toml
├── pitchfork.toml
└── run
```

**`agent-env-component.toml`** describes it:

```toml
name = "my-app"
title = "My app"
summary = "A small Python web app"

[http]
port = 8000
```

**`pitchfork.toml`** says what to keep running. It is an ordinary
[pitchfork](https://pitchfork.jdx.dev) file:

```toml
namespace = "agent-env-my-app"

[daemons.server]
run = "./run"
ready_port = 8000
retry = true
```

**`run`** starts the app. Make it executable (`chmod +x run`). For a one-line
command you can skip the script and write it in `pitchfork.toml` directly, e.g.
`run = "npm install && exec node server.js"`.

```bash
#!/bin/bash
exec python3 -m http.server 8000 --bind 127.0.0.1
```

Install it, and `server` starts, the page appears at `/~env/my-app`, and it is
listed on the `/~env/` index page.

Only `agent-env-component.toml` is required. A component can be just tools
(`mise.toml`), just commands (`bin/`), or just a link to something running
elsewhere.

`python3`, `node`, `git` and the usual command-line tools are already available.
Add anything else with a [`mise.toml`](#the-other-files).

### `agent-env-component.toml`

```toml
# Required. Lowercase letters, digits and dashes.
name = "my-app"

# Shown on the /~env/ index page.
title = "My app"
summary = "One line about what it is"

# Optional: a web page, behind the environment's sign-in.
[http]
port = 8000            # where your app listens, on 127.0.0.1
path = "~env/my-app"   # this is the default: ~env/<name>
strip = true           # this is the default; see below
start = "index.html"   # optional: the page /~env/my-app/ opens, if not its own

# Optional, any number of them: links shown on the /~env/ index page and by
# `agent-env urls`, for things that are not web pages.
[[links]]
label = "Connect from Files or Finder"
url = "smb://{host}/workspace"

# Optional: environment variables, set in every shell, every daemon, and
# commands run with `ssh box some-command`.
[env]
MY_APP_URL = "http://127.0.0.1:8000"
```

#### `[http]`

Visitors reach your app at `<your URL>/<path>`, after the same sign-in as
everything else. Keep your app listening on `127.0.0.1`, so that is the only way
in. Until your app is listening, visitors get an error page.

- **`path`** is where it appears, under `~env/` by default. Use `"/"` to make it
  the main thing at your environment's address, the way `opencode` does. Only one
  component can have `"/"`, and no two components can share a path: with
  `opencode` turned on, your component cannot take `"/"` and `install` says so.
- **`strip`** decides what path your app sees.
  - With `strip = true`, your app is spoken to as if it lived at `/`: a visit to
    `/~env/my-app/settings` reaches it as `/settings`. Most apps work like this
    with no changes, as long as their links are relative (`settings`, not
    `/settings`).
  - With `strip = false`, your app sees the full `/~env/my-app/settings`. Use it
    for apps that have a setting for the path they are served under (often a
    `--base-path` or `--prefix` option); set it to `/~env/my-app` and they get
    every link right.

#### `[[links]]`

In a `url`, `{host}` becomes the host name in your environment's address: for
`https://box.example.ts.net`, it is `box.example.ts.net`.

#### `[env]`

For fixed values. For values that have to be worked out each time, use `env.sh`.

New shells see a change straight away. Daemons see it from the next container
start, and `install` reminds you when that applies.

### The other files

| File | What it does |
|---|---|
| `pitchfork.toml` | The daemons to keep running. See below. |
| `mise.toml` | Tools to install with [mise](https://mise.jdx.dev), in the usual `[tools]` format. They are available everywhere, including to your daemons' `run` commands. They are installed when you install the component, and updated to the latest version at every container start unless you give an exact version. |
| `env.sh` | A shell script run by every login shell: the browser terminal and SSH sessions. Use it for values that have to be computed, such as a password read from a file. Daemons and `ssh box some-command` do not see these values; a daemon that needs a computed value should work it out in its own `run` script. |
| `bin/` | Commands, available everywhere: terminals, SSH, and daemons. Each needs to be executable and start with a `#!` line. Two components cannot provide a command with the same name, and a command cannot be named like one the system already has, such as `sudo` or `git`. |

#### `pitchfork.toml`

This is an ordinary [pitchfork](https://pitchfork.jdx.dev/) file, and every
option in its documentation works: `ready_port`, `ready_http`, `depends`, `retry`
and so on. `run` is a shell command, run in your component's folder.

- Daemons run as you (the `dev` user), not as root. They can still use any port,
  including low ones like 445: Docker allows that inside a container.
- With `retry = true`, a daemon that exits is started again.
- The file must contain the line `namespace = "agent-env-<name>"`, using the
  `name` from `agent-env-component.toml`, before any `[daemons…]`. Your daemons
  then appear as `agent-env-my-app/server`.

Manage them like any of your daemons, with no sudo:

```bash
pitchfork logs -f agent-env-my-app/server
pitchfork restart agent-env-my-app/server
```

They also appear in the daemons dashboard at `/pitchfork`.

## Setting things up when the container starts

You can give the container scripts to run every time it starts, before your
components start. Use them to fetch your own components, install dotfiles, or
anything else a fresh environment should have.

The configurator has a box for one: write it under **What runs → Startup
script**, and it goes into your `compose.yaml` for you. Change it there rather than in
the file, because running the configurator again writes it from your answers.

By hand, supply them through your compose file's `configs` (Docker Compose 2.23.1
or newer), into `/etc/agent-env/provision.d/`:

```yaml
services:
  agent-env:
    configs:
      - source: my-setup
        target: /etc/agent-env/provision.d/10-my-setup
        mode: 0755

configs:
  my-setup:
    content: |
      #!/bin/bash
      set -e
      if [ ! -d ~/src/my-app ]; then
        git clone https://github.com/me/my-app ~/src/my-app
      fi
      cd ~/src/my-app
      git pull --ff-only || true
      agent-env component install .
```

- Scripts run as you (`dev`, home `/home/dev`), one at a time in name order
  (`10-…` before `20-…`), with your tools on `PATH`.
- They run on **every** start, so write them to be safe to repeat: check before
  creating things. `agent-env component install` is already safe to repeat.
- A component a script installs starts on that same start.
- For a private repository, pass a token in through the compose file and use it
  in the clone URL. Compose reads `$` in `content` itself, so write `$$` for a
  `$` meant for the script:

  ```yaml
  services:
    agent-env:
      environment:
        GIT_TOKEN: ${GIT_TOKEN}    # from your .env
  configs:
    my-setup:
      content: |
        #!/bin/bash
        git clone "https://x-access-token:$${GIT_TOKEN}@github.com/me/my-app" ~/src/my-app
  ```

- Edits to a script take effect when the container is recreated
  (`docker compose up -d`).
- If a script fails (no network, say), the container still starts. Read what
  happened with `agent-env logs provision`.

A component installed by a script comes back at the next start even if you
uninstalled it. To remove it for good, take it out of the script too.

## When something isn't working

Start with:

```bash
agent-env component list
```

It shows each component, built-in or yours, with where it comes from and whether
its daemons are running. Then:

- **`install` refused the component.** It says why. Run
  `agent-env component check .` to see every problem without installing, such as
  an invalid name, a missing or wrong `namespace`, a path or command already
  taken by another component, or a reserved name.
- **A daemon is not running.** Read its output with
  `pitchfork logs agent-env-<name>/<daemon>`. Common causes: `run` is not
  executable, the port is already in use, or the app listens on a different port
  from `ready_port`, so it never counts as ready.
- **The page shows an error.** The app is not listening on the `[http]` port yet,
  or it listens on something other than `127.0.0.1`.
- **A component from a startup script is missing.** Run
  `agent-env logs provision` to see what the script did.

## Putting it together

To give every new environment your own setup from the first start:

1. Keep your component in its own repository.
2. Add a startup script, as above, that clones it and runs
   `agent-env component install .`.
3. Start the container. The script installs your component as the environment
   starts, and updates it on every start after. If it doesn't appear,
   `agent-env logs provision` says why.
