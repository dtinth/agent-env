#!/usr/bin/env node
/**
 * agent-env setup — generate a compose.yaml and .env for this workstation.
 *
 *   deno run -A https://raw.githubusercontent.com/dtinth/agent-env/main/setup.ts
 *
 * Deliberately dependency-free: it is meant to be run straight from a URL,
 * before anything has been cloned or pulled, so it should not need an import
 * map, a lockfile, or a network fetch beyond itself and generate.ts beside it.
 *
 * This file is the terminal half: prompts, files, exit codes. What the answers
 * turn into lives in generate.ts, a pure module a web UI can use as well.
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
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import process from "node:process";
import { createInterface, type Interface } from "node:readline";
import {
  allowListProblem,
  type Answers,
  ANSWERS_FILE,
  type AuthMode,
  CHECKS,
  generate,
  hostPathFor,
  type Mode,
  type Preset,
  portClashProblem,
  type Problem,
  publicUrlFor,
  refusal,
  validate,
  VERSION,
  type Workspace,
} from "./generate.ts";

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

const args = process.argv.slice(2);

let rl: Interface | undefined;
/** Set once the wizard is done asking, so closing stdin then is expected. */
let finished = false;

/** One line from the terminal. Closing stdin instead ends the wizard. */
function prompt(question: string): Promise<string | null> {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    // Input ending mid-wizard (Ctrl-D, a closed pipe) is not an answer.
    // Treating it as "take the default" would run the remaining questions
    // unattended — including "Overwrite them?" — so stop, writing nothing.
    rl.on("close", () => {
      if (finished) return;
      note();
      note(C.r("Input closed before the questions were answered. Nothing written."));
      process.exit(1);
    });
    // Without a listener readline swallows Ctrl-C and just pauses, which
    // leaves the wizard hanging at a prompt nobody can answer.
    rl.on("SIGINT", () => {
      note();
      process.exit(130);
    });
  }
  const r = rl;
  return new Promise((resolve) => r.question(`${question} `, resolve));
}

function note(s = "") {
  console.log(s);
}
function warn(s: string) {
  console.log(`${C.y("!")} ${s}`);
}

function bad(key: string, why: string): never {
  note(`${C.r("Invalid answer")} for ${C.b(key)}: ${why}`);
  process.exit(2);
}

/** Report a problem with the answers as a whole, and stop. */
function fail(p: Problem): never {
  note();
  note(C.r(p.message));
  for (const line of p.detail ?? []) note(`  ${line}`);
  process.exit(1);
}

/** A numbered menu. Written by hand so the script stays dependency-free. */
async function select<T extends string>(
  key: string,
  question: string,
  options: { value: T; label: string; hint?: string }[],
  fallback: T,
): Promise<T> {
  if (key in preset) {
    const v = preset[key] as T;
    // An --answers file is automation input, and automation is exactly where a
    // silently-wrong value turns into a broken deployment nobody typed.
    if (!options.some((o) => o.value === v)) {
      bad(key, `expected one of ${options.map((o) => o.value).join(", ")}, got "${v}"`);
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
    const raw = await prompt(`  choice [${options.findIndex((o) => o.value === fallback) + 1}]:`);
    if (raw === null || raw.trim() === "") return fallback;
    const n = Number(raw.trim());
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      return options[n - 1].value;
    }
    warn(`pick 1-${options.length}`);
  }
}

