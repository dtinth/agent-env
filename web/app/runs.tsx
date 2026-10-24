/**
 * The "What runs" step: every component in a list, and the chosen one's detail
 * beside it, with its switch. On a phone the two take turns.
 */

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import "./runs.css";
import { type Component, STARTUP_SCRIPT_TARGET } from "../../generate.ts";
import { type Configurator, componentsOf } from "./model.ts";
import { Choices, DesktopGeometry, LimitFields, type Option } from "./ui.tsx";

type Badge = "at /" | "not published" | "prototype" | "https or localhost";

interface Entry {
  title: string;
  /** Under the title in the list. */
  sub: string;
  summary: string;
  /** Where it shows up. */
  where: string;
  badges: Badge[];
  /** What the host or deployment has to provide. */
  needs?: string;
}

const ENTRIES: Record<Component, Entry> = {
  desktop: {
    title: "Desktop",
    sub: "/~env/desktop",
    summary:
      "XFCE on a virtual display. Headed agent-browser sessions show up here, so you can watch the agent work.",
    where: "/~env/desktop",
    badges: [],
  },
  "desktop-selkies": {
    title: "Desktop",
    sub: "/~env/desktop",
    summary:
      "XFCE on a virtual display. Headed agent-browser sessions show up here, so you can watch the agent work.",
    where: "/~env/desktop",
    badges: ["prototype", "https or localhost"],
    needs: "An https address, or localhost: Selkies refuses to start otherwise.",
  },
  terminal: {
    title: "Terminal",
    sub: "/~env/terminal",
    summary: "A login shell in the browser, over ttyd.",
    where: "/~env/terminal",
    badges: [],
  },
  files: {
    title: "Files",
    sub: "/~env/files",
    summary: "Browse, upload and download the workspace, with dufs.",
    where: "/~env/files",
    badges: [],
  },
  opencode: {
    title: "OpenCode",
    sub: "at /",
    summary: "OpenCode's web UI and API. Installed on first start and kept current.",
    where: "/",
    badges: ["at /"],
  },
  docker: {
    title: "Docker",
    sub: "containers for the agent",
    summary: "A rootless Docker engine of your own, so the agent can run containers.",
    where: "—",
    badges: [],
    needs: "Five host flags in compose.yaml; see below.",
  },
  smb: {
    title: "SMB share",
    sub: "smb://…/workspace",
    summary:
      "The workspace as an SMB share, for the iPad Files app or Finder. Sign in as dev; the password is on the /~env/ page.",
    where: "smb://<host>/workspace",
    badges: ["not published"],
    needs:
      "Port 445 is never published, since a file share cannot sit behind the sign-in. On a tailnet it is reachable as is; elsewhere, forward it to the container yourself, on a network you trust.",
  },
};

const DESKTOP_OPTIONS: Option[] = [
  {
    value: "desktop",
    title: "noVNC",
    desc: "Works everywhere; several people can drive it at once.",
  },
  {
    value: "desktop-selkies",
    title: "Selkies (prototype)",
    desc: "Audio and smoother video; needs https or localhost; one person drives.",
  },
];

const isOn = (c: Configurator, id: Component) => componentsOf(c.fields).includes(id);

