#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
/**
 * agent-env setup — generate a compose.yaml and .env for this workstation.
 *
 *   deno run -A https://raw.githubusercontent.com/dtinth/agent-env/main/setup.ts
 *
 * Deliberately dependency-free: it is meant to be run straight from a URL,
 * before anything has been cloned or pulled, so it should not need an import
 * map, a lockfile, or a network fetch beyond itself.
 *
 * It asks about eight things and writes good defaults for the other fifty.
 * .env.example remains the reference for everything it does not ask about.
 *
 * Re-running it is the point: it reads back what it wrote last time, offers
 * those as the defaults, and preserves the secrets already in .env. That makes
 * it an upgrade tool as well as a scaffolder.
 *
 *   --answers <file>   take answers from JSON instead of prompting
 *   --out <dir>        write somewhere other than the current directory
 *   --force            overwrite without asking
 */

const VERSION = 1;
const ANSWERS_FILE = "agent-env.setup.json";

type Mode = "local" | "caddy" | "tailscale";
type AuthMode = "google" | "basic" | "none";

interface Workspace {
  kind: "volume" | "path";
  path?: string;
  puid?: number;
  pgid?: number;
}

interface Answers {
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
  allowedEmails?: string;
  allowedEmailDomains?: string;
  gatewayUser?: string;
  opencodeEnable: boolean;
  primaryPort?: number;
  dashboard: boolean;
  rootlessDocker: boolean;
  sshKeys: string;
  sshPort?: number;
  workspace: Workspace;
  timezone: string;
}

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

const C = {
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

let interactive = true;
let preset: Record<string, unknown> = {};

function note(s = "") {
  console.log(s);
}
function warn(s: string) {
  console.log(`${C.y("!")} ${s}`);
}

/** A numbered menu. Written by hand so the script stays dependency-free. */
function select<T extends string>(
  key: string,
  question: string,
  options: { value: T; label: string; hint?: string }[],
  fallback: T,
): T {
  if (key in preset) return preset[key] as T;
  if (!interactive) return fallback;

  note();
  note(C.b(question));
  options.forEach((o, i) => {
    const mark = o.value === fallback ? C.g("*") : " ";
    note(`  ${mark} ${i + 1}) ${o.label}`);
    if (o.hint) note(`       ${C.dim(o.hint)}`);
  });
  while (true) {
    const raw = prompt(
      `  choice [${options.findIndex((o) => o.value === fallback) + 1}]:`,
    );
    if (raw === null || raw.trim() === "") return fallback;
    const n = Number(raw.trim());
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      return options[n - 1].value;
    }
    warn(`pick 1-${options.length}`);
  }
}

function ask(
  key: string,
  question: string,
  fallback = "",
  opts: { optional?: boolean; validate?: (v: string) => string | null } = {},
): string {
  if (key in preset) return String(preset[key] ?? "");
  if (!interactive) return fallback;

  while (true) {
    const suffix = fallback
      ? ` [${fallback}]`
      : opts.optional
      ? ` ${C.dim("(optional)")}`
      : "";
    const raw = prompt(`${C.b(question)}${suffix}:`);
    const value = raw === null || raw.trim() === "" ? fallback : raw.trim();
    if (!value && !opts.optional) {
      warn("required");
      continue;
    }
    const err = opts.validate ? opts.validate(value) : null;
    if (err) {
      warn(err);
      continue;
    }
    return value;
  }
}

