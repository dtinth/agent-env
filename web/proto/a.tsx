/** Prototype A — Catalog: built-ins as toggle cards, settings opening beneath them. */

import { type ComponentChildren, render } from "preact";
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
  Badges,
  type CatalogEntry,
  ComponentsProblem,
  entry,
  type Extras,
  isOn,
  offered,
  RepoRows,
  ScriptEditor,
  setOn,
  Switch,
  useExtras,
  YamlPreview,
} from "./extras.tsx";

function Card(props: {
  e: Pick<CatalogEntry, "title" | "summary" | "where" | "badges">;
  on: boolean;
  onChange: (on: boolean) => void;
  radio?: boolean;
}) {
  const { e, on } = props;
  return (
    <div
      class={`pa-card ${on ? "on" : ""}`}
      onClick={() => props.onChange(props.radio ? true : !on)}
    >
      <div class="pa-card-top">
        <strong>{e.title}</strong>
        {props.radio ? (
          <span class={`pa-radio ${on ? "on" : ""}`} aria-hidden="true" />
        ) : (
          <Switch on={on} onChange={props.onChange} label={e.title} />
        )}
      </div>
      <p>{e.summary}</p>
      <div class="pa-card-foot">
        {e.where === "—" ? <span class="muted pa-noweb">no web page</span> : <code>{e.where}</code>}
        <Badges list={e.badges} />
      </div>
    </div>
  );
}

function Toggle({ c, id }: { c: Configurator; id: Component }) {
  return <Card e={entry(id)} on={isOn(c, id)} onChange={(on) => setOn(c, id, on)} />;
}

function Group(props: { title: string; note?: string; children: ComponentChildren }) {
  return (
    <section class="pa-group">
      <div class="pa-group-head">
        <h3>{props.title}</h3>
        {props.note && <span class="muted">{props.note}</span>}
      </div>
      {props.children}
    </section>
  );
}

function RunsA({ c, x }: { c: Configurator; x: Extras }) {
  const f = c.fields;
  const desktopOn = f.desktop !== "none";
  const selkies = f.desktop === "desktop-selkies";
  const list = componentsOf(f);
  return (
    <>
      <p class="pa-lede">
        Each card is one component. What is on goes into{" "}
        <code>AGENT_ENV_COMPONENTS={list.join(",") || '""'}</code>
      </p>

      <Group title="In the browser" note="behind the same sign-in, under /~env/">
        <div class="pa-grid">
          <Card
            e={{
              title: "Desktop",
              summary: selkies
                ? "XFCE over Selkies: audio and smoother video, one person drives."
                : "XFCE on a virtual display, over noVNC. Several people can drive it.",
              where: "/~env/desktop",
              badges: selkies ? ["prototype"] : [],
            }}
            on={desktopOn}
            onChange={(on) => c.set("desktop", on ? "desktop" : "none")}
          />
          <Toggle c={c} id="terminal" />
          <Toggle c={c} id="files" />
        </div>
        {desktopOn && (
          <div class="pa-drawer" style={{ "--notch": "16.6%" }}>
            <div class="pa-drawer-title">Desktop settings</div>
            <Choices c={c} name="desktop" cols={2} options={DESKTOP_OPTIONS.slice(0, 2)} />
            <DesktopGeometry c={c} />
          </div>
        )}
      </Group>

      <Group title="At /" note="one thing answers at your address">
        <div class="pa-grid two">
          <Card
            radio
            e={entry("opencode")}
            on={f.opencode}
            onChange={() => c.set("opencode", true)}
          />
          <Card
            radio
            e={{
              title: "Your own app",
              summary:
                "Whatever listens on a port of your choosing, optionally started and kept running for you.",
              where: `/ → :${f.primaryPort.trim() || "3000"}`,
              badges: [],
            }}
            on={!f.opencode}
            onChange={() => c.set("opencode", false)}
          />
        </div>
        <div class="pa-drawer" style={{ "--notch": f.opencode ? "25%" : "75%" }}>
          {f.opencode ? (
            <p class="pa-drawer-note">
              OpenCode has <code>/</code>, so there is no <code>PRIMARY_COMMAND</code>: the two
              cannot share it. Pick <b>Your own app</b> to serve something else there instead.
            </p>
          ) : (
            <>
              <div class="pa-drawer-title">Your own app</div>
              <PrimaryFields c={c} />
              <p class="hint">
                With no command, start it yourself; until something listens, <code>/</code> shows
                the <code>/~env/</code> index.
              </p>
            </>
          )}
        </div>
      </Group>

      <Group title="Infrastructure">
        <div class="pa-grid">
          <Toggle c={c} id="docker" />
          {offered(c, "smb") && <Toggle c={c} id="smb" />}
        </div>
        {f.docker && (
          <p class="callout">
            Rootless Docker needs the host to relax this container's sandbox. The compose file adds{" "}
            <code>SYS_ADMIN</code>, unconfined seccomp, AppArmor and systempaths, and{" "}
            <code>/dev/net/tun</code>.
          </p>
        )}
      </Group>
      <ComponentsProblem c={c} />

      <Group title="Your components" note="folders with an agent-env-component.toml, from git">
        {x.repos.length ? (
          <RepoRows x={x} />
        ) : (
          <p class="muted pa-empty">
            None yet. Each one is cloned into <code>~/src</code> and installed on every start.
          </p>
        )}
        <button type="button" class="small pa-add" onClick={() => x.addRepo()}>
          + Add a repository
        </button>
      </Group>

      <details class="pa-details" open={!!x.script.trim()}>
        <summary>
          <h3>Startup script</h3>
          <span class="muted">
            {x.script.trim()
              ? `${x.script.trim().split("\n").length} lines · runs first, on every start`
              : "optional · runs as dev before anything starts"}
          </span>
        </summary>
        <ScriptEditor x={x} rows={6} />
      </details>

      <YamlPreview x={x} class="pa-yaml" />

      <Group title="Limits" note="optional; blank means none">
        <LimitFields c={c} />
      </Group>
    </>
  );
}

function Page() {
  const x = useExtras();
  return <App runs={(c) => <RunsA c={c} x={x} />} />;
}

render(<Page />, document.getElementById("app")!);