/** Turn one on or off through its field. */
function setOn(c: Configurator, id: Exclude<Component, "desktop-selkies">, on: boolean): void {
  switch (id) {
    case "desktop":
      return c.set("desktop", on ? "desktop" : "none");
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

type Sel = Exclude<Component, "desktop-selkies"> | "script" | "limits";

function Badges({ list }: { list: Badge[] }) {
  if (!list.length) return null;
  return (
    <span class="r-badges">
      {list.map((b) => (
        <span class={`r-badge r-badge-${b.replace(/[^a-z]+/g, "-")}`}>{b}</span>
      ))}
    </span>
  );
}

function Switch(props: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      class={`r-switch ${props.on ? "on" : ""}`}
      onClick={() => props.onChange(!props.on)}
    >
      <span />
    </button>
  );
}

function Item(props: {
  sel: Sel;
  current: Sel;
  onSelect: (s: Sel) => void;
  title: string;
  sub: ComponentChildren;
  on?: boolean;
  /** Something in its detail needs fixing. */
  problem?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        class={`r-item ${props.sel === props.current ? "here" : ""} ${props.problem ? "problem" : ""}`}
        aria-current={props.sel === props.current}
        onClick={() => props.onSelect(props.sel)}
      >
        <span class="r-item-text">
          <span class="r-item-title">{props.title}</span>
          <span class="r-item-sub">{props.sub}</span>
        </span>
        {props.on !== undefined && (
          <span class={`r-state ${props.on ? "on" : ""}`}>{props.on ? "On" : "Off"}</span>
        )}
        <span class="r-chev" aria-hidden="true">
          ›
        </span>
      </button>
    </li>
  );
}

function Head(props: {
  title: string;
  badges?: Badge[];
  on?: boolean;
  onToggle?: (on: boolean) => void;
}) {
  return (
    <header class="r-head">
      <h2>
        {props.title} <Badges list={props.badges ?? []} />
      </h2>
      {props.onToggle && (
        <label class="r-head-switch">
          <span>{props.on ? "On" : "Off"}</span>
          <Switch on={!!props.on} onChange={props.onToggle} label={props.title} />
        </label>
      )}
    </header>
  );
}

function Facts(props: { rows: [string, ComponentChildren][] }) {
  return (
    <dl class="r-facts">
      {props.rows.map(([k, v]) => (
        <>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </>
      ))}
    </dl>
  );
}

function ComponentDetail({ c, id }: { c: Configurator; id: Component }) {
  const e = ENTRIES[id];
  return (
    <>
      <Head
        title={e.title}
        badges={e.badges}
        on={isOn(c, id)}
        onToggle={(on) => setOn(c, id === "desktop-selkies" ? "desktop" : id, on)}
      />
      <p class="r-lede">{e.summary}</p>
      <Facts
        rows={[
          ["Shows up at", <code>{e.where}</code>],
          ["Needs", e.needs ?? "Nothing extra."],
        ]}
      />
      {id === "opencode" && (
        <p class="hint">
          Only one thing answers at <code>/</code>. With OpenCode off, a component of yours can have
          it; with nothing there, <code>/</code> shows the <code>/~env/</code> index.
        </p>
      )}
      {id === "docker" && (
        <>
          <h3>What it means for you</h3>
          <p>
            Running containers needs the sandbox around this container loosened a little. On its own
            that changes nothing you would notice, and nothing new can reach the host. The one risk:
            if the Linux kernel has an unpatched bug, code in the container has a better chance of
            exploiting it. Even then the rootless engine keeps the fallout inside this container's
            own unprivileged user, not the host. Leave it off unless the agent needs to run
            containers.
          </p>
          <div class="callout">
            <p>
              <b>Turning Docker on adds five flags to compose.yaml.</b> A rootless engine needs
              them: <code>cap_add: SYS_ADMIN</code>, unconfined seccomp, AppArmor and systempaths,
              and <code>/dev/net/tun</code>. The configurator writes them for you.
            </p>
            <p>
              They widen what code in the container can do, though still well short of{" "}
              <code>--privileged</code>.
            </p>
          </div>
        </>
      )}
    </>
  );
}

function DesktopDetail({ c }: { c: Configurator }) {
  const f = c.fields;
  return (
    <>
      <ComponentDetail c={c} id={f.desktop === "none" ? "desktop" : f.desktop} />
      {f.desktop !== "none" && (
        <>
          <h3>Over</h3>
          <Choices c={c} name="desktop" cols={2} options={DESKTOP_OPTIONS} />
          <h3>Display</h3>
          <DesktopGeometry c={c} />
        </>
      )}
    </>
  );
}

function ScriptDetail({ c }: { c: Configurator }) {
  return (
    <>
      <Head title="Startup script" />
      <p class="r-lede">
        Runs as <code>dev</code> before any component starts, every time the container starts, so
        make it safe to repeat. What it did is in <code>agent-env logs provision</code>.
      </p>
      <p class="hint">
        Components of your own go in here too: get the folder onto the disk (a{" "}
        <code>git clone</code>, say) and run <code>agent-env component install</code> on it.
      </p>
      <label class="field">
        <span class="label">
          Script <small>(bash, in a login shell; write $ as usual)</small>
        </span>
        <textarea
          class="mono"
          rows={10}
          spellcheck={false}
          placeholder={
            "# e.g. dotfiles, global tools, your own components\n" +
            "mise use -g ripgrep\n" +
            "[ -d ~/src/my-component ] || git clone https://github.com/me/my-component ~/src/my-component\n" +
            "agent-env component install ~/src/my-component"
          }
          value={c.fields.startupScript}
          onInput={(e) => c.set("startupScript", e.currentTarget.value)}
        />
      </label>
      <p class="hint">
        It goes into <code>compose.yaml</code> as a config, mounted at{" "}
        <code>{STARTUP_SCRIPT_TARGET}</code>. Change it here rather than there: running the
        configurator again writes it from your answers.
      </p>
    </>
  );
}

function LimitsDetail({ c }: { c: Configurator }) {
  return (
    <>
      <Head title="Limits" />
      <p class="r-lede">
        Optional caps for a shared host, covering everything in the container. Blank means none.
      </p>
      <LimitFields c={c} />
    </>
  );
}

export function Runs({ c }: { c: Configurator }) {
  const [sel, pick] = useState<Sel>("desktop");
  // On a phone the list and the detail take turns: picking opens the detail.
  const [open, setOpen] = useState(false);
  const select = (s: Sel) => {
    pick(s);
    setOpen(true);
    if (window.matchMedia("(max-width: 700px)").matches) {
      document.querySelector(".c-form")?.scrollIntoView();
    }
  };
  const f = c.fields;
  const item = (id: Exclude<Sel, "script" | "limits" | "desktop">) => (
    <Item
      sel={id}
      current={sel}
      onSelect={select}
      title={ENTRIES[id].title}
      sub={ENTRIES[id].sub}
      on={isOn(c, id)}
    />
  );
  const scriptLines = c.answers.startupScript?.split("\n").length ?? 0;
  const problem = (...fields: string[]) => fields.some((k) => c.errorFor(k));

  let detail: ComponentChildren;
  if (sel === "desktop") detail = <DesktopDetail c={c} />;
  else if (sel === "script") detail = <ScriptDetail c={c} />;
  else if (sel === "limits") detail = <LimitsDetail c={c} />;
  else detail = <ComponentDetail c={c} id={sel} />;

  return (
    <div class={`r ${open ? "open" : ""}`}>
      <nav class="r-list">
        <ul>
          <Item
            sel="desktop"
            current={sel}
            onSelect={select}
            title="Desktop"
            sub={
              f.desktop === "none"
                ? "/~env/desktop"
                : `${f.desktop === "desktop-selkies" ? "Selkies" : "noVNC"} · ${c.answers.desktopSize?.replace("x", "×")}`
            }
            on={f.desktop !== "none"}
            problem={problem("desktopSize", "desktopScale")}
          />
          {item("terminal")}
          {item("files")}
          {item("opencode")}
          {item("docker")}
          {item("smb")}
        </ul>
        <ul>
          <Item
            sel="script"
            current={sel}
            onSelect={select}
            title="Startup script"
            sub={scriptLines ? `${scriptLines} line${scriptLines === 1 ? "" : "s"}` : "none"}
          />
          <Item
            sel="limits"
            current={sel}
            onSelect={select}
            title="Limits"
            problem={problem("memoryGiB", "swapGiB", "cpus")}
            sub={
              [
                f.memoryGiB.trim() && `${f.memoryGiB.trim()} GiB`,
                f.cpus.trim() && `${f.cpus.trim()} CPUs`,
              ]
                .filter(Boolean)
                .join(" · ") || "none"
            }
          />
        </ul>
        <div class="r-value">
          <span>AGENT_ENV_COMPONENTS</span>
          <code>{componentsOf(f).join(",\u200b") || '""'}</code>
        </div>
      </nav>
      <section class="r-detail">
        <button type="button" class="r-back" onClick={() => setOpen(false)}>
          ← Everything
        </button>
        {detail}
        {c.errorFor("components") && <p class="callout danger">{c.errorFor("components")}</p>}
      </section>
    </div>
  );
}
