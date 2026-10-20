/**
 * The configurator's state: the form as a flat record of fields, turned into
 * generate.ts Answers the way the setup.ts wizard's collect() shapes them, plus
 * the sections the steps group those fields into. The rules — what is valid,
 * what each answer turns into — all live in generate.ts, so the two front ends
 * cannot disagree.
 */

import { useEffect, useMemo, useState } from "preact/hooks";
import {
  type Answers,
  answersFromCompose,
  ANSWERS_KEY,
  type AuthMode,
  DEFAULT_NAME,
  DESKTOP_SIZES,
  generate,
  LEGACY_ANSWERS_FILE,
  hostPathFor,
  type Mode,
  type DesktopBackend,
  type Preset,
  type Problem,
  publicUrlFor,
  randomSecret,
  validate,
  VERSION,
} from "../../generate.ts";

export const DEFAULT_FIELDS = {
  name: DEFAULT_NAME as string,
  mode: "local",
  behindProxy: false,
  publicUrl: "",
  domain: "",
  httpsPort: "8443",
  acmeEmail: "",
  tsHostname: "",
  authMode: "basic",
  googleClientId: "",
  githubClientId: "",
  githubUsers: "",
  githubOrg: "",
  githubTeam: "",
  allowedEmails: "",
  allowedEmailDomains: "",
  gatewayUser: "dev",
  preset: "vanilla",
  primaryPort: "3000",
  primaryCommand: "",
  desktopBackend: "novnc",
  desktopSizePick: "1920x1080",
  desktopSizeCustom: "",
  desktopScale: "100",
  rootlessDocker: false,
  sshKeys: "",
  sshPort: "2222",
  workspaceKind: "volume",
  workspacePath: "",
  puid: "1000",
  pgid: "1000",
  homeKind: "volume",
  homePath: "",
  homeUid: "1000",
  homeGid: "1000",
  timezone: "UTC",
  existingEnv: "",
};
export type Fields = typeof DEFAULT_FIELDS;
export type FieldName = keyof Fields;

/** The screenshots' starting point: a public deployment, half filled in. */
export const DEMO_FIELDS: Partial<Fields> = {
  mode: "caddy",
  domain: "agent.example.com",
  authMode: "google",
  googleClientId: "1234-abc.apps.googleusercontent.com",
  preset: "opencode",
  sshKeys: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample dtinth@laptop",
  timezone: "Asia/Bangkok",
};

const num = (v: string): number | undefined => (v.trim() === "" ? undefined : Number(v));

