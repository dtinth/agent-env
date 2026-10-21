/**
 * Tests for setup.ts.
 *
 *   vp test
 *
 * These run the wizard the way a person does — as a subprocess, writing real
 * files — rather than importing its internals. What matters is the generated
 * output, and output is the only thing a user ever sees.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertMatch, assertStringIncludes } from "./test-assert.ts";

const SETUP = new URL("./setup.ts", import.meta.url).pathname;
const ENV_EXAMPLE = new URL("./.env.example", import.meta.url).pathname;

const readText = (path: string) => readFileSync(path, "utf8");
const writeText = (path: string, body: string, opts: { append?: boolean } = {}) =>
  writeFileSync(path, body, { flag: opts.append ? "a" : "w" });

/**
 * Keys that belong to a sidecar rather than to the image, so they are correctly
 * absent from .env.example. Anything else the wizard emits has to be documented
 * there, or the two drift and .env.example stops being the reference.
 */
const SIDECAR_KEYS = new Set(["TS_AUTHKEY"]);

interface Run {
  code: number;
  stdout: string;
  dir: string;
}

function run(answers: Record<string, unknown>, dir: string, extra: string[] = []): Run {
  const file = `${dir}/answers.json`;
  writeText(file, JSON.stringify(answers));
  // Plain node, nothing else: this is exactly how a person runs it.
  const out = spawnSync(process.execPath, [SETUP, "--answers", file, "--out", dir, ...extra], {
    encoding: "utf8",
  });
  return { code: out.status ?? 1, stdout: out.stdout, dir };
}

/**
 * The body of an inline `configs:` entry, unindented and unescaped — what
 * compose hands the sidecar.
 */
function inlineConfig(compose: string, name: string): string {
  const m = new RegExp(`^  ${name}:\n    content: \\|\n((?:      .*\n|\n)*)`, "m").exec(compose);
  assert(m, `no inline config named ${name}`);
  return m[1]
    .split("\n")
    .map((l) => l.slice(6))
    .join("\n")
    .replaceAll("$$", "$");
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "agent-env-setup-"));
}

/**
 * The non-secret settings, hardcoded in compose.yaml as `- "KEY=value"` — what
 * the container receives, after Compose has turned $$ back into $.
 */
function settingsOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, quoted] of readText(`${dir}/compose.yaml`).matchAll(
    /^ {6}- ("[A-Z][A-Z0-9_]*=.*")$/gm,
  )) {
    const [k, ...v] = (JSON.parse(quoted) as string).split("=");
    out[k] = v.join("=").replaceAll("$$", "$");
  }
  return out;
}

/**
 * The *effective* value of each key, the way dotenv reads it — an unquoted
 * value ends at an unescaped #, and a quoted one is unwrapped. Comparing raw
 * file text instead would fail the wizard for preserving a line exactly, which
 * is the behaviour that keeps exotic values intact.
 */
function envOf(dir: string): Record<string, string> {
  const out: Record<string, string> = settingsOf(dir);
  for (const line of readText(`${dir}/.env`).split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2].trim();
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length > 1) {
      out[m[1]] = raw.slice(1, -1).replace(/\\(.)/g, "$1");
    } else if (raw.startsWith("'") && raw.endsWith("'") && raw.length > 1) {
      out[m[1]] = raw.slice(1, -1);
    } else {
      out[m[1]] = raw.replace(/\s+#.*$/, "").trim();
    }
  }
  return out;
}

const BASE = {
  preset: "opencode",
  rootlessDocker: false,
  sshKeys: "ssh-ed25519 AAAA test@host",
  sshPort: 2222,
  workspaceKind: "volume",
  timezone: "UTC",
};

const LOCAL = {
  ...BASE,
  mode: "local",
  behindProxy: false,
  authMode: "basic",
  gatewayUser: "dev",
};
const CADDY = {
  ...BASE,
  mode: "caddy",
  domain: "agent.example.com",
  httpsPort: 8443,
  acmeEmail: "me@example.com",
  authMode: "google",
  googleClientId: "1.apps.googleusercontent.com",
  allowedEmails: "me@example.com",
};
const GITHUB = {
  ...BASE,
  mode: "caddy",
  domain: "agent.example.com",
  httpsPort: 8443,
  acmeEmail: "me@example.com",
  authMode: "github",
  githubClientId: "Iv1.0123456789abcdef",
  githubOrg: "acme",
  githubTeam: "platform,sre",
};
const TS = {
  ...BASE,
  mode: "tailscale",
  tsHostname: "work.tail1234.ts.net",
  authMode: "none",
};
const PLATFORM = {
  ...BASE,
  sshPort: undefined,
  mode: "none",
  publicUrl: "https://agent.example.com",
  authMode: "github",
  githubClientId: "Iv1.0123456789abcdef",
  githubUsers: "octocat",
};

// ---------------------------------------------------------------------------

test("each mode generates a complete, self-consistent set of files", () => {
  for (const [name, answers, extra] of [
    ["local", LOCAL, []],
    ["caddy", CADDY, []],
    ["tailscale", TS, []],
  ] as const) {
    const dir = tmp();
    const r = run(answers, dir);
    assertEquals(r.code, 0, `${name} exited ${r.code}`);
    for (const f of [".env", "compose.yaml", ...extra]) {
      assert(statSync(`${dir}/${f}`).isFile(), `${name} did not write ${f}`);
    }
  }
});

