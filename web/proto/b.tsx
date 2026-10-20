/** Prototype B: claw's sidebar holds the sections; form and files fill the rest. */

import { render } from "preact";
import { useState } from "preact/hooks";
import "./claw.css";
import "./b.css";
import { nextSteps, SECTIONS, type SectionId, useConfigurator } from "./model.ts";
import { Existing, FilesPanel, OkIcon, ProblemList, SectionBody, WarnIcon } from "./ui.tsx";

const BLURB: Record<SectionId, string> = {
  where: "Where this runs decides the URL, the ports and which sidecar you get.",
  who: "The gate in front of everything. Whoever passes it has root in the container.",
  runs: "What lives at / and how the desktop reaches your browser.",
  storage: "How you get in over SSH, and where your files are kept.",
  files: "",
};

function App() {
  const c = useConfigurator();
  const [tab, setTab] = useState<SectionId>("where");
  const section = SECTIONS.find((s) => s.id === tab)!;
  const ok = c.problems.length === 0;
  return (
    <div class="b-shell">
      <aside class="b-side">
        <h1>
          <b>agent-env</b>
          <br />
          configurator
        </h1>
        <nav class="b-tabs" role="tablist">
          {SECTIONS.map((s) => {
            const issues = c.problemsIn(s.id).length;
            return (
              <button role="tab" aria-selected={s.id === tab} onClick={() => setTab(s.id)}>
                <span class="b-tab-title">
                  {s.title}
                  {issues ? (
                    <span class="b-badge">
                      <WarnIcon /> {issues}
                    </span>
                  ) : (
                    <OkIcon />
                  )}
                </span>
                <span class="b-tab-summary">{s.summary(c.answers)}</span>
              </button>
            );
          })}
        </nav>
        <div class="b-status">
          {ok ? (
            <>
              <h3 class="ok-head">
                <OkIcon /> Ready to deploy
              </h3>
              <ol class="steps">
                {nextSteps(c.answers).map((s) => (
                  <li>{s}</li>
                ))}
              </ol>
            </>
          ) : (
            <>
              <h3 class="warn-head">
                <WarnIcon /> Needs attention
              </h3>
              <ProblemList c={c} onGo={setTab} />
            </>
          )}
        </div>
      </aside>

      <main class="b-main">
        <header class="b-section-head">
          <h2>{section.title}</h2>
          <p class="muted">{BLURB[section.id]}</p>
        </header>
        <SectionBody c={c} id={section.id} />
        <details class="b-existing">
          <summary>Updating an existing deployment?</summary>
          <Existing c={c} />
        </details>
      </main>

      <FilesPanel c={c} class="b-files" />
    </div>
  );
}

render(<App />, document.getElementById("app")!);