export function toAnswers(f: Fields): Answers {
  const mode = f.mode as Mode;
  const authMode = f.authMode as AuthMode;
  const preset = f.preset as Preset;
  const behindProxy = mode === "local" ? f.behindProxy : undefined;
  const a: Answers = {
    version: VERSION,
    name: f.name.trim() || DEFAULT_NAME,
    mode,
    behindProxy,
    publicUrl: "",
    domain: mode === "caddy" ? f.domain.trim() : undefined,
    httpsPort: mode === "caddy" ? num(f.httpsPort) : undefined,
    acmeEmail: mode === "caddy" ? f.acmeEmail.trim() : undefined,
    tsHostname: mode === "tailscale" ? f.tsHostname.trim() : undefined,
    authMode,
    preset,
    desktopBackend: f.desktopBackend as DesktopBackend,
    desktopSize:
      f.desktopSizePick === "custom"
        ? f.desktopSizeCustom
            .trim()
            .toLowerCase()
            .replace(/\s*[x×]\s*/, "x")
        : f.desktopSizePick,
    desktopScale: Number(f.desktopScale),
    primaryPort: preset === "vanilla" ? num(f.primaryPort) : undefined,
    primaryCommand: preset === "vanilla" ? f.primaryCommand.trim() || undefined : undefined,
    rootlessDocker: f.rootlessDocker,
    sshKeys: f.sshKeys.trim(),
    sshPort: mode === "tailscale" ? undefined : num(f.sshPort),
    workspace:
      f.workspaceKind === "path"
        ? {
            kind: "path",
            path: f.workspacePath.trim() && hostPathFor(f.workspacePath.trim()),
            puid: num(f.puid) ?? 1000,
            pgid: num(f.pgid) ?? 1000,
          }
        : { kind: "volume" },
    home:
      f.homeKind === "path"
        ? {
            kind: "path",
            path: f.homePath.trim() && hostPathFor(f.homePath.trim()),
            puid: num(f.homeUid) ?? 1000,
            pgid: num(f.homeGid) ?? 1000,
          }
        : { kind: "volume" },
    timezone: f.timezone.trim() || "UTC",
  };
  if (authMode === "google") a.googleClientId = f.googleClientId.trim();
  if (authMode === "github") {
    a.githubClientId = f.githubClientId.trim();
    a.githubUsers = f.githubUsers.trim();
    a.githubOrg = f.githubOrg.trim();
    a.githubTeam = f.githubTeam.trim();
  }
  if (authMode === "google" || authMode === "github") {
    a.allowedEmails = f.allowedEmails.trim();
    a.allowedEmailDomains = f.allowedEmailDomains.trim();
  }
  if (authMode === "basic") a.gatewayUser = f.gatewayUser.trim() || "dev";
  a.publicUrl = publicUrlFor({ ...a, publicUrl: behindProxy ? f.publicUrl.trim() : "" });
  return a;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export type SectionId = "where" | "who" | "runs" | "storage" | "files";

export interface Section {
  id: SectionId;
  title: string;
  /** Problems whose field is one of these belong to this section. */
  fields: string[];
  summary: (a: Answers) => string;
}

const MODE_LABEL: Record<Mode, string> = {
  local: "This machine",
  caddy: "Public domain",
  tailscale: "Tailnet",
};
const AUTH_LABEL: Record<AuthMode, string> = {
  google: "Google",
  github: "GitHub",
  basic: "Password",
  none: "No auth",
};
const count = (v: string | undefined) => (v ?? "").split(",").filter((x) => x.trim()).length;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export const SECTIONS: Section[] = [
  {
    id: "where",
    title: "Where",
    fields: ["name", "mode", "publicUrl", "domain", "httpsPort", "acmeEmail", "tsHostname"],
    summary: (a) =>
      `${a.name ?? DEFAULT_NAME} · ${MODE_LABEL[a.mode]} · ${a.publicUrl.replace(/^https?:\/\//, "")}`,
  },
  {
    id: "who",
    title: "Who",
    fields: [
      "authMode",
      "googleClientId",
      "githubClientId",
      "githubUsers",
      "githubOrg",
      "githubTeam",
      "allowedEmails",
      "allowedEmailDomains",
      "gatewayUser",
    ],
    summary: (a) => {
      if (a.authMode === "basic") return `Password · user ${a.gatewayUser}`;
      if (a.authMode === "none") return "No auth";
      const n =
        count(a.allowedEmails) +
        count(a.allowedEmailDomains) +
        count(a.githubUsers) +
        count(a.githubOrg) +
        count(a.githubTeam);
      return `${AUTH_LABEL[a.authMode]} · ${n ? plural(n, "rule") : "no allow list"}`;
    },
  },
  {
    id: "runs",
    title: "What runs",
    fields: [
      "preset",
      "primaryPort",
      "primaryCommand",
      "desktopBackend",
      "desktopSize",
      "desktopScale",
    ],
    summary: (a) =>
      [
        a.preset === "opencode" ? "OpenCode" : "Vanilla",
        `${a.desktopBackend === "selkies" ? "Selkies" : "noVNC"} ${a.desktopSize?.replace("x", "×")}`,
        a.rootlessDocker ? "Docker" : "",
      ]
        .filter(Boolean)
        .join(" · "),
  },
  {
    id: "storage",
    title: "Access & storage",
    fields: [
      "sshKeys",
      "sshPort",
      "workspacePath",
      "puid",
      "pgid",
      "homePath",
      "homeUid",
      "homeGid",
    ],
    summary: (a) => {
      const keys = a.sshKeys.split("\n").filter((l) => l.trim()).length;
      const vols = [a.workspace, a.home ?? { kind: "volume" }].filter(
        (w) => w.kind === "volume",
      ).length;
      return `${plural(keys, "SSH key")} · ${vols === 2 ? "2 volumes" : vols === 1 ? "1 volume, 1 bind" : "2 binds"}`;
    },
  },
];

/** How a problem names its field when it is shown away from the field itself. */
export const FIELD_LABELS: Record<string, string> = {
  name: "Environment name",
  publicUrl: "Public URL",
  domain: "Domain name",
  httpsPort: "HTTPS port",
  acmeEmail: "Let's Encrypt email",
  tsHostname: "MagicDNS name",
  googleClientId: "Google client ID",
  githubClientId: "GitHub client ID",
  githubTeam: "Allowed teams",
  primaryPort: "Primary port",
  primaryCommand: "Command",
  desktopBackend: "Desktop",
  desktopSize: "Screen size",
  desktopScale: "Text size",
  sshPort: "SSH port",
  workspacePath: "Workspace directory",
  puid: "Owner UID",
  pgid: "Owner GID",
  homePath: "Home directory",
  homeUid: "Owner UID",
  homeGid: "Owner GID",
};

export function sectionOf(p: Problem): SectionId | undefined {
  return SECTIONS.find((s) => p.field && s.fields.includes(p.field))?.id;
}

// ---------------------------------------------------------------------------
// The hook every layout uses
// ---------------------------------------------------------------------------

/**
 * Secrets are minted once per key and then held, so the password on screen
 * does not change with every keystroke, or with a reload of this tab. They are
 * kept in sessionStorage, not localStorage: a credential should not outlive
 * the visit on this machine. Across visits, importing the .env in use is the
 * way to keep them. Re-rolling clears this.
 */
const SECRETS_KEY = "agent-env-configurator:secrets";
const STORAGE_KEY = "agent-env-configurator:answers";

function loadSecrets(): Map<string, string> {
  try {
    return new Map(
      Object.entries(
        JSON.parse(sessionStorage.getItem(SECRETS_KEY) ?? "{}") as Record<string, string>,
      ),
    );
  } catch {
    return new Map();
  }
}
function saveSecrets(minted: Map<string, string>): void {
  try {
    sessionStorage.setItem(SECRETS_KEY, JSON.stringify(Object.fromEntries(minted)));
  } catch {
    // Blocked storage: secrets still hold for as long as the page is open.
  }
}

/** Saved answers, back into the form's fields: the inverse of `toAnswers`. */
export function fieldsFromAnswers(a: Partial<Answers>): Partial<Fields> {
  const f: Partial<Fields> = {};
  const str = (v: string | number | undefined) => (v === undefined ? undefined : String(v));
  const put = <K extends FieldName>(k: K, v: Fields[K] | undefined) => {
    if (v !== undefined && v !== null) f[k] = v;
  };
  put("name", a.name);
  put("mode", a.mode);
  put("behindProxy", a.behindProxy);
  if (a.behindProxy) put("publicUrl", a.publicUrl);
  put("domain", a.domain);
  put("httpsPort", str(a.httpsPort));
  put("acmeEmail", a.acmeEmail);
  put("tsHostname", a.tsHostname);
  put("authMode", a.authMode);
  put("googleClientId", a.googleClientId);
  put("githubClientId", a.githubClientId);
  put("githubUsers", a.githubUsers);
  put("githubOrg", a.githubOrg);
  put("githubTeam", a.githubTeam);
  put("allowedEmails", a.allowedEmails);
  put("allowedEmailDomains", a.allowedEmailDomains);
  put("gatewayUser", a.gatewayUser);
  put("preset", a.preset);
  put("primaryPort", str(a.primaryPort));
  put("primaryCommand", a.primaryCommand);
  put("desktopBackend", a.desktopBackend);
  if (a.desktopSize) {
    const known = DESKTOP_SIZES.some((s) => s.value === a.desktopSize);
    put("desktopSizePick", known ? a.desktopSize : "custom");
    if (!known) put("desktopSizeCustom", a.desktopSize);
  }
  put("desktopScale", str(a.desktopScale));
  put("rootlessDocker", a.rootlessDocker);
  put("sshKeys", a.sshKeys);
  put("sshPort", str(a.sshPort));
  put("timezone", a.timezone);
  if (a.workspace) {
    put("workspaceKind", a.workspace.kind);
    put("workspacePath", a.workspace.path);
    put("puid", str(a.workspace.puid));
    put("pgid", str(a.workspace.pgid));
  }
  if (a.home) {
    put("homeKind", a.home.kind);
    put("homePath", a.home.path);
    put("homeUid", str(a.home.puid));
    put("homeGid", str(a.home.pgid));
  }
  return f;
}

/**
 * The answers in what was pasted, or why there are none. An older deployment
 * keeps them in agent-env.setup.json rather than compose.yaml, and that file
 * is accepted in the same box, since it is the same thing to the person.
 */
export function readImport(text: string): { answers: Partial<Answers> | null } | { error: string } {
  // Nothing pasted: only the .env is being brought in, and the form stays as it is.
  if (!text.trim()) return { answers: null };
  const fromCompose = answersFromCompose(text);
  if (fromCompose) return { answers: fromCompose };
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v) && "mode" in v) {
      return { answers: v as Partial<Answers> };
    }
  } catch {
    // Not the legacy file either; say what was expected below.
  }
  return {
    error: `No ${ANSWERS_KEY} answers in this. Paste a compose.yaml made by this page or setup.ts, or the ${LEGACY_ANSWERS_FILE} an older version wrote beside it.`,
  };
}

