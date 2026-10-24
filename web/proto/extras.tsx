/**
 * What the three "What runs" prototypes share: a catalog of the built-in
 * components bound to the real configurator fields, and prototype-only state
 * for the things the configurator cannot write yet — components of your own,
 * from git repositories, and a startup script — with the compose YAML they
 * would add. None of the extras reach generate.ts.
 */

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { Component } from "../../generate.ts";
import { type Configurator, componentsOf } from "../app/model.ts";
import { CopyButton } from "../app/ui.tsx";

// ---------------------------------------------------------------------------
// The built-ins
// ---------------------------------------------------------------------------

export type Badge = "at /" | "host flags" | "tailnet only" | "prototype" | "https or localhost";
export type Group = "browser" | "root" | "infra";

export interface CatalogEntry {
  id: Component;
  title: string;
  summary: string;
  /** Where it shows up. */
  where: string;
  badges: Badge[];
  group: Group;
  /** The configurator field that turns it on, as `field` or `field = value`. */
  field: string;
  /** What the host or deployment has to provide. */
  needs?: string;
  /** Whether it has settings of its own in this step. */
  settings?: boolean;
}

export const CATALOG: CatalogEntry[] = [
  {
    id: "desktop",
    title: "Desktop",
    summary: "XFCE on a virtual display, over noVNC. Several people can drive it at once.",
    where: "/~env/desktop",
    badges: [],
    group: "browser",
    field: 'desktop = "desktop"',
    settings: true,
  },
  {
    id: "desktop-selkies",
    title: "Desktop (Selkies)",
    summary: "The same desktop over Selkies: audio and smoother video, one person drives.",
    where: "/~env/desktop",
    badges: ["prototype", "https or localhost"],
    group: "browser",
    field: 'desktop = "desktop-selkies"',
    needs: "An https address, or localhost: the page refuses to start otherwise.",
    settings: true,
  },
  {
    id: "terminal",
    title: "Terminal",
    summary: "A login shell in the browser, over ttyd.",
    where: "/~env/terminal",
    badges: [],
    group: "browser",
    field: "terminal",
  },
  {
    id: "files",
    title: "Files",
    summary: "Browse, upload and download the workspace, with dufs.",
    where: "/~env/files",
    badges: [],
    group: "browser",
    field: "fileManager",
  },
  {
    id: "opencode",
    title: "OpenCode",
    summary: "OpenCode's web UI and API. Installed on first start and kept current.",
    where: "/",
    badges: ["at /"],
    group: "root",
    field: "opencode",
  },
  {
    id: "docker",
    title: "Docker",
    summary: "A rootless Docker engine of your own, so the agent can run containers.",
    where: "—",
    badges: ["host flags"],
    group: "infra",
    field: "docker",
    needs:
      "Five host flags that widen the sandbox: SYS_ADMIN, unconfined seccomp, AppArmor and systempaths, and /dev/net/tun. The compose file gets them.",
  },
  {
    id: "smb",
    title: "SMB share",
    summary: "The workspace as an SMB share, for the iPad Files app or Finder. Sign in as dev.",
    where: "smb://host/workspace",
    badges: ["tailnet only"],
    group: "infra",
    field: "smb",
    needs:
      "A tailnet: a file share cannot sit behind the sign-in, so it is never published elsewhere.",
  },
];

export const entry = (id: Component) => CATALOG.find((e) => e.id === id)!;

/** Whether this deployment can have it at all: SMB only on a tailnet. */
export const offered = (c: Configurator, id: Component) =>
  id !== "smb" || c.fields.mode === "tailscale";

export const isOn = (c: Configurator, id: Component) => componentsOf(c.fields).includes(id);

/** Turn one on or off through its real field. The two desktops replace each other. */
export function setOn(c: Configurator, id: Component, on: boolean): void {
  switch (id) {
    case "desktop":
    case "desktop-selkies":
      if (on) c.set("desktop", id);
      else if (c.fields.desktop === id) c.set("desktop", "none");
      return;
    case "terminal":
      return c.set("terminal", on);
    case "files":
      return c.set("fileManager", on);
    case "opencode":
      return c.set("opencode", on);
    case "docker":
      return c.set("docker", on);
    case "smb":
      return c.set("smb", on);
  }
}

/** What answers at `/`, in words. */
export function rootLabel(c: Configurator): { title: string; detail: string } {
  const f = c.fields;
  if (f.opencode) return { title: "OpenCode", detail: "the opencode component" };
  const port = f.primaryPort.trim() || "3000";
  return f.primaryCommand.trim()
    ? { title: `Your command, on port ${port}`, detail: f.primaryCommand.trim() }
    : { title: `Port ${port}`, detail: "whatever you start there yourself" };
}

