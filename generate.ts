/**
 * agent-env deployment generator — answers in, files out.
 *
 *   import { generate, validate } from "./generate.ts";
 *   const files = generate(answers, { existingEnv });
 *   // { ".env": "...", "compose.yaml": "...", "agent-env.setup.json": "..." }
 *
 * A pure function of its input: no filesystem, no prompts, no runtime APIs, no
 * imports — it runs unchanged in Node and in a browser. The same module backs
 * the setup.ts wizard and the web configurator in web/. The one source of variation is the secrets it mints when
 * `existingEnv` has none; pass `randomSecret` to make that deterministic too.
 *
 * The deployment is a compose.yaml and a .env and nothing else: sidecar
 * config is inlined in compose.yaml as `configs:` content, so the pair can be
 * pasted into Dockge, Dokploy, or any other tool that takes a compose stack.
 * The third file, agent-env.setup.json, is not deployed; it records the
 * answers so the next run can offer them as defaults.
 */

export const VERSION = 1;

export const PRESETS = ["opencode", "vanilla"] as const;
export type Preset = (typeof PRESETS)[number];
export const ANSWERS_FILE = "agent-env.setup.json";

export type Mode = "local" | "caddy" | "tailscale";
export type AuthMode = "google" | "github" | "basic" | "none";

export interface Workspace {
  kind: "volume" | "path";
  path?: string;
  puid?: number;
  pgid?: number;
}

export interface Answers {
  version: number;
  mode: Mode;
  behindProxy?: boolean;
  publicUrl: string;
  domain?: string;
  httpsPort?: number;
  acmeEmail?: string;
  tsHostname?: string;
  authMode: AuthMode;
  googleClientId?: string;
  githubClientId?: string;
  githubUsers?: string;
  githubOrg?: string;
  githubTeam?: string;
  allowedEmails?: string;
  allowedEmailDomains?: string;
  gatewayUser?: string;
  /** What the environment is for; see rootfs/opt/agent-env/presets. */
  preset: Preset;
  /** Where / goes when no preset server answers it (vanilla only). */
  primaryPort?: number;
  /** A command the container supervises at / (vanilla only). */
  primaryCommand?: string;
  rootlessDocker: boolean;
  sshKeys: string;
  sshPort?: number;
  workspace: Workspace;
  timezone: string;
}
// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * The entrypoint's `clean_list`, in TypeScript. An allow list decides whether
 * there is a gate at all, so what the wizard counts has to be what the
 * container will count: `", ,"` is a non-empty answer that describes nobody,
 * and treating it as an allow list writes a deployment the image then refuses
 * to start.
 */
export function cleanList(v: string | undefined): string {
  return (v ?? "")
    .split(",")
    .map((x) => x.replace(/\s+/g, ""))
    .filter((x) => x.length > 0)
    .join(",");
}

/**
 * Matches the entrypoint's own rand_secret: 32 random bytes, base64url,
 * unpadded. Web Crypto, so it runs in a browser as well as in Node.
 */
export function randomSecret(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * The image accepts 1/yes/on/enabled as well as true, but everything that reads
 * the generated config back compares against a literal. Emit only true/false,
 * so a value typed here cannot desynchronise a reader from the entrypoint.
 */
const bool = (v: boolean) => (v ? "true" : "false");

export interface EnvEntry {
  /** Unquoted, for reuse as a value. */
  value: string;
  /** Exactly as it was written, for carrying a line through untouched. */
  raw: string;
}

export function parseEnvFile(text: string): Record<string, EnvEntry> {
  const out: Record<string, EnvEntry> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2].trim();
    let value: string;
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length > 1) {
      value = raw.slice(1, -1).replace(/\\(.)/g, "$1");
    } else if (raw.startsWith("'") && raw.endsWith("'") && raw.length > 1) {
      value = raw.slice(1, -1);
    } else {
      // dotenv ends an unquoted value at an unescaped #. Reading past it made
      // a managed value come back different, so a rerun rewrote the password.
      value = raw.replace(/\s+#.*$/, "").trim();
    }
    out[m[1]] = { value, raw };
  }
  return out;
}

/**
 * dotenv treats an unquoted # as the start of a comment, so a value that
 * contains one — or leading/trailing space — has to be quoted or it is silently
 * truncated where the # begins.
 */