export function nextSteps(a: Answers): string[] {
  const steps: string[] = [];
  if (a.authMode === "google" || a.authMode === "github") {
    const which = a.authMode === "google" ? "Google" : "GitHub";
    const key = a.authMode === "google" ? "GOOGLE_CLIENT_SECRET" : "GITHUB_CLIENT_SECRET";
    steps.push(`Put your ${which} client secret in .env (${key}).`);
    steps.push(`Register the redirect URI ${a.publicUrl}/oauth2/callback.`);
  }
  if (a.mode === "caddy") steps.push(`Point an A record for ${a.domain} at the host.`);
  if (a.mode === "tailscale")
    steps.push("Put a tagged, reusable Tailscale auth key in .env (TS_AUTHKEY).");
  steps.push("Save both files in one directory and run docker compose up -d.");
  steps.push(`Then open ${a.publicUrl}.`);
  return steps;
}

/** Where the form starts: this browser's last answers, or the wizard's defaults. */
function initialFields(): { fields: Fields; restored: boolean; chosen: boolean } {
  const base = {
    ...DEFAULT_FIELDS,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
  // ?demo and ?demo=ready start from a half-filled and a complete public
  // deployment, for screenshots; nothing is read from or saved to storage.
  const demo = new URLSearchParams(location.search).get("demo");
  if (demo !== null) {
    return {
      fields: {
        ...base,
        ...DEMO_FIELDS,
        ...(demo === "ready" ? { allowedEmailDomains: "example.com" } : {}),
      },
      restored: false,
      chosen: true,
    };
  }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      return {
        fields: { ...base, ...fieldsFromAnswers(JSON.parse(saved) as Partial<Answers>) },
        restored: true,
        chosen: true,
      };
    }
  } catch {
    // Unreadable or unavailable: start fresh.
  }
  return { fields: base, restored: false, chosen: false };
}

