/**
 * agent-env deployment generator — answers in, files out.
 *
 *   import { generate, validate } from "./generate.ts";
 *   const files = generate(answers, { existingEnv });
 *   // { ".env": "...", "compose.yaml": "..." }
 *
 * A pure function of its input: no filesystem, no prompts, no runtime APIs, no
 * imports — it runs unchanged in Node and in a browser. The same module backs
 * the setup.ts wizard and the web configurator in web/. The one source of variation is the secrets it mints when
 * `existingEnv` has none; pass `randomSecret` to make that deterministic too.
 *
 * The deployment is a compose.yaml and a .env and nothing else: sidecar
 * config is inlined in compose.yaml as `configs:` content, so the pair can be
 * pasted into Dockge, Dokploy, or any other tool that takes a compose stack.
 * The answers themselves ride along in compose.yaml under `x-agent-env`, so
 * the next run can offer them as defaults; `answersFromCompose` reads them.
 */

/**
 * The answers' shape. 2 replaced `preset`, `desktopBackend` and
 * `rootlessDocker` with `components`; `migrateAnswers` reads the old shape.
 */
export const VERSION = 2;

/** The environment's name when none is given: the Compose project, and its hostname. */
export const DEFAULT_NAME = "agent-env";

/**
 * Whether a .env still lacks the OAuth client secret this sign-in needs: no
 * line for it, or the placeholder, quoted or not.
 */
export function needsClientSecret(authMode: AuthMode, env: string): boolean {
  const key = clientSecretKey(authMode);
  if (!key) return false;
  const v = parseEnvFile(env)[key]?.value.trim() ?? "";
  return v === "" || v.startsWith("CHANGEME");
}

/** Where a Google OAuth client is made; the configurators send people straight there. */
export const GOOGLE_CLIENT_CREATE_URL = "https://console.cloud.google.com/auth/clients/create";

/** The .env key holding the OAuth client secret for this sign-in, if it has one. */
export function clientSecretKey(authMode: AuthMode): string | undefined {
  return authMode === "google"
    ? "GOOGLE_CLIENT_SECRET"
    : authMode === "github"
      ? "GITHUB_CLIENT_SECRET"
      : undefined;
}

/**
 * The image's built-in components, in the order they are written to
 * AGENT_ENV_COMPONENTS. See docs/components.md.
 */
export const COMPONENTS = [
  "desktop",
  "desktop-selkies",
  "terminal",
  "files",
  "opencode",
  "docker",
  "smb",
] as const;
export type Component = (typeof COMPONENTS)[number];
/** What the image runs when AGENT_ENV_COMPONENTS is unset. */
export const DEFAULT_COMPONENTS: readonly Component[] = ["desktop", "terminal", "files"];
/** The two ways to serve the desktop. Both live at /~env/desktop, so one at most. */
export const DESKTOPS = ["desktop", "desktop-selkies"] as const;

export const isComponent = (v: unknown): v is Component =>
  typeof v === "string" && (COMPONENTS as readonly string[]).includes(v);

/** Known names, once each, in the canonical order. */
export function sortComponents(list: readonly string[]): Component[] {
  return COMPONENTS.filter((c) => list.includes(c));
}

/** The desktop component in the list, if there is one. */
export function desktopOf(list: readonly string[]): (typeof DESKTOPS)[number] | undefined {
  return DESKTOPS.find((d) => list.includes(d));
}

/**
 * Settings the image now refuses to start with, because AGENT_ENV_COMPONENTS
 * replaced them. Never written, and dropped from an existing .env.
 */
export const REMOVED_KEYS = [
  "AGENT_ENV_PRESET",
  "DESKTOP_ENABLE",
  "DESKTOP_BACKEND",
  "TTYD_ENABLE",
  "DUFS_ENABLE",
  "DOCKER_ROOTLESS_ENABLE",
] as const;

/** Answers as version 1 wrote them. Read by `migrateAnswers`, never written. */
export interface LegacyAnswers {
  preset?: string;
  desktopBackend?: string;
  rootlessDocker?: boolean;
}

/** How the image read a boolean setting; anything else was its default. */
const truthy = (v: string) => /^(1|true|yes|on|enabled)$/i.test(v.trim());
const falsy = (v: string) => /^(0|false|no|off|disabled)$/i.test(v.trim());

/**
 * The components an older deployment was running, from its version 1 answers
 * and the settings in its .env that replaced them. Answers that already have
 * `components` keep them, adjusted by any of those settings the .env still
 * has, since those are what the container was actually doing. With neither,
 * the answers come back as they were, and the defaults apply.
 */
export function migrateAnswers(
  prev: Partial<Answers> & LegacyAnswers,
  existingEnv = "",
): Partial<Answers> {
  const { preset, desktopBackend, rootlessDocker, ...rest } = prev;
  const env = parseEnvFile(existingEnv);
  const legacyEnv = REMOVED_KEYS.some((k) => k in env);
  const legacyAnswers =
    preset !== undefined || desktopBackend !== undefined || rootlessDocker !== undefined;
  if (!Array.isArray(rest.components) && !legacyAnswers && !legacyEnv) return rest;

  const list = new Set<string>(
    Array.isArray(rest.components) ? rest.components : DEFAULT_COMPONENTS,
  );
  const toggle = (c: Component, on: boolean | undefined) => {
    if (on === true) list.add(c);
    if (on === false) list.delete(c);
  };
  const selkies = (on: boolean) => {
    if (!desktopOf([...list])) return;
    list.delete("desktop");
    list.delete("desktop-selkies");
    list.add(on ? "desktop-selkies" : "desktop");
  };
  if (preset !== undefined) toggle("opencode", preset === "opencode");
  if (desktopBackend !== undefined) selkies(desktopBackend === "selkies");
  if (typeof rootlessDocker === "boolean") toggle("docker", rootlessDocker);

  const flag = (k: string): boolean | undefined => {
    const v = env[k]?.value;
    return v === undefined ? undefined : truthy(v) ? true : falsy(v) ? false : undefined;
  };
  if (env.AGENT_ENV_PRESET) toggle("opencode", env.AGENT_ENV_PRESET.value.trim() === "opencode");
  if (env.DESKTOP_BACKEND) selkies(env.DESKTOP_BACKEND.value.trim() === "selkies");
  if (flag("DESKTOP_ENABLE") === false) {
    list.delete("desktop");
    list.delete("desktop-selkies");
  }
  if (flag("TTYD_ENABLE") === false) list.delete("terminal");
  if (flag("DUFS_ENABLE") === false) list.delete("files");
  toggle("docker", flag("DOCKER_ROOTLESS_ENABLE"));
  return { ...rest, components: sortComponents([...list]) };
}