async function ask(
  key: string,
  question: string,
  fallback = "",
  opts: { optional?: boolean; validate?: (v: string) => string | null } = {},
): Promise<string> {
  if (key in preset) {
    // Typed answers are trimmed; an answers file should behave the same, and
    // new URL() trims for its own parsing while the raw value goes on to be
    // written verbatim.
    const given = preset[key];
    // A number is a fine answer to a port question; anything stranger is
    // shown as written, for the validator to turn away.
    const v = (
      typeof given === "string" ? given : given == null ? "" : JSON.stringify(given)
    ).trim();
    if (!v && !opts.optional) bad(key, "required");
    const err = v && opts.validate ? opts.validate(v) : null;
    if (err) bad(key, err);
    return v;
  }
  if (!interactive) return fallback;

  while (true) {
    const suffix = fallback ? ` [${fallback}]` : opts.optional ? ` ${C.dim("(optional)")}` : "";
    const raw = await prompt(`${C.b(question)}${suffix}:`);
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

async function yesNo(key: string, question: string, fallback: boolean): Promise<boolean> {
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
    const raw = await prompt(`${C.b(question)} ${fallback ? "[Y/n]" : "[y/N]"}:`);
    if (raw === null || raw.trim() === "") return fallback;
    const v = raw.trim().toLowerCase();
    if (["y", "yes"].includes(v)) return true;
    if (["n", "no"].includes(v)) return false;
  }
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

async function collect(prev: Partial<Answers>): Promise<Answers> {
  note(C.b("\nagent-env setup"));
  note(
    C.dim("A hosted agent workstation: a desktop, a terminal, SSH, and an agent if you want one."),
  );
  if (Object.keys(prev).length) {
    note(C.dim(`Re-running — previous answers are the defaults, and secrets in .env are kept.`));
  }

  // 1. Where it runs. This is the top-level branch: it decides the ports, the
  //    sidecars, the PUBLIC_URL and the sensible auth mode. Everything else
  //    follows from it.
  const mode = await select<Mode>(
    "mode",
    "Where will this run?",
    [
      {
        value: "local",
        label: "This machine only",
        hint: "Ports bound to 127.0.0.1. Nothing is exposed; put your own proxy in front if you want it reachable.",
      },
      {
        value: "caddy",
        label: "A public domain, with TLS handled here",
        hint: "Adds a Caddy sidecar that gets a certificate from Let's Encrypt.",
      },
      {
        value: "tailscale",
        label: "A tailnet, via Tailscale",
        hint: "Adds a Tailscale sidecar. The tailnet is the boundary; SSH and mosh just work.",
      },
    ],
    prev.mode ?? "local",
  );

  let publicUrl = "";
  let behindProxy: boolean | undefined;
  let domain: string | undefined;
  let httpsPort: number | undefined;
  let acmeEmail: string | undefined;
  let tsHostname: string | undefined;

  if (mode === "local") {
    behindProxy = await yesNo(
      "behindProxy",
      "Will something else terminate TLS in front of this (nginx, an ingress, a tunnel)?",
      prev.behindProxy ?? false,
    );
    publicUrl = behindProxy
      ? await ask(
          "publicUrl",
          "The URL people will actually type",
          prev.publicUrl ?? "https://agent.example.com",
          {
            validate: CHECKS.publicUrl,
          },
        )
      : "http://localhost:8080";
  }

  if (mode === "caddy") {
    domain = await ask("domain", "Domain name", prev.domain ?? "agent.example.com", {
      validate: CHECKS.domain,
    });
    // A non-standard HTTPS port is fine — Google allows ports in redirect URIs,
    // and one hostname across several ports shares the session cookie, which is
    // host-scoped. Port 443 is offered but not assumed: it is often taken.
    httpsPort = Number(
      await ask("httpsPort", "HTTPS port to serve on", String(prev.httpsPort ?? 8443), {
        validate: CHECKS.port,
      }),
    );
    acmeEmail = await ask(
      "acmeEmail",
      "Email for Let's Encrypt (expiry notices)",
      prev.acmeEmail ?? "",
      { optional: true, validate: CHECKS.acmeEmail },
    );
    publicUrl = publicUrlFor({ mode, domain, httpsPort, publicUrl });
  }

  if (mode === "tailscale") {
    // Google forbids raw IPs in redirect URIs, so the MagicDNS name is the only
    // address that works for the OAuth modes — and it is nicer anyway.
    tsHostname = await ask(
      "tsHostname",
      "Full MagicDNS name of this machine (e.g. work.tailXXXX.ts.net)",
      prev.tsHostname ?? "agent-env.example.ts.net",
      { validate: CHECKS.tsHostname },
    );
    publicUrl = publicUrlFor({ mode, tsHostname, publicUrl });
  }

  // 2. Who gets in. The mode decides what is reasonable here, which is the
  //    single best reason for this script to exist.
  const authDefault: AuthMode =
    prev.authMode ?? (mode === "tailscale" ? "none" : mode === "caddy" ? "google" : "basic");

  if (mode === "tailscale" && authDefault === "none") {
    note();
    warn("On a tailnet the usual answer is no extra auth: the tailnet is the boundary.");
    warn("Anyone on your tailnet then gets a root-capable shell in this container.");
    warn("If that is not what you want, pick one of the sign-ins below.");
  }

  const authMode = await select<AuthMode>(
    "authMode",
    "Who can get in?",
    [
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
    ],
    authDefault,
  );

  const refused = refusal({ mode, authMode });
  if (refused) fail(refused);
  if (authMode === "none" && mode === "local" && behindProxy) {
    warn("AUTH_MODE=none with a proxy in front: make sure the proxy is the one authenticating.");
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
    googleClientId = await ask(
      "googleClientId",
      "Google OAuth client ID",
      prev.googleClientId ?? "",
      { validate: CHECKS.googleClientId },
    );
    note(C.dim(`  Register this redirect URI with that client: ${publicUrl}/oauth2/callback`));
    allowedEmails = await ask(
      "allowedEmails",
      "Allowed emails (comma-separated)",
      prev.allowedEmails ?? "",
      { optional: true },
    );
    allowedEmailDomains = await ask(
      "allowedEmailDomains",
      "Allowed email domains (comma-separated)",
      prev.allowedEmailDomains ?? "",
      { optional: true },
    );
    const noList = allowListProblem({
      authMode,
      allowedEmails,
      allowedEmailDomains,
    });
    if (noList) fail(noList);
  }

  if (authMode === "github") {
    githubClientId = await ask(
      "githubClientId",
      "GitHub OAuth app client ID",
      prev.githubClientId ?? "",
    );
    note(C.dim(`  Register this callback URL with that app: ${publicUrl}/oauth2/callback`));
    githubUsers = await ask(
      "githubUsers",
      "Allowed GitHub usernames (comma-separated)",
      prev.githubUsers ?? "",
      { optional: true },
    );
    githubOrg = await ask("githubOrg", "Allowed GitHub organisation", prev.githubOrg ?? "", {
      optional: true,
    });
    githubTeam = await ask(
      "githubTeam",
      githubOrg
        ? "Allowed teams in that org (comma-separated slugs)"
        : "Allowed teams (comma-separated, each one org:team)",
      prev.githubTeam ?? "",
      {
        optional: true,
        // Blank stays valid — the question is optional, and this runs on
        // the empty answer too.
        validate: (v) => CHECKS.githubTeam(v, githubOrg),
      },
    );
    // The image counts an email rule as an allow list for GitHub too, so the
    // wizard has to be able to write one — otherwise an email-only deployment
    // the container would accept cannot be generated here at all.
    allowedEmails = await ask(
      "allowedEmails",
      "Allowed emails (comma-separated)",
      prev.allowedEmails ?? "",
      { optional: true },
    );
    allowedEmailDomains = await ask(
      "allowedEmailDomains",
      "Allowed email domains (comma-separated)",
      prev.allowedEmailDomains ?? "",
      { optional: true },
    );
    const noList = allowListProblem({
      authMode,
      githubUsers,
      githubOrg,
      githubTeam,
      allowedEmails,
      allowedEmailDomains,
    });
    if (noList) fail(noList);
  }

  if (authMode === "basic") {
    gatewayUser = await ask("gatewayUser", "Username", prev.gatewayUser ?? "dev");
  }

  // 3. What lives at /.
  const agentPreset = await select<Preset>(
    "preset",
    "What should this environment run?",
    [
      {
        value: "vanilla",
        label: "Nothing in particular",
        hint: "no agent installed; / goes to whatever you run on a port",
      },
      {
        value: "opencode",
        label: "OpenCode",
        hint: "installs OpenCode and serves its web UI at /",
      },
    ],
    prev.preset ?? "vanilla",
  );
  let primaryPort: number | undefined;
  let primaryCommand: string | undefined;
  // Not asked under opencode, so an answers file naming one would be dropped
  // without a word.
  if (agentPreset !== "vanilla" && preset.primaryCommand) {
    bad(
      "primaryCommand",
      "only the vanilla preset takes one; the opencode preset runs its own server",
    );
  }
  if (agentPreset === "vanilla") {
    primaryPort = Number(
      await ask(
        "primaryPort",
        "Port inside the container that / should proxy to",
        String(prev.primaryPort ?? 3000),
        { validate: CHECKS.port },
      ),
    );
    primaryCommand =
      (await ask(
        "primaryCommand",
        "A command to run there ($PORT is the port; blank to start your own later)",
        prev.primaryCommand ?? "",
        { optional: true },
      )) || undefined;
  }

  // 4. Extras. Each of these costs something, so they are asked rather than
  //    assumed.
  const rootlessDocker = await yesNo(
    "rootlessDocker",
    "Let the agent run its own containers (rootless Docker)?",
    prev.rootlessDocker ?? false,
  );
  if (rootlessDocker) {
    note(
      C.dim("  Adds five host flags that widen the sandbox. See the README before shipping this."),
    );
    if (mode === "tailscale") {
      warn("Rootless Docker inside the Tailscale network namespace is UNTESTED.");
      warn("Inner published ports land in the tailnet namespace and need serve config.");
    }
  }

  const sshKeys = await ask(
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
      await ask("sshPort", "Host port for SSH", String(prev.sshPort ?? 2222), {
        validate: CHECKS.port,
      }),
    );
  }

  // 5. Where the code lives. A host path needs PUID/PGID to match, which is
  //    the classic thing to get wrong by hand.
  const wsKind = await select<"volume" | "path">(
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
    let path = await ask(
      "workspacePath",
      "Host directory to mount at /workspace",
      prev.workspace?.path ?? "",
      { validate: CHECKS.workspacePath },
    );
    if (hostPathFor(path) !== path) {
      note(
        C.dim(
          `  Reading "${path}" as "${hostPathFor(path)}" — compose treats a bare name as a volume.`,
        ),
      );
      path = hostPathFor(path);
    }
    let puid = 1000,
      pgid = 1000;
    try {
      // Relative paths in the compose file resolve against the compose file,
      // which lives in --out — not against wherever this was run from.
      const st = statSync(path.startsWith("/") ? path : `${outDir.replace(/\/$/, "")}/${path}`);
      if (typeof st.uid === "number") puid = st.uid;
      if (typeof st.gid === "number") pgid = st.gid;
      note(
        C.dim(`  Owned by ${puid}:${pgid} — the container will run as that, so files stay yours.`),
      );
    } catch {
      warn(
        `Cannot stat ${path} — defaulting PUID/PGID to 1000:1000, fix in .env if that is wrong.`,
      );
    }
    workspace = { kind: "path", path, puid, pgid };
  }

  const timezone = await ask(
    "timezone",
    "Time zone",
    prev.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
  );

  // Checked where the numbers are still attached to the questions that
  // produced them.
  const clash = portClashProblem({
    mode,
    behindProxy,
    publicUrl,
    sshPort,
  });
  if (clash) fail(clash);

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
    preset: agentPreset,
    primaryPort,
    primaryCommand,
    rootlessDocker,
    sshKeys,
    sshPort,
    workspace,
    timezone,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

async function main() {
  outDir = arg("out") ?? ".";
  const force = args.includes("--force");
  const answersArg = arg("answers");

  if (answersArg) {
    preset = JSON.parse(readFileSync(answersArg, "utf8"));
    interactive = false;
  } else if (!process.stdin.isTTY) {
    // Falling back to defaults here would generate a deployment nobody chose,
    // and write it over whatever was there.
    note(C.r("No terminal to ask questions on."));
    note("  Run this interactively, or pass --answers <file.json> to say what");
    note("  you want. It will not guess.");
    process.exit(2);
  }

  const p = (f: string) => `${outDir.replace(/\/$/, "")}/${f}`;
  const prev: Partial<Answers> = JSON.parse(readIfExists(p(ANSWERS_FILE)) ?? "{}");
  const answers = await collect(prev);
  // collect() has already asked about everything validate() checks, one
  // question at a time; this is the backstop, not the first line.
  for (const problem of validate(answers)) fail(problem);
  const files = generate(answers, {
    existingEnv: readIfExists(p(".env")) ?? "",
  });

  note();
  const clobber = Object.keys(files).filter(
    (f) => f !== ANSWERS_FILE && readIfExists(p(f)) !== null,
  );
  if (clobber.length && !force && !interactive) {
    note(C.r("These already exist, and this is not an interactive run:"));
    note(`  ${clobber.join(", ")}`);
    note("  Pass --force to overwrite them.");
    process.exit(1);
  }
  if (clobber.length && !force && interactive) {
    note(`${C.y("These already exist and will be overwritten:")} ${clobber.join(", ")}`);
    if (!(await yesNo("__overwrite", "Overwrite them?", true))) {
      note("Nothing written.");
      process.exit(1);
    }
  }

  try {
    mkdirSync(outDir, { recursive: true });
  } catch {
    /* already there */
  }
  // Write beside, then rename: an interruption partway through used to leave
  // .env from one generation next to a compose file from another, which is a
  // deployment that never existed.
  const staged: [string, string][] = [];
  try {
    for (const [name, body] of Object.entries(files)) {
      const tmp = p(`.${name}.tmp`);
      writeFileSync(tmp, body);
      if (name === ".env") chmodSync(tmp, 0o600);
      staged.push([tmp, p(name)]);
    }
  } catch (e) {
    for (const [tmp] of staged) {
      try {
        rmSync(tmp);
      } catch {
        /* nothing to clean up */
      }
    }
    throw e;
  }
  for (const [tmp, final] of staged) {
    renameSync(tmp, final);
    note(`${C.g("wrote")} ${final}`);
  }

  // Both are inlined in compose.yaml now, so a copy on disk is from an older
  // generation whatever the mode.
  const stale = ["Caddyfile", "ts-serve.json"].filter(
    (f) => !(f in files) && readIfExists(p(f)) !== null,
  );
  if (stale.length) {
    note();
    for (const f of stale) {
      warn(`${p(f)} is left over from a previous run and is no longer used.`);
    }
    warn("Left in place in case you edited it — delete it when you are sure.");
  }

  note();
  note(C.b("Next:"));
  const oauth = answers.authMode === "google" || answers.authMode === "github";
  if (oauth) {
    const which = answers.authMode === "google" ? "Google" : "GitHub";
    const key = answers.authMode === "google" ? "GOOGLE_CLIENT_SECRET" : "GITHUB_CLIENT_SECRET";
    note(`  1. Put your ${which} client secret in .env (${key}).`);
    note(`  2. Register this redirect URI: ${answers.publicUrl}/oauth2/callback`);
  }
  if (answers.mode === "caddy") {
    note(
      `  ${
        oauth ? "3" : "1"
      }. Point an A record for ${answers.domain} at this host, before first start.`,
    );
  }
  if (answers.mode === "tailscale") {
    note(`  ${oauth ? "3" : "1"}. Put a tagged, reusable auth key in .env (TS_AUTHKEY).`);
  }
  note(`  ${"docker compose up -d"}`);
  note(`  ${"docker compose exec agent-env agent-env urls"}`);
  note();
  note(`Reachable at ${C.b(answers.publicUrl)}`);
  if (answers.sshPort) {
    note(`SSH on host port ${C.b(String(answers.sshPort))} — change it here if that is taken.`);
  }
  note(`The environment's own pages live under ${C.b(answers.publicUrl + "/~env/")}`);
}

await main();
finished = true;
rl?.close();
