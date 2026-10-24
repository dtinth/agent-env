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
  answersFromCompose,
  type AuthMode,
  CHECKS,
  DEFAULT_NAME,
  generate,
  hostPathFor,
  clientSecretKey,
  GOOGLE_CLIENT_CREATE_URL,
  isIPv4,
  needsClientSecret,
  LEGACY_ANSWERS_FILE,
  type Mode,
  type Component,
  COMPONENTS,
  DEFAULT_COMPONENTS,
  DEFAULT_DESKTOP_SIZE,
  desktopOf,
  DESKTOP_SIZES,
  isComponent,
  migrateAnswers,
  portClashProblem,
  type Problem,
  publicUrlFor,
  refusal,
  sortComponents,
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
/**
 * The OAuth client secret, if one was pasted. Kept apart from the answers,
 * which compose.yaml carries; it is for .env only.
 */
let clientSecret: string | undefined;

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

  // The name tells deployments on one host apart: Compose keys its containers
  // and volumes on it, and outside Tailscale it is the shell prompt's hostname.
  const name = await ask("name", "Name of this environment", prev.name ?? DEFAULT_NAME, {
    validate: CHECKS.name,
  });

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
      {
        value: "none",
        label: "None: a platform routes to it",
        hint: "For Dokploy, Coolify and the like. Publishes no ports; the platform's proxy reaches port 8080.",
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

  if (mode === "none") {
    publicUrl = await ask(
      "publicUrl",
      "The URL the platform serves this at",
      prev.publicUrl ?? "https://agent.example.com",
      { validate: CHECKS.publicUrl },
    );
  }

  if (mode === "caddy") {
    // An IPv4 address works too: Caddy asks Let's Encrypt for a six-day
    // certificate, the only kind it issues for an address.
    domain = await ask(
      "domain",
      "Domain name, or this host's public IPv4 address",
      prev.domain ?? "agent.example.com",
      { validate: CHECKS.domain },
    );
    // A non-standard HTTPS port is fine — Google allows ports in redirect URIs,
    // and one hostname across several ports shares the session cookie, which is
    // host-scoped. 80 is published for ACME either way.
    httpsPort = Number(
      await ask("httpsPort", "HTTPS port to serve on", String(prev.httpsPort ?? 443), {
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
      prev.tsHostname ?? `${name}.example.ts.net`,
      { validate: CHECKS.tsHostname },
    );
    publicUrl = publicUrlFor({ mode, tsHostname, publicUrl });
  }

  // 2. Who gets in. The mode decides what is reasonable here, which is the
  //    single best reason for this script to exist.
  const authDefault: AuthMode =
    prev.authMode ??
    (mode === "tailscale" ? "none" : mode === "caddy" || mode === "none" ? "google" : "basic");

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
  if (authMode === "none" && ((mode === "local" && behindProxy) || mode === "none")) {
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
    // In the order Google's console asks for things.
    note();
    note(`  1. Open ${GOOGLE_CLIENT_CREATE_URL}`);
    note(`  2. Pick ${C.b("Web application")}, and add this under Authorized redirect URIs:`);
    note(`       ${publicUrl}/oauth2/callback`);
    note("  3. Create it, and paste what it shows:");
    googleClientId = await ask("googleClientId", "Client ID", prev.googleClientId ?? "", {
      validate: CHECKS.googleClientId,
    });
    // Asked only at the terminal: an answers file is kept as the record of a
    // deployment, and a secret does not belong in one.
    if (interactive) {
      const kept = !needsClientSecret("google", readIfExists(`${outDir}/.env`) ?? "");
      clientSecret =
        (await ask(
          "__googleClientSecret",
          `Client secret (${kept ? "blank keeps the one in .env" : "blank to put it in .env later"})`,
          "",
          { optional: true },
        )) || undefined;
    }
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

  // 3. What runs. One list, AGENT_ENV_COMPONENTS, asked about a piece at a
  //    time; each piece defaults to what was running before.
  const components = await chooseComponents(prev.components, mode);
  const desktop = desktopOf(components);

  const knownSize = (v: string | undefined) => DESKTOP_SIZES.some((s) => s.value === v);
  const sizeCheck = (v: string) => (/^\d{3,5}x\d{3,5}$/.test(v) ? null : "write it like 1920x1080");
  // Without a desktop these are not asked, and the previous ones are kept for
  // when it comes back.
  let desktopSize = prev.desktopSize;
  let desktopScale = prev.desktopScale;
  if (desktop && "desktopSize" in preset) {
    // An --answers file names the size outright; there is no menu to pick from.
    desktopSize = await ask("desktopSize", "Screen size", DEFAULT_DESKTOP_SIZE, {
      validate: sizeCheck,
    });
  } else if (desktop) {
    const pick = await select<string>(
      "desktopSizePick",
      "How big should the desktop screen be?",
      [
        ...DESKTOP_SIZES.map((s) => ({ value: s.value as string, label: s.label })),
        { value: "custom", label: "Something else", hint: "you type width and height" },
      ],
      prev.desktopSize && !knownSize(prev.desktopSize)
        ? "custom"
        : (prev.desktopSize ?? DEFAULT_DESKTOP_SIZE),
    );
    desktopSize =
      pick === "custom"
        ? await ask(
            "desktopSizeCustom",
            "Width x height, like 2200x1300",
            prev.desktopSize ?? DEFAULT_DESKTOP_SIZE,
            {
              validate: sizeCheck,
            },
          )
        : pick;
  }
  desktopSize = desktopSize?.toLowerCase();
  if (desktop) {
    // A number in an answers file, a menu string at the prompt.
    if ("desktopScale" in preset) preset.desktopScale = String(preset.desktopScale);
    desktopScale = Number(
      await select<string>(
        "desktopScale",
        "How large should text and windows look? (raise it on a high-resolution screen)",
        [
          { value: "100", label: "100%", hint: "normal" },
          { value: "125", label: "125%" },
          { value: "150", label: "150%" },
          { value: "200", label: "200%", hint: "HiDPI, for a 4K screen" },
          { value: "300", label: "300%" },
        ],
        String(prev.desktopScale ?? 100),
      ),
    );
  }
  let primaryPort: number | undefined;
  let primaryCommand: string | undefined;
  const opencode = components.includes("opencode");
  // Not asked with opencode, so an answers file naming one would be dropped
  // without a word.
  if (opencode && preset.primaryCommand) {
    bad("primaryCommand", "OpenCode is at /, so there is no command to run there");
  }
  if (!opencode) {
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

  // Limits are for a shared host. Blank means none, which is what a machine of
  // its own wants. On a re-run, Enter keeps the limit already there, as with
  // every other question, so "-" takes over what blank meant.
  const optionalNumber = async (
    key: string,
    question: string,
    prevValue: number | undefined,
    validate: (v: string) => string | null,
  ): Promise<number | undefined> => {
    const v = await ask(
      key,
      prevValue === undefined ? question : question.replace("blank", "-"),
      prevValue === undefined ? "" : String(prevValue),
      { optional: true, validate: (v) => (v === "-" ? null : validate(v)) },
    );
    return v && v !== "-" ? Number(v) : undefined;
  };
  const memoryGiB = await optionalNumber(
    "memoryGiB",
    "Memory limit in GiB (blank for none)",
    prev.memoryGiB,
    CHECKS.memoryGiB,
  );
  // Not asked without a memory limit, but read from an answers file anyway, so
  // validation can say it needs one rather than it vanishing.
  const swapGiB =
    memoryGiB === undefined && !("swapGiB" in preset)
      ? undefined
      : await optionalNumber(
          "swapGiB",
          "Swap on top of that in GiB (0 for none; blank lets Docker allow as much again)",
          prev.swapGiB,
          CHECKS.swapGiB,
        );
  const cpus = await optionalNumber(
    "cpus",
    "CPU limit, like 2 or 0.5 (blank for none)",
    prev.cpus,
    CHECKS.cpus,
  );

  const sshKeys = await ask(
    "sshKeys",
    "SSH public key(s) for the dev user (separate several with ;)",
    prev.sshKeys ?? "",
    { optional: true },
  );
  if (!sshKeys) {
    warn("No SSH keys: you will only be able to get in through the browser.");
  }

  // On a tailnet SSH is reached on the tailnet address with nothing published,
  // and a platform publishes nothing at all, so neither needs asking. Everywhere
  // else it is a host port, and 2222 is often already taken.
  let sshPort: number | undefined;
  if (mode !== "tailscale" && mode !== "none") {
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

  // Owner of a bind-mounted directory, which the container's user must match.
  // Relative paths in the compose file resolve against the compose file, which
  // lives in --out — not against wherever this was run from.
  const ownerOf = (path: string) => {
    let puid = 1000,
      pgid = 1000;
    try {
      const st = statSync(path.startsWith("/") ? path : `${outDir.replace(/\/$/, "")}/${path}`);
      if (typeof st.uid === "number") puid = st.uid;
      if (typeof st.gid === "number") pgid = st.gid;
      note(
        C.dim(`  Owned by ${puid}:${pgid} — the container will run as that, so files stay yours.`),
      );
    } catch {
      warn(
        `Cannot stat ${path} — defaulting PUID/PGID to 1000:1000, fix in compose.yaml if that is wrong.`,
      );
    }
    return { puid, pgid };
  };

  const askHostPath = async (key: string, label: string, previous: string) => {
    const path = await ask(key, label, previous, { validate: CHECKS.workspacePath });
    if (hostPathFor(path) === path) return path;
    note(
      C.dim(
        `  Reading "${path}" as "${hostPathFor(path)}" — compose treats a bare name as a volume.`,
      ),
    );
    return hostPathFor(path);
  };

  let workspace: Workspace = { kind: "volume" };
  if (wsKind === "path") {
    const path = await askHostPath(
      "workspacePath",
      "Host directory to mount at /workspace",
      prev.workspace?.path ?? "",
    );
    workspace = { kind: "path", path, ...ownerOf(path) };
  }

  // 6. The home directory holds logins, dotfiles and installed tools. A host
  //    directory makes them easy to back up and inspect.
  const homeKind = await select<"volume" | "path">(
    "homeKind",
    "Where should the home directory (/home/dev) come from?",
    [
      {
        value: "volume",
        label: "A Docker volume",
        hint: "Managed by Docker; survives recreation.",
      },
      {
        value: "path",
        label: "A directory on this host",
        hint: "Back up or inspect logins and dotfiles directly.",
      },
    ],
    prev.home?.kind ?? "volume",
  );

  let home: Workspace = { kind: "volume" };
  if (homeKind === "path") {
    const path = await askHostPath(
      "homePath",
      "Host directory to mount at /home/dev",
      prev.home?.path ?? "",
    );
    // One container user owns both, so /workspace's IDs win if it is a path too.
    home = { kind: "path", path, ...(workspace.kind === "path" ? {} : ownerOf(path)) };
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
    name,
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
    components,
    desktopSize,
    desktopScale,
    primaryPort,
    primaryCommand,
    memoryGiB,
    swapGiB,
    cpus,
    sshKeys,
    sshPort,
    workspace,
    home,
    timezone,
  };
}

/**
 * AGENT_ENV_COMPONENTS, a question per component. An answers file gives the
 * list as `components`, or in version 1's terms (`preset`, `desktopBackend`,
 * `rootlessDocker`), which still mean what they did.
 */
async function chooseComponents(
  previous: Component[] | undefined,
  mode: Mode,
): Promise<Component[]> {
  let start = previous ?? [...DEFAULT_COMPONENTS];
  const old = ["preset", "desktopBackend", "rootlessDocker"].filter((k) => k in preset);
  if ("components" in preset && old.length) {
    bad(old[0], "give the components, or the older preset/desktopBackend/rootlessDocker, not both");
  }
  if ("components" in preset) {
    const given = preset.components;
    const list = Array.isArray(given)
      ? given
      : typeof given === "string"
        ? given
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean)
        : null;
    if (!list) bad("components", 'expected a list, like ["desktop", "terminal"]');
    const unknown = list.filter((c) => !isComponent(c));
    if (unknown.length) {
      bad("components", `unknown ${unknown.join(", ")}; expected some of ${COMPONENTS.join(", ")}`);
    }
    // Both desktops is an answer to report, not to quietly resolve: validate
    // says so after the questions.
    return sortComponents(list);
  }
  // Version 1's keys, checked as strictly as they were then: "false" must not
  // be read as true and widen the sandbox.
  const legacy: { preset?: string; desktopBackend?: string; rootlessDocker?: boolean } = {};
  if ("preset" in preset) {
    legacy.preset = await select(
      "preset",
      "",
      [
        { value: "vanilla", label: "" },
        { value: "opencode", label: "" },
      ],
      "vanilla",
    );
  }
  if ("desktopBackend" in preset) {
    legacy.desktopBackend = await select(
      "desktopBackend",
      "",
      [
        { value: "novnc", label: "" },
        { value: "selkies", label: "" },
      ],
      "novnc",
    );
  }
  if ("rootlessDocker" in preset) {
    legacy.rootlessDocker = await yesNo("rootlessDocker", "", false);
  }
  if (Object.keys(legacy).length) {
    start = migrateAnswers({ components: start, ...legacy }).components ?? start;
  }
  if (!interactive) return start;

  const on = new Set<Component>(start);
  const desktop = await select<"none" | Component>(
    "__desktop",
    "A desktop in the browser?",
    [
      {
        value: "desktop",
        label: "Yes, with noVNC",
        hint: "works everywhere, several people can drive it at once",
      },
      {
        value: "desktop-selkies",
        label: "Yes, with Selkies (prototype)",
        hint: "audio and smoother video; needs https or localhost, one person drives",
      },
      { value: "none", label: "No desktop" },
    ],
    desktopOf(start) ?? "none",
  );
  on.delete("desktop");
  on.delete("desktop-selkies");
  if (desktop !== "none") on.add(desktop);

  const choose = async (c: Component, question: string) => {
    if (await yesNo(`__${c}`, question, on.has(c))) on.add(c);
    else on.delete(c);
  };
  await choose("terminal", "A terminal in the browser?");
  await choose("files", "A file manager in the browser?");
  await choose("opencode", "OpenCode at /?");
  await choose("docker", "Let the agent run its own containers (rootless Docker)?");
  if (on.has("docker")) {
    note(
      C.dim("  Adds five host flags that widen the sandbox. See AGENTS.md before shipping this."),
    );
    if (mode === "tailscale") {
      warn("Rootless Docker inside the Tailscale network namespace is UNTESTED.");
      warn("Inner published ports land in the tailnet namespace and need serve config.");
    }
  }
  await choose("smb", "Share the workspace over SMB, for the Files app or Finder?");
  if (on.has("smb")) {
    note(C.dim("  Sign in as dev; the password is on the /~env/ page."));
    if (mode !== "tailscale") {
      note(C.dim("  Port 445 is not published: forward it yourself, on a network you trust."));
    }
  }
  return sortComponents([...on]);
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
  // The answers live in compose.yaml now; a deployment from before that still
  // has them in the file beside it.
  // Either may be from before components, and so may the .env beside them.
  const prev: Partial<Answers> = migrateAnswers(
    answersFromCompose(readIfExists(p("compose.yaml")) ?? "") ??
      JSON.parse(readIfExists(p(LEGACY_ANSWERS_FILE)) ?? "{}"),
    readIfExists(p(".env")) ?? "",
  );
  const answers = await collect(prev);
  // collect() has already asked about everything validate() checks, one
  // question at a time; this is the backstop, not the first line.
  for (const problem of validate(answers)) fail(problem);
  const files = generate(answers, {
    existingEnv: readIfExists(p(".env")) ?? "",
    clientSecret,
  });

  note();
  const clobber = Object.keys(files).filter((f) => readIfExists(p(f)) !== null);
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

  // All three are inlined in compose.yaml now, so a copy on disk is from an
  // older generation whatever the mode.
  const stale = ["Caddyfile", "ts-serve.json", LEGACY_ANSWERS_FILE].filter(
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
  // Numbered as they come: which steps there are depends on the answers.
  let n = 0;
  const step = (s: string) => note(`  ${++n}. ${s}`);
  const key = clientSecretKey(answers.authMode);
  // Only while .env still has the placeholder: a pasted or kept secret is done.
  if (key && needsClientSecret(answers.authMode, files[".env"])) {
    const which = answers.authMode === "google" ? "Google" : "GitHub";
    step(`Put your ${which} client secret in .env (${key}).`);
  }
  // Google's was one of the questions; GitHub's is still to do.
  if (answers.authMode === "github") {
    step(`Register this redirect URI: ${answers.publicUrl}/oauth2/callback`);
  }
  // An address needs no record; it is already where it points.
  if (answers.mode === "caddy" && !isIPv4(answers.domain ?? "")) {
    step(`Point an A record for ${answers.domain} at this host, before first start.`);
  }
  if (answers.mode === "tailscale") {
    step("Put a tagged, reusable auth key in .env (TS_AUTHKEY).");
  }
  if (answers.mode === "none") {
    step(`Have the platform route ${answers.publicUrl} to port 8080 of the agent-env service.`);
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