export const DEFAULT_DESKTOP_SIZE = "1920x1080";
/** Sizes the forms offer by name; any other WxH is a custom size. */
export const DESKTOP_SIZES = [
  { value: "1280x720", label: "1280 × 720 (HD)" },
  { value: "1920x1080", label: "1920 × 1080 (Full HD)" },
  { value: "2560x1440", label: "2560 × 1440 (QHD)" },
  { value: "3840x2160", label: "3840 × 2160 (4K)" },
] as const;
/** Text and UI size as a percentage; 100 is 96 DPI. */
export const DESKTOP_SCALES = [100, 125, 150, 200, 300] as const;

/** The DPI a scale percentage means. */
export function dpiFor(scale: number): number {
  return Math.round((96 * scale) / 100);
}
/** The top-level key in compose.yaml that records the answers it was made from. */
export const ANSWERS_KEY = "x-agent-env";

/** Where the startup script lands: the image runs what is in provision.d at every start. */
export const STARTUP_SCRIPT_TARGET = "/etc/agent-env/provision.d/10-startup";

/** The script as it is written out: Unix line ends, no blank lines around it; "" for none. */
export function startupScriptBody(a: Pick<Answers, "startupScript">): string {
  return (a.startupScript ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^([ \t]*\n)+/, "")
    .trimEnd();
}

/**
 * Where the answers lived before they moved into compose.yaml. Read, never
 * written, so a deployment made by an older version still upgrades.
 */
export const LEGACY_ANSWERS_FILE = "agent-env.setup.json";

/**
 * Where it runs. "none" publishes nothing: a platform such as Dokploy or
 * Coolify routes to the container itself, so ports would only get in its way.
 */
export type Mode = "local" | "caddy" | "tailscale" | "wireguard" | "none";
export type AuthMode = "google" | "github" | "basic" | "none";

export interface Workspace {
  kind: "volume" | "path";
  path?: string;
  puid?: number;
  pgid?: number;
}

/**
 * A WireGuard peer: a device that dials in. Only its public key and tunnel
 * address are kept — the private key lives in the client's own config and is
 * never stored on the server side, which is how WireGuard is meant to work.
 */
export interface WireguardPeer {
  /** A label for the peer, and the basename of its generated .conf. */
  name: string;
  /** The peer's base64 public key, listed in the server's wg0.conf. */
  publicKey: string;
  /** The peer's address inside the tunnel, like 10.8.0.2. */
  address: string;
}

/**
 * WireGuard deployment settings. All of this is public: the server's private
 * key is the one secret, and it lives in .env as WG_PRIVATE_KEY, not here.
 * The front ends generate the keys; `generate` only formats them.
 */
export interface Wireguard {
  /** What peers dial — the host's public address and the published UDP port,
   *  like 203.0.113.7:51820 or vps.example.com:51820. */
  endpoint: string;
  /** The UDP port the sidecar listens on and compose publishes. */
  listenPort: number;
  /** The server's own address inside the tunnel, with its prefix, like
   *  10.8.0.1/24. A peer reaches the gateway at this host over the tunnel. */
  address: string;
  /** The server's base64 public key, written into every client config.
   *  Derived from WG_PRIVATE_KEY by the front end. */
  serverPublicKey: string;
  peers: WireguardPeer[];
}

