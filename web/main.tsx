/**
 * The web configurator: a stepper over generate.ts. Each step's form sits
 * beside a running summary of every answer, and the files get a step of their
 * own at the end. Every change re-renders the files; nothing leaves the page.
 */

import { render } from "preact";
import { useState } from "preact/hooks";
import "./app/claw.css";
import "./app/layout.css";
import { nextSteps, SECTIONS, type SectionId, useConfigurator } from "./app/model.ts";
import { FilesPanel, ImportDialog, OkIcon, ProblemList, SectionBody, WarnIcon } from "./app/ui.tsx";

const STEPS: { id: SectionId; title: string }[] = [
  ...SECTIONS,
  { id: "files", title: "Review & download" },
];

function App() {
  const c = useConfigurator();
  const [step, setStep] = useState<SectionId>("where");
  const [importing, setImporting] = useState(false);
  const index = STEPS.findIndex((s) => s.id === step);
  const issuesIn = (id: SectionId) => (id === "files" ? c.problems : c.problemsIn(id)).length;

  return (
    <div class="c-page">
      <header class="c-head">
        <div class="c-title">
          <h1>
            <b>agent-env</b> configurator
          </h1>
          <p class="muted">
            Answers in, <code>compose.yaml</code> and <code>.env</code> out, for Docker Compose,
            Dockge or Dokploy. Nothing you type leaves this page. Prefer a terminal?{" "}
            <code>node setup.ts</code> asks the same questions.
          </p>
        </div>
        <button class="c-import" onClick={() => setImporting(true)}>
          Import existing…
        </button>
      </header>

      <ol class="c-steps">
        {STEPS.map((s, i) => {
          const issues = issuesIn(s.id);
          const state = s.id === step ? "current" : issues ? "attention" : i < index ? "done" : "";
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

      {c.restoredWithoutSecrets && (
        <p class="callout c-notice">
          Your answers from last time are back, but the secrets in this <code>.env</code> are new.
          If you have already deployed,{" "}
          <button class="link" onClick={() => setImporting(true)}>
            import your current <code>.env</code>
          </button>{" "}
          to keep the ones in use.
        </p>
      )}

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
              <h3>Secrets</h3>
              <p class="c-small">
                {c.fields.existingEnv.trim() ? (
                  <>
                    Kept from the <code>.env</code> you imported; only missing ones are generated.
                  </>
                ) : (
                  <>
                    Generated in this tab. Updating a deployment?{" "}
                    <button class="link" onClick={() => setImporting(true)}>
                      Import it
                    </button>{" "}
                    to keep the ones in use.
                  </>
                )}
              </p>
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
            <ul>
              {SECTIONS.map((s) => {
                const issues = c.problemsIn(s.id);
                return (
                  <li>
                    <button
                      class={`c-row ${s.id === step ? "here" : ""}`}
                      onClick={() => setStep(s.id)}
                    >
                      <span class="c-row-title">
                        {s.title}
                        {issues.length ? <WarnIcon /> : <OkIcon />}
                      </span>
                      <span class="c-row-value">{s.summary(c.answers)}</span>
                      {issues.length > 0 && <span class="c-issue">{issues[0].message}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
            <div class="c-url">
              <span class="muted">Opens at</span>
              <code>{c.answers.publicUrl}</code>
            </div>
          </aside>
        </main>
      )}

      {importing && <ImportDialog c={c} onClose={() => setImporting(false)} />}
    </div>
  );
}

render(<App />, document.getElementById("app")!);
