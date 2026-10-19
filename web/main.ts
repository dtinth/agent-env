/**
 * The web configurator: a form over generate.ts. Every change re-renders the
 * files; nothing leaves the page. The rules — what is valid, what each answer
 * turns into — all live in generate.ts, shared with the setup.ts wizard, so
 * the two cannot disagree.
 */

import {
  type Answers,
  ANSWERS_FILE,
  type AuthMode,
  generate,
  hostPathFor,
  type Mode,
  DEFAULT_DESKTOP_SIZE,
  DESKTOP_SCALES,
  DESKTOP_SIZES,
  type DesktopBackend,
  type Preset,
  type Problem,
  publicUrlFor,
  randomSecret,
  validate,
  VERSION,
} from "../generate.ts";

const form = document.querySelector<HTMLFormElement>("#form")!;
const code = document.querySelector<HTMLElement>("#code")!;
const problemsBox = document.querySelector<HTMLElement>("#problems")!;
const next = document.querySelector<HTMLOListElement>("#next")!;
const tabs = [...document.querySelectorAll<HTMLButtonElement>("[role=tab]")];

const STORAGE_KEY = "agent-env-configurator:answers";

let files: Record<string, string> = {};
let current = "compose.yaml";

/**
 * Secrets are minted once per key and then held, so the password on screen
 * does not change with every keystroke, or with a reload of this tab. They are
 * kept in sessionStorage, not localStorage: a credential should not outlive
 * the visit on this machine. Across visits, the existing .env box is the way
 * to keep them, and the page says so. "New secrets" clears this.
 */
const SECRETS_KEY = "agent-env-configurator:secrets";
let minted = new Map<string, string>(loadSecrets());
function loadSecrets(): [string, string][] {
  try {
    return Object.entries(
      JSON.parse(sessionStorage.getItem(SECRETS_KEY) ?? "{}") as Record<string, string>,
    );
  } catch {
    return [];
  }
}
function saveSecrets(): void {
  try {
    sessionStorage.setItem(SECRETS_KEY, JSON.stringify(Object.fromEntries(minted)));
  } catch {
    // Blocked storage: secrets still hold for as long as the page is open.
  }
}
const stableSecret = (bytes: number, key: string): string => {
  if (!minted.has(key)) {
    minted.set(key, randomSecret(bytes));
    saveSecrets();
  }
  return minted.get(key)!;
};
/** True when this tab started from a previous visit's answers but not its secrets. */
let restoredWithoutSecrets = false;

/** Answers the person has set themselves, so mode defaults leave them alone. */
const touched = new Set<string>();

// ---------------------------------------------------------------------------
// Form ↔ answers
// ---------------------------------------------------------------------------

function el(name: string): HTMLInputElement | HTMLTextAreaElement {
  return form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement;
}
function text(name: string): string {
  return el(name).value.trim();
}
function checked(name: string): boolean {
  return (el(name) as HTMLInputElement).checked;
}
/** The chosen value of a radio group, or of a menu of the same name. */
function radio(name: string): string {
  const picked = form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
  if (picked) return picked.value;
  return form.querySelector<HTMLSelectElement>(`select[name="${name}"]`)?.value ?? "";
}
function num(name: string): number | undefined {
  const v = text(name);
  return v === "" ? undefined : Number(v);
}

