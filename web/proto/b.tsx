/** Prototype B — List and detail: every component in a list, the chosen one beside it. */

import { type ComponentChildren, render } from "preact";
import { useState } from "preact/hooks";
import "../app/claw.css";
import "../app/layout.css";
import "./protos.css";
import type { Component } from "../../generate.ts";
import { type Configurator, componentsOf } from "../app/model.ts";
import { App } from "../app/shell.tsx";
import { Choices, DESKTOP_OPTIONS, DesktopGeometry, LimitFields } from "../app/ui.tsx";
import {
  type Badge,
  Badges,
  ComponentsProblem,
  entry,
  type Extras,
  isOn,
  provisionFiles,
  ScriptEditor,
  setOn,
  Switch,
  useExtras,
  YamlPreview,
} from "./extras.tsx";

type Sel = `c:${Component}` | "desktop" | "script" | "limits";

function Item(props: {
  sel: Sel;
  current: Sel;
  onSelect: (s: Sel) => void;
  title: string;
  sub: ComponentChildren;
  on?: boolean;
  dim?: boolean;
}) {
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        class={`pb-item ${props.sel === props.current ? "here" : ""} ${props.dim ? "dim" : ""}`}
        onClick={() => props.onSelect(props.sel)}
        onKeyDown={(e) => e.key === "Enter" && props.onSelect(props.sel)}
      >
        <span class="pb-item-text">
          <span class="pb-item-title">{props.title}</span>
          <span class="pb-item-sub">{props.sub}</span>
        </span>
        {props.on !== undefined && (
          <span class={`pb-state ${props.on ? "on" : ""}`}>{props.on ? "On" : "Off"}</span>
        )}
        <span class="pb-chev" aria-hidden="true">
          ›
        </span>
      </div>
    </li>
  );
}

function Facts(props: { rows: [string, ComponentChildren][] }) {
  return (
    <dl class="pb-facts">
      {props.rows.map(([k, v]) => (
        <>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </>
      ))}
    </dl>
  );
}

function Head(props: {
  title: ComponentChildren;
  badges?: Badge[];
  on?: boolean;
  onToggle?: (on: boolean) => void;
  kicker: string;
}) {
  return (
    <header class="pb-head">
      <div>
        <span class="pb-kicker">{props.kicker}</span>
        <h2>
          {props.title} <Badges list={props.badges ?? []} />
        </h2>
      </div>
      {props.onToggle && (
        <label class="pb-head-switch">
          <span>{props.on ? "On" : "Off"}</span>
          <Switch on={!!props.on} onChange={props.onToggle} label="On" />
        </label>
      )}
    </header>
  );
}

function BuiltinDetail({ c, id }: { c: Configurator; id: Component }) {
  const e = entry(id);
  return (
    <>
      <Head
        kicker="Built-in component"
        title={e.title}
        badges={e.badges}
        on={isOn(c, id)}
        onToggle={(on) => setOn(c, id, on)}
      />
      <p class="pb-lede">{e.summary}</p>
      <Facts
        rows={[
          ["Shows up at", <code>{id === "smb" ? "smb://<host>/workspace" : e.where}</code>],
          ["Needs", e.needs ?? "Nothing extra."],
          ["In compose", <code>AGENT_ENV_COMPONENTS</code>],
        ]}
      />
      {id === "opencode" && (
        <p class="hint">
          Only one thing answers at <code>/</code>. With OpenCode off, a component of yours can have
          it; with nothing there, <code>/</code> shows the <code>/~env/</code> index.
        </p>
      )}
      {id === "docker" && (
        <div class="callout">
          <p>
            <b>Turning Docker on adds five flags to compose.yaml.</b> A rootless engine needs them:{" "}
            <code>cap_add: SYS_ADMIN</code>, unconfined seccomp, AppArmor and systempaths, and{" "}
            <code>/dev/net/tun</code>. The configurator writes them for you.
          </p>
          <p>
            They widen what code in the container can do, though still well short of{" "}
            <code>--privileged</code>.
          </p>
        </div>
      )}
    </>
  );
}