function envValue(v: string): string {
  // A backslash is an escape to dotenv even unquoted, so "pa\ss" comes back as
  // "pass" unless it is quoted and the backslash doubled.
  if (v === "" || (/^[^\s"'#\\$][^#\\$]*$/.test(v) && v === v.trim())) return v;
  // Compose expands $VAR in a double-quoted .env value; single quotes are literal.
  if (v.includes("$") && !v.includes("'")) return `'${v}'`;
  return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}
// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Something wrong with a set of answers, worded for a person to fix. */
export interface Problem {
  /** The answer at fault, as a key of the answers file, when there is one. */
  field?: string;
  /** One line: what is wrong. */
  message: string;
  /** Why it matters, and what to do instead. */
  detail?: string[];
}

const PORT = (v: string): string | null =>
  /^\d+$/.test(v) && +v > 0 && +v < 65536 ? null : "a port number";

/** Takes an answer as typed; returns why it is wrong, or null. */
type Check = (v: string) => string | null;

/** Per-answer format checks, shared by the wizard's prompts and `validate`. */
export const CHECKS: {
  publicUrl: Check;
  domain: Check;
  port: Check;
  acmeEmail: Check;
  tsHostname: Check;
  googleClientId: Check;
  githubTeam: (v: string, org: string | undefined) => string | null;
  workspacePath: Check;
} = {
  publicUrl(v: string): string | null {
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      return "needs to look like https://host or http://host:port";
    }
    if (!/^https?:$/.test(u.protocol)) return "http or https only";
    // Everything downstream appends to this, the redirect URI among it. A query
    // or fragment would be inherited by all of them.
    if (u.pathname !== "/" || u.search || u.hash) {
      return "just the origin — no path, query or fragment";
    }
    return null;
  },
  domain: (v: string): string | null =>
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(v)
      ? null
      : "a bare hostname, no scheme and no port",
  port: PORT,
  // Written into the Caddyfile as a directive argument, so the same class of
  // problem as the workspace path: anything outside an address could become
  // configuration.
  acmeEmail: (v: string): string | null =>
    /^[^\s<>"'{}\\]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)
      ? null
      : "an email address, or leave it blank",
  tsHostname: (v: string): string | null =>
    /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(v)
      ? null
      : "the machine's full tailnet name, like work.tail1234.ts.net",
  googleClientId: (v: string): string | null =>
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.apps\.googleusercontent\.com$/.test(v)
      ? null
      : "should look like 1234-abc.apps.googleusercontent.com",
  /**
   * The two forms are mutually exclusive, and oauth2-proxy matches either
   * literally: with an org set it compares each entry against the bare slug,
   * and with no org it compares against `org:team` and rejects anything else
   * outright. A deployment with the wrong shape starts happily and turns
   * everyone away, which is the worst way to find out.
   */
  githubTeam(v: string, org: string | undefined): string | null {
    const teams = cleanList(v).split(",").filter(Boolean);
    if (teams.length === 0) return null;
    if (org) {
      return teams.every((t) => !t.includes(":"))
        ? null
        : "with an organisation set, each team is a plain slug like platform";
    }
    return teams.every((t) => /^[^:]+:[^:]+$/.test(t))
      ? null
      : "without an organisation each team must be exactly org:team, like acme:platform";
  },
  // Quoting handles colons and hashes. A newline cannot be quoted into a
  // single scalar, and would become extra YAML inside the service.
  workspacePath: (v: string): string | null =>
    /[\n\r]/.test(v) ? "a path cannot contain a newline" : null,
};

/**
 * Compose reads a bare relative path as a named volume, and there is no such
 * volume, so it rejects the file. "./" is what was meant.
 */
export function hostPathFor(path: string): string {
  return path.startsWith("/") || path.startsWith(".") ? path : `./${path}`;
}

/** The URL people type, derived from the answers that decide it. */
export function publicUrlFor(
  a: Pick<Answers, "mode" | "behindProxy" | "publicUrl" | "domain" | "httpsPort" | "tsHostname">,
): string {
  if (a.mode === "caddy") {
    const port = a.httpsPort ?? 8443;
    return `https://${a.domain}${port === 443 ? "" : `:${port}`}`;
  }
  if (a.mode === "tailscale") return `https://${a.tsHostname}`;
  return a.behindProxy ? a.publicUrl : "http://localhost:8080";
}

/**
 * The one thing worth refusing outright. Everything in the container is
 * root-capable, and a public domain with no auth hands that to the internet.
 */
export function refusal(a: Pick<Answers, "mode" | "authMode">): Problem | null {
  if (a.authMode !== "none" || a.mode !== "caddy") return null;
  return {
    field: "authMode",
    message: "Refusing to generate that.",
    detail: [
      "A public domain with AUTH_MODE=none puts a root-capable shell on the internet.",
      "Pick Google or GitHub sign-in, or basic auth, or the tailnet mode.",
    ],
  };
}

/**
 * The image refuses to start an OAuth mode without an allow list, so catching
 * it here saves a deploy-time failure. Counted after cleaning, as it is there.
 */
export function allowListProblem(
  a: Pick<
    Answers,
    | "authMode"
    | "githubUsers"
    | "githubOrg"
    | "githubTeam"
    | "allowedEmails"
    | "allowedEmailDomains"
  >,
): Problem | null {
  const emails = [a.allowedEmails, a.allowedEmailDomains];
  if (a.authMode === "google" && !emails.some((v) => cleanList(v))) {
    return {
      field: "allowedEmails",
      message: "Google sign-in needs an allow list.",
      detail: [
        "Without one, any Google account on the internet could sign in, and",
        "the container refuses to start rather than let that happen.",
      ],
    };
  }
  // The image counts an email rule as an allow list for GitHub too.
  if (
    a.authMode === "github" &&
    ![a.githubUsers, a.githubOrg, a.githubTeam, ...emails].some((v) => cleanList(v))
  ) {
    return {
      field: "githubUsers",
      message: "GitHub sign-in needs an allow list.",
      detail: [
        "Give usernames, an org, teams, or an email rule. Without one, any",
        "GitHub account on the internet could sign in, and",
        "the container refuses to start rather than let that happen.",
      ],
    };
  }
  return null;
}

/**
 * Docker will happily accept two mappings on one host port and then fail to
 * bind at `up`. Nothing downstream catches it, so check it here.
 */
export function portClashProblem(
  a: Pick<Answers, "mode" | "behindProxy" | "publicUrl" | "sshPort">,
): Problem | null {
  const claims: [number, string][] = [];
  const claim = (port: number | undefined, what: string) => {
    if (port !== undefined) claims.push([port, what]);
  };
  const u = new URL(a.publicUrl);
  const extPort = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (a.mode === "local") {
    claim(a.behindProxy ? 8080 : extPort, "the gateway");
  }
  if (a.mode === "caddy") {
    claim(80, "ACME validation");
    claim(extPort, "the gateway, through caddy");
  }
  claim(a.sshPort, "SSH");
  const seen = new Map<number, string>();
  for (const [port, what] of claims) {
    const already = seen.get(port);
    if (already) {
      return {
        field: "sshPort",
        message: `Port ${port} is claimed twice.`,
        detail: [
          `${already} and ${what} would both bind it, and Docker cannot.`,
          "Pick a different port for one of them.",
        ],
      };
    }
    seen.set(port, what);
  }
  return null;
}

/**
 * Everything wrong with a complete set of answers, or an empty list. `generate`
 * refuses anything this reports, so a UI can call it first to show the
 * problems next to the fields they belong to.
 */
export function validate(a: Answers): Problem[] {
  const out: Problem[] = [];
  const field = (key: string, why: string | null) => {
    if (why) out.push({ field: key, message: why });
  };
  const required = (key: string, v: unknown) => {
    if (v === undefined || v === null || v === "") field(key, "required");
  };
  const port = (key: string, v: number | undefined) => {
    if (v !== undefined) field(key, PORT(String(v)));
  };

  if (!["local", "caddy", "tailscale"].includes(a.mode)) {
    field("mode", "expected one of local, caddy, tailscale");
    return out;
  }
  if (!["google", "github", "basic", "none"].includes(a.authMode)) {
    field("authMode", "expected one of google, github, basic, none");
    return out;
  }

  if (a.mode === "local" && a.behindProxy) {
    required("publicUrl", a.publicUrl);
    if (a.publicUrl) field("publicUrl", CHECKS.publicUrl(a.publicUrl));
  }
  if (a.mode === "caddy") {
    required("domain", a.domain);
    if (a.domain) field("domain", CHECKS.domain(a.domain));
    port("httpsPort", a.httpsPort);
    if (a.acmeEmail) field("acmeEmail", CHECKS.acmeEmail(a.acmeEmail));
  }
  if (a.mode === "tailscale") {
    required("tsHostname", a.tsHostname);
    if (a.tsHostname) field("tsHostname", CHECKS.tsHostname(a.tsHostname));
  }
  if (a.authMode === "google") {
    required("googleClientId", a.googleClientId);
    if (a.googleClientId) {
      field("googleClientId", CHECKS.googleClientId(a.googleClientId));
    }
  }
  if (a.authMode === "github") {
    required("githubClientId", a.githubClientId);
    if (a.githubTeam) {
      field("githubTeam", CHECKS.githubTeam(a.githubTeam, a.githubOrg));
    }
  }
  if (a.preset === "vanilla") port("primaryPort", a.primaryPort);
  if (a.primaryCommand) {
    if (a.preset !== "vanilla") {
      field(
        "primaryCommand",
        "only the vanilla preset takes one; the opencode preset runs its own server",
      );
    } else if (/[\r\n]/.test(a.primaryCommand)) {
      field("primaryCommand", "one line only");
    } else if (a.primaryCommand.includes("$") && a.primaryCommand.includes("'")) {
      // Compose expands $ in a .env value unless it is single-quoted, and a
      // single-quoted value cannot hold a '.
      field(
        "primaryCommand",
        "cannot contain both $ and ' — put the command in a script and run that",
      );
    }
  }
  port("sshPort", a.sshPort);
  if (a.workspace?.kind === "path") {
    // The entrypoint hands these to usermod/groupmod, which refuse anything
    // but a plain non-negative integer — and refusing stops the container.
    for (const [key, id] of [
      ["puid", a.workspace.puid],
      ["pgid", a.workspace.pgid],
    ] as const) {
      if (id !== undefined && !(Number.isInteger(id) && id >= 0)) {
        field(key, "a numeric user or group ID, like 1000");
      }
    }
    required("workspacePath", a.workspace.path);
    if (a.workspace.path) {
      field("workspacePath", CHECKS.workspacePath(a.workspace.path));
    }
  }
  // The cross-answer checks assume the answers they read are well-formed.
  if (out.length) return out;

  for (const p of [refusal(a), allowListProblem(a), portClashProblem(a)]) {
    if (p) out.push(p);
  }
  return out;
}

/** Thrown by `generate` for answers `validate` would report on. */
export class InvalidAnswers extends Error {
  readonly problems: Problem[];
  constructor(problems: Problem[]) {
    super(problems.map((p) => p.message).join("\n"));
    this.name = "InvalidAnswers";
    this.problems = problems;
  }
}
// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Keys belonging to a sidecar service, not to the agent-env container. */
const SIDECAR_KEYS = new Set(["TS_AUTHKEY"]);

/** What the image documents for mosh, and what the client is told to ask for. */
const MOSH_PORTS = "60000-60010:60000-60010/udp";

export interface RenderedEnv {
  text: string;
  /** Every key the file mentions, set or commented. */
  keys: string[];
}

export function renderEnv(
  a: Answers,
  keep: Record<string, EnvEntry>,
  rand: (bytes: number, key: string) => string = randomSecret,
): RenderedEnv {
  const L: string[] = [];
  const emitted = new Set<string>();
  /**
   * Keys this run has decided about, whether or not it wrote a line. Not the
   * same as `emitted`, which is also the compose passthrough list: a key that
   * was deliberately left out has no value to pass through, but it must not be
   * dragged back in by the carry-through pass either.
   */
  const decided = new Set<string>();
  const put = (k: string, v: string) => {
    emitted.add(k);
    L.push(`${k}=${envValue(v)}`);
  };
  /**
   * Reuse a value exactly as it was written. Never through put(): that renders
   * a value, and a rendered `"my secret"` becomes `"\"my secret\""` with the
   * quotes now part of the credential.
   */
  const carry = (k: string): boolean => {
    const existing = keep[k];
    if (!existing) return false;
    emitted.add(k);
    L.push(`${k}=${existing.raw}`);
    return true;
  };
  /** Reuse the existing line, or generate one when there is nothing. */
  const secret = (k: string, gen: () => string) => {
    if (!carry(k)) put(k, gen());
  };
  /**
   * An allow list, written the way the entrypoint will read it. Emitting the
   * raw answer would put `GITHUB_TEAM=,` in .env for an answer that describes
   * nobody — a key the image cleans away to nothing, left there to be puzzled
   * over. What was counted is what gets written.
   */
  const putList = (k: string, v: string | undefined) => {
    // Decided either way. Clearing an allow list has to actually clear it —
    // carrying the old one back from .env would leave the operator looking at
    // a file that still admits the account they just removed.
    decided.add(k);
    const cleaned = cleanList(v);
    if (cleaned) put(k, cleaned);
  };

  L.push("# Generated by setup.ts — safe to edit; re-running keeps your secrets.");
  L.push("# .env.example documents every key, including the ones not set here.");
  L.push("");
  L.push("# --- Where it lives ---");
  put("PUBLIC_URL", a.publicUrl);
  put("TZ", a.timezone);
  L.push("");

  // Every allow list is decided by this run, whichever sign-in is chosen. One
  // carried through from another mode would sit in .env and come back into
  // force the moment AUTH_MODE pointed at it again.
  for (const k of [
    "ALLOWED_EMAILS",
    "ALLOWED_EMAIL_DOMAINS",
    "GITHUB_USERS",
    "GITHUB_ORG",
    "GITHUB_TEAM",
  ]) {
    decided.add(k);
  }

  L.push("# --- Who gets in ---");
  put("AUTH_MODE", a.authMode);
  if (a.authMode === "google") {
    put("GOOGLE_CLIENT_ID", a.googleClientId ?? "");
    if (!carry("GOOGLE_CLIENT_SECRET")) {
      put("GOOGLE_CLIENT_SECRET", "CHANGEME-google-client-secret");
    }
    putList("ALLOWED_EMAILS", a.allowedEmails);
    putList("ALLOWED_EMAIL_DOMAINS", a.allowedEmailDomains);
    L.push("# Persisted so sessions survive a restart instead of silently rotating.");
    secret("OAUTH2_PROXY_COOKIE_SECRET", () => rand(32, "OAUTH2_PROXY_COOKIE_SECRET"));
  }
  if (a.authMode === "github") {
    put("GITHUB_CLIENT_ID", a.githubClientId ?? "");
    if (!carry("GITHUB_CLIENT_SECRET")) {
      put("GITHUB_CLIENT_SECRET", "CHANGEME-github-client-secret");
    }
    putList("GITHUB_USERS", a.githubUsers);
    putList("GITHUB_ORG", a.githubOrg);
    putList("GITHUB_TEAM", a.githubTeam);
    putList("ALLOWED_EMAILS", a.allowedEmails);
    putList("ALLOWED_EMAIL_DOMAINS", a.allowedEmailDomains);
    L.push("# Persisted so sessions survive a restart instead of silently rotating.");
    secret("OAUTH2_PROXY_COOKIE_SECRET", () => rand(32, "OAUTH2_PROXY_COOKIE_SECRET"));
  }
  if (a.authMode === "basic") {
    put("GATEWAY_USER", a.gatewayUser ?? "dev");
    secret("GATEWAY_PASSWORD", () => rand(18, "GATEWAY_PASSWORD"));
  }
  L.push("");

  L.push("# --- What lives at / ---");
  // Decided whether or not it is written: an old command left in .env would
  // keep running (vanilla) or stop the container starting (opencode).
  decided.add("PRIMARY_COMMAND");
  put("AGENT_ENV_PRESET", a.preset);
  if (a.preset === "vanilla") {
    put("PRIMARY_PORT", String(a.primaryPort ?? 3000));
    if (a.primaryCommand) put("PRIMARY_COMMAND", a.primaryCommand);
  }
  L.push("");

  L.push("# --- Services ---");
  put("DOCKER_ROOTLESS_ENABLE", bool(a.rootlessDocker));
  L.push("");

  L.push("# --- Access ---");
  // Decided either way: a key removed from the answers is revoked, not kept.
  decided.add("SSH_AUTHORIZED_KEYS");
  if (a.sshKeys) put("SSH_AUTHORIZED_KEYS", a.sshKeys);
  else L.push("# SSH_AUTHORIZED_KEYS=ssh-ed25519 AAAA... you@host");
  L.push("");

  L.push("# --- Model providers ---");
  L.push("# Or sign in interactively with /connect in the TUI; it persists on the home volume.");
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
    if (carry(k)) {
      // reused as written
    } else {
      emitted.add(k);
      L.push(`# ${k}=`);
    }
  }
  L.push("");

  if (a.workspace.kind === "path") {
    L.push("# --- Host filesystem ---");
    L.push("# Matches the owner of the directory mounted at /workspace.");
    put("PUID", String(a.workspace.puid ?? 1000));
    put("PGID", String(a.workspace.pgid ?? 1000));
    L.push("");
  }

  if (a.mode === "tailscale") {
    L.push("# --- Tailscale ---");
    L.push("# Tag the key and make it reusable, or an unattended restart after it");
    L.push("# expires (90 days at most) will fail to come back.");
    if (!carry("TS_AUTHKEY")) put("TS_AUTHKEY", "tskey-auth-CHANGEME");
    L.push("");
  }

  // Anything else already in .env is the operator's — another provider key, a
  // MISE_TOOLS list, a DESKTOP_RESOLUTION. This file is theirs to edit, and a
  // generator that silently drops what it does not recognise makes "re-run it"
  // advice you cannot follow.
  const carried = Object.keys(keep)
    .filter((k) => !emitted.has(k) && !decided.has(k))
    .sort();
  if (carried.length) {
    L.push("# --- Kept from your previous .env ---");
    // Carried through as written: re-quoting someone else's value is how a
    // trailing comment marker eats the rest of it.
    for (const k of carried) {
      emitted.add(k);
      L.push(`${k}=${keep[k].raw}`);
    }
    L.push("");
  }

  return { text: L.join("\n") + "\n", keys: [...emitted] };
}

/**
 * What the agent-env service passes through. Derived from the generated .env
 * rather than kept as a second list: compose reads .env only for interpolation,
 * so anything documented there but missing here would silently keep the image
 * default, which is a confusing way to lose a setting.
 */
function envPassthroughKeys(keys: string[]): string[] {
  return keys.filter((k) => !SIDECAR_KEYS.has(k));
}

/** A YAML double-quoted scalar. Paths are data, not syntax. */
function yamlString(v: string): string {
  return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export function renderCompose(a: Answers, envKeys: string[]): string {
  const gp = 8080;
  const pub = new URL(a.publicUrl);
  const extPort = pub.port ? Number(pub.port) : pub.protocol === "https:" ? 443 : 80;
  const L: string[] = [];

  L.push("# Generated by setup.ts. Re-run it to regenerate, or edit freely —");
  L.push("# a re-run offers your previous answers as the defaults.");
  L.push("#");
  L.push(`# Mode: ${a.mode}.  Reachable at ${a.publicUrl}`);
  L.push("");
  L.push("name: agent-env");
  L.push("");
  L.push("services:");
  L.push("  agent-env:");
  L.push("    image: ghcr.io/dtinth/agent-env:latest");
  L.push("    pull_policy: always");
  L.push("    restart: unless-stopped");
  L.push("");
  L.push("    environment:");
  for (const k of envPassthroughKeys(envKeys)) L.push(`      - ${k}`);
  L.push("");

  if (a.mode === "tailscale") {
    // Sharing the sidecar's network namespace means this service cannot declare
    // ports of its own — tailscale serve is the only way in, and SSH is reached
    // on the tailnet address directly.
    L.push("    # Shares the Tailscale container's network namespace, so it has no");
    L.push("    # ports of its own: `tailscale serve` is the way in, and SSH is");
    L.push("    # reachable on the tailnet address with nothing published.");
    L.push("    network_mode: service:tailscale");
    L.push("    depends_on:");
    L.push("      - tailscale");
  } else if (a.mode === "caddy") {
    L.push("    # HTTP is not published: the caddy service in front is the only");
    L.push("    # way in. SSH is raw TCP, which Caddy cannot proxy, so it is");
    L.push("    # published directly, or there would be no way in but the browser.");
    L.push("    expose:");
    L.push(`      - "${gp}"`);
    L.push("    ports:");
    L.push(`      - "${a.sshPort ?? 2222}:22"`);
    L.push("      # One UDP port per mosh session; ssh alone is not enough.");
    L.push(`      - "${MOSH_PORTS}"`);
  } else {
    // With a TLS terminator in front, PUBLIC_URL is the proxy's address and has
    // nothing to do with what this container binds — taking its port would make
    // the two fight over 443. Bind the gateway's own ports and let the proxy
    // forward to them.
    const hostPort = a.behindProxy ? gp : extPort;
    L.push(
      a.behindProxy
        ? "    # Bound to loopback for the proxy in front to forward to."
        : "    # Bound to loopback. Put your own proxy in front to expose it.",
    );
    L.push("    ports:");
    L.push(`      - "127.0.0.1:${hostPort}:${gp}"`);
    L.push(`      - "127.0.0.1:${a.sshPort ?? 2222}:22"`);
    L.push("      # mosh picks one UDP port per session out of this range.");
    L.push("      # Without it ssh connects and every mosh session times out.");
    L.push(`      - "127.0.0.1:${MOSH_PORTS}"`);
  }
  L.push("");

  L.push("    # Chromium needs more than the default 64 MB of /dev/shm.");
  L.push('    shm_size: "2gb"');
  L.push("");

  if (a.rootlessDocker) {
    L.push("    # DOCKER_ROOTLESS_ENABLE=true needs all five of these. The entrypoint");
    L.push("    # names any that are missing and leaves the daemon down.");
    L.push("    cap_add:");
    L.push("      - SYS_ADMIN # setuid newuidmap, to map the subuid range");
    L.push("    security_opt:");
    L.push("      - seccomp=unconfined # runc's per-container session keyring (keyctl)");
    L.push("      - apparmor=unconfined # docker-default denies mount; rootlesskit remounts /");
    L.push("      - systempaths=unconfined # writable /proc/sys, for net.ipv4.ip_forward");
    L.push("    devices:");
    L.push("      - /dev/net/tun # slirp4netns' tap device");
    L.push("");
  }

  L.push("    volumes:");
  if (a.workspace.kind === "path") {
    // Normalised here too, not only by the front ends: any caller of generate
    // gets a bind mount, never an undeclared named volume.
    L.push(`      - ${yamlString(`${hostPathFor(a.workspace.path ?? "")}:/workspace`)}`);
  } else {
    L.push("      - workspace:/workspace");
  }
  L.push("      # The whole home directory, so a tool the agent installs survives");
  L.push("      # being recreated on a new image.");
  L.push("      - home:/home/dev");
  L.push("      # Keeps the generated SSH host keys across image updates.");
  L.push("      - agent-env-state:/var/lib/agent-env");
  L.push("");

  if (a.mode === "caddy") {
    L.push("  caddy:");
    L.push("    image: caddy:2-alpine");
    L.push("    restart: unless-stopped");
    L.push("    ports:");
    L.push("      # ACME validates on 80 (HTTP-01) or 443 (TLS-ALPN-01) and nowhere");
    L.push("      # else, so this stays published even though the site is served on");
    L.push(`      # ${extPort}.`);
    L.push('      - "80:80"');
    L.push(`      - "${extPort}:${extPort}"`);
    L.push("    configs:");
    L.push("      - source: caddyfile");
    L.push("        target: /etc/caddy/Caddyfile");
    L.push("    volumes:");
    L.push("      # Without this every recreate re-issues the certificate and you");
    L.push("      # hit Let's Encrypt's duplicate-certificate limit.");
    L.push("      - caddy_data:/data");
    L.push("      - caddy_config:/config");
    L.push("");
  }

  if (a.mode === "tailscale") {
    L.push("  tailscale:");
    L.push("    image: tailscale/tailscale:stable");
    L.push("    hostname: " + (a.tsHostname ?? "agent-env").split(".")[0]);
    L.push("    restart: unless-stopped");
    L.push("    environment:");
    L.push("      - TS_AUTHKEY");
    L.push("      - TS_STATE_DIR=/var/lib/tailscale");
    L.push("      - TS_SERVE_CONFIG=/config/serve.json");
    L.push("      - TS_USERSPACE=false");
    L.push("    configs:");
    L.push("      - source: ts-serve");
    L.push("        target: /config/serve.json");
    L.push("    volumes:");
    L.push("      # Without persistent state every restart burns a fresh auth key.");
    L.push("      - ts-state:/var/lib/tailscale");
    L.push("    devices:");
    L.push("      - /dev/net/tun");
    L.push("    cap_add:");
    L.push("      - NET_ADMIN");
    L.push("");
  }

  // Sidecar configuration is inlined rather than written beside this file:
  // compose.yaml is then the whole deployment, which is what a stack UI like
  // Dockge or Dokploy expects to be handed, and there is no second file to
  // fall out of step with it.
  const configs: [string, string][] = [];
  if (a.mode === "caddy") configs.push(["caddyfile", renderCaddyfile(a)]);
  if (a.mode === "tailscale") configs.push(["ts-serve", renderTsServe(a)]);
  if (configs.length) {
    L.push("configs:");
    for (const [name, body] of configs) {
      L.push(`  ${name}:`);
      L.push("    content: |");
      for (const line of body.trimEnd().split("\n")) {
        // Compose interpolates ${...} inside content, so a literal $ is $$.
        L.push(line ? `      ${line.replace(/\$/g, "$$$$")}` : "");
      }
    }
    L.push("");
  }

  L.push("volumes:");
  if (a.workspace.kind !== "path") L.push("  workspace:");
  L.push("  home:");
  L.push("  agent-env-state:");
  if (a.mode === "caddy") {
    L.push("  caddy_data:");
    L.push("  caddy_config:");
  }
  if (a.mode === "tailscale") L.push("  ts-state:");
  return L.join("\n") + "\n";
}

export function renderCaddyfile(a: Answers): string {
  const pub = new URL(a.publicUrl);
  const extPort = pub.port ? Number(pub.port) : 443;
  const L: string[] = [];
  L.push("# Generated by setup.ts.");
  L.push("#");
  L.push("# This terminates TLS and nothing else. Authentication and the /~env/");
  L.push("# routing belong to the gateway inside the container, so they behave");
  L.push("# identically whether or not this config is in play.");
  if (a.acmeEmail) {
    L.push("");
    L.push("{");
    L.push(`\temail ${a.acmeEmail}`);
    L.push("}");
  }
  L.push("");
  L.push(`${a.domain}:${extPort} {`);
  L.push("\treverse_proxy agent-env:8080");
  L.push("}");
  return L.join("\n") + "\n";
}

export function renderTsServe(a: Answers): string {
  const port = 443;
  const cfg = {
    TCP: { [port]: { HTTPS: true } },
    Web: {
      [`${a.tsHostname}:${port}`]: {
        Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } },
      },
    },
  };
  return JSON.stringify(cfg, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  /**
   * The .env this deployment already has, as text. Secrets in it are kept
   * rather than regenerated, and keys this module does not manage are carried
   * through as written.
   */
  existingEnv?: string;
  /**
   * Mints a base64url secret from `bytes` random bytes, for the .env key named
   * `key`. Web Crypto by default. A UI that re-renders on every keystroke can
   * memoise by `key` so the secrets it shows hold still.
   */
  randomSecret?: (bytes: number, key: string) => string;
}

/**
 * Render a deployment. Returns file name → contents. Throws `InvalidAnswers`
 * for anything `validate` reports, rather than write a deployment the image
 * would refuse, or one that should not exist at all.
 */
export function generate(answers: Answers, options: GenerateOptions = {}): Record<string, string> {
  const problems = validate(answers);
  if (problems.length) throw new InvalidAnswers(problems);
  const env = renderEnv(
    answers,
    parseEnvFile(options.existingEnv ?? ""),
    options.randomSecret ?? randomSecret,
  );
  return {
    ".env": env.text,
    "compose.yaml": renderCompose(answers, env.keys),
    [ANSWERS_FILE]: JSON.stringify(answers, null, 2) + "\n",
  };
}