export function useConfigurator() {
  const [start] = useState(initialFields);
  const [fields, setFields] = useState<Fields>(start.fields);
  // Answers set on purpose, so the mode's default gate leaves them alone.
  const [touched] = useState(() => new Set<string>(start.chosen ? ["authMode"] : []));
  const [minted, setMinted] = useState(loadSecrets);
  // Answers came back from a previous visit, but the secrets beside them did
  // not. Decided once, before generate() mints any: from then on this tab has
  // secrets of its own, and they are still not the deployment's. It lasts
  // until that .env is imported or new secrets are chosen on purpose.
  const [missingSecrets, setMissingSecrets] = useState(
    () => start.restored && loadSecrets().size === 0,
  );

  const stableSecret = (bytes: number, key: string): string => {
    if (!minted.has(key)) {
      minted.set(key, randomSecret(bytes));
      saveSecrets(minted);
    }
    return minted.get(key)!;
  };
  const rerollSecrets = () => {
    const fresh = new Map<string, string>();
    saveSecrets(fresh);
    setMinted(fresh);
    setMissingSecrets(false);
  };
  const keepNewSecrets = () => setMissingSecrets(false);

  /**
   * Replace the answers with imported ones, if any were given, and keep the
   * secrets of the .env given. A .env on its own leaves the answers alone.
   */
  const importDeployment = (answers: Partial<Answers> | null, env: string) => {
    if (!answers) {
      setFields((f) => ({ ...f, existingEnv: env }));
      return;
    }
    touched.add("authMode");
    setFields((f) => ({
      ...DEFAULT_FIELDS,
      timezone: f.timezone,
      ...fieldsFromAnswers(answers),
      existingEnv: env,
    }));
  };

  const set = <K extends FieldName>(name: K, value: Fields[K]) => {
    touched.add(name);
    setFields((f) => {
      const next = { ...f, [name]: value };
      // As the wizard does: the mode decides the sensible gate until it is picked.
      if (name === "mode" && !touched.has("authMode")) {
        next.authMode = value === "tailscale" ? "none" : value === "caddy" ? "google" : "basic";
      }
      return next;
    });
  };

  const answers = useMemo(() => toAnswers(fields), [fields]);
  const problems = useMemo(() => validate(answers), [answers]);
  // An invalid form has no files. Keeping the last valid ones would let Copy
  // and Download export a deployment that no longer matches the answers.
  const files = useMemo(
    () =>
      problems.length
        ? null
        : generate(answers, { existingEnv: fields.existingEnv, randomSecret: stableSecret }),
    [answers, problems, fields.existingEnv, minted],
  );
  useEffect(() => {
    if (!files || new URLSearchParams(location.search).has("demo")) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(answers));
    } catch {
      // Private mode or blocked storage: the page works without it.
    }
  }, [files]);
  const errorFor = (field: string) => problems.find((p) => p.field === field)?.message;
  const problemsIn = (id: SectionId) => problems.filter((p) => sectionOf(p) === id);

  return {
    fields,
    set,
    answers,
    problems,
    files,
    errorFor,
    problemsIn,
    rerollSecrets,
    importDeployment,
    keepNewSecrets,
    restoredWithoutSecrets: missingSecrets && !fields.existingEnv.trim(),
  };
}
export type Configurator = ReturnType<typeof useConfigurator>;
