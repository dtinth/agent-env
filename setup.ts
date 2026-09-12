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
type AuthMode = "google" | "github" | "basic" | "none";

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
  githubClientId?: string;
  githubUsers?: string;
  githubOrg?: string;
  githubTeam?: string;
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
/** Where the generated files land; relative answers resolve against it. */
let outDir = ".";

function note(s = "") {
  console.log(s);
}
function warn(s: string) {
  console.log(`${C.y("!")} ${s}`);
}

/** A numbered menu. Written by hand so the script stays dependency-free. */
function bad(key: string, why: string): never {
  note(`${C.r("Invalid answer")} for ${C.b(key)}: ${why}`);
  Deno.exit(2);
}

function select<T extends string>(
  key: string,
  question: string,
  options: { value: T; label: string; hint?: string }[],
  fallback: T,
): T {
  if (key in preset) {
    const v = preset[key] as T;
    // An --answers file is automation input, and automation is exactly where a
    // silently-wrong value turns into a broken deployment nobody typed.
    if (!options.some((o) => o.value === v)) {
      bad(
        key,
        `expected one of ${options.map((o) => o.value).join(", ")}, got "${v}"`,
      );
    }
    return v;
  }
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
  if (key in preset) {
    // Typed answers are trimmed; an answers file should behave the same, and
    // new URL() trims for its own parsing while the raw value goes on to be
    // written verbatim.
    const v = String(preset[key] ?? "").trim();
    if (!v && !opts.optional) bad(key, "required");
    const err = v && opts.validate ? opts.validate(v) : null;
    if (err) bad(key, err);
    return v;
  }
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
    // An optional question that came back blank is answered: there is nothing
    // for a validator to check, and running one would reject the very answer
    // the question offered — the preset path skips it for the same reason.
    const err = value && opts.validate ? opts.validate(value) : null;
    if (err) {
      warn(err);
      continue;
    }
    return value;
  }
}

