/** Prototype C — Composer: the component list as chips, a picker, and what happens at boot. */

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
  Badges,
  CATALOG,
  ComponentsProblem,
  entry,
  type Extras,
  provisionFiles,
  repoName,
  RepoRows,
  rootLabel,
  ScriptEditor,
  setOn,
  useExtras,
  YamlPreview,
} from "./extras.tsx";

function Picker(props: { c: Configurator; x: Extras; onClose: () => void }) {
  const { c, x } = props;
  const [url, setUrl] = useState("");
  const on = componentsOf(c.fields);
  const left = CATALOG.filter((e) => !on.includes(e.id));
  const add = (id: Component) => {
    setOn(c, id, true);
    props.onClose();
  };
  return (
    <>
      <div class="pc-scrim" onClick={props.onClose} />
      <div class="pc-picker card" role="dialog" aria-label="Add a component">
        <div class="pc-picker-label">Built in</div>
        {left.length ? (
          <ul>
            {left.map((e) => {
              const replaces =
                (e.id === "desktop" && on.includes("desktop-selkies")) ||
                (e.id === "desktop-selkies" && on.includes("desktop"));
              return (
                <li>
                  <button type="button" class="pc-pick" onClick={() => add(e.id)}>
                    <span class="pc-pick-top">
                      <strong>{e.title}</strong>
                      {e.where === "—" ? (
                        <span class="muted">no web page</span>
                      ) : (
                        <code>{e.where}</code>
                      )}
                      <Badges list={e.badges} />
                    </span>
                    <span class="pc-pick-desc">
                      {e.summary}
                      {replaces && (
                        <em>
                          {" "}
                          Replaces the {e.id === "desktop" ? "Selkies" : "noVNC"} desktop: both live
                          at /~env/desktop.
                        </em>
                      )}
                      {e.id === "opencode" && c.fields.primaryCommand.trim() && (
                        <em> Takes / from your command, which then is not run.</em>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p class="muted pc-picker-none">Every built-in component is on.</p>
        )}
        <div class="pc-picker-label">From a git repository…</div>
        <form
          class="pc-picker-git"
          onSubmit={(e) => {
            e.preventDefault();
            if (!url.trim()) return;
            x.addRepo({ url: url.trim() });
            props.onClose();
          }}
        >
          <input
            type="text"
            class="mono"
            spellcheck={false}
            placeholder="https://github.com/you/your-component"
            value={url}
            onInput={(e) => setUrl(e.currentTarget.value)}
          />
          <button type="submit" class="small primary" disabled={!url.trim()}>
            Add
          </button>
        </form>
        <p class="pc-picker-foot muted">
          Cloned into <code>~/src</code> and installed with <code>agent-env component install</code>{" "}
          on every start.
        </p>
      </div>
    </>
  );
}

function Panel(props: {
  id: string;
  open: Set<string>;
  toggle: (id: string) => void;
  title: ComponentChildren;
  aside?: ComponentChildren;
  children: ComponentChildren;
}) {
  const isOpen = props.open.has(props.id);
  return (
    <section class={`pc-panel ${isOpen ? "open" : ""}`}>
      <button type="button" class="pc-panel-head" onClick={() => props.toggle(props.id)}>
        <span class="pc-chev">{isOpen ? "▾" : "▸"}</span>
        <span class="pc-panel-title">{props.title}</span>
        <span class="pc-panel-aside">{props.aside}</span>
      </button>
      {isOpen && <div class="pc-panel-body">{props.children}</div>}
    </section>
  );
}

function RunsC({ c, x }: { c: Configurator; x: Extras }) {
  const f = c.fields;
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState(() => new Set(["root", "desktop"]));
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const list = componentsOf(f);
  const root = rootLabel(c);
  const files = provisionFiles(x);
  const desktop = f.desktop === "none" ? undefined : f.desktop;

  return (
    <>
      <div class="pc-compose">
        <div class="pc-var">
          <code class="pc-key">AGENT_ENV_COMPONENTS=</code>
          {list.map((id) => (
            <span class="pc-chip">
              {id}
              <button type="button" aria-label={`Remove ${id}`} onClick={() => setOn(c, id, false)}>
                ×
              </button>
            </span>
          ))}
          {!list.length && <span class="muted pc-none">nothing built in</span>}
        </div>
        {x.repos.length > 0 && (
          <div class="pc-var">
            <code class="pc-key">from git</code>
            {x.repos.map((r, i) => (
              <span class="pc-chip git">
                {r.url.trim() ? repoName(r.url) : "new repository"}
                <button type="button" aria-label="Remove" onClick={() => x.removeRepo(i)}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div class="pc-add-wrap">
          <button type="button" class="primary" onClick={() => setPicking(true)}>
            + Add component
          </button>
          {picking && <Picker c={c} x={x} onClose={() => setPicking(false)} />}
        </div>
      </div>

      <div class="pc-routes">
        <div class={`pc-route root ${f.opencode ? "" : "own"}`}>
          <code>/</code>
          <span>
            <b>{root.title}</b>
            <small>{f.opencode ? "PRIMARY_COMMAND is not used" : root.detail}</small>
          </span>
        </div>
        {desktop && (
          <div class="pc-route">
            <code>/~env/desktop</code>
            <span>{desktop === "desktop" ? "noVNC" : "Selkies"}</span>
          </div>
        )}
        {list.includes("terminal") && (
          <div class="pc-route">
            <code>/~env/terminal</code>
            <span>Terminal</span>
          </div>
        )}
        {list.includes("files") && (
          <div class="pc-route">
            <code>/~env/files</code>
            <span>Files</span>
          </div>
        )}
        {list.includes("smb") && (
          <div class="pc-route">
            <code>smb://</code>
            <span>SMB share</span>
          </div>
        )}
      </div>
      <ComponentsProblem c={c} />

      <div class="pc-accordion">
        <Panel
          id="root"
          open={open}
          toggle={toggle}
          title={
            <>
              At <code>/</code>
            </>
          }
          aside={root.title}
        >
          <div class="pc-seg">
            <button
              type="button"
              class={f.opencode ? "on" : ""}
              onClick={() => c.set("opencode", true)}
            >
              OpenCode <Badges list={["at /"]} />
            </button>
            <button
              type="button"
              class={f.opencode ? "" : "on"}
              onClick={() => c.set("opencode", false)}
            >
              Your own app
            </button>
          </div>
          {f.opencode ? (
            <p class="hint">
              The <code>opencode</code> component serves <code>/</code>. Switch to your own app for
              a port and a command of your choosing; the two cannot share <code>/</code>.
            </p>
          ) : (
            <PrimaryFields c={c} />
          )}
        </Panel>
        {desktop && (
          <Panel
            id="desktop"
            open={open}
            toggle={toggle}
            title={entry(desktop).title}
            aside={`${desktop === "desktop" ? "noVNC" : "Selkies"} · ${c.answers.desktopSize?.replace("x", "×")} · ${f.desktopScale}%`}
          >
            <Choices c={c} name="desktop" cols={2} options={DESKTOP_OPTIONS.slice(0, 2)} />
            <DesktopGeometry c={c} />
          </Panel>
        )}
        {list.includes("docker") && (
          <Panel id="docker" open={open} toggle={toggle} title="Docker" aside="host flags">
            <p class="pc-text">{entry("docker").needs}</p>
          </Panel>
        )}
        {list.includes("smb") && (
          <Panel id="smb" open={open} toggle={toggle} title="SMB share" aside="port 445">
            <p class="pc-text">
              Sign in as <code>dev</code>. The password is generated on first start and shown on the{" "}
              <code>/~env/</code> page; set <code>SMB_PASSWORD</code> in <code>.env</code> to choose
              it.
            </p>
          </Panel>
        )}
        {x.repos.map((r, i) => (
          <Panel
            id={`repo:${i}`}
            open={open}
            toggle={toggle}
            title={r.url.trim() ? repoName(r.url) : "New repository"}
            aside={r.ref?.trim() ? `from git · ${r.ref.trim()}` : "from git"}
          >
            <RepoRows x={x} only={i} />
          </Panel>
        ))}
      </div>

      <section class="pc-boot">
        <h3>On every start</h3>
        <ol class="pc-timeline">
          <li class={x.script.trim() ? "" : "idle"}>
            <div class="pc-step-head">
              <strong>Your startup script</strong>
              <code>provision.d/10-setup</code>
            </div>
            <ScriptEditor x={x} rows={7} bare />
          </li>
          <li class={x.repos.some((r) => r.url.trim()) ? "" : "idle"}>
            <div class="pc-step-head">
              <strong>Clone and install your components</strong>
              <code>provision.d/20-components</code>
            </div>
            {x.repos.some((r) => r.url.trim()) ? (
              <ul class="pc-step-list">
                {x.repos
                  .filter((r) => r.url.trim())
                  .map((r) => (
                    <li>
                      <code>{r.url.trim()}</code> → <code>~/src/{repoName(r.url)}</code>, then{" "}
                      <code>agent-env component install .</code>
                    </li>
                  ))}
              </ul>
            ) : (
              <p class="muted pc-text">
                None. Add one with <b>+ Add component</b> → <i>From a git repository…</i>
              </p>
            )}
          </li>
          <li>
            <div class="pc-step-head">
              <strong>Start every component</strong>
            </div>
            <div class="pc-step-chips">
              {list.map((id) => (
                <span class="pc-chip static">{id}</span>
              ))}
              {x.repos
                .filter((r) => r.url.trim())
                .map((r) => (
                  <span class="pc-chip git static">{repoName(r.url)}</span>
                ))}
              {!f.opencode && f.primaryCommand.trim() && (
                <span class="pc-chip static own">primary</span>
              )}
            </div>
          </li>
        </ol>
        <YamlPreview
          x={x}
          title={
            files.length ? (
              <>
                {files.length === 1 ? "One script" : `${files.length} scripts`}, as{" "}
                <code>compose.yaml</code> carries them
              </>
            ) : undefined
          }
        />
      </section>

      <h3>
        Limits <small>(optional; blank means none)</small>
      </h3>
      <LimitFields c={c} />
    </>
  );
}

function Page() {
  const x = useExtras();
  return <App runs={(c) => <RunsC c={c} x={x} />} />;
}

render(<Page />, document.getElementById("app")!);