export function Badges({ list }: { list: Badge[] }) {
  if (!list.length) return null;
  return (
    <span class="p-badges">
      {list.map((b) => (
        <span class={`p-badge p-badge-${b.replace(/[^a-z]+/g, "-")}`}>{b}</span>
      ))}
    </span>
  );
}

export function Switch(props: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      disabled={props.disabled}
      class={`p-switch ${props.on ? "on" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        props.onChange(!props.on);
      }}
    >
      <span />
    </button>
  );
}

// ---------------------------------------------------------------------------
// The extras: your own components, and a startup script
// ---------------------------------------------------------------------------

export interface RepoComponent {
  url: string;
  ref?: string;
}

const DEMO_REPOS: RepoComponent[] = [{ url: "https://github.com/me/my-agent-tools" }];
const DEMO_SCRIPT = `# Dotfiles, and a log of every start
if [ ! -d ~/.dotfiles ]; then
  git clone https://github.com/me/dotfiles ~/.dotfiles
fi
~/.dotfiles/install.sh
echo "started $(date -Is)" >> ~/.provision.log`;

export function useExtras() {
  const [demo] = useState(() => new URLSearchParams(location.search).get("demo") === "ready");
  const [repos, setRepos] = useState<RepoComponent[]>(() => (demo ? DEMO_REPOS : []));
  const [script, setScript] = useState(() => (demo ? DEMO_SCRIPT : ""));
  return {
    repos,
    script,
    setScript,
    addRepo: (r: RepoComponent = { url: "" }) => setRepos((l) => [...l, r]),
    updateRepo: (i: number, patch: Partial<RepoComponent>) =>
      setRepos((l) => l.map((r, j) => (j === i ? { ...r, ...patch } : r))),
    removeRepo: (i: number) => setRepos((l) => l.filter((_, j) => j !== i)),
  };
}
export type Extras = ReturnType<typeof useExtras>;

/** `~/src/<this>`: the repository's last path segment, without `.git`. */
export function repoName(url: string): string {
  const last =
    url
      .trim()
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .split(/[/:]/)
      .pop() ?? "";
  return (
    last
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "repo"
  );
}

/** Something wrong with a repo row, if anything. */
export function repoProblem(r: RepoComponent, all: RepoComponent[]): string | undefined {
  const url = r.url.trim();
  if (!url) return "paste a clone URL";
  if (!/^(https?:\/\/|git@|ssh:\/\/)\S+$/.test(url)) return "an https:// or git@ URL";
  const name = repoName(url);
  if (all.filter((o) => o.url.trim() && repoName(o.url) === name).length > 1)
    return `two repositories would both clone into ~/src/${name}`;
  return undefined;
}

const usable = (x: Extras) => x.repos.filter((r) => r.url.trim() && !repoProblem(r, x.repos));

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** 20-components: clone or update each repository, and install it. */
export function componentsScript(x: Extras): string {
  const lines = [
    "#!/bin/bash",
    "# Written by the configurator: your own components, from git.",
    "# Clones each one the first time, updates it after, and installs it;",
    "# `agent-env component install` does nothing when nothing changed.",
    "install_from_git() {",
    '  local url="$1" ref="$2" dir="$HOME/src/$3"',
    '  if [ ! -d "$dir/.git" ]; then',
    '    git clone ${ref:+--branch "$ref"} "$url" "$dir" || return 1',
    "  else",
    '    git -C "$dir" pull --ff-only || echo "could not update $3; using what is there" >&2',
    "  fi",
    '  (cd "$dir" && agent-env component install .)',
    "}",
    "mkdir -p ~/src",
  ];
  for (const r of usable(x)) {
    const name = repoName(r.url);
    lines.push(
      `install_from_git ${sq(r.url.trim())} ${sq(r.ref?.trim() ?? "")} ${name} || echo "${name} was not installed" >&2`,
    );
  }
  return lines.join("\n");
}

/** 10-setup: the user's own script, given a shebang if it has none. */
export function setupScript(x: Extras): string {
  const body = x.script.replace(/\s+$/, "");
  return body.startsWith("#!") ? body : `#!/bin/bash\n${body}`;
}

export interface ProvisionFile {
  config: string;
  target: string;
  body: string;
}

/** The files /etc/agent-env/provision.d/ would get, in the order they run. */
export function provisionFiles(x: Extras): ProvisionFile[] {
  const files: ProvisionFile[] = [];
  if (x.script.trim())
    files.push({
      config: "provision-setup",
      target: "/etc/agent-env/provision.d/10-setup",
      body: setupScript(x),
    });
  if (usable(x).length)
    files.push({
      config: "provision-components",
      target: "/etc/agent-env/provision.d/20-components",
      body: componentsScript(x),
    });
  return files;
}

/** What compose.yaml would gain: the mounts under agent-env, and the configs. */
export function extrasYaml(x: Extras): string {
  const files = provisionFiles(x);
  if (!files.length) return "";
  const L = ["services:", "  agent-env:", "    configs:"];
  for (const f of files) {
    L.push(`      - source: ${f.config}`, `        target: ${f.target}`, "        mode: 0755");
  }
  L.push("", "configs:");
  for (const f of files) {
    L.push(`  ${f.config}:`, "    content: |");
    // Compose interpolates ${...} inside content, so a literal $ is $$.
    for (const line of f.body.split("\n"))
      L.push(line ? `      ${line.replace(/\$/g, "$$$$")}` : "");
  }
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Editors and the preview
// ---------------------------------------------------------------------------

export function RepoRows(props: { x: Extras; compact?: boolean; only?: number }) {
  const { x, compact, only } = props;
  return (
    <div class={`p-repos ${compact ? "compact" : ""}`}>
      {x.repos.map((r, i) => {
        if (only !== undefined && i !== only) return null;
        const problem = r.url.trim() || x.repos.length > 1 ? repoProblem(r, x.repos) : undefined;
        return (
          <div class="p-repo">
            <label class={`field grow ${problem ? "has-error" : ""}`}>
              {!compact && <span class="label">Git repository</span>}
              <input
                type="text"
                class="mono"
                spellcheck={false}
                placeholder="https://github.com/you/your-component"
                value={r.url}
                onInput={(e) => x.updateRepo(i, { url: e.currentTarget.value })}
              />
              {problem ? (
                <em class="error">{problem}</em>
              ) : (
                r.url.trim() && (
                  <span class="p-hint">
                    → <code>~/src/{repoName(r.url)}</code>
                  </span>
                )
              )}
            </label>
            <label class="field p-ref">
              {!compact && (
                <span class="label">
                  Branch or tag <small>(optional)</small>
                </span>
              )}
              <input
                type="text"
                class="mono"
                spellcheck={false}
                placeholder="default"
                value={r.ref ?? ""}
                onInput={(e) => x.updateRepo(i, { ref: e.currentTarget.value })}
              />
            </label>
            <button
              type="button"
              class="small p-remove"
              aria-label="Remove"
              onClick={() => x.removeRepo(i)}
            >
              Remove
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function ScriptEditor(props: { x: Extras; rows?: number; bare?: boolean }) {
  const { x, rows = 6, bare } = props;
  return (
    <label class="field">
      <span class={`label ${bare ? "p-sr" : ""}`}>
        Your startup script{" "}
        <small>
          (bash, as <code>dev</code>, on every start; write <code>$</code> as usual)
        </small>
      </span>
      <textarea
        class="mono"
        rows={rows}
        spellcheck={false}
        placeholder={"# e.g. dotfiles, global tools, a clone of the project\nmise use -g ripgrep"}
        value={x.script}
        onInput={(e) => x.setScript(e.currentTarget.value)}
      />
    </label>
  );
}

export function YamlPreview(props: { x: Extras; title?: ComponentChildren; class?: string }) {
  const yaml = extrasYaml(props.x);
  return (
    <div class={`p-yaml ${props.class ?? ""}`}>
      <div class="p-yaml-head">
        <span>
          {props.title ?? (
            <>
              Adds to <code>compose.yaml</code>
            </>
          )}
          <span class="p-mock">preview only</span>
        </span>
        {yaml && <CopyButton text={yaml} />}
      </div>
      {yaml ? (
        <pre>
          <code>{yaml}</code>
        </pre>
      ) : (
        <p class="p-yaml-empty">
          Nothing yet. Add a repository or a script, and the <code>configs:</code> that carry them
          into <code>/etc/agent-env/provision.d/</code> appear here.
        </p>
      )}
    </div>
  );
}

/** The line every prototype shows when the real validation objects. */
export function ComponentsProblem({ c }: { c: Configurator }) {
  const e = c.errorFor("components");
  return e ? <p class="callout danger">{e}</p> : null;
}