function yesNo(key: string, question: string, fallback: boolean): boolean {
  if (key in preset) {
    const v = preset[key];
    if (typeof v === "boolean") return v;
    if (v === "true") return true;
    if (v === "false") return false;
    // Truthiness would make the string "false" enable rootless Docker, which
    // adds SYS_ADMIN and relaxes seccomp. Not a thing to infer.
    bad(key, `expected true or false, got ${JSON.stringify(v)}`);
  }
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
/**
 * The entrypoint's `clean_list`, in TypeScript. An allow list decides whether
 * there is a gate at all, so what the wizard counts has to be what the
 * container will count: `", ,"` is a non-empty answer that describes nobody,
 * and treating it as an allow list writes a deployment the image then refuses
 * to start.
 */
function cleanList(v: string | undefined): string {
  return (v ?? "").split(",").map((x) => x.replace(/\s+/g, "")).filter((x) =>
    x.length > 0
  ).join(",");
}

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

interface EnvEntry {
  /** Unquoted, for reuse as a value. */
  value: string;
  /** Exactly as it was written, for carrying a line through untouched. */
  raw: string;
}

function parseEnvFile(text: string): Record<string, EnvEntry> {
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
  if (v === "" || (/^[^\s"'#\\][^#\\]*$/.test(v) && v === v.trim())) return v;
  return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

function collect(
  prev: Partial<Answers>,
  existingEnv: Record<string, EnvEntry>,
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
          validate: (v) => {
            let u: URL;
            try {
              u = new URL(v);
            } catch {
              return "needs to look like https://host or http://host:port";
            }
            if (!/^https?:$/.test(u.protocol)) return "http or https only";
            // Everything downstream appends to this: the redirect URI, the
            // dashboard origin. A query or fragment is inherited by all of them.
            if (u.pathname !== "/" || u.search || u.hash) {
              return "just the origin — no path, query or fragment";
            }
            return null;
          },
        },
      )
      : "http://localhost:8080";
  }

  if (mode === "caddy") {
    domain = ask("domain", "Domain name", prev.domain ?? "agent.example.com", {
      validate: (
        v,
      ) => (/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i
          .test(v)
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
        // Written into the Caddyfile as a directive argument, so the same class
        // of problem as the workspace path: anything outside an address could
        // become configuration.
        validate: (v) =>
          /^[^\s<>"'{}\\]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)
            ? null
            : "an email address, or leave it blank",
      },
    );
    publicUrl = `https://${domain}${httpsPort === 443 ? "" : `:${httpsPort}`}`;
  }

  if (mode === "tailscale") {
    // Google forbids raw IPs in redirect URIs, so the MagicDNS name is the only
    // address that works for the OAuth modes — and it is nicer anyway.
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
    warn("If that is not what you want, pick one of the sign-ins below.");
  }

  const authMode = select<AuthMode>("authMode", "Who can get in?", [
    {
      value: "google",
      label: "Google sign-in",
      hint: "oauth2-proxy, restricted to an allow list.",
    },
    {
      value: "github",
      label: "GitHub sign-in",
      hint: "oauth2-proxy, restricted to accounts, orgs or teams.",
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
      `  Pick Google or GitHub sign-in, or basic auth, or the tailnet mode.`,
    );
    Deno.exit(1);
  }
  if (authMode === "none" && mode === "local" && behindProxy) {
    warn(
      "AUTH_MODE=none with a proxy in front: make sure the proxy is the one authenticating.",
    );
  }

  let googleClientId: string | undefined;
  let githubClientId: string | undefined;
  let githubUsers: string | undefined;
  let githubOrg: string | undefined;
  let githubTeam: string | undefined;
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
        ) => (/^[A-Za-z0-9][A-Za-z0-9._-]*\.apps\.googleusercontent\.com$/.test(
            v,
          )
          ? null
          : "should look like 1234-abc.apps.googleusercontent.com"),
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
    // saves a deploy-time failure. Counted after cleaning, as it is there.
    if (!cleanList(allowedEmails) && !cleanList(allowedEmailDomains)) {
      note();
      note(C.r("Google sign-in needs an allow list."));
      note(
        "  Without one, any Google account on the internet could sign in, and",
      );
      note("  the container refuses to start rather than let that happen.");
      Deno.exit(1);
    }
  }

  if (authMode === "github") {
    githubClientId = ask(
      "githubClientId",
      "GitHub OAuth app client ID",
      prev.githubClientId ?? "",
    );
    note(
      C.dim(
        `  Register this callback URL with that app: ${publicUrl}/oauth2/callback`,
      ),
    );
    githubUsers = ask(
      "githubUsers",
      "Allowed GitHub usernames (comma-separated)",
      prev.githubUsers ?? "",
      { optional: true },
    );
    githubOrg = ask(
      "githubOrg",
      "Allowed GitHub organisation",
      prev.githubOrg ?? "",
      { optional: true },
    );
    githubTeam = ask(
      "githubTeam",
      githubOrg
        ? "Allowed teams in that org (comma-separated slugs)"
        : "Allowed teams (comma-separated, each one org:team)",
      prev.githubTeam ?? "",
      {
        optional: true,
        // The two forms are mutually exclusive, and oauth2-proxy matches
        // either literally: with an org set it compares each entry against the
        // bare slug, and with no org it compares against `org:team` and
        // rejects anything else outright. A deployment with the wrong shape
        // starts happily and turns everyone away, which is the worst way to
        // find out. Blank stays valid — the question is optional, and this
        // runs on the empty answer too.
        validate: (v) => {
          const teams = cleanList(v).split(",").filter(Boolean);
          if (teams.length === 0) return null;
          if (githubOrg) {
            return teams.every((t) => !t.includes(":"))
              ? null
              : "with an organisation set, each team is a plain slug like platform";
          }
          return teams.every((t) => /^[^:]+:[^:]+$/.test(t))
            ? null
            : "without an organisation each team must be exactly org:team, like acme:platform";
        },
      },
    );
    // The image counts an email rule as an allow list for GitHub too, so the
    // wizard has to be able to write one — otherwise an email-only deployment
    // the container would accept cannot be generated here at all.
    allowedEmails = ask(
      "allowedEmails",
      "Allowed emails (comma-separated)",
      prev.allowedEmails ?? "",
      { optional: true },
    );
    allowedEmailDomains = ask(
      "allowedEmailDomains",
      "Allowed email domains (comma-separated)",
      prev.allowedEmailDomains ?? "",
      { optional: true },
    );
    // Same reason as the Google branch: the image refuses to start without an
    // allow list, and finding that out at deploy time is worse. Counted the
    // way the entrypoint counts it — see cleanList.
    if (
      ![githubUsers, githubOrg, githubTeam, allowedEmails, allowedEmailDomains]
        .some((v) => cleanList(v))
    ) {
      note();
      note(C.r("GitHub sign-in needs an allow list."));
      note(
        "  Give usernames, an org, teams, or an email rule. Without one, any",
      );
      note(
        "  GitHub account on the internet could sign in, and",
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
  const maxMain = 65535 - DASHBOARD_PORT_OFFSET;
  const dashboard = yesNo(
    "dashboard",
    mode === "caddy"
      ? `Serve the agent-browser dashboard too? (needs a second port, ${
        (httpsPort ?? 8443) + 1
      })`
      : "Serve the agent-browser dashboard too? (needs a second port)",
    prev.dashboard ?? mode !== "caddy",
  );

  // Only the dashboard needs the port above, so this is a limit on that
  // combination, not on the port itself.
  if (dashboard && httpsPort !== undefined && httpsPort > maxMain) {
    note();
    note(C.r(`Port ${httpsPort} leaves no room for the dashboard.`));
    note(
      `  It is served on the next port up, and ${
        httpsPort + DASHBOARD_PORT_OFFSET
      } is not a port.`,
    );
    note(`  Pick ${maxMain} or lower, or turn the dashboard off.`);
    Deno.exit(1);
  }

  const rootlessDocker = yesNo(
    "rootlessDocker",
    "Let the agent run its own containers (rootless Docker)?",
    prev.rootlessDocker ?? false,
  );
  if (rootlessDocker) {
    note(
      C.dim(
        "  Adds five host flags that widen the sandbox. See the README before shipping this.",
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
    let path = ask(
      "workspacePath",
      "Host directory to mount at /workspace",
      prev.workspace?.path ?? "",
      {
        // Quoting handles colons and hashes. A newline cannot be quoted into a
        // single scalar, and would become extra YAML inside the service.
        validate: (v) =>
          /[\n\r]/.test(v) ? "a path cannot contain a newline" : null,
      },
    );
    // Compose reads a bare relative path as a named volume, and there is no
    // such volume, so it rejects the file. "./" is what was meant.
    if (!path.startsWith("/") && !path.startsWith(".")) {
      note(
        C.dim(
          `  Reading "${path}" as "./${path}" — compose treats a bare name as a volume.`,
        ),
      );
      path = `./${path}`;
    }
    let puid = 1000, pgid = 1000;
    try {
      // Relative paths in the compose file resolve against the compose file,
      // which lives in --out — not against wherever this was run from.
      const st = Deno.statSync(
        path.startsWith("/") ? path : `${outDir.replace(/\/$/, "")}/${path}`,
      );
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

  // Docker will happily accept two mappings on one host port and then fail to
  // bind at `up`. Nothing downstream catches it, so check it where the numbers
  // are still attached to the questions that produced them.
  const claims: [number, string][] = [];
  const claim = (port: number | undefined, what: string) => {
    if (port !== undefined) claims.push([port, what]);
  };
  const extPort = new URL(publicUrl).port
    ? Number(new URL(publicUrl).port)
    : new URL(publicUrl).protocol === "https:"
    ? 443
    : 80;
  if (mode === "local") {
    claim(behindProxy ? 8080 : extPort, "the gateway");
    if (dashboard) {
      claim(
        behindProxy ? 8081 : extPort + DASHBOARD_PORT_OFFSET,
        "the dashboard",
      );
    }
  }
  if (mode === "caddy") {
    claim(80, "ACME validation");
    claim(extPort, "the gateway, through caddy");
    if (dashboard) {
      claim(extPort + DASHBOARD_PORT_OFFSET, "the dashboard, through caddy");
    }
  }
  claim(sshPort, "SSH");
  const seen = new Map<number, string>();
  for (const [port, what] of claims) {
    const already = seen.get(port);
    if (already) {
      note();
      note(C.r(`Port ${port} is claimed twice.`));
      note(`  ${already} and ${what} would both bind it, and Docker cannot.`);
      note("  Pick a different port for one of them.");
      Deno.exit(1);
    }
    seen.set(port, what);
  }

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
    githubClientId,
    githubUsers,
    githubOrg,
    githubTeam,
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

/** Keys belonging to a sidecar service, not to the agent-env container. */
const SIDECAR_KEYS = new Set(["TS_AUTHKEY"]);

const DASHBOARD_PORT_OFFSET = 1;
/** What the image documents for mosh, and what the client is told to ask for. */
const MOSH_PORTS = "60000-60010:60000-60010/udp";

/** The port the dashboard is reached on. Everything that needs it asks here. */
function dashboardPort(a: Answers): number {
  const u = new URL(a.publicUrl);
  const base = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  return base + DASHBOARD_PORT_OFFSET;
}

function dashboardUrl(a: Answers): string {
  // Same hostname, different port. The oauth2-proxy session cookie is
  // host-scoped and ignores the port, so one sign-in covers both and only one
  // redirect URI is ever registered with the provider.
  const u = new URL(a.publicUrl);
  u.port = String(dashboardPort(a));
  return u.toString().replace(/\/$/, "");
}

interface RenderedEnv {
  text: string;
  /** Every key the file mentions, set or commented. */
  keys: string[];
}

function renderEnv(a: Answers, keep: Record<string, EnvEntry>): RenderedEnv {
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
    if (!carry("GOOGLE_CLIENT_SECRET")) {
      put("GOOGLE_CLIENT_SECRET", "CHANGEME-google-client-secret");
    }
    putList("ALLOWED_EMAILS", a.allowedEmails);
    putList("ALLOWED_EMAIL_DOMAINS", a.allowedEmailDomains);
    L.push(
      "# Persisted so sessions survive a restart instead of silently rotating.",
    );
    secret("OAUTH2_PROXY_COOKIE_SECRET", () => randomSecret(32));
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
    L.push(
      "# Tag the key and make it reusable, or an unattended restart after it",
    );
    L.push("# expires (90 days at most) will fail to come back.");
    if (!carry("TS_AUTHKEY")) put("TS_AUTHKEY", "tskey-auth-CHANGEME");
    L.push("");
  }

  // Anything else already in .env is the operator's — another provider key, a
  // MISE_TOOLS list, a DESKTOP_RESOLUTION. This file is theirs to edit, and a
  // generator that silently drops what it does not recognise makes "re-run it"
  // advice you cannot follow.
  const carried = Object.keys(keep).filter((k) =>
    !emitted.has(k) && !decided.has(k)
  ).sort();
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

function renderCompose(a: Answers, envKeys: string[]): string {
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
  for (const k of envPassthroughKeys(envKeys)) L.push(`      - ${k}`);
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
    L.push("      # One UDP port per mosh session; ssh alone is not enough.");
    L.push(`      - "${MOSH_PORTS}"`);
  } else {
    // With a TLS terminator in front, PUBLIC_URL is the proxy's address and has
    // nothing to do with what this container binds — taking its port would make
    // the two fight over 443. Bind the gateway's own ports and let the proxy
    // forward to them.
    const hostPort = a.behindProxy ? gp : extPort;
    const hostDash = a.behindProxy ? dp : extPort + DASHBOARD_PORT_OFFSET;
    L.push(
      a.behindProxy
        ? "    # Bound to loopback for the proxy in front to forward to."
        : "    # Bound to loopback. Put your own proxy in front to expose it.",
    );
    L.push("    ports:");
    L.push(`      - "127.0.0.1:${hostPort}:${gp}"`);
    if (a.dashboard) L.push(`      - "127.0.0.1:${hostDash}:${dp}"`);
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
    L.push(
      "    # DOCKER_ROOTLESS_ENABLE=true needs all five of these. The entrypoint",
    );
    L.push("    # names any that are missing and leaves the daemon down.");
    L.push("    cap_add:");
    L.push("      - SYS_ADMIN # setuid newuidmap, to map the subuid range");
    L.push("    security_opt:");
    L.push(
      "      - seccomp=unconfined # runc's per-container session keyring (keyctl)",
    );
    L.push(
      "      - apparmor=unconfined # docker-default denies mount; rootlesskit remounts /",
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
    L.push(`      - ${yamlString(`${a.workspace.path}:/workspace`)}`);
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
    const dash = dashboardPort(a);
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
  outDir = arg("out") ?? ".";
  const force = Deno.args.includes("--force");
  const answersArg = arg("answers");

  if (answersArg) {
    preset = JSON.parse(Deno.readTextFileSync(answersArg));
    interactive = false;
  } else if (!Deno.stdin.isTerminal()) {
    // Falling back to defaults here would generate a deployment nobody chose,
    // and write it over whatever was there.
    note(C.r("No terminal to ask questions on."));
    note("  Run this interactively, or pass --answers <file.json> to say what");
    note("  you want. It will not guess.");
    Deno.exit(2);
  }

  const p = (f: string) => `${outDir.replace(/\/$/, "")}/${f}`;
  const prev: Partial<Answers> = JSON.parse(
    readIfExists(p(ANSWERS_FILE)) ?? "{}",
  );
  const existingEnv = parseEnvFile(readIfExists(p(".env")) ?? "");

  const answers = collect(prev, existingEnv);

  const env = renderEnv(answers, existingEnv);
  const files: Record<string, string> = {
    ".env": env.text,
    "compose.yaml": renderCompose(answers, env.keys),
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
  if (clobber.length && !force && !interactive) {
    note(C.r("These already exist, and this is not an interactive run:"));
    note(`  ${clobber.join(", ")}`);
    note("  Pass --force to overwrite them.");
    Deno.exit(1);
  }
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
  // Write beside, then rename: an interruption partway through used to leave
  // .env from one generation next to a compose file from another, which is a
  // deployment that never existed.
  const staged: [string, string][] = [];
  try {
    for (const [name, body] of Object.entries(files)) {
      const tmp = p(`.${name}.tmp`);
      Deno.writeTextFileSync(tmp, body);
      if (name === ".env") Deno.chmodSync(tmp, 0o600);
      staged.push([tmp, p(name)]);
    }
  } catch (e) {
    for (const [tmp] of staged) {
      try {
        Deno.removeSync(tmp);
      } catch { /* nothing to clean up */ }
    }
    throw e;
  }
  for (const [tmp, final] of staged) {
    Deno.renameSync(tmp, final);
    note(`${C.g("wrote")} ${final}`);
  }

  const stale = [
    ["Caddyfile", "caddy"],
    ["ts-serve.json", "tailscale"],
  ].filter(([f, forMode]) =>
    answers.mode !== forMode && !(f in files) && readIfExists(p(f)) !== null
  );
  if (stale.length) {
    note();
    for (const [f] of stale) {
      warn(`${p(f)} is left over from a previous mode and is no longer used.`);
    }
    warn("Left in place in case you edited it — delete it when you are sure.");
  }

  note();
  note(C.b("Next:"));
  const oauth = answers.authMode === "google" || answers.authMode === "github";
  if (oauth) {
    const which = answers.authMode === "google" ? "Google" : "GitHub";
    const key = answers.authMode === "google"
      ? "GOOGLE_CLIENT_SECRET"
      : "GITHUB_CLIENT_SECRET";
    note(`  1. Put your ${which} client secret in .env (${key}).`);
    note(
      `  2. Register this redirect URI: ${answers.publicUrl}/oauth2/callback`,
    );
  }
  if (answers.mode === "caddy") {
    note(
      `  ${
        oauth ? "3" : "1"
      }. Point an A record for ${answers.domain} at this host, before first start.`,
    );
  }
  if (answers.mode === "tailscale") {
    note(
      `  ${
        oauth ? "3" : "1"
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