test("every emitted key is documented in .env.example", () => {
  const documented = new Set(
    [...readText(ENV_EXAMPLE).matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]),
  );
  const undocumented = new Set<string>();
  for (const answers of [LOCAL, CADDY, GITHUB, TS]) {
    const dir = tmp();
    run(answers, dir);
    for (const [, k] of readText(`${dir}/.env`).matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)) {
      if (!documented.has(k) && !SIDECAR_KEYS.has(k)) undocumented.add(k);
    }
  }
  assertEquals(
    [...undocumented],
    [],
    ".env.example is the reference for every key; these would be undocumented",
  );
});

test("booleans are emitted canonically", () => {
  // The image accepts 1/yes/on/enabled too, but the healthcheck, the agent-env
  // helper and the smoke suite all compare against a literal. A non-canonical
  // value here would desynchronise them from what the entrypoint decided.
  const dir = tmp();
  run(
    {
      ...LOCAL,
      preset: "vanilla",
      primaryPort: 3000,
      rootlessDocker: true,
    },
    dir,
  );
  const env = envOf(dir);
  for (const k of ["DOCKER_ROOTLESS_ENABLE"]) {
    assertMatch(env[k], /^(true|false)$/, `${k}=${env[k]} is not canonical`);
  }
});

test("the vanilla preset takes a command, and $PORT survives Compose", () => {
  // Compose expands $VAR in a value, which would hand the command an empty
  // port. It has to come out as $$PORT in compose.yaml.
  const dir = tmp();
  const r = run(
    {
      ...LOCAL,
      preset: "vanilla",
      primaryPort: 3000,
      primaryCommand: "npm run dev -- --port $PORT",
    },
    dir,
  );
  assertEquals(r.code, 0);
  const env = readText(`${dir}/.env`);
  assert(!env.includes("PRIMARY_COMMAND"), "a setting, not a secret, landed in .env");
  assertStringIncludes(
    readText(`${dir}/compose.yaml`),
    "PRIMARY_COMMAND=npm run dev -- --port $$PORT",
  );
  assertEquals(envOf(dir).PRIMARY_COMMAND, "npm run dev -- --port $PORT");
});

test("clearing the command drops it from a regenerated .env", () => {
  // An old PRIMARY_COMMAND carried through from the previous .env would keep
  // running under vanilla and stop an opencode container from starting at all.
  const dir = tmp();
  const vanilla = { ...LOCAL, preset: "vanilla", primaryPort: 3000 };
  run({ ...vanilla, primaryCommand: "node app.js" }, dir);
  assertEquals(envOf(dir).PRIMARY_COMMAND, "node app.js");
  // Unmentioned answers fall back to the previous run's; clearing says so.
  run({ ...vanilla, primaryCommand: "" }, dir, ["--force"]);
  assert(!("PRIMARY_COMMAND" in envOf(dir)), "the cleared command came back");
  run({ ...vanilla, primaryCommand: "node app.js" }, dir, ["--force"]);
  run({ ...LOCAL, preset: "opencode", primaryCommand: "" }, dir, ["--force"]);
  assert(!("PRIMARY_COMMAND" in envOf(dir)), "switching to opencode kept the command");
});

test("the opencode preset runs its own server, so a command is refused", () => {
  const dir = tmp();
  const r = run({ ...LOCAL, preset: "opencode", primaryCommand: "node app.js" }, dir);
  assertEquals(r.code, 2);
  assert(!existsSync(`${dir}/compose.yaml`));
});

test("a public domain with no authentication is refused", () => {
  const dir = tmp();
  const r = run({ ...CADDY, authMode: "none" }, dir);
  assertEquals(r.code, 1);
  assertStringIncludes(r.stdout, "Refusing");
  // Nothing half-written: a refusal must not leave a deployable-looking file.
  assert(!existsSync(`${dir}/compose.yaml`), "compose.yaml written despite refusing");
  assert(!existsSync(`${dir}/.env`), ".env written despite refusing");
});

test("google sign-in without an allow list is refused", () => {
  const dir = tmp();
  const r = run({ ...CADDY, allowedEmails: "", allowedEmailDomains: "" }, dir);
  assertEquals(r.code, 1);
  assertStringIncludes(r.stdout, "allow list");
  assert(!existsSync(`${dir}/compose.yaml`));
});

test("re-running keeps the secrets and the hand edits in .env", () => {
  const dir = tmp();
  run(LOCAL, dir);
  const first = envOf(dir).GATEWAY_PASSWORD;
  assert(first && first.length > 12, "no password generated");

  writeText(`${dir}/.env`, "\nANTHROPIC_API_KEY=sk-ant-kept\n", {
    append: true,
  });
  run(LOCAL, dir, ["--force"]);

  const second = envOf(dir);
  assertEquals(second.GATEWAY_PASSWORD, first, "password rotated on re-run");
  assertEquals(second.ANTHROPIC_API_KEY, "sk-ant-kept", "hand-added key lost on re-run");
});

test("the cookie secret is persisted, so sessions survive a restart", () => {
  const dir = tmp();
  run(CADDY, dir);
  const s = envOf(dir).OAUTH2_PROXY_COOKIE_SECRET;
  // oauth2-proxy needs a decoded length of 16, 24 or 32 bytes.
  assertEquals(atob(s.replaceAll("-", "+").replaceAll("_", "/")).length, 32);
  run(CADDY, dir, ["--force"]);
  assertEquals(envOf(dir).OAUTH2_PROXY_COOKIE_SECRET, s, "cookie secret rotated");
});