export interface Answers {
  version: number;
  /**
   * The Compose project name, and the container's hostname outside Tailscale;
   * absent means agent-env. Two deployments with the same name are one project
   * to Compose, so the second would take over the first.
   */
  name?: string;
  mode: Mode;
  behindProxy?: boolean;
  publicUrl: string;
  domain?: string;
  httpsPort?: number;
  acmeEmail?: string;
  tsHostname?: string;
  /** Present only in wireguard mode; the keys in it are generated by the front ends. */
  wireguard?: Wireguard;
  authMode: AuthMode;
  googleClientId?: string;
  githubClientId?: string;
  githubUsers?: string;
  githubOrg?: string;
  githubTeam?: string;
  allowedEmails?: string;
  allowedEmailDomains?: string;
  gatewayUser?: string;
  /** The built-in components to run, in COMPONENTS order; see docs/components.md. */
  components: Component[];
  /** Where / goes when opencode is not running. */
  primaryPort?: number;
  /** A command the container supervises at /, when opencode is not running. */
  primaryCommand?: string;
  /** Virtual screen size as "WxH"; absent means 1920x1080. */
  desktopSize?: string;
  /** Text and UI size in percent (100 = 96 DPI); absent means 100. */
  desktopScale?: number;
  /** Memory limit in GiB for the agent-env container; absent means none. */
  memoryGiB?: number;
  /**
   * Swap allowed on top of memoryGiB, in GiB. Absent leaves it to Docker, which
   * allows as much again as the memory limit when the host has swap; 0 is none.
   */
  swapGiB?: number;
  /** CPUs the container may use, like 2.5; absent means all of them. */
  cpus?: number;
  /**
   * A bash script run as dev on every start, before any component; absent
   * means none. It is how components of your own get installed.
   */
  startupScript?: string;
  sshKeys: string;
  sshPort?: number;
  workspace: Workspace;
  /** Where /home/dev lives; a Docker volume when absent. */
  home?: Workspace;
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

/** A plain decimal within bounds; Compose and the kernel take nothing fancier. */
const amount =
  (min: number, max: number, what: string) =>
  (v: string): string | null =>
    /^\d+(\.\d{1,2})?$/.test(v) && +v >= min && +v <= max ? null : what;

/** Takes an answer as typed; returns why it is wrong, or null. */
type Check = (v: string) => string | null;

/** Per-answer format checks, shared by the wizard's prompts and `validate`. */
export const CHECKS: {
  name: Check;
  publicUrl: Check;
  domain: Check;
  port: Check;
  acmeEmail: Check;
  tsHostname: Check;
  wgEndpoint: Check;
  wgAddress: Check;
  wgPeerName: Check;
  googleClientId: Check;
  githubTeam: (v: string, org: string | undefined) => string | null;
  workspacePath: Check;
  memoryGiB: Check;
  swapGiB: Check;
  cpus: Check;
} = {
  // Below 1 GiB the desktop and Chromium do not fit beside /dev/shm, which is
  // charged to the same limit once used.
  memoryGiB: amount(1, 4096, "GiB of memory, at least 1, like 8 or 1.5"),
  swapGiB: amount(0, 4096, "GiB of swap, like 4, or 0 for none"),
  cpus: amount(0.01, 1024, "a number of CPUs, like 2 or 0.5"),
  // A Compose project name may have underscores and a hostname may not, so the
  // name is held to what both accept.
  name: (v: string): string | null =>
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(v)
      ? null
      : "lowercase letters, digits and hyphens, like agent-env or work-2",
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
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(v) || isIPv4(v)
      ? null
      : "a bare hostname or IPv4 address, no scheme and no port",
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
  // What a peer dials: the host's public address and the published UDP port.
  // The host becomes the Endpoint in every client config, so it is held to an
  // address, the same class of concern as the ACME email and workspace path.
  wgEndpoint: (v: string): string | null => {
    const m = /^(.+):(\d{1,5})$/.exec(v.trim());
    if (!m) return "host:port, like 203.0.113.7:51820 or vps.example.com:51820";
    const [, host, port] = m;
    if (PORT(port)) return "the port must be 1–65535, like 51820";
    const isName = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(host);
    return isIPv4(host) || isName ? null : "the host must be a domain or IPv4 address";
  },
  // The server's own tunnel address, with its prefix. Private ranges are the
  // norm, but any IPv4/prefix is accepted — it is the operator's tunnel to number.
  wgAddress: (v: string): string | null => {
    const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(v.trim());
    return m && isIPv4(m[1]) && +m[2] >= 8 && +m[2] <= 32
      ? null
      : "an IPv4 address with a prefix, like 10.8.0.1/24";
  },
  // A peer label: it becomes an [Interface] comment and the basename of the
  // peer's .conf, so it stays to characters safe in both.
  wgPeerName: (v: string): string | null =>
    /^[a-z0-9][a-z0-9_-]*$/i.test(v.trim())
      ? null
      : "a short label of letters, digits, dashes or underscores, like laptop or phone-2",
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
 * A dotted-quad IPv4 address. Let's Encrypt certifies those, but only on its
 * six-day shortlived profile, so a public domain that is an address needs
 * Caddy to ask for that profile.
 */
export function isIPv4(v: string): boolean {
  const parts = v.split(".");
  return (
    parts.length === 4 && parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255)
  );
}

/**
 * Compose reads a bare relative path as a named volume, and there is no such
 * volume, so it rejects the file. "./" is what was meant.
 */
export function hostPathFor(path: string): string {
  return path.startsWith("/") || path.startsWith(".") ? path : `./${path}`;
}

/** The URL people type, derived from the answers that decide it. */
export function publicUrlFor(
  a: Pick<
    Answers,
    "mode" | "behindProxy" | "publicUrl" | "domain" | "httpsPort" | "tsHostname" | "wireguard"
  >,
): string {
  if (a.mode === "caddy") {
    const port = a.httpsPort ?? 443;
    return `https://${a.domain}${port === 443 ? "" : `:${port}`}`;
  }
  if (a.mode === "tailscale") return `https://${a.tsHostname}`;
  // The tunnel is the boundary and carries the encryption, so the gateway is
  // plain HTTP on its own port, reached at the server's address inside the
  // tunnel. No TLS, no published web port — only the WireGuard UDP port is open.
  if (a.mode === "wireguard") return `http://${wgServerHost(a.wireguard)}:8080`;
  if (a.mode === "none") return a.publicUrl;
  return a.behindProxy ? a.publicUrl : "http://localhost:8080";
}

/** The server's tunnel address without its prefix, for the URL a peer uses. */
export function wgServerHost(wg: Wireguard | undefined): string {
  return (wg?.address ?? "").split("/")[0];
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
      "Pick Google or GitHub sign-in, or basic auth, or a tunnel mode (tailnet or WireGuard).",
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
    claim(extPort, "the gateway over TLS");
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

  if (!["local", "caddy", "tailscale", "wireguard", "none"].includes(a.mode)) {
    field("mode", "expected one of local, caddy, tailscale, wireguard, none");
    return out;
  }
  if (!["google", "github", "basic", "none"].includes(a.authMode)) {
    field("authMode", "expected one of google, github, basic, none");
    return out;
  }

  if (a.name !== undefined) field("name", CHECKS.name(a.name));
  if (a.memoryGiB !== undefined) field("memoryGiB", CHECKS.memoryGiB(String(a.memoryGiB)));
  if (a.swapGiB !== undefined) {
    field("swapGiB", CHECKS.swapGiB(String(a.swapGiB)));
    // Docker counts swap as memory + swap, so without a memory limit there is
    // nothing for it to be on top of.
    if (a.memoryGiB === undefined) field("swapGiB", "needs a memory limit to go with it");
  }
  if (a.cpus !== undefined) field("cpus", CHECKS.cpus(String(a.cpus)));
  if ((a.mode === "local" && a.behindProxy) || a.mode === "none") {
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
  if (a.mode === "wireguard") {
    const wg = a.wireguard;
    if (!wg) {
      field("wireguard", "required");
    } else {
      required("wgEndpoint", wg.endpoint);
      if (wg.endpoint) field("wgEndpoint", CHECKS.wgEndpoint(wg.endpoint));
      port("wgListenPort", wg.listenPort);
      required("wgAddress", wg.address);
      if (wg.address) field("wgAddress", CHECKS.wgAddress(wg.address));
      required("wgServerPublicKey", wg.serverPublicKey);
      // Peers are optional — a server with none is a valid starting point, and
      // the operator adds devices by re-running. Each one that is there must be
      // well-formed and must not collide with the server or another peer.
      const seenNames = new Set<string>();
      const seenAddrs = new Set<string>([wgServerHost(wg)]);
      for (const [i, p] of (wg.peers ?? []).entries()) {
        const where = `wgPeers[${i}]`;
        field(where, CHECKS.wgPeerName(p.name ?? ""));
        if (!p.publicKey) field(where, `peer ${p.name || i} has no public key`);
        if (!isIPv4(p.address ?? "")) {
          field(where, `peer ${p.name || i} needs a tunnel address, like 10.8.0.2`);
        }
        const key = (p.name ?? "").trim().toLowerCase();
        if (seenNames.has(key)) field(where, `two peers are both named ${p.name}`);
        seenNames.add(key);
        if (seenAddrs.has(p.address)) field(where, `${p.address} is used by more than one peer`);
        seenAddrs.add(p.address);
      }
    }
  }
  if (a.authMode === "google") {
    // Google's redirect URI rules: "Hosts cannot be raw IP addresses."
    if (a.mode === "caddy" && a.domain && isIPv4(a.domain)) {
      field(
        "domain",
        `Google sign-in refuses an IP address in its redirect URI. Use a name for it, like ${a.domain.replace(/\./g, "-")}.sslip.io, or GitHub or password sign-in`,
      );
    }
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
  const components: unknown[] = Array.isArray(a.components) ? a.components : [];
  const has = (c: Component) => components.includes(c);
  const unknown = components.filter((c) => !isComponent(c));
  if (!Array.isArray(a.components)) {
    field("components", "a list of components, like desktop, terminal, files");
  } else if (unknown.length) {
    field(
      "components",
      `unknown component ${unknown.map((c) => JSON.stringify(c)).join(", ")}; the built-in ones are ${COMPONENTS.join(", ")}`,
    );
  } else if (has("desktop") && has("desktop-selkies")) {
    field("components", "pick one desktop: desktop and desktop-selkies both live at /~env/desktop");
  } else if (has("desktop-selkies")) {
    // Selkies' page refuses to start outside a secure context: https, or
    // localhost. noVNC has no such rule, so this is the one place to say so.
    const url = publicUrlFor(a);
    if (
      !url.startsWith("https://") &&
      !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url)
    ) {
      field(
        "components",
        "Selkies needs https or localhost; this URL is plain http on another host. Use noVNC, or serve it over https.",
      );
    }
  }
  if (a.desktopSize !== undefined) {
    const m = /^(\d{3,5})x(\d{3,5})$/.exec(a.desktopSize);
    if (!m) {
      field("desktopSize", "write it as width × height, like 1920x1080");
    } else if (+m[1] < 640 || +m[1] > 7680 || +m[2] < 480 || +m[2] > 4320) {
      field("desktopSize", "between 640×480 and 7680×4320");
    }
  }
  if (a.desktopScale !== undefined) {
    if (!Number.isInteger(a.desktopScale) || a.desktopScale < 100 || a.desktopScale > 400) {
      field("desktopScale", "a whole percentage from 100 to 400");
    }
  }
  if (!has("opencode")) port("primaryPort", a.primaryPort);
  if (a.primaryCommand) {
    if (has("opencode")) {
      field("primaryCommand", "OpenCode is at /, so there is no command to run there");
    } else if (/[\r\n]/.test(a.primaryCommand)) {
      field("primaryCommand", "one line only");
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
  if (a.home?.kind === "path") {
    required("homePath", a.home.path);
    if (a.home.path) field("homePath", CHECKS.workspacePath(a.home.path));
    if (a.workspace?.kind !== "path") {
      for (const [key, id] of [
        ["homeUid", a.home.puid],
        ["homeGid", a.home.pgid],
      ] as const) {
        if (id !== undefined && !(Number.isInteger(id) && id >= 0)) {
          field(key, "a numeric user or group ID, like 1000");
        }
      }
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
const SIDECAR_KEYS = new Set(["TS_AUTHKEY", "WG_PRIVATE_KEY"]);

/** What the image documents for mosh, and what the client is told to ask for. */
const MOSH_PORTS = "60000-60010:60000-60010/udp";

export interface RenderedEnv {
  text: string;
  /**
   * Keys the .env sets and the container passes through by name: the secrets,
   * and anything the operator added themselves.
   */
  keys: string[];
  /** Everything else, hardcoded into compose.yaml as KEY=value. */
  settings: [string, string][];
  /**
   * Secrets the operator must supply: the deployment cannot work without them,
   * and no placeholder is written for them. compose.yaml passes each as
   * `${KEY:?}` so `docker compose up` refuses to start until it is set, rather
   * than booting with a CHANGEME value that only fails later and less clearly.
   */
  required: string[];
}

/**
 * An authorized_keys file as the entrypoint wants it in SSH_AUTHORIZED_KEYS:
 * one key per line. Blank lines and comments are dropped, and the old
 * semicolon-separated form still reads as several keys.
 */
export function normaliseSshKeys(v: string | undefined): string {
  return (v ?? "")
    .split(/[\r\n;]+/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .join("\n");
}

export function renderEnv(
  a: Answers,
  keep: Record<string, EnvEntry>,
  rand: (bytes: number, key: string) => string = randomSecret,
): RenderedEnv {
  const L: string[] = [];
  const emitted = new Set<string>();
  /**
   * Non-secret settings. They live in compose.yaml, so .env stays a file of
   * secrets that can be pasted into a secret store without sifting.
   */
  const settings: [string, string][] = [];
  /**
   * Keys this run has decided about, whether or not it wrote a line. Not the
   * same as `emitted`, which is also the compose passthrough list: a key that
   * was deliberately left out has no value to pass through, but it must not be
   * dragged back in by the carry-through pass either.
   */
  const decided = new Set<string>();
  /** Required secrets this config needs; see RenderedEnv.required. */
  const required: string[] = [];
  const set = (k: string, v: string) => {
    decided.add(k);
    settings.push([k, v]);
  };
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
   * A secret only the operator can supply. Its existing value is kept; when
   * there is none, no placeholder is written — compose enforces it with
   * `${KEY:?}` so `up` fails loudly rather than the image booting with a
   * CHANGEME value that looks real. A commented, uncomment-ready line is left as
   * a reminder of where it goes.
   */
  const requireSecret = (k: string) => {
    decided.add(k);
    required.push(k);
    if (!carry(k)) {
      L.push(`# ${k}=  # required — docker compose up refuses to start until you set this`);
    }
  };
  /**
   * An allow list, written the way the entrypoint will read it. Emitting the
   * raw answer would put `GITHUB_TEAM=,` in compose.yaml for an answer that
   * describes nobody — a key the image cleans away to nothing, left there to
   * be puzzled over. What was counted is what gets written.
   */
  const setList = (k: string, v: string | undefined) => {
    // Decided either way. Clearing an allow list has to actually clear it —
    // carrying the old one back from .env would leave the operator looking at
    // a file that still admits the account they just removed.
    decided.add(k);
    const cleaned = cleanList(v);
    if (cleaned) set(k, cleaned);
  };

  // Every key that now lives in compose.yaml is decided by this run, so a
  // .env from before the split cannot carry a stale copy back in — the .env
  // value would win over nothing, but sit there contradicting the compose file.
  for (const k of [
    "PUBLIC_URL",
    "TZ",
    "AUTH_MODE",
    "GOOGLE_CLIENT_ID",
    "GITHUB_CLIENT_ID",
    "GATEWAY_USER",
    "GATEWAY_TLS_DOMAIN",
    "ACME_EMAIL",
    "AGENT_ENV_COMPONENTS",
    "PRIMARY_PORT",
    "PRIMARY_COMMAND",
    // The image refuses to start with any of these, so an old .env loses them.
    ...REMOVED_KEYS,
    "SSH_AUTHORIZED_KEYS",
    "PUID",
    "PGID",
    "ALLOWED_EMAILS",
    "ALLOWED_EMAIL_DOMAINS",
    "GITHUB_USERS",
    "GITHUB_ORG",
    "GITHUB_TEAM",
  ]) {
    decided.add(k);
  }

  L.push("# Secrets only. Everything else is in compose.yaml.");
  L.push("# Generated by setup.ts — safe to edit; re-running keeps your secrets.");
  L.push("");

  set("PUBLIC_URL", a.publicUrl);
  set("TZ", a.timezone);
  set("AUTH_MODE", a.authMode);
  if (a.authMode === "google") {
    set("GOOGLE_CLIENT_ID", a.googleClientId ?? "");
    requireSecret("GOOGLE_CLIENT_SECRET");
    setList("ALLOWED_EMAILS", a.allowedEmails);
    setList("ALLOWED_EMAIL_DOMAINS", a.allowedEmailDomains);
    L.push("# Persisted so sessions survive a restart instead of silently rotating.");
    secret("OAUTH2_PROXY_COOKIE_SECRET", () => rand(32, "OAUTH2_PROXY_COOKIE_SECRET"));
  }
  if (a.authMode === "github") {
    set("GITHUB_CLIENT_ID", a.githubClientId ?? "");
    requireSecret("GITHUB_CLIENT_SECRET");
    setList("GITHUB_USERS", a.githubUsers);
    setList("GITHUB_ORG", a.githubOrg);
    setList("GITHUB_TEAM", a.githubTeam);
    setList("ALLOWED_EMAILS", a.allowedEmails);
    setList("ALLOWED_EMAIL_DOMAINS", a.allowedEmailDomains);
    L.push("# Persisted so sessions survive a restart instead of silently rotating.");
    secret("OAUTH2_PROXY_COOKIE_SECRET", () => rand(32, "OAUTH2_PROXY_COOKIE_SECRET"));
  }
  if (a.authMode === "basic") {
    set("GATEWAY_USER", a.gatewayUser ?? "dev");
    secret("GATEWAY_PASSWORD", () => rand(18, "GATEWAY_PASSWORD"));
  }

  // Always written, even when it is the image's default: the list is the
  // whole answer, and leaving it unset would hand it to whatever a later
  // image's default turns out to be.
  set("AGENT_ENV_COMPONENTS", sortComponents(a.components).join(","));
  if (desktopOf(a.components)) {
    if (a.desktopSize && a.desktopSize !== DEFAULT_DESKTOP_SIZE) {
      set("DESKTOP_RESOLUTION", `${a.desktopSize}x24`);
    }
    if (a.desktopScale && a.desktopScale !== 100) {
      set("DESKTOP_DPI", String(dpiFor(a.desktopScale)));
    }
  }
  if (!a.components.includes("opencode")) {
    set("PRIMARY_PORT", String(a.primaryPort ?? 3000));
    if (a.primaryCommand) set("PRIMARY_COMMAND", a.primaryCommand);
  }
  const ssh = normaliseSshKeys(a.sshKeys);
  if (ssh) set("SSH_AUTHORIZED_KEYS", ssh);
  // The container's user takes the owner of whichever directory is bind-mounted;
  // /workspace's wins if both are, since there is only one user.
  const owner = a.workspace.kind === "path" ? a.workspace : a.home?.kind === "path" ? a.home : null;
  if (owner) {
    set("PUID", String(owner.puid ?? 1000));
    set("PGID", String(owner.pgid ?? 1000));
  }

  if (a.mode === "caddy") {
    // The gateway Caddy owns TLS now; these tell it which name to certify and
    // which ACME account to use. No sidecar, so nothing else reads them.
    set("GATEWAY_TLS_DOMAIN", a.domain ?? "");
    if (a.acmeEmail) set("ACME_EMAIL", a.acmeEmail);
  }
  if (a.mode === "tailscale") {
    L.push("# Tag the key and make it reusable, or an unattended restart after it");
    L.push("# expires (90 days at most) will fail to come back.");
    requireSecret("TS_AUTHKEY");
  }
  if (a.mode === "wireguard") {
    L.push("# The server's WireGuard private key. Its public key is in compose.yaml");
    L.push("# and in every client config; this half stays here and stays secret.");
    L.push("# Lose it and every client config has to be reissued, so keep a copy.");
    requireSecret("WG_PRIVATE_KEY");
  }
  L.push("");

  // Anything else already in .env is the operator's — a provider key, a
  // MISE_TOOLS list, a DESKTOP_DEPTH. This file is theirs to edit, and a
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

  return {
    text:
      L.join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd() + "\n",
    keys: [...emitted],
    settings,
    required,
  };
}

/**
 * What the agent-env service passes through by name. Derived from the
 * generated .env rather than kept as a second list: compose reads .env only
 * for interpolation, so anything in it but missing here would silently keep
 * the image default, which is a confusing way to lose a setting.
 */
function envPassthroughKeys(keys: string[]): string[] {
  return keys.filter((k) => !SIDECAR_KEYS.has(k));
}

/** A YAML double-quoted scalar. Paths are data, not syntax. */
function yamlString(v: string): string {
  return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}

export function renderCompose(a: Answers, env: RenderedEnv): string {
  const gp = 8080;
  const pub = new URL(a.publicUrl);
  const extPort = pub.port ? Number(pub.port) : pub.protocol === "https:" ? 443 : 80;
  const L: string[] = [];

  L.push("# Generated by setup.ts. Re-run it to regenerate, or edit freely —");
  L.push("# a re-run offers your previous answers as the defaults.");
  L.push("#");
  L.push(`# Mode: ${a.mode}.  Reachable at ${a.publicUrl}`);
  L.push("");
  const name = a.name ?? DEFAULT_NAME;
  L.push("# The project name. Containers and volumes are named after it, so each");
  L.push("# deployment on one host needs its own.");
  // Quoted, as is the hostname: a name like 123 or true is a valid hostname,
  // and unquoted YAML would read it as a number or a boolean.
  L.push(`name: ${yamlString(name)}`);
  L.push("");
  L.push("services:");
  L.push("  agent-env:");
  L.push("    image: ghcr.io/dtinth/agent-env:latest");
  L.push("    pull_policy: always");
  L.push("    restart: unless-stopped");
  // Sharing a sidecar's network namespace (Tailscale or WireGuard) means taking
  // its hostname too; Docker refuses one of its own there.
  const sharesNetns = a.mode === "tailscale" || a.mode === "wireguard";
  if (!sharesNetns) L.push(`    hostname: ${yamlString(name)}`);
  L.push("    # Docker keeps every line of output forever unless told otherwise.");
  L.push("    logging:");
  L.push("      driver: json-file");
  L.push("      options:");
  L.push('        max-size: "10m"');
  L.push('        max-file: "3"');
  L.push("");
  L.push("    environment:");
  // Compose interpolates $ in a value, so a literal one is $$.
  for (const [k, v] of env.settings) {
    L.push(`      - ${yamlString(`${k}=${v}`.replace(/\$/g, "$$$$"))}`);
  }
  // A required secret is passed even when .env has no line for it, so compose's
  // ${KEY:?} can refuse `up` until it is set rather than the image booting
  // without it. Everything else is read from .env by name.
  const requiredSet = new Set(env.required);
  const passthrough = envPassthroughKeys(env.keys);
  for (const k of env.required) {
    if (!SIDECAR_KEYS.has(k) && !passthrough.includes(k)) passthrough.push(k);
  }
  if (passthrough.length) {
    L.push("      # Secrets, from .env.");
    for (const k of passthrough) {
      // A $ must survive Compose's own interpolation of this list, except in the
      // ${KEY:?} guard, which is exactly the interpolation we want.
      L.push(requiredSet.has(k) ? `      - "${k}=\${${k}:?set ${k} in .env}"` : `      - ${k}`);
    }
  }
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
  } else if (a.mode === "wireguard") {
    // Shares the WireGuard container's network namespace, so it has no ports of
    // its own: a peer reaches the gateway at the server's tunnel address and
    // SSHes there too, with only the UDP port (on the sidecar) published.
    L.push("    # Shares the WireGuard container's network namespace: a peer reaches");
    L.push("    # the gateway on the tunnel address with nothing published here, and");
    L.push("    # SSH the same way. Only the WireGuard UDP port is open, on the sidecar.");
    L.push("    network_mode: service:wireguard");
    L.push("    depends_on:");
    L.push("      - wireguard");
  } else if (a.mode === "none") {
    // A platform's proxy reaches the container on its own network. Published
    // ports would bypass it, and on a shared host they would collide.
    L.push("    # Nothing is published: the platform routes to the gateway on 8080.");
    L.push("    # These say what listens, for its routing; Docker ignores them.");
    L.push("    expose:");
    L.push(`      - "${gp}"`);
    L.push('      - "22"');
  } else if (a.mode === "caddy") {
    L.push("    # The gateway Caddy terminates TLS itself and fetches the Let's");
    L.push("    # Encrypt certificate, so 80 (the ACME challenge and the http->https");
    L.push("    # redirect) and 443 are published straight from this container — there");
    L.push("    # is no separate proxy. SSH is raw TCP, published directly.");
    L.push("    ports:");
    L.push('      - "80:80"');
    L.push(`      - "${a.httpsPort ?? 443}:443"`);
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

  if (a.memoryGiB !== undefined || a.cpus !== undefined) {
    // MiB, so a fractional GiB is still a whole number Docker accepts.
    const mib = (gib: number) => `"${Math.round(gib * 1024)}m"`;
    L.push("    # Limits for everything in the container, rootless Docker's own");
    L.push("    # containers included. Past the memory, the kernel kills the largest");
    L.push("    # process, and its supervisor starts it again.");
    if (a.memoryGiB !== undefined) {
      L.push(`    mem_limit: ${mib(a.memoryGiB)}`);
      if (a.swapGiB !== undefined) {
        L.push(
          a.swapGiB === 0
            ? "    # Memory and swap together; equal to the memory, so no swap."
            : `    # Memory and swap together: ${a.swapGiB} GiB of swap on top.`,
        );
        L.push(`    memswap_limit: ${mib(a.memoryGiB + a.swapGiB)}`);
      }
    }
    if (a.cpus !== undefined) L.push(`    cpus: ${a.cpus}`);
    L.push("");
  }

  if (a.components.includes("docker")) {
    L.push("    # The docker component needs all five of these. The entrypoint");
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

  const script = startupScriptBody(a);
  if (script) {
    L.push("    # The startup script: run as dev, in a login shell, on every start");
    L.push("    # and before any component. `agent-env logs provision` shows what it");
    L.push("    # did. It is written from the answers at the end of this file, so");
    L.push("    # change it with the configurator rather than here.");
    L.push("    configs:");
    L.push("      - source: startup-script");
    L.push(`        target: ${STARTUP_SCRIPT_TARGET}`);
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
  if (a.home?.kind === "path") {
    L.push(`      - ${yamlString(`${hostPathFor(a.home.path ?? "")}:/home/dev`)}`);
  } else {
    L.push("      - home:/home/dev");
  }
  L.push("      # Keeps the generated SSH host keys across image updates.");
  L.push("      - agent-env-state:/var/lib/agent-env");
  L.push("");

  if (a.mode === "tailscale") {
    L.push("  tailscale:");
    L.push("    image: tailscale/tailscale:stable");
    L.push("    hostname: " + yamlString((a.tsHostname ?? DEFAULT_NAME).split(".")[0]));
    L.push("    restart: unless-stopped");
    L.push("    logging:");
    L.push("      driver: json-file");
    L.push("      options:");
    L.push('        max-size: "10m"');
    L.push('        max-file: "3"');
    L.push("    environment:");
    L.push('      - "TS_AUTHKEY=${TS_AUTHKEY:?set TS_AUTHKEY in .env}"');
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

  if (a.mode === "wireguard") {
    const wg = a.wireguard;
    const port = wg?.listenPort ?? 51820;
    L.push("  wireguard:");
    L.push("    image: lscr.io/linuxserver/wireguard:latest");
    L.push("    restart: unless-stopped");
    L.push("    logging:");
    L.push("      driver: json-file");
    L.push("      options:");
    L.push('        max-size: "10m"');
    L.push('        max-file: "3"');
    L.push("    # The one port peers dial. Everything the agent-env container serves");
    L.push("    # is reached over the tunnel, so nothing else is published.");
    L.push("    ports:");
    L.push(`      - "${port}:${port}/udp"`);
    L.push("    cap_add:");
    L.push("      - NET_ADMIN");
    L.push("      # Only needed where the host kernel has no built-in wireguard module");
    L.push("      # (most do, since Linux 5.6). Drop it, and the modules mount, if so.");
    L.push("      - SYS_MODULE");
    L.push("    sysctls:");
    L.push("      - net.ipv4.conf.all.src_valid_mark=1");
    L.push("    configs:");
    L.push("      - source: wg-conf");
    L.push("        target: /config/wg_confs/wg0.conf");
    L.push("    volumes:");
    L.push("      - /lib/modules:/lib/modules:ro");
    L.push("    devices:");
    L.push("      - /dev/net/tun");
    L.push("");
  }

  // Sidecar configuration is inlined rather than written beside this file:
  // compose.yaml is then the whole deployment, which is what a stack UI like
  // Dockge or Dokploy expects to be handed, and there is no second file to
  // fall out of step with it.
  const configs: { name: string; body: string; interpolate?: boolean }[] = [];
  if (a.mode === "tailscale") configs.push({ name: "ts-serve", body: renderTsServe(a) });
  // The wg config is the one that *wants* Compose to interpolate — it carries
  // ${WG_PRIVATE_KEY} from .env — so its lines are passed through un-escaped. The
  // only $ in it is that reference; peer keys and addresses never contain one.
  if (a.mode === "wireguard") {
    configs.push({ name: "wg-conf", body: renderWgConf(a), interpolate: true });
  }
  if (script) configs.push({ name: "startup-script", body: script });
  if (configs.length) {
    L.push("configs:");
    for (const { name, body, interpolate } of configs) {
      L.push(`  ${name}:`);
      // YAML takes a block's indentation from its first non-blank line, so a
      // script that starts indented says how deep the block is instead.
      const first = body.split("\n").find((l) => l.trim()) ?? "";
      L.push(`    content: ${/^[ \t]/.test(first) ? "|2" : "|"}`);
      for (const line of body.trimEnd().split("\n")) {
        // Compose interpolates ${...} inside content, so a literal $ is $$ —
        // except where the content means to be interpolated (the wg config).
        L.push(line ? `      ${interpolate ? line : line.replace(/\$/g, "$$$$")}` : "");
      }
    }
    L.push("");
  }

  L.push("volumes:");
  if (a.workspace.kind !== "path") L.push("  workspace:");
  if (a.home?.kind !== "path") L.push("  home:");
  L.push("  agent-env-state:");
  if (a.mode === "tailscale") L.push("  ts-state:");
  L.push("");
  L.push("# The answers this file was made from, so the next run can offer them");
  L.push("# again. Compose ignores x- keys. Keep it on one line.");
  L.push(`${ANSWERS_KEY}: ${answersLine(a)}`);
  return L.join("\n") + "\n";
}

/**
 * JSON is YAML, so the answers ride in compose.yaml as one flow mapping that
 * needs no YAML parser to read back. Compose interpolates $ in extension
 * fields too, so a literal one is $$ — `$PORT` in a command would otherwise
 * be expanded to nothing, with a warning, on every `up`.
 */
function answersLine(a: Answers): string {
  return JSON.stringify(a).replace(/\$/g, "$$$$");
}

/**
 * The answers a compose.yaml written by `generate` carries, or null when it
 * has none — one from before they moved here, or one written by hand.
 */
export function answersFromCompose(text: string): Partial<Answers> | null {
  const m = new RegExp(`^${ANSWERS_KEY}:[ \\t]*(\\{.*\\})[ \\t]*$`, "m").exec(text);
  if (!m) return null;
  try {
    const v: unknown = JSON.parse(m[1].replace(/\$\$/g, "$"));
    return v && typeof v === "object" && !Array.isArray(v)
      ? migrateAnswers(v as Partial<Answers> & LegacyAnswers)
      : null;
  } catch {
    return null;
  }
}

/**
 * The server's wg0.conf, inlined into compose.yaml. The private key is left as
 * `${WG_PRIVATE_KEY}` for Compose to fill from .env at `up`, so the secret stays
 * out of this file; `:?` makes `up` refuse to start until it is set. Each peer
 * is one [Peer] with its public key and a /32 route to its tunnel address.
 */
export function renderWgConf(a: Answers): string {
  const wg = a.wireguard;
  if (!wg) return "";
  const L = [
    "[Interface]",
    `Address = ${wg.address}`,
    `ListenPort = ${wg.listenPort}`,
    "PrivateKey = ${WG_PRIVATE_KEY:?set WG_PRIVATE_KEY in .env}",
  ];
  for (const p of wg.peers) {
    L.push(
      "",
      `# ${p.name}`,
      "[Peer]",
      `PublicKey = ${p.publicKey}`,
      `AllowedIPs = ${p.address}/32`,
    );
  }
  return L.join("\n") + "\n";
}

/**
 * One peer's client config, an output file for the operator to install on that
 * device. It holds the peer's own private key, the server's public key and
 * dial-in endpoint, and a /32 route to the gateway — so the tunnel carries only
 * traffic to the server and the device keeps its own internet.
 */
export function renderWgClientConf(a: Answers, peer: WireguardPeer, privateKey: string): string {
  const wg = a.wireguard;
  if (!wg) return "";
  return (
    [
      "[Interface]",
      `PrivateKey = ${privateKey}`,
      `Address = ${peer.address}/32`,
      "",
      "[Peer]",
      `PublicKey = ${wg.serverPublicKey}`,
      `Endpoint = ${wg.endpoint}`,
      // Only the gateway's own tunnel address, so the device routes nothing else
      // through the VPS. Widen it by hand if you want the whole tunnel subnet.
      `AllowedIPs = ${wgServerHost(wg)}/32`,
      // The server cannot dial a peer behind NAT, so the peer keeps the path open.
      "PersistentKeepalive = 25",
    ].join("\n") + "\n"
  );
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
  /**
   * The OAuth client secret, as pasted. It goes to .env and never into the
   * answers, which compose.yaml carries. Blank keeps the one `existingEnv` has.
   */
  clientSecret?: string;
  /**
   * WireGuard private keys, which the front ends generate (Web Crypto in the
   * browser, node:crypto in the wizard) — `generate` is synchronous and only
   * formats them. The public halves ride in `answers.wireguard`; the private
   * halves stay here.
   */
  wireguard?: {
    /** The server's private key, for .env. First run only — afterwards it is
     *  kept from `existingEnv` like any other secret. */
    serverPrivateKey?: string;
    /** Peers to write a `wireguard/<name>.conf` for this run, by peer name →
     *  private key. Only the peers generated this run: the server never stores
     *  a client's private key, so an existing peer's config is not reissued. */
    clientPrivateKeys?: Record<string, string>;
  };
}

/**
 * Render a deployment. Returns file name → contents. Throws `InvalidAnswers`
 * for anything `validate` reports, rather than write a deployment the image
 * would refuse, or one that should not exist at all.
 */
export function generate(answers: Answers, options: GenerateOptions = {}): Record<string, string> {
  const problems = validate(answers);
  if (problems.length) throw new InvalidAnswers(problems);
  const keep = parseEnvFile(options.existingEnv ?? "");
  const key = clientSecretKey(answers.authMode);
  const pasted = options.clientSecret?.trim();
  if (key && pasted) keep[key] = { value: pasted, raw: envValue(pasted) };
  // The server's private key is a secret like any other: a freshly generated one
  // is written now, and on a re-run `existingEnv` already carries it.
  const serverKey = options.wireguard?.serverPrivateKey?.trim();
  if (answers.mode === "wireguard" && serverKey) {
    keep["WG_PRIVATE_KEY"] = { value: serverKey, raw: envValue(serverKey) };
  }
  const env = renderEnv(answers, keep, options.randomSecret ?? randomSecret);
  const files: Record<string, string> = {
    ".env": env.text,
    "compose.yaml": renderCompose(answers, env),
  };
  // A client config per peer generated this run. It holds that peer's private
  // key, so it is an output to hand to the device, never part of the stack.
  const clientKeys = options.wireguard?.clientPrivateKeys;
  if (answers.mode === "wireguard" && clientKeys) {
    for (const peer of answers.wireguard?.peers ?? []) {
      const pk = clientKeys[peer.name]?.trim();
      if (pk) files[`wireguard/${peer.name}.conf`] = renderWgClientConf(answers, peer, pk);
    }
  }
  return files;
}