function yesNo(key: string, question: string, fallback: boolean): boolean {
  if (key in preset) return Boolean(preset[key]);
  if (!interactive) return fallback;
  while (true) {
    const raw = prompt(`${C.b(question)} ${fallback ? "[Y/n]" : "[y/N]"}:`);
    if (raw === null || raw.trim() === "") return fallback;
    const v = raw.trim().toLowerCase();
    if (["y", "yes"].includes(v)) return true;
    if (["n", "no"].includes(v)) return false;
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** Matches the entrypoint's own rand_secret: 32 random bytes, base64url, unpadded. */
function randomSecret(bytes = 32): string {
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

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

function collect(
  prev: Partial<Answers>,
  existingEnv: Record<string, string>,
): Answers {
  note(C.b("\nagent-env setup"));
  note(
    C.dim("A hosted agent workstation: OpenCode, a desktop, a terminal, SSH."),
  );
  if (Object.keys(prev).length) {
    note(
      C.dim(
        `Re-running — previous answers are the defaults, and secrets in .env are kept.`,
      ),
    );
  }

  // 1. Where it runs. This is the top-level branch: it decides the ports, the
  //    sidecars, the PUBLIC_URL and the sensible auth mode. Everything else
  //    follows from it.
  const mode = select<Mode>("mode", "Where will this run?", [
    {
      value: "local",
      label: "This machine only",
      hint:
        "Ports bound to 127.0.0.1. Nothing is exposed; put your own proxy in front if you want it reachable.",
    },
    {
      value: "caddy",
      label: "A public domain, with TLS handled here",
      hint: "Adds a Caddy sidecar that gets a certificate from Let's Encrypt.",
    },
    {
      value: "tailscale",
      label: "A tailnet, via Tailscale",
      hint:
        "Adds a Tailscale sidecar. The tailnet is the boundary; SSH and mosh just work.",
    },
  ], prev.mode ?? "local");

  let publicUrl = "";
  let behindProxy: boolean | undefined;
  let domain: string | undefined;
  let httpsPort: number | undefined;
  let acmeEmail: string | undefined;
  let tsHostname: string | undefined;

  if (mode === "local") {
    behindProxy = yesNo(
      "behindProxy",
      "Will something else terminate TLS in front of this (nginx, an ingress, a tunnel)?",
      prev.behindProxy ?? false,
    );
    publicUrl = behindProxy
      ? ask(
        "publicUrl",
        "The URL people will actually type",
        prev.publicUrl ?? "https://agent.example.com",
        {
          validate: (v) =>
            /^https?:\/\/[^/\s]+$/.test(v)
              ? null
              : "needs to look like https://host or http://host:port, with no trailing path",
        },
      )
      : "http://localhost:8080";
  }

  if (mode === "caddy") {
    domain = ask("domain", "Domain name", prev.domain ?? "agent.example.com", {
      validate: (
        v,
      ) => (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)
        ? null
        : "a bare hostname, no scheme and no port"),
    });
    // A non-standard HTTPS port is fine — Google allows ports in redirect URIs,
    // and one hostname across several ports shares the session cookie, which is
    // host-scoped. Port 443 is offered but not assumed: it is often taken.
    httpsPort = Number(
      ask(
        "httpsPort",
        "HTTPS port to serve on",
        String(prev.httpsPort ?? 8443),
        {
          validate: (
            v,
          ) => (/^\d+$/.test(v) && +v > 0 && +v < 65536
            ? null
            : "a port number"),
        },
      ),
    );
    acmeEmail = ask(
      "acmeEmail",
      "Email for Let's Encrypt (expiry notices)",
      prev.acmeEmail ?? "",
      {
        optional: true,
      },
    );
    publicUrl = `https://${domain}${httpsPort === 443 ? "" : `:${httpsPort}`}`;
  }

  if (mode === "tailscale") {
    // Google forbids raw IPs in redirect URIs, so the MagicDNS name is the only
    // address that works for google auth — and it is nicer anyway.
    tsHostname = ask(
      "tsHostname",
      "Full MagicDNS name of this machine (e.g. work.tailXXXX.ts.net)",
      prev.tsHostname ?? "agent-env.example.ts.net",
      {
        validate: (v) =>
          /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(v)
            ? null
            : "the machine's full tailnet name, like work.tail1234.ts.net",
      },
    );
    publicUrl = `https://${tsHostname}`;
  }

  // 2. Who gets in. The mode decides what is reasonable here, which is the
  //    single best reason for this script to exist.
  const authDefault: AuthMode = prev.authMode ??
    (mode === "tailscale" ? "none" : mode === "caddy" ? "google" : "basic");

  if (mode === "tailscale" && authDefault === "none") {
    note();
    warn(
      "On a tailnet the usual answer is no extra auth: the tailnet is the boundary.",
    );
    warn(
      "Anyone on your tailnet then gets a root-capable shell in this container.",
    );
    warn("If that is not what you want, pick Google sign-in below.");
  }

  const authMode = select<AuthMode>("authMode", "Who can get in?", [
    {
      value: "google",
      label: "Google sign-in",
      hint: "oauth2-proxy, restricted to an allow list.",
    },
    {
      value: "basic",
      label: "A username and password",
      hint: "Fine on localhost or behind a VPN.",
    },
    {
      value: "none",
      label: "No authentication",
      hint: "Only sane when something else is the boundary.",
    },
  ], authDefault);

  // The one thing worth refusing outright. Everything in the container is
  // root-capable, and a public domain with no auth hands that to the internet.
  if (authMode === "none" && mode === "caddy") {
    note();
    note(C.r("Refusing to generate that."));
    note(
      `  A public domain with AUTH_MODE=none puts a root-capable shell on the internet.`,
    );
    note(
      `  Pick Google sign-in, or basic auth, or use the tailnet mode instead.`,
    );
    Deno.exit(1);
  }
  if (authMode === "none" && mode === "local" && behindProxy) {
    warn(
      "AUTH_MODE=none with a proxy in front: make sure the proxy is the one authenticating.",
    );
  }

  let googleClientId: string | undefined;
  let allowedEmails: string | undefined;
  let allowedEmailDomains: string | undefined;
  let gatewayUser: string | undefined;

  if (authMode === "google") {
    googleClientId = ask(
      "googleClientId",
      "Google OAuth client ID",
      prev.googleClientId ?? "",
      {
        validate: (
          v,
        ) => (v.includes(".apps.googleusercontent.com")
          ? null
          : "should end in .apps.googleusercontent.com"),
      },
    );
    note(
      C.dim(
        `  Register this redirect URI with that client: ${publicUrl}/oauth2/callback`,
      ),
    );
    allowedEmails = ask(
      "allowedEmails",
      "Allowed emails (comma-separated)",
      prev.allowedEmails ?? "",
      {
        optional: true,
      },
    );
    allowedEmailDomains = ask(
      "allowedEmailDomains",
      "Allowed email domains (comma-separated)",
      prev.allowedEmailDomains ?? "",
      { optional: true },
    );
    // The image refuses to start without one of these, so catching it now
    // saves a deploy-time failure.
    if (!allowedEmails && !allowedEmailDomains) {
      note();
      note(C.r("Google sign-in needs an allow list."));
      note(
        "  Without one, any Google account on the internet could sign in, and",
      );
      note("  the container refuses to start rather than let that happen.");
      Deno.exit(1);
    }
  }

  if (authMode === "basic") {
    gatewayUser = ask(
      "gatewayUser",
      "Username",
      prev.gatewayUser ?? "opencode",
    );
  }

  // 3. What lives at /.
  const opencodeEnable = yesNo(
    "opencodeEnable",
    "Run OpenCode at / ?",
    prev.opencodeEnable ?? true,
  );
  let primaryPort: number | undefined;
  if (!opencodeEnable) {
    primaryPort = Number(
      ask(
        "primaryPort",
        "Port inside the container that / should proxy to",
        String(prev.primaryPort ?? 3000),
        {
          validate: (
            v,
          ) => (/^\d+$/.test(v) && +v > 0 && +v < 65536
            ? null
            : "a port number"),
        },
      ),
    );
  }

  // 4. Extras. Each of these costs something, so they are asked rather than
  //    assumed.
  const dashboard = yesNo(
    "dashboard",
    mode === "caddy"
      ? `Serve the agent-browser dashboard too? (needs a second port, ${
        (httpsPort ?? 8443) + 1
      })`
      : "Serve the agent-browser dashboard too? (needs a second port)",
    prev.dashboard ?? mode !== "caddy",
  );

  const rootlessDocker = yesNo(
    "rootlessDocker",
    "Let the agent run its own containers (rootless Docker)?",
    prev.rootlessDocker ?? false,
  );
  if (rootlessDocker) {
    note(
      C.dim(
        "  Adds four host flags that widen the sandbox. See the README before shipping this.",
      ),
    );
    if (mode === "tailscale") {
      warn(
        "Rootless Docker inside the Tailscale network namespace is UNTESTED.",
      );
      warn(
        "Inner published ports land in the tailnet namespace and need serve config.",
      );
    }
  }

  const sshKeys = ask(
    "sshKeys",
    "SSH public key(s) for the dev user, semicolon-separated",
    prev.sshKeys ?? "",
    { optional: true },
  );
  if (!sshKeys) {
    warn("No SSH keys: you will only be able to get in through the browser.");
  }

  // On a tailnet SSH is reached on the tailnet address with nothing published,
  // which is the one place this does not need asking. Everywhere else it is a
  // host port, and 2222 is often already taken.
  let sshPort: number | undefined;
  if (mode !== "tailscale") {
    sshPort = Number(
      ask("sshPort", "Host port for SSH", String(prev.sshPort ?? 2222), {
        validate: (v) =>
          /^\d+$/.test(v) && +v > 0 && +v < 65536 ? null : "a port number",
      }),
    );
  }

  // 5. Where the code lives. A host path needs PUID/PGID to match, which is
  //    the classic thing to get wrong by hand.
  const wsKind = select<"volume" | "path">(
    "workspaceKind",
    "Where should /workspace come from?",
    [
      {
        value: "volume",
        label: "A Docker volume",
        hint: "Managed by Docker; survives recreation.",
      },
      {
        value: "path",
        label: "A directory on this host",
        hint: "Edit the same files from outside the container.",
      },
    ],
    prev.workspace?.kind ?? "volume",
  );

  let workspace: Workspace = { kind: "volume" };
  if (wsKind === "path") {
    const path = ask(
      "workspacePath",
      "Host directory to mount at /workspace",
      prev.workspace?.path ?? "",
    );
    let puid = 1000, pgid = 1000;
    try {
      const st = Deno.statSync(path);
      if (typeof st.uid === "number") puid = st.uid;
      if (typeof st.gid === "number") pgid = st.gid;
      note(
        C.dim(
          `  Owned by ${puid}:${pgid} — the container will run as that, so files stay yours.`,
        ),
      );
    } catch {
      warn(
        `Cannot stat ${path} — defaulting PUID/PGID to 1000:1000, fix in .env if that is wrong.`,
      );
    }
    workspace = { kind: "path", path, puid, pgid };
  }

  const timezone = ask(
    "timezone",
    "Time zone",
    prev.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
  );

  void existingEnv;
  return {
    version: VERSION,
    mode,
    behindProxy,
    publicUrl,
    domain,
    httpsPort,
    acmeEmail,
    tsHostname,
    authMode,
    googleClientId,
    allowedEmails,
    allowedEmailDomains,
    gatewayUser,
    opencodeEnable,
    primaryPort,
    dashboard,
    rootlessDocker,
    sshKeys,
    sshPort,
    workspace,
    timezone,
  };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const DASHBOARD_PORT_OFFSET = 1;

function dashboardUrl(a: Answers): string {
  // Same hostname, different port. The oauth2-proxy session cookie is
  // host-scoped and ignores the port, so one sign-in covers both and only one
  // redirect URI is ever registered with Google.
  const u = new URL(a.publicUrl);
  const base = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  u.port = String(base + DASHBOARD_PORT_OFFSET);
  return u.toString().replace(/\/$/, "");
}

function renderEnv(a: Answers, keep: Record<string, string>): string {
  const L: string[] = [];
  const put = (k: string, v: string) => L.push(`${k}=${v}`);
  const secret = (k: string, gen: () => string) => put(k, keep[k] || gen());

  L.push(
    "# Generated by setup.ts — safe to edit; re-running keeps your secrets.",
  );
  L.push(
    "# .env.example documents every key, including the ones not set here.",
  );
  L.push("");
  L.push("# --- Where it lives ---");
  put("PUBLIC_URL", a.publicUrl);
  if (a.dashboard) put("DASHBOARD_PUBLIC_URL", dashboardUrl(a));
  put("TZ", a.timezone);
  L.push("");

  L.push("# --- Who gets in ---");
  put("AUTH_MODE", a.authMode);
  if (a.authMode === "google") {
    put("GOOGLE_CLIENT_ID", a.googleClientId ?? "");
    put(
      "GOOGLE_CLIENT_SECRET",
      keep.GOOGLE_CLIENT_SECRET || "CHANGEME-google-client-secret",
    );
    if (a.allowedEmails) put("ALLOWED_EMAILS", a.allowedEmails);
    if (a.allowedEmailDomains) {
      put("ALLOWED_EMAIL_DOMAINS", a.allowedEmailDomains);
    }
    L.push(
      "# Persisted so sessions survive a restart instead of silently rotating.",
    );
    secret("OAUTH2_PROXY_COOKIE_SECRET", () => randomSecret(32));
  }
  if (a.authMode === "basic") {
    put("GATEWAY_USER", a.gatewayUser ?? "opencode");
    secret("GATEWAY_PASSWORD", () => randomSecret(18));
  }
  L.push("");

  L.push("# --- What lives at / ---");
  put("OPENCODE_ENABLE", bool(a.opencodeEnable));
  if (!a.opencodeEnable) put("PRIMARY_PORT", String(a.primaryPort ?? 3000));
  L.push("");

  L.push("# --- Services ---");
  put("AB_DASHBOARD_ENABLE", bool(a.dashboard));
  put("DOCKER_ROOTLESS_ENABLE", bool(a.rootlessDocker));
  L.push("");

  L.push("# --- Access ---");
  if (a.sshKeys) put("SSH_AUTHORIZED_KEYS", a.sshKeys);
  else L.push("# SSH_AUTHORIZED_KEYS=ssh-ed25519 AAAA... you@host");
  L.push("");

  L.push("# --- Model providers ---");
  L.push(
    "# Or sign in interactively with /connect in the TUI; it persists on the home volume.",
  );
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
    if (keep[k]) put(k, keep[k]);
    else L.push(`# ${k}=`);
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
    L.push(
      "# Tag the key and make it reusable, or an unattended restart after it",
    );
    L.push("# expires (90 days at most) will fail to come back.");
    put("TS_AUTHKEY", keep.TS_AUTHKEY || "tskey-auth-CHANGEME");
    L.push("");
  }

  return L.join("\n") + "\n";
}

function envPassthroughKeys(a: Answers): string[] {
  const keys = ["PUBLIC_URL", "TZ", "AUTH_MODE"];
  if (a.dashboard) keys.splice(1, 0, "DASHBOARD_PUBLIC_URL");
  if (a.authMode === "google") {
    keys.push(
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "OAUTH2_PROXY_COOKIE_SECRET",
    );
    if (a.allowedEmails) keys.push("ALLOWED_EMAILS");
    if (a.allowedEmailDomains) keys.push("ALLOWED_EMAIL_DOMAINS");
  }
  if (a.authMode === "basic") keys.push("GATEWAY_USER", "GATEWAY_PASSWORD");
  keys.push("OPENCODE_ENABLE");
  if (!a.opencodeEnable) keys.push("PRIMARY_PORT");
  keys.push("AB_DASHBOARD_ENABLE", "DOCKER_ROOTLESS_ENABLE");
  keys.push("SSH_AUTHORIZED_KEYS", "ANTHROPIC_API_KEY", "OPENAI_API_KEY");
  if (a.workspace.kind === "path") keys.push("PUID", "PGID");
  return keys;
}

function renderCompose(a: Answers): string {
  const gp = 8080;
  const dp = 8081;
  const pub = new URL(a.publicUrl);
  const extPort = pub.port
    ? Number(pub.port)
    : pub.protocol === "https:"
    ? 443
    : 80;
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
  for (const k of envPassthroughKeys(a)) L.push(`      - ${k}`);
  L.push("");

  if (a.mode === "tailscale") {
    // Sharing the sidecar's network namespace means this service cannot declare
    // ports of its own — tailscale serve is the only way in, and SSH is reached
    // on the tailnet address directly.
    L.push(
      "    # Shares the Tailscale container's network namespace, so it has no",
    );
    L.push(
      "    # ports of its own: `tailscale serve` is the way in, and SSH is",
    );
    L.push("    # reachable on the tailnet address with nothing published.");
    L.push("    network_mode: service:tailscale");
    L.push("    depends_on:");
    L.push("      - tailscale");
  } else if (a.mode === "caddy") {
    L.push(
      "    # HTTP is not published: the caddy service in front is the only",
    );
    L.push("    # way in. SSH is raw TCP, which Caddy cannot proxy, so it is");
    L.push(
      "    # published directly, or there would be no way in but the browser.",
    );
    L.push("    expose:");
    L.push(`      - "${gp}"`);
    if (a.dashboard) L.push(`      - "${dp}"`);
    L.push("    ports:");
    L.push(`      - "${a.sshPort ?? 2222}:22"`);
  } else {
    L.push(
      "    # Bound to loopback. Put your own proxy in front to expose it.",
    );
    L.push("    ports:");
    L.push(`      - "127.0.0.1:${extPort}:${gp}"`);
    if (a.dashboard) {
      L.push(`      - "127.0.0.1:${extPort + DASHBOARD_PORT_OFFSET}:${dp}"`);
    }
    L.push(`      - "127.0.0.1:${a.sshPort ?? 2222}:22"`);
  }
  L.push("");

  L.push("    # Chromium needs more than the default 64 MB of /dev/shm.");
  L.push('    shm_size: "2gb"');
  L.push("");

  if (a.rootlessDocker) {
    L.push(
      "    # DOCKER_ROOTLESS_ENABLE=true needs all four of these. The entrypoint",
    );
    L.push("    # names any that are missing and leaves the daemon down.");
    L.push("    cap_add:");
    L.push("      - SYS_ADMIN # setuid newuidmap, to map the subuid range");
    L.push("    security_opt:");
    L.push(
      "      - seccomp=unconfined # runc's per-container session keyring (keyctl)",
    );
    L.push(
      "      - systempaths=unconfined # writable /proc/sys, for net.ipv4.ip_forward",
    );
    L.push("    devices:");
    L.push("      - /dev/net/tun # slirp4netns' tap device");
    L.push("");
  }

  L.push("    volumes:");
  if (a.workspace.kind === "path") {
    L.push(`      - ${a.workspace.path}:/workspace`);
  } else {
    L.push("      - workspace:/workspace");
  }
  L.push(
    "      # The whole home directory, so a tool the agent installs survives",
  );
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
    L.push(
      "      # ACME validates on 80 (HTTP-01) or 443 (TLS-ALPN-01) and nowhere",
    );
    L.push(
      "      # else, so this stays published even though the site is served on",
    );
    L.push(`      # ${extPort}.`);
    L.push('      - "80:80"');
    L.push(`      - "${extPort}:${extPort}"`);
    if (a.dashboard) {
      L.push(
        `      - "${extPort + DASHBOARD_PORT_OFFSET}:${
          extPort + DASHBOARD_PORT_OFFSET
        }"`,
      );
    }
    L.push("    volumes:");
    L.push("      - ./Caddyfile:/etc/caddy/Caddyfile:ro");
    L.push(
      "      # Without this every recreate re-issues the certificate and you",
    );
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
    L.push("    volumes:");
    L.push(
      "      # Without persistent state every restart burns a fresh auth key.",
    );
    L.push("      - ts-state:/var/lib/tailscale");
    L.push("      - ./ts-serve.json:/config/serve.json:ro");
    L.push("    devices:");
    L.push("      - /dev/net/tun");
    L.push("    cap_add:");
    L.push("      - NET_ADMIN");
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

function renderCaddyfile(a: Answers): string {
  const pub = new URL(a.publicUrl);
  const extPort = pub.port ? Number(pub.port) : 443;
  const L: string[] = [];
  L.push("# Generated by setup.ts.");
  L.push("#");
  L.push(
    "# This terminates TLS and nothing else. Authentication and the /~env/",
  );
  L.push(
    "# routing belong to the gateway inside the container, so they behave",
  );
  L.push("# identically whether or not this file is in play.");
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
  if (a.dashboard) {
    L.push("");
    L.push(
      "# Same hostname, second port: the session cookie is host-scoped and",
    );
    L.push("# ignores the port, so one sign-in covers both.");
    L.push(`${a.domain}:${extPort + DASHBOARD_PORT_OFFSET} {`);
    L.push("\treverse_proxy agent-env:8081");
    L.push("}");
  }
  return L.join("\n") + "\n";
}

function renderTsServe(a: Answers): string {
  const port = 443;
  const cfg: Record<string, unknown> = {
    TCP: { [port]: { HTTPS: true } },
    Web: {
      [`${a.tsHostname}:${port}`]: {
        Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } },
      },
    },
  };
  if (a.dashboard) {
    const dash = 8443;
    (cfg.TCP as Record<number, unknown>)[dash] = { HTTPS: true };
    (cfg.Web as Record<string, unknown>)[`${a.tsHostname}:${dash}`] = {
      Handlers: { "/": { Proxy: "http://127.0.0.1:8081" } },
    };
  }
  return JSON.stringify(cfg, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

function readIfExists(path: string): string | null {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
}

function main() {
  const outDir = arg("out") ?? ".";
  const force = Deno.args.includes("--force");
  const answersArg = arg("answers");

  if (answersArg) {
    preset = JSON.parse(Deno.readTextFileSync(answersArg));
    interactive = false;
  } else if (!Deno.stdin.isTerminal()) {
    interactive = false;
  }

  const p = (f: string) => `${outDir.replace(/\/$/, "")}/${f}`;
  const prev: Partial<Answers> = JSON.parse(
    readIfExists(p(ANSWERS_FILE)) ?? "{}",
  );
  const existingEnv = parseEnvFile(readIfExists(p(".env")) ?? "");

  const answers = collect(prev, existingEnv);

  const files: Record<string, string> = {
    ".env": renderEnv(answers, existingEnv),
    "compose.yaml": renderCompose(answers),
    [ANSWERS_FILE]: JSON.stringify(answers, null, 2) + "\n",
  };
  if (answers.mode === "caddy") files["Caddyfile"] = renderCaddyfile(answers);
  if (answers.mode === "tailscale") {
    files["ts-serve.json"] = renderTsServe(answers);
  }

  note();
  const clobber = Object.keys(files).filter((f) =>
    f !== ANSWERS_FILE && readIfExists(p(f)) !== null
  );
  if (clobber.length && !force && interactive) {
    note(
      `${C.y("These already exist and will be overwritten:")} ${
        clobber.join(", ")
      }`,
    );
    if (!yesNo("__overwrite", "Overwrite them?", true)) {
      note("Nothing written.");
      Deno.exit(1);
    }
  }

  try {
    Deno.mkdirSync(outDir, { recursive: true });
  } catch { /* already there */ }
  for (const [name, body] of Object.entries(files)) {
    Deno.writeTextFileSync(p(name), body);
    // .env holds secrets; the others do not.
    if (name === ".env") Deno.chmodSync(p(name), 0o600);
    note(`${C.g("wrote")} ${p(name)}`);
  }

  note();
  note(C.b("Next:"));
  if (answers.authMode === "google") {
    note(`  1. Put your Google client secret in .env (GOOGLE_CLIENT_SECRET).`);
    note(
      `  2. Register this redirect URI: ${answers.publicUrl}/oauth2/callback`,
    );
  }
  if (answers.mode === "caddy") {
    note(
      `  ${
        answers.authMode === "google" ? "3" : "1"
      }. Point an A record for ${answers.domain} at this host, before first start.`,
    );
  }
  if (answers.mode === "tailscale") {
    note(
      `  ${
        answers.authMode === "google" ? "3" : "1"
      }. Put a tagged, reusable auth key in .env (TS_AUTHKEY).`,
    );
  }
  note(`  ${"docker compose up -d"}`);
  note(`  ${"docker compose exec agent-env agent-env urls"}`);
  note();
  note(`Reachable at ${C.b(answers.publicUrl)}`);
  if (answers.sshPort) {
    note(
      `SSH on host port ${
        C.b(String(answers.sshPort))
      } — change it here if that is taken.`,
    );
  }
  note(
    `The environment's own pages live under ${
      C.b(answers.publicUrl + "/~env/")
    }`,
  );
}

if (import.meta.main) main();
