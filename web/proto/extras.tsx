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

export type Badge = "at /" | "not published" | "prototype" | "https or localhost";
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
    badges: [],
    group: "infra",
    field: "docker",
    needs: "Five host flags in compose.yaml; see below.",
  },
  {
    id: "smb",
    title: "SMB share",
    summary: "The workspace as an SMB share, for the iPad Files app or Finder. Sign in as dev.",
    where: "smb://host/workspace",
    badges: ["not published"],
    group: "infra",
    field: "smb",
    needs:
      "Port 445 is never published, since a file share cannot sit behind the sign-in. On a tailnet it is reachable as is; elsewhere, forward it to the container yourself, on a network you trust.",
  },
];

export const entry = (id: Component) => CATALOG.find((e) => e.id === id)!;

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
// The extra: a startup script, which is also how your own components get in
// ---------------------------------------------------------------------------

const DEMO_SCRIPT = `# Dotfiles
if [ ! -d ~/.dotfiles ]; then
  git clone https://github.com/me/dotfiles ~/.dotfiles
fi
~/.dotfiles/install.sh

# A component of my own: clone it once, then install it on every start
# (install does nothing when nothing changed)
[ -d ~/src/my-agent-tools ] || git clone https://github.com/me/my-agent-tools ~/src/my-agent-tools
agent-env component install ~/src/my-agent-tools`;

export function useExtras() {
  const [demo] = useState(() => new URLSearchParams(location.search).get("demo") === "ready");
  const [script, setScript] = useState(() => (demo ? DEMO_SCRIPT : ""));
  return { script, setScript };
}
export type Extras = ReturnType<typeof useExtras>;

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
        placeholder={
          "# e.g. dotfiles, global tools, your own components\nmise use -g ripgrep\nagent-env component install ~/src/my-component"
        }
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
          Nothing yet. Write a script, and the <code>configs:</code> entry that carries it into{" "}
          <code>/etc/agent-env/provision.d/</code> appears here.
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
