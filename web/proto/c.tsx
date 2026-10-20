/**
 * Prototype C: a stepper. Each step's form sits beside a running summary of
 * every answer; the files get a step of their own at the end, full width.
 */

import { render } from "preact";
import { useState } from "preact/hooks";
import "./claw.css";
import "./c.css";
import { nextSteps, SECTIONS, type SectionId, useConfigurator } from "./model.ts";
import { Existing, FilesPanel, OkIcon, ProblemList, SectionBody, WarnIcon } from "./ui.tsx";

const STEPS: { id: SectionId; title: string }[] = [
  ...SECTIONS,
  { id: "files", title: "Review & download" },
];

function App() {
  const c = useConfigurator();
  const [step, setStep] = useState<SectionId>("where");
  const index = STEPS.findIndex((s) => s.id === step);
  const issuesIn = (id: SectionId) => (id === "files" ? c.problems : c.problemsIn(id)).length;

  return (
    <div class="c-page">
      <header class="c-head">
        <h1>
          <b>agent-env</b> configurator
        </h1>
        <ol class="c-steps">
          {STEPS.map((s, i) => {
            const issues = issuesIn(s.id);
            const state =
              s.id === step ? "current" : issues ? "attention" : i < index ? "done" : "";
            return (
              <li class={state}>
                <button onClick={() => setStep(s.id)}>
                  <span class="c-dot">
                    {issues && s.id !== "files" ? <WarnIcon /> : i < index ? "✓" : i + 1}
                  </span>
                  <span>{s.title}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </header>

      {step === "files" ? (
        <main class="c-review">
          <FilesPanel c={c} class="c-files" />
          <aside class="c-review-side">
            {c.problems.length ? (
              <div class="card">
                <h3 class="c-warn">Fix these first</h3>
                <ProblemList c={c} onGo={setStep} />
              </div>
            ) : (
              <div class="card">
                <h3 class="c-ok">Next steps</h3>
                <ol class="steps">
                  {nextSteps(c.answers).map((s) => (
                    <li>{s}</li>
                  ))}
                </ol>
              </div>
            )}
            <div class="card">
              <h3>Updating an existing deployment?</h3>
              <Existing c={c} />
            </div>
          </aside>
        </main>
      ) : (
        <main class="c-main">
          <section class="card c-form">
            <SectionBody c={c} id={step} />
            <footer class="c-foot">
              <button disabled={index === 0} onClick={() => setStep(STEPS[index - 1].id)}>
                ← Back
              </button>
              <button class="primary" onClick={() => setStep(STEPS[index + 1].id)}>
                {STEPS[index + 1].title} →
              </button>
            </footer>
          </section>
          <aside class="c-summary card">
            <h3>Your deployment</h3>
            <dl>
              {SECTIONS.map((s) => {
                const issues = c.problemsIn(s.id);
                return (
                  <button
                    class={`c-row ${s.id === step ? "here" : ""}`}
                    onClick={() => setStep(s.id)}
                  >
                    <dt>
                      {s.title}
                      {issues.length ? <WarnIcon /> : <OkIcon />}
                    </dt>
                    <dd>{s.summary(c.answers)}</dd>
                    {issues.length > 0 && <dd class="c-issue">{issues[0].message}</dd>}
                  </button>
                );
              })}
            </dl>
            <div class="c-url">
              <span class="muted">Opens at</span>
              <code>{c.answers.publicUrl}</code>
            </div>
          </aside>
        </main>
      )}
    </div>
  );
}

render(<App />, document.getElementById("app")!);