test("the rootless-Docker flags are all present, or none are", () => {
  const off = tmp(),
    on = tmp();
  run(LOCAL, off);
  run({ ...LOCAL, rootlessDocker: true }, on);

  const offCompose = readText(`${off}/compose.yaml`);
  for (const flag of [
    "SYS_ADMIN",
    "seccomp=unconfined",
    "apparmor=unconfined",
    "systempaths=unconfined",
    "/dev/net/tun",
  ]) {
    assert(!offCompose.includes(flag), `${flag} present while rootless Docker is off`);
  }

  const onCompose = readText(`${on}/compose.yaml`);
  // Each one is load-bearing; four out of five leaves the daemon down with a
  // message, which is a worse failure than not offering it at all.
  for (const flag of [
    "SYS_ADMIN",
    "seccomp=unconfined",
    "apparmor=unconfined",
    "systempaths=unconfined",
    "/dev/net/tun",
  ]) {
    assertStringIncludes(onCompose, flag);
  }
  assertEquals(envOf(on).DOCKER_ROOTLESS_ENABLE, "true");
});

test("mode decides the network shape", () => {
  const local = tmp(),
    caddy = tmp(),
    ts = tmp();
  run(LOCAL, local);
  run(CADDY, caddy);
  run(TS, ts);

  // Local binds loopback only: nothing is reachable off this machine by accident.
  const l = readText(`${local}/compose.yaml`);
  for (const line of l.split("\n").filter((x) => /^\s+- "\d|^\s+- "127/.test(x))) {
    assertMatch(line, /127\.0\.0\.1:/, `local mode published ${line.trim()} on all interfaces`);
  }

  // ACME only ever validates on 80 or 443, so a site on 8443 still needs 80.
  const c = readText(`${caddy}/compose.yaml`);
  assertStringIncludes(c, '- "80:80"');
  assertStringIncludes(c, '- "8443:8443"');
  // Caddy cannot proxy raw TCP here, so SSH has to be published directly or
  // there is no way in but the browser.
  assertStringIncludes(c, ':22"');

  // Sharing the sidecar's namespace means this service cannot declare ports.
  const t = readText(`${ts}/compose.yaml`);
  assertStringIncludes(t, "network_mode: service:tailscale");
  const agentBlock = t.slice(t.indexOf("agent-env:"), t.indexOf("tailscale:"));
  assert(!/^\s+ports:/m.test(agentBlock), "ports declared alongside network_mode");
});

test("the name is the project and the hostname, and tells deployments apart", () => {
  // Unnamed, it is agent-env, as every deployment was before it could be named.
  const plain = tmp();
  run(LOCAL, plain);
  const p = readText(`${plain}/compose.yaml`);
  assertMatch(p, /^name: "agent-env"$/m);
  assertMatch(p, /^ {4}hostname: "agent-env"$/m);

  // A second deployment on the host is its own project, so it gets its own
  // containers and volumes instead of taking over the first's.
  const named = tmp();
  run({ ...LOCAL, name: "work-2" }, named);
  const n = readText(`${named}/compose.yaml`);
  assertMatch(n, /^name: "work-2"$/m);
  assertMatch(n, /^ {4}hostname: "work-2"$/m);
  // And a re-run remembers it.
  run(LOCAL, named);
  assertMatch(readText(`${named}/compose.yaml`), /^name: "work-2"$/m);

  // Compose wants both as strings, and unquoted YAML reads these as a number,
  // a float, null and a boolean.
  for (const name of ["123", "1e2", "null", "true"]) {
    const dir = tmp();
    run({ ...LOCAL, name }, dir);
    const c = readText(`${dir}/compose.yaml`);
    assertStringIncludes(c, `\nname: "${name}"\n`);
    assertStringIncludes(c, `\n    hostname: "${name}"\n`);
  }

  // Under Tailscale the sidecar owns the hostname; Docker refuses one on a
  // service that shares its network namespace.
  const ts = tmp();
  run({ ...TS, name: "work-2" }, ts);
  const t = readText(`${ts}/compose.yaml`);
  assertMatch(t, /^name: "work-2"$/m);
  const agentBlock = t.slice(t.indexOf("agent-env:"), t.indexOf("tailscale:"));
  assert(!/^\s+hostname:/m.test(agentBlock), "hostname declared alongside network_mode");

  // Both a project name and a hostname have to accept it.
  for (const name of ["Work", "work_2", "-work", "work.example"]) {
    const dir = tmp();
    assertEquals(run({ ...LOCAL, name }, dir).code, 2, `accepted name ${name}`);
  }
});

test("PUBLIC_URL matches what each mode actually serves", () => {
  const cases: [Record<string, unknown>, string][] = [
    [LOCAL, "http://localhost:8080"],
    [CADDY, "https://agent.example.com:8443"],
    // 443 unless asked otherwise; 80 is published for ACME either way.
    [{ ...CADDY, httpsPort: undefined }, "https://agent.example.com"],
    [TS, "https://work.tail1234.ts.net"],
    [PLATFORM, "https://agent.example.com"],
  ];
  for (const [answers, expected] of cases) {
    const dir = tmp();
    run(answers, dir);
    assertEquals(envOf(dir).PUBLIC_URL, expected);
  }
});

test(".env is written with restrictive permissions", () => {
  if (process.platform === "win32") return;
  const dir = tmp();
  run(LOCAL, dir);
  const mode = statSync(`${dir}/.env`).mode & 0o777;
  assertEquals(mode, 0o600, `.env is ${mode.toString(8)}, and it holds secrets`);
});