/** What the form says, shaped exactly as the wizard's collect() returns it. */
function readAnswers(): Answers {
  const mode = radio("mode") as Mode;
  const authMode = radio("authMode") as AuthMode;
  const behindProxy = mode === "local" ? checked("behindProxy") : undefined;
  const preset = radio("preset") as Preset;
  const a: Answers = {
    version: VERSION,
    mode,
    behindProxy,
    publicUrl: "",
    domain: mode === "caddy" ? text("domain") : undefined,
    httpsPort: mode === "caddy" ? num("httpsPort") : undefined,
    acmeEmail: mode === "caddy" ? text("acmeEmail") : undefined,
    tsHostname: mode === "tailscale" ? text("tsHostname") : undefined,
    authMode,
    preset,
    desktopBackend: radio("desktopBackend") as DesktopBackend,
    desktopSize:
      radio("desktopSizePick") === "custom"
        ? text("desktopSizeCustom")
            .toLowerCase()
            .replace(/\s*[x×]\s*/, "x")
        : radio("desktopSizePick"),
    desktopScale: Number(radio("desktopScale")),
    primaryPort: preset === "vanilla" ? num("primaryPort") : undefined,
    primaryCommand: preset === "vanilla" ? text("primaryCommand") || undefined : undefined,
    rootlessDocker: checked("rootlessDocker"),
    sshKeys: text("sshKeys"),
    sshPort: mode === "tailscale" ? undefined : num("sshPort"),
    workspace:
      radio("workspaceKind") === "path"
        ? {
            kind: "path",
            path: text("workspacePath") && hostPathFor(text("workspacePath")),
            puid: num("puid") ?? 1000,
            pgid: num("pgid") ?? 1000,
          }
        : { kind: "volume" },
    home:
      radio("homeKind") === "path"
        ? {
            kind: "path",
            path: text("homePath") && hostPathFor(text("homePath")),
            puid: num("homeUid") ?? 1000,
            pgid: num("homeGid") ?? 1000,
          }
        : { kind: "volume" },
    timezone: text("timezone") || "UTC",
  };
  if (authMode === "google") {
    a.googleClientId = text("googleClientId");
  }
  if (authMode === "github") {
    a.githubClientId = text("githubClientId");
    a.githubUsers = text("githubUsers");
    a.githubOrg = text("githubOrg");
    a.githubTeam = text("githubTeam");
  }
  if (authMode === "google" || authMode === "github") {
    a.allowedEmails = text("allowedEmails");
    a.allowedEmailDomains = text("allowedEmailDomains");
  }
  if (authMode === "basic") a.gatewayUser = text("gatewayUser") || "dev";
  a.publicUrl = publicUrlFor({ ...a, publicUrl: behindProxy ? text("publicUrl") : "" });
  return a;
}

/** Fill the form from saved answers — agent-env.setup.json, or this page's own. */
function writeAnswers(a: Partial<Answers>): void {
  const set = (name: string, v: string | number | boolean | undefined | null) => {
    if (v === undefined || v === null) return;
    const input = el(name);
    if (input instanceof HTMLInputElement && input.type === "checkbox") {
      input.checked = Boolean(v);
    } else {
      input.value = String(v);
    }
    touched.add(name);
  };
  const pick = (name: string, v: string | undefined) => {
    if (!v) return;
    const input = form.querySelector<HTMLInputElement>(`input[name="${name}"][value="${v}"]`);
    if (input) input.checked = true;
    touched.add(name);
  };
  pick("mode", a.mode);
  pick("authMode", a.authMode);
  pick("preset", a.preset);
  pick("desktopBackend", a.desktopBackend);
  if (a.desktopSize) {
    const known = DESKTOP_SIZES.some((s) => s.value === a.desktopSize);
    set("desktopSizePick", known ? a.desktopSize : "custom");
    if (!known) set("desktopSizeCustom", a.desktopSize);
  }
  set("desktopScale", a.desktopScale);
  set("behindProxy", a.behindProxy);
  if (a.behindProxy) set("publicUrl", a.publicUrl);
  for (const k of [
    "domain",
    "httpsPort",
    "acmeEmail",
    "tsHostname",
    "googleClientId",
    "githubClientId",
    "githubUsers",
    "githubOrg",
    "githubTeam",
    "allowedEmails",
    "allowedEmailDomains",
    "gatewayUser",
    "primaryPort",
    "primaryCommand",
    "rootlessDocker",
    "sshKeys",
    "sshPort",
    "timezone",
  ] as const) {
    set(k, a[k]);
  }
  if (a.workspace) {
    pick("workspaceKind", a.workspace.kind);
    set("workspacePath", a.workspace.path);
    set("puid", a.workspace.puid);
    set("pgid", a.workspace.pgid);
  }
  if (a.home) {
    pick("homeKind", a.home.kind);
    set("homePath", a.home.path);
    set("homeUid", a.home.puid);
    set("homeGid", a.home.pgid);
  }
}

