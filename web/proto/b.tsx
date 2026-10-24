/** Prototype B — List and detail: every component in a list, the chosen one beside it. */

import { type ComponentChildren, render } from "preact";
import { useState } from "preact/hooks";
import "../app/claw.css";
import "../app/layout.css";
import "./protos.css";
import type { Component } from "../../generate.ts";
import { type Configurator, componentsOf } from "../app/model.ts";
import { App } from "../app/shell.tsx";
import {
  Choices,
  DESKTOP_OPTIONS,
  DesktopGeometry,
  LimitFields,
  PrimaryFields,
} from "../app/ui.tsx";
import {
  type Badge,
  Badges,
  ComponentsProblem,
  entry,
  type Extras,
  isOn,
  provisionFiles,
  repoName,
  RepoRows,
  rootLabel,
  ScriptEditor,
  setOn,
  Switch,
  useExtras,
  YamlPreview,
} from "./extras.tsx";

type Sel = `c:${Component}` | "desktop" | "root" | `repo:${number}` | "script" | "limits";

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
  const f = c.fields;
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
        <div class="pb-relation">
          <h3>And your own app</h3>
          <p>
            Only one thing answers at <code>/</code>.{" "}
            {f.opencode ? (
              <>
                With OpenCode on, <code>PRIMARY_PORT</code> and <code>PRIMARY_COMMAND</code> are not
                used.
              </>
            ) : (
              <>
                OpenCode is off, so <code>/</code> goes to <b>{rootLabel(c).title}</b>.
              </>
            )}
          </p>
        </div>
      )}
      {id === "docker" && f.docker && (
        <p class="callout">
          This is a real widening of what code in the container can do, still well short of{" "}
          <code>--privileged</code>.
        </p>
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

function RootDetail({ c }: { c: Configurator }) {
  const f = c.fields;
  return (
    <>
      <Head
        kicker="At /"
        title="Your own app"
        on={!f.opencode}
        onToggle={(on) => c.set("opencode", !on)}
      />
      <p class="pb-lede">
        Not a component: <code>/</code> proxies to a port, and the container can run a command there
        and keep it running.
      </p>
      {f.opencode ? (
        <div class="pb-blocked">
          <p>
            <b>OpenCode has /.</b> Your own app takes over when OpenCode is off; the two cannot
            share the address.
          </p>
          <button type="button" class="small" onClick={() => c.set("opencode", false)}>
            Turn OpenCode off and use my app
          </button>
        </div>
      ) : (
        <>
          <Facts
            rows={[
              ["Shows up at", <code>/</code>],
              ["In compose", <code>PRIMARY_PORT, PRIMARY_COMMAND</code>],
            ]}
          />
          <h3>Settings</h3>
          <PrimaryFields c={c} />
          <p class="hint">
            With nothing listening, <code>/</code> shows the <code>/~env/</code> index instead.
          </p>
        </>
      )}
    </>
  );
}

function RepoDetail({ x, i }: { x: Extras; i: number }) {
  const r = x.repos[i];
  const name = r.url.trim() ? repoName(r.url) : "New repository";
  return (
    <>
      <Head kicker="Your component" title={name} />
      <p class="pb-lede">
        A folder with an <code>agent-env-component.toml</code>, kept in git. The startup script
        clones it into <code>~/src/{r.url.trim() ? repoName(r.url) : "…"}</code> on the first start,
        pulls it on the next ones, and runs <code>agent-env component install .</code> each time.
      </p>
      <RepoRows x={x} only={i} />
      <p class="hint">
        A private repository needs a token in the URL; pass it in through <code>.env</code>.
      </p>
      <YamlPreview x={x} />
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
  else if (sel === "root") detail = <RootDetail c={c} />;
  else if (sel === "script")
    detail = (
      <>
        <Head kicker="On every start" title="Startup script" />
        <p class="pb-lede">
          Runs as <code>dev</code> before any component starts, every time the container starts.
          Make it safe to repeat. What it did is in <code>agent-env logs provision</code>.
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
  else if (sel.startsWith("repo:")) {
    const i = Number(sel.slice(5));
    detail = x.repos[i] ? (
      <RepoDetail x={x} i={i} />
    ) : (
      <p class="muted pb-gone">
        Removed. It is no longer cloned or installed; a copy already in <code>~/src</code> stays
        installed until <code>agent-env component uninstall</code>.
      </p>
    );
  } else detail = <BuiltinDetail c={c} id={sel.slice(2) as Component} />;

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
          <Item
            sel="root"
            current={sel}
            onSelect={setSel}
            title="Your own app"
            sub={f.opencode ? "OpenCode has /" : `at / → :${f.primaryPort.trim() || "3000"}`}
            dim={f.opencode}
          />
          {builtin("docker", "needs host flags")}
          {builtin("smb", "smb://…/workspace")}
        </ul>
        <div class="pb-label">Yours</div>
        <ul>
          {x.repos.map((r, i) => (
            <Item
              sel={`repo:${i}`}
              current={sel}
              onSelect={setSel}
              title={r.url.trim() ? repoName(r.url) : "New repository"}
              sub="from git"
            />
          ))}
          <li>
            <button
              type="button"
              class="pb-add"
              onClick={() => {
                x.addRepo();
                setSel(`repo:${x.repos.length}`);
              }}
            >
              + Add from git
            </button>
          </li>
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