// ---------------------------------------------------------------------------
// Regressions. Each of these was a real defect found in review on this branch,
// reproduced before it was fixed.
// ---------------------------------------------------------------------------

test("a re-run keeps every key, not just the ones it knows", () => {
  // The first version carried an allowlist of secrets and dropped the rest, so
  // a MISE_TOOLS or DESKTOP_RESOLUTION added by hand vanished on the next run —
  // while the README said the file was safe to edit.
  const dir = tmp();
  run(LOCAL, dir);
  writeText(
    `${dir}/.env`,
    "\nMISE_TOOLS=python@3.13 go@latest\nDESKTOP_RESOLUTION=2560x1440x24\nOPENROUTER_API_KEY=sk-or-mine\n",
    { append: true },
  );
  run(LOCAL, dir, ["--force"]);
  const env = envOf(dir);
  assertEquals(env.MISE_TOOLS, "python@3.13 go@latest");
  assertEquals(env.DESKTOP_RESOLUTION, "2560x1440x24");
  assertEquals(env.OPENROUTER_API_KEY, "sk-or-mine");
});

test("behind a TLS proxy, the container does not bind the proxy's port", () => {
  // PUBLIC_URL is the proxy's address. Binding its port made the container
  // fight whatever is already terminating TLS on 443.
  const dir = tmp();
  run({ ...LOCAL, behindProxy: true, publicUrl: "https://agent.example.com" }, dir);
  const compose = readText(`${dir}/compose.yaml`);
  assert(!compose.includes("127.0.0.1:443:"), "bound the proxy's own port");
  assertStringIncludes(compose, "127.0.0.1:8080:8080");
  assertEquals(envOf(dir).PUBLIC_URL, "https://agent.example.com");
});

test("mosh's UDP range is published wherever SSH is", () => {
  for (const answers of [LOCAL, CADDY]) {
    const dir = tmp();
    run(answers, dir);
    assertStringIncludes(readText(`${dir}/compose.yaml`), "60000-60010:60000-60010/udp");
  }
});

test("a workspace path is data, not YAML syntax", () => {
  const dir = tmp();
  run({ ...LOCAL, workspaceKind: "path", workspacePath: "/srv/my:code" }, dir);
  assertStringIncludes(readText(`${dir}/compose.yaml`), '"/srv/my:code:/workspace"');
});

test("a workspace path cannot inject compose configuration", () => {
  const dir = tmp();
  const r = run(
    {
      ...LOCAL,
      workspaceKind: "path",
      workspacePath: "/srv/code\n    privileged: true",
    },
    dir,
  );
  assert(r.code !== 0, "accepted a path containing a newline");
  assert(!existsSync(`${dir}/compose.yaml`), "wrote a compose file anyway");
});

test("answers from a file face the same validators as typed ones", () => {
  // --answers is automation input, and automation is where a silently-wrong
  // value becomes a deployment nobody typed.
  for (const broken of [
    { ...LOCAL, mode: "nonsense" },
    { ...CADDY, httpsPort: "not-a-port" },
    { ...CADDY, domain: "https://not-a-bare-hostname" },
  ]) {
    const dir = tmp();
    const r = run(broken as Record<string, unknown>, dir);
    assertEquals(r.code, 2, `accepted ${JSON.stringify(broken).slice(0, 60)}`);
    assert(!existsSync(`${dir}/compose.yaml`));
  }
});

test("a setting kept in .env actually reaches the container", () => {
  // Carrying unknown keys into .env was only half the job: compose reads .env
  // for interpolation, so a key missing from the service's environment list
  // silently keeps the image default. The two lists are one list now.
  const dir = tmp();
  run(LOCAL, dir);
  writeText(`${dir}/.env`, "\nMISE_TOOLS=python@3.13\n", {
    append: true,
  });
  run(LOCAL, dir, ["--force"]);
  assertEquals(envOf(dir).MISE_TOOLS, "python@3.13");
  assertStringIncludes(readText(`${dir}/compose.yaml`), "- MISE_TOOLS");
});

