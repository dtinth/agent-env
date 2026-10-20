/**
 * Shared state for the configurator prototypes: the form as a flat record of
 * fields, turned into generate.ts Answers exactly as web/main.ts does it, plus
 * the sections the layouts group those fields into.
 */

import { useMemo, useState } from "preact/hooks";
import {
  type Answers,
  type AuthMode,
  generate,
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
    fields: ["mode", "publicUrl", "domain", "httpsPort", "acmeEmail", "tsHostname"],
    summary: (a) => `${MODE_LABEL[a.mode]} · ${a.publicUrl.replace(/^https?:\/\//, "")}`,
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

const minted = new Map<string, string>();
const stableSecret = (bytes: number, key: string): string => {
  if (!minted.has(key)) minted.set(key, randomSecret(bytes));
  return minted.get(key)!;
};

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

export function useConfigurator() {
  const param = new URLSearchParams(location.search).get("demo");
  const demo = param !== null;
  const [fields, setFields] = useState<Fields>(() => ({
    ...DEFAULT_FIELDS,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    ...(demo ? DEMO_FIELDS : {}),
    // ?demo=ready fills in the one answer the demo leaves out, so files show.
    ...(param === "ready" ? { allowedEmailDomains: "example.com" } : {}),
  }));
  const [touched] = useState(() => new Set<string>(demo ? Object.keys(DEMO_FIELDS) : []));

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
  const files = useMemo(
    () =>
      problems.length
        ? null
        : generate(answers, { existingEnv: fields.existingEnv, randomSecret: stableSecret }),
    [answers, problems, fields.existingEnv],
  );
  const errorFor = (field: string) => problems.find((p) => p.field === field)?.message;
  const problemsIn = (id: SectionId) => problems.filter((p) => sectionOf(p) === id);

  return { fields, set, answers, problems, files, errorFor, problemsIn };
}
export type Configurator = ReturnType<typeof useConfigurator>;