function DesktopDetail({ c }: { c: Configurator }) {
  const f = c.fields;
  const id = f.desktop === "none" ? "desktop" : f.desktop;
  const e = entry(id);
  return (
    <>
      <Head
        kicker="Built-in component"
        title="Desktop"
        badges={e.badges}
        on={f.desktop !== "none"}
        onToggle={(on) => c.set("desktop", on ? "desktop" : "none")}
      />
      <p class="pb-lede">
        XFCE on a virtual display. Headed agent-browser sessions show up here, so you can watch the
        agent work.
      </p>
      <Facts
        rows={[
          ["Shows up at", <code>/~env/desktop</code>],
          ["Needs", e.needs ?? "Nothing extra."],
          [
            "In compose",
            <code>AGENT_ENV_COMPONENTS={f.desktop === "none" ? "…" : f.desktop}</code>,
          ],
        ]}
      />
      {f.desktop !== "none" && (
        <>
          <h3>Over</h3>
          <Choices c={c} name="desktop" cols={2} options={DESKTOP_OPTIONS.slice(0, 2)} />
          <h3>Display</h3>
          <DesktopGeometry c={c} />
        </>
      )}
    </>
  );
}

function RunsB({ c, x }: { c: Configurator; x: Extras }) {
  const [sel, pick] = useState<Sel>("desktop");
  // On a phone the list and the detail take turns: picking opens the detail.
  const [open, setOpen] = useState(false);
  const setSel = (s: Sel) => {
    pick(s);
    setOpen(true);
    if (window.matchMedia("(max-width: 700px)").matches) {
      document.querySelector(".c-form")?.scrollIntoView();
    }
  };
  const f = c.fields;
  const builtin = (id: Component, sub: string) => (
    <Item
      sel={`c:${id}`}
      current={sel}
      onSelect={setSel}
      title={entry(id).title}
      sub={sub}
      on={isOn(c, id)}
    />
  );
  const files = provisionFiles(x);
  const list = componentsOf(f);
  let detail: ComponentChildren;
  if (sel === "desktop") detail = <DesktopDetail c={c} />;
  else if (sel === "script")
    detail = (
      <>
        <Head kicker="On every start" title="Startup script" />
        <p class="pb-lede">
          Runs as <code>dev</code> before any component starts, every time the container starts.
          Make it safe to repeat. What it did is in <code>agent-env logs provision</code>.
        </p>
        <p class="hint">
          Components of your own go in here too: get the folder onto the disk (a{" "}
          <code>git clone</code>, say) and run <code>agent-env component install</code> on it.
        </p>
        <ScriptEditor x={x} rows={9} />
        <YamlPreview x={x} />
      </>
    );
  else if (sel === "limits")
    detail = (
      <>
        <Head kicker="Resources" title="Limits" />
        <p class="pb-lede">
          Optional caps for a shared host, covering everything in the container. Blank means none.
        </p>
        <LimitFields c={c} />
      </>
    );
  else detail = <BuiltinDetail c={c} id={sel.slice(2) as Component} />;

  return (
    <div class={`pb ${open ? "open" : ""}`}>
      <nav class="pb-list">
        <div class="pb-label">Built in</div>
        <ul>
          <Item
            sel="desktop"
            current={sel}
            onSelect={setSel}
            title="Desktop"
            sub={
              f.desktop === "none"
                ? "off"
                : `${f.desktop === "desktop-selkies" ? "Selkies" : "noVNC"} · ${c.answers.desktopSize?.replace("x", "×")}`
            }
            on={f.desktop !== "none"}
          />
          {builtin("terminal", "/~env/terminal")}
          {builtin("files", "/~env/files")}
          {builtin("opencode", "at /")}
          {builtin("docker", "containers for the agent")}
          {builtin("smb", "smb://…/workspace")}
        </ul>
        <div class="pb-label">Setup</div>
        <ul>
          <Item
            sel="script"
            current={sel}
            onSelect={setSel}
            title="Startup script"
            sub={
              files.length
                ? files.map((p) => p.target.split("/").pop()).join(", ")
                : "nothing runs at start"
            }
          />
          <Item
            sel="limits"
            current={sel}
            onSelect={setSel}
            title="Limits"
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
        <div class="pb-value">
          <span>AGENT_ENV_COMPONENTS</span>
          <code>{list.join(",\u200b") || '""'}</code>
        </div>
      </nav>
      <section class="pb-detail">
        <button type="button" class="pb-back" onClick={() => setOpen(false)}>
          ← All components
        </button>
        {detail}
        <ComponentsProblem c={c} />
      </section>
    </div>
  );
}

function Page() {
  const x = useExtras();
  return <App runs={(c) => <RunsB c={c} x={x} />} />;
}

render(<Page />, document.getElementById("app")!);
