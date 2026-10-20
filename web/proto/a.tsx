/** Prototype A: summary tabs across the top; the section and the files side by side. */

import { render } from "preact";
import { useState } from "preact/hooks";
import "./claw.css";
import "./a.css";
import { SECTIONS, type SectionId, useConfigurator } from "./model.ts";
import { Existing, FilesPanel, OkIcon, ProblemList, SectionBody, WarnIcon } from "./ui.tsx";

function App() {
  const c = useConfigurator();
  const [tab, setTab] = useState<SectionId>("where");
  const index = SECTIONS.findIndex((s) => s.id === tab);
  const section = SECTIONS[index];
  return (
    <div class="a-page">
      <header class="a-head">
        <h1>
          <b>agent-env</b> configurator
        </h1>
        <p class="muted">
          Answers in, <code>compose.yaml</code> and <code>.env</code> out. Nothing leaves this page.
        </p>
      </header>

      <nav class="a-tabs" role="tablist">
        {SECTIONS.map((s, i) => {
          const issues = c.problemsIn(s.id).length;
          return (
            <button
              role="tab"
              aria-selected={s.id === tab}
              class={issues ? "attention" : ""}
              onClick={() => setTab(s.id)}
            >
              <span class="a-tab-title">
                <span class="a-num">{i + 1}</span> {s.title}
                {issues ? <WarnIcon /> : <OkIcon />}
              </span>
              <span class="a-tab-summary">{s.summary(c.answers)}</span>
            </button>
          );
        })}
      </nav>

      <main class="a-main">
        <section class="card a-form">
          <SectionBody c={c} id={section.id} />
          <footer class="a-foot">
            <button disabled={index === 0} onClick={() => setTab(SECTIONS[index - 1].id)}>
              ← Back
            </button>
            {index < SECTIONS.length - 1 && (
              <button class="primary" onClick={() => setTab(SECTIONS[index + 1].id)}>
                {SECTIONS[index + 1].title} →
              </button>
            )}
          </footer>
        </section>

        <aside class="a-side">
          {c.problems.length > 0 && (
            <div class="card a-problems">
              <ProblemList c={c} onGo={setTab} />
            </div>
          )}
          <FilesPanel c={c} class="a-files" />
          <details class="card a-existing">
            <summary>Updating an existing deployment?</summary>
            <Existing c={c} />
          </details>
        </aside>
      </main>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