test("a carried value keeps its quoting", () => {
  // dotenv truncates an unquoted value at the first #, so stripping the quotes
  // and writing the value back raw silently eats the rest of it.
  const dir = tmp();
  run(LOCAL, dir);
  writeText(`${dir}/.env`, `\nOPENCODE_CONFIG_CONTENT='part # suffix'\n`, {
    append: true,
  });
  run(LOCAL, dir, ["--force"]);
  const line = readText(`${dir}/.env`)
    .split("\n")
    .find((l) => l.startsWith("OPENCODE_CONFIG_CONTENT="))!;
  assert(
    /^OPENCODE_CONFIG_CONTENT=['"]part # suffix['"]$/.test(line),
    `value lost its quoting: ${line}`,
  );
});

test("two services cannot be given the same host port", () => {
  for (const [answers, why] of [
    [{ ...LOCAL, sshPort: 8080 }, "ssh vs gateway"],
    [{ ...CADDY, sshPort: 80 }, "ssh vs ACME"],
    [{ ...CADDY, sshPort: 8443 }, "ssh vs gateway through caddy"],
  ] as const) {
    const dir = tmp();
    const r = run(answers as Record<string, unknown>, dir);
    assertEquals(r.code, 1, `accepted a collision: ${why}`);
    assertStringIncludes(r.stdout, "claimed twice");
    assert(!existsSync(`${dir}/compose.yaml`));
  }
});

test("a non-boolean answer cannot enable a privileged feature", () => {
  // JSON has strings, and "false" is truthy. Inferring from truthiness meant a
  // typo added SYS_ADMIN and relaxed seccomp.

  // The canonical spellings are honoured, and "false" means false.
  const off = tmp();
  assertEquals(run({ ...LOCAL, rootlessDocker: "false" }, off).code, 0);
  assertEquals(envOf(off).DOCKER_ROOTLESS_ENABLE, "false");
  assert(
    !readText(`${off}/compose.yaml`).includes("SYS_ADMIN"),
    'the string "false" still widened the sandbox',
  );

  // Anything else is a typo, and guessing at it is how the sandbox gets
  // widened by accident.
  for (const v of ["no", "0", 0, "", null, "yes"]) {
    const dir = tmp();
    const r = run({ ...LOCAL, rootlessDocker: v } as Record<string, unknown>, dir);
    assertEquals(r.code, 2, `accepted rootlessDocker=${JSON.stringify(v)}`);
    assert(!existsSync(`${dir}/compose.yaml`));
  }
});

test("a managed value survives an inline comment", () => {
  const dir = tmp();
  run(LOCAL, dir);
  const env = readText(`${dir}/.env`).replace(
    /^GATEWAY_PASSWORD=.*$/m,
    "GATEWAY_PASSWORD=hunter2 # my password",
  );
  writeText(`${dir}/.env`, env);
  run(LOCAL, dir, ["--force"]);
  assertEquals(envOf(dir).GATEWAY_PASSWORD, "hunter2");
});

test("the top port is accepted for the gateway", () => {
  assertEquals(run({ ...CADDY, httpsPort: 65535 }, tmp()).code, 0);
});

test("a bare relative workspace path is read as a directory", () => {
  // Compose treats `workspace:/workspace` as a named volume that does not
  // exist, and rejects the whole file.
  const dir = tmp();
  run({ ...LOCAL, workspaceKind: "path", workspacePath: "code" }, dir);
  assertStringIncludes(readText(`${dir}/compose.yaml`), '"./code:/workspace"');
});

test("a crafted ACME email cannot write Caddy directives", () => {
  const dir = tmp();
  const r = run(
    {
      ...CADDY,
      acmeEmail: 'me@example.com\n}\n:80 {\n\trespond "x"',
    },
    dir,
  );
  assertEquals(r.code, 2);
  assert(!existsSync(`${dir}/compose.yaml`));
});

test("caddy mode inlines the Caddyfile in compose.yaml", () => {
  const dir = tmp();
  assertEquals(run(CADDY, dir).code, 0);
  assert(!existsSync(`${dir}/Caddyfile`), "wrote a separate Caddyfile");
  const compose = readText(`${dir}/compose.yaml`);
  assertStringIncludes(compose, "        target: /etc/caddy/Caddyfile");
  assertStringIncludes(compose, "  caddyfile:\n    content: |\n");
  assertStringIncludes(compose, "      agent.example.com:");
  assertStringIncludes(compose, "\treverse_proxy agent-env:8080");
});

test("memory, swap and CPU limits are optional, and say what they mean", () => {
  // None by default: a machine of its own wants none.
  const plain = tmp();
  run(LOCAL, plain);
  assert(!/mem_limit|memswap_limit|cpus:/.test(readText(`${plain}/compose.yaml`)));

  // Written in MiB, so a fractional GiB is still a whole number for Docker.
  // Swap is memory plus swap, which is how Docker counts it.
  const limited = tmp();
  assertEquals(run({ ...LOCAL, memoryGiB: 1.5, swapGiB: 2, cpus: 2.5 }, limited).code, 0);
  const c = readText(`${limited}/compose.yaml`);
  assertStringIncludes(c, '    mem_limit: "1536m"\n');
  assertStringIncludes(c, '    memswap_limit: "3584m"\n');
  assertStringIncludes(c, "    cpus: 2.5\n");

  // 0 is no swap: the total equals the memory.
  const noSwap = tmp();
  run({ ...LOCAL, memoryGiB: 8, swapGiB: 0 }, noSwap);
  assertStringIncludes(readText(`${noSwap}/compose.yaml`), '    memswap_limit: "8192m"\n');

  // Swap with no memory limit has nothing to sit on top of; the rest are
  // amounts, and nothing else.
  for (const bad of [{ swapGiB: 2 }, { memoryGiB: 0.5 }, { memoryGiB: "8g" }, { cpus: 0 }]) {
    const dir = tmp();
    assert(run({ ...LOCAL, ...bad }, dir).code !== 0, `accepted ${JSON.stringify(bad)}`);
    assert(!existsSync(`${dir}/compose.yaml`));
  }
});

test("on a platform nothing is published, only exposed", () => {
  // Dokploy and the like route to the container through their own proxy, so a
  // published port would only bypass it or collide with another stack.
  const dir = tmp();
  assertEquals(run(PLATFORM, dir).code, 0);
  const c = readText(`${dir}/compose.yaml`);
  assert(!/^\s+ports:/m.test(c), "a port was published");
  assertStringIncludes(c, '    expose:\n      - "8080"\n      - "22"\n');
  assert(!/^ {2}(caddy|tailscale):/m.test(c), "a sidecar was added");

  // The URL is the platform's, so there is nothing to derive it from.
  const missing = tmp();
  assertEquals(run({ ...PLATFORM, publicUrl: "" }, missing).code, 2);
});

test("an IP address gets a six-day certificate, and no Google sign-in", () => {
  // Let's Encrypt issues IP certificates only on its shortlived profile, so
  // Caddy has to ask for it, or every attempt is refused.
  const ip = { ...CADDY, domain: "203.0.113.7", authMode: "basic", gatewayUser: "dev" };
  const dir = tmp();
  assertEquals(run(ip, dir).code, 0);
  const caddyfile = inlineConfig(readText(`${dir}/compose.yaml`), "caddyfile");
  assertStringIncludes(caddyfile, "203.0.113.7:8443 {");
  assertStringIncludes(caddyfile, "\t\tissuer acme {\n\t\t\tprofile shortlived\n\t\t}");

  // A name keeps the ordinary 90-day certificate.
  const named = tmp();
  run(CADDY, named);
  assert(!inlineConfig(readText(`${named}/compose.yaml`), "caddyfile").includes("shortlived"));

  // Google's redirect URI rules: "Hosts cannot be raw IP addresses."
  const google = tmp();
  assertEquals(run({ ...CADDY, domain: "203.0.113.7" }, google).code, 1);
  assert(!existsSync(`${google}/compose.yaml`), "compose.yaml written despite refusing");

  // Something that only looks like an address is still not a hostname.
  const bad = tmp();
  assertEquals(run({ ...ip, domain: "203.0.113.256" }, bad).code, 2);
});

test("sidecar files from an older generation are reported as stale", () => {
  const cases: [Record<string, unknown>, string][] = [
    [CADDY, "Caddyfile"],
    [TS, "ts-serve.json"],
  ];
  for (const [answers, f] of cases) {
    const dir = tmp();
    writeText(`${dir}/${f}`, "old\n");
    const r = run(answers, dir, ["--force"]);
    assertEquals(r.code, 0);
    assertStringIncludes(r.stdout, `${f} is left over`);
    assertEquals(readText(`${dir}/${f}`), "old\n");
  }
});

test("tailscale mode inlines its serve config in compose.yaml", () => {
  const dir = tmp();
  assertEquals(run(TS, dir).code, 0);
  assert(!existsSync(`${dir}/ts-serve.json`), "wrote a separate ts-serve.json");
  const compose = readText(`${dir}/compose.yaml`);
  assertStringIncludes(compose, "        target: /config/serve.json");
  const serve = JSON.parse(inlineConfig(compose, "ts-serve"));
  assert(serve.Web["work.tail1234.ts.net:443"], "serve config lost its host");
});

test("a malformed domain is rejected", () => {
  for (const d of ["-a.example.com", "a..example.com", "example", "a.example.com-"]) {
    const dir = tmp();
    assertEquals(run({ ...CADDY, domain: d }, dir).code, 2, `accepted ${d}`);
  }
});

test("automation does not overwrite an existing deployment by omission", () => {
  const dir = tmp();
  assertEquals(run(LOCAL, dir).code, 0);
  const r = run(LOCAL, dir);
  assertEquals(r.code, 1, "overwrote without --force");
  assertStringIncludes(r.stdout, "--force");
  assertEquals(run(LOCAL, dir, ["--force"]).code, 0);
});

test("a reused credential keeps its exact value", () => {
  // Unescaping a quoted value and writing it back re-escaped turned pa\ss into
  // pass — a password that silently stopped being the password.
  const dir = tmp();
  run(LOCAL, dir);
  const env = readText(`${dir}/.env`).replace(
    /^GATEWAY_PASSWORD=.*$/m,
    String.raw`GATEWAY_PASSWORD="pa\\ss"`,
  );
  writeText(`${dir}/.env`, env);
  run(LOCAL, dir, ["--force"]);
  const line = readText(`${dir}/.env`)
    .split("\n")
    .find((l) => l.startsWith("GATEWAY_PASSWORD="))!;
  assertEquals(line, String.raw`GATEWAY_PASSWORD="pa\\ss"`);
});

test("a URL with a query or fragment is rejected", () => {
  // Every derived address appends to PUBLIC_URL, so a suffix here is inherited
  // by the OAuth redirect URI and everything else built on it.
  for (const u of [
    "https://a.example.com?x=1",
    "https://a.example.com#frag",
    "https://a.example.com/base",
    "ftp://a.example.com",
  ]) {
    const dir = tmp();
    assertEquals(run({ ...LOCAL, behindProxy: true, publicUrl: u }, dir).code, 2, `accepted ${u}`);
  }
});

test("an OAuth client id needs more than the suffix", () => {
  for (const id of [
    ".apps.googleusercontent.com",
    "apps.googleusercontent.com",
    "x.apps.googleusercontent.com.evil",
  ]) {
    const dir = tmp();
    assertEquals(run({ ...CADDY, googleClientId: id }, dir).code, 2, `accepted ${id}`);
  }
  const ok = tmp();
  assertEquals(
    run({ ...CADDY, googleClientId: "1234-abc.apps.googleusercontent.com" }, ok).code,
    0,
  );
});

test("every reused value round-trips byte for byte", () => {
  // Fixing one reuse path and leaving the others is how a quoted client secret
  // came back as "\"my secret\"". There are several kinds of reused value, so
  // check all of them rather than the one that was reported.
  const cases: [Record<string, unknown>, string, string][] = [
    [LOCAL, "GATEWAY_PASSWORD", `"pa ss"`],
    [CADDY, "GOOGLE_CLIENT_SECRET", `"my secret"`],
    [CADDY, "OAUTH2_PROXY_COOKIE_SECRET", `'quoted-cookie-secret-value-32ch!'`],
    [LOCAL, "ANTHROPIC_API_KEY", `"sk-with space"`],
    [TS, "TS_AUTHKEY", `"tskey with space"`],
    [LOCAL, "SOME_OTHER_SETTING", `"carried # verbatim"`],
  ];
  for (const [answers, key, raw] of cases) {
    const dir = tmp();
    run(answers, dir);
    const before = readText(`${dir}/.env`);
    const replaced = new RegExp(`^#?\\s*${key}=.*$`, "m").test(before)
      ? before.replace(new RegExp(`^#?\\s*${key}=.*$`, "m"), `${key}=${raw}`)
      : `${before}\n${key}=${raw}\n`;
    writeText(`${dir}/.env`, replaced);

    run(answers, dir, ["--force"]);
    const line = readText(`${dir}/.env`)
      .split("\n")
      .find((l) => l.startsWith(`${key}=`));
    assertEquals(line, `${key}=${raw}`, `${key} was rewritten`);
  }
});

test("an answer wrapped in whitespace is not taken literally", () => {
  // new URL() trims for its own parsing, so validation passed and the padded
  // string went on to be written as PUBLIC_URL.
  const dir = tmp();
  run({ ...LOCAL, behindProxy: true, publicUrl: " https://a.example.com " }, dir);
  assertEquals(envOf(dir).PUBLIC_URL, "https://a.example.com");
});

test("GitHub sign-in writes its own credentials and allow list", () => {
  const dir = tmp();
  const r = run(GITHUB, dir);
  assertEquals(r.code, 0);
  const env = envOf(dir);
  assertEquals(env.AUTH_MODE, "github");
  assertEquals(env.GITHUB_CLIENT_ID, "Iv1.0123456789abcdef");
  assertEquals(env.GITHUB_ORG, "acme");
  assertEquals(env.GITHUB_TEAM, "platform,sre");
  // Google's keys would be dead weight the operator has to reason about.
  assert(!("GOOGLE_CLIENT_ID" in env));
  // Both OAuth modes need the cookie secret persisted, or every restart
  // silently signs everyone out.
  assertMatch(env.OAUTH2_PROXY_COOKIE_SECRET, /^[A-Za-z0-9_-]{20,}$/);
  // The secret is the one thing the wizard cannot know.
  assertStringIncludes(env.GITHUB_CLIENT_SECRET, "CHANGEME");
  assertStringIncludes(r.stdout, "GITHUB_CLIENT_SECRET");
});

test("GitHub sign-in with no allow list is refused", () => {
  const dir = tmp();
  const r = run({ ...GITHUB, githubOrg: "", githubTeam: "", githubUsers: "" }, dir);
  assertEquals(r.code, 1);
  assertStringIncludes(r.stdout, "needs an allow list");
});

// The entrypoint counts an email rule as a GitHub allow list, so a deployment
// restricted only by address is one the container accepts — and therefore one
// the wizard has to be able to write, and to read back on a re-run.
test("GitHub sign-in can be restricted by email alone", () => {
  const dir = tmp();
  const answers = {
    ...GITHUB,
    githubOrg: "",
    githubTeam: "",
    githubUsers: "",
    allowedEmailDomains: "example.com",
  };
  const r = run(answers, dir);
  assertEquals(r.code, 0);
  assertEquals(envOf(dir).ALLOWED_EMAIL_DOMAINS, "example.com");
  assert(!("GITHUB_ORG" in envOf(dir)));

  const again = run(answers, dir, ["--force"]);
  assertEquals(again.code, 0);
  assertEquals(envOf(dir).ALLOWED_EMAIL_DOMAINS, "example.com");
  assertEquals(envOf(dir).AUTH_MODE, "github");
});

// The entrypoint counts an allow list after the separators come out of it, so
// the wizard has to as well: an answer like ", ," describes nobody, and taking
// it for an allow list writes a deployment the image then refuses to start.
test("an allow list of only separators is not an allow list", () => {
  const dir = tmp();
  const r = run(
    {
      ...GITHUB,
      githubUsers: ", ,",
      githubOrg: " ",
      githubTeam: "",
      allowedEmails: " ",
    },
    dir,
  );
  assertEquals(r.code, 1);
  assertStringIncludes(r.stdout, "needs an allow list");
});

// oauth2-proxy's hasTeam rejects an unqualified slug outright when no org is
// configured, so this combination starts and turns everyone away.
test("a team-only allow list must name its organisation", () => {
  const dir = tmp();
  const bad = run({ ...GITHUB, githubOrg: "", githubTeam: "platform" }, dir);
  assertEquals(bad.code, 2);
  assertStringIncludes(bad.stdout, "org:team");

  const good = run({ ...GITHUB, githubOrg: "", githubTeam: "acme:platform,other:sre" }, tmp());
  assertEquals(good.code, 0);
});

// With an org set, plain slugs are what oauth2-proxy wants.
test("teams inside an organisation stay plain slugs", () => {
  const dir = tmp();
  const r = run({ ...GITHUB, githubOrg: "acme", githubTeam: "platform" }, dir);
  assertEquals(r.code, 0);
  assertEquals(envOf(dir).GITHUB_TEAM, "platform");
});

// oauth2-proxy matches either team form literally — the bare slug when an org
// is set, `org:team` when not — so a half-written entry is a deployment that
// starts and turns everyone away.
test("a malformed team name is refused", () => {
  for (const team of ["acme:", ":platform", "acme:platform:extra"]) {
    const r = run({ ...GITHUB, githubOrg: "", githubTeam: team }, tmp());
    assertEquals(r.code, 2, `expected ${team} to be refused`);
    assertStringIncludes(r.stdout, "org:team");
  }
});

// The mirror: with an org set it is compared against the team name alone, so a
// qualified name never matches.
test("a qualified team name is refused when an org is set", () => {
  const r = run({ ...GITHUB, githubOrg: "acme", githubTeam: "acme:platform" }, tmp());
  assertEquals(r.code, 2);
  assertStringIncludes(r.stdout, "plain slug");
});

// The team question is optional, and its validator runs on the empty answer
// too — an interactive user with no org who skips it was stuck in a loop.
// A value that cleans away to nothing reaches the same branch through the
// answers file, which is the only path a test can drive.
test("an empty team list is not a malformed one", () => {
  const dir = tmp();
  const r = run({ ...GITHUB, githubTeam: ",", githubOrg: "acme" }, dir);
  assertEquals(r.code, 0);
  assert(!("GITHUB_TEAM" in envOf(dir)));
  assertEquals(envOf(dir).GITHUB_ORG, "acme");
});

// Clearing an allow list has to actually clear it. The carry-through pass
// exists so a key the wizard does not know about survives a re-run, but an
// allow list it just asked about is not one of those — restoring it would
// leave the operator looking at a file that still admits the account they
// removed.
test("a cleared allow list does not come back on a re-run", () => {
  const dir = tmp();
  const first = run({ ...GITHUB, githubUsers: "octocat", githubOrg: "acme" }, dir);
  assertEquals(first.code, 0);
  assertEquals(envOf(dir).GITHUB_USERS, "octocat");

  const again = run({ ...GITHUB, githubUsers: ", ,", githubOrg: "acme" }, dir, ["--force"]);
  assertEquals(again.code, 0);
  assert(!("GITHUB_USERS" in envOf(dir)));
  assertEquals(envOf(dir).GITHUB_ORG, "acme");
  // And it is not passed through to a container that has no value for it.
  assert(!readText(`${dir}/compose.yaml`).includes("GITHUB_USERS"));
});

// The same rule for SSH: a key removed from the answers is a key whose access
// was revoked, and carrying it through would leave it authorized.
test("removed SSH keys do not come back on a re-run", () => {
  const dir = tmp();
  run({ ...LOCAL, sshKeys: "ssh-ed25519 AAAA old@host" }, dir);
  assertEquals(envOf(dir).SSH_AUTHORIZED_KEYS, "ssh-ed25519 AAAA old@host");
  assertEquals(run({ ...LOCAL, sshKeys: "" }, dir, ["--force"]).code, 0);
  assert(!("SSH_AUTHORIZED_KEYS" in envOf(dir)), "a removed key is still authorized");
});

// And for every allow list when the sign-in changes: a list left behind in
// .env comes back into force the moment AUTH_MODE is pointed at it again.
test("allow lists do not survive a change of sign-in", () => {
  const dir = tmp();
  run({ ...GITHUB, githubUsers: "octocat", allowedEmails: "me@example.com" }, dir);
  assertEquals(run({ ...GITHUB, authMode: "basic" }, dir, ["--force"]).code, 0);
  const env = envOf(dir);
  for (const k of [
    "GITHUB_USERS",
    "GITHUB_ORG",
    "GITHUB_TEAM",
    "ALLOWED_EMAILS",
    "ALLOWED_EMAIL_DOMAINS",
  ]) {
    assert(!(k in env), `${k} outlived the switch to basic auth`);
  }
});

test("the home directory can come from the host", () => {
  const dir = tmp();
  run({ ...LOCAL, homeKind: "path", homePath: "home" }, dir);
  const compose = readText(`${dir}/compose.yaml`);
  assertStringIncludes(compose, '"./home:/home/dev"');
  assert(!/^ {2}home:$/m.test(compose));
});

test("the wizard takes a desktop size, scale and backend from an answers file", () => {
  const dir = tmp();
  run({ ...LOCAL, desktopSize: "2560x1440", desktopScale: 150, desktopBackend: "selkies" }, dir);
  const compose = readText(`${dir}/compose.yaml`);
  assertStringIncludes(compose, "DESKTOP_RESOLUTION=2560x1440x24");
  assertStringIncludes(compose, "DESKTOP_DPI=144");
  assertStringIncludes(compose, "DESKTOP_BACKEND=selkies");
});

test("answers from before they moved into compose.yaml are still offered", () => {
  // A deployment made by an older version has agent-env.setup.json beside it
  // and no x-agent-env key. Its answers must still come back as defaults.
  const dir = tmp();
  const vanilla = { ...LOCAL, preset: "vanilla", primaryPort: 3000 };
  writeText(
    `${dir}/agent-env.setup.json`,
    JSON.stringify({ ...vanilla, primaryCommand: "node app.js" }),
  );
  const r = run(vanilla, dir);
  assertEquals(r.code, 0);
  assertEquals(envOf(dir).PRIMARY_COMMAND, "node app.js");
  assertStringIncludes(r.stdout, "agent-env.setup.json is left over");
  // From here on compose.yaml is where they come from.
  assertStringIncludes(readText(`${dir}/compose.yaml`), '"primaryCommand":"node app.js"');
});