// ---------------------------------------------------------------------------
// Defaults that follow the mode, as the wizard's do
// ---------------------------------------------------------------------------

function applyModeDefaults(): void {
  const mode = radio("mode") as Mode;
  if (!touched.has("authMode")) {
    const auth = mode === "tailscale" ? "none" : mode === "caddy" ? "google" : "basic";
    form.querySelector<HTMLInputElement>(`input[name="authMode"][value="${auth}"]`)!.checked = true;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** `data-show="mode=caddy"`, `"authMode=google,github"`, `"behindProxy"`, `"preset=vanilla"`. */
function shown(rule: string): boolean {
  const negate = rule.startsWith("!");
  const body = negate ? rule.slice(1) : rule;
  const [name, values] = body.split("=");
  const result = values === undefined ? checked(name) : values.split(",").includes(radio(name));
  return negate ? !result : result;
}

function showProblems(problems: Problem[]): void {
  for (const e of form.querySelectorAll<HTMLElement>("[data-error]")) e.textContent = "";
  problemsBox.replaceChildren();
  problemsBox.hidden = problems.length === 0;
  if (!problems.length) return;
  const title = document.createElement("strong");
  title.textContent =
    problems.length === 1 ? "One thing to fix first" : `${problems.length} things to fix first`;
  const list = document.createElement("ul");
  for (const p of problems) {
    const slot = p.field ? form.querySelector<HTMLElement>(`[data-error="${p.field}"]`) : null;
    // An empty slot is display:none itself, so ask whether its section is
    // hidden rather than whether the slot is laid out.
    if (slot && !slot.closest("[hidden]")) slot.textContent = p.message;
    // A field-level message ("required") needs its question to make sense on
    // its own; the label beside the slot is that question.
    const label = slot?.closest("label")?.querySelector(":scope > span")?.textContent;
    const li = document.createElement("li");
    li.textContent = [
      label && !p.detail ? `${label.trim()}: ${p.message}` : p.message,
      ...(p.detail ?? []),
    ].join(" ");
    list.append(li);
  }
  problemsBox.append(title, list);
}

function showNextSteps(a: Answers, ok: boolean): void {
  const steps: string[] = [];
  if (ok) {
    if (a.authMode === "google" || a.authMode === "github") {
      const which = a.authMode === "google" ? "Google" : "GitHub";
      const key = a.authMode === "google" ? "GOOGLE_CLIENT_SECRET" : "GITHUB_CLIENT_SECRET";
      steps.push(`Put your ${which} client secret in .env (${key}).`);
      steps.push(`Register the redirect URI ${a.publicUrl}/oauth2/callback.`);
    }
    if (a.mode === "caddy") steps.push(`Point an A record for ${a.domain} at the host first.`);
    if (a.mode === "tailscale") {
      steps.push("Put a tagged, reusable Tailscale auth key in .env (TS_AUTHKEY).");
    }
    steps.push(
      "Docker Compose: save both files in one directory and run docker compose up -d. " +
        "Dockge or Dokploy: paste compose.yaml as the stack and .env into its environment.",
    );
    steps.push(`Then open ${a.publicUrl}.`);
  }
  next.replaceChildren(
    ...steps.map((s) => {
      const li = document.createElement("li");
      li.textContent = s;
      return li;
    }),
  );
}

function render(): void {
  for (const node of form.querySelectorAll<HTMLElement>("[data-show]")) {
    node.hidden = !shown(node.dataset.show!);
  }
  const answers = readAnswers();
  document.querySelector("#redirect-uri")!.textContent = `${answers.publicUrl}/oauth2/callback`;
  document.querySelector("#team-hint")!.textContent = text("githubOrg")
    ? "(slugs in that org, comma-separated)"
    : "(comma-separated, each one org:team)";

  const problems = validate(answers);
  showProblems(problems);
  showNextSteps(answers, problems.length === 0);
  // An invalid form has no files. Keeping the last valid ones would let Copy
  // and Download export a deployment that no longer matches the answers.
  files = {};
  if (problems.length === 0) {
    files = generate(answers, {
      existingEnv: el("existingEnv").value,
      randomSecret: stableSecret,
    });
    try {
      localStorage.setItem(STORAGE_KEY, files[ANSWERS_FILE]);
    } catch {
      // Private mode or blocked storage: the page works without it.
    }
  }
  for (const id of ["#copy", "#download"]) {
    document.querySelector<HTMLButtonElement>(id)!.disabled = problems.length > 0;
  }
  document.querySelector<HTMLElement>("#secrets-note")!.hidden =
    !restoredWithoutSecrets || el("existingEnv").value.trim() !== "";
  showFile();
}

function showFile(): void {
  for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.file === current));
  code.textContent = files[current] ?? "Fix the problems above to see this file.";
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

form.addEventListener("input", (e) => {
  const name = (e.target as HTMLInputElement).name;
  if (name) touched.add(name);
  if (name === "mode") applyModeDefaults();
  render();
});
form.addEventListener("submit", (e) => e.preventDefault());

for (const t of tabs) {
  t.addEventListener("click", () => {
    current = t.dataset.file!;
    showFile();
  });
}

document.querySelector("#copy")!.addEventListener("click", async (e) => {
  const button = e.currentTarget as HTMLButtonElement;
  await navigator.clipboard.writeText(files[current] ?? "");
  button.textContent = "Copied";
  setTimeout(() => (button.textContent = "Copy"), 1200);
});

document.querySelector("#download")!.addEventListener("click", () => {
  // Not text/plain: browsers append ".txt" to a name like ".env" for that.
  const blob = new Blob([files[current] ?? ""], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  // Some browsers drop a leading dot; "env" saved this way still needs renaming.
  a.download = current;
  a.click();
  // Revoked on the next tick, not now: some browsers start the download
  // asynchronously and would find the URL already gone.
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
});

document.querySelector("#regenerate")!.addEventListener("click", () => {
  minted = new Map();
  saveSecrets();
  render();
});

document.querySelector<HTMLInputElement>("#load-answers")!.addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    writeAnswers(JSON.parse(await file.text()) as Partial<Answers>);
  } catch {
    alert(`${file.name} is not an ${ANSWERS_FILE} this page can read.`);
  }
  render();
});

// The menus come from generate.ts, so the form and the wizard cannot drift apart.
const fill = (name: string, options: { value: string; label: string }[], chosen: string) => {
  const menu = form.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!;
  for (const o of options) menu.add(new Option(o.label, o.value));
  menu.value = chosen;
};
fill(
  "desktopSizePick",
  [...DESKTOP_SIZES, { value: "custom", label: "Something else…" }],
  DEFAULT_DESKTOP_SIZE,
);
fill(
  "desktopScale",
  DESKTOP_SCALES.map((s) => ({
    value: String(s),
    label: s === 100 ? "100% (normal)" : s === 200 ? "200% (HiDPI)" : `${s}%`,
  })),
  "100",
);

// Start from what this browser saw last, or from the wizard's own defaults.
el("timezone").value = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    writeAnswers(JSON.parse(saved) as Partial<Answers>);
    restoredWithoutSecrets = minted.size === 0;
  }
} catch {
  // Unreadable or unavailable: start fresh.
}
render();
