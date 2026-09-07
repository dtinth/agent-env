/**
 * Tests for setup.ts.
 *
 *   deno test -A
 *
 * These run the wizard the way a person does — as a subprocess, writing real
 * files — rather than importing its internals. What matters is the generated
 * output, and output is the only thing a user ever sees.
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";

const SETUP = new URL("./setup.ts", import.meta.url).pathname;
const ENV_EXAMPLE = new URL("./.env.example", import.meta.url).pathname;

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

function run(
  answers: Record<string, unknown>,
  dir: string,
  extra: string[] = [],
): Run {
  const file = `${dir}/answers.json`;
  Deno.writeTextFileSync(file, JSON.stringify(answers));
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", SETUP, "--answers", file, "--out", dir, ...extra],
    stdout: "piped",
    stderr: "piped",
  });
  const out = cmd.outputSync();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout), dir };
}

function tmp(): string {
  return Deno.makeTempDirSync({ prefix: "agent-env-setup-" });
}

/**
 * The *effective* value of each key, the way dotenv reads it — an unquoted
 * value ends at an unescaped #, and a quoted one is unwrapped. Comparing raw
 * file text instead would fail the wizard for preserving a line exactly, which
 * is the behaviour that keeps exotic values intact.
 */
function envOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of Deno.readTextFileSync(`${dir}/.env`).split("\n")) {
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
  opencodeEnable: true,
  dashboard: true,
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
  gatewayUser: "opencode",
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

// ---------------------------------------------------------------------------

Deno.test("each mode generates a complete, self-consistent set of files", () => {
  for (
    const [name, answers, extra] of [
      ["local", LOCAL, []],
      ["caddy", CADDY, ["Caddyfile"]],
      ["tailscale", TS, ["ts-serve.json"]],
    ] as const
  ) {
    const dir = tmp();
    const r = run(answers, dir);
    assertEquals(r.code, 0, `${name} exited ${r.code}`);
    for (
      const f of [".env", "compose.yaml", "agent-env.setup.json", ...extra]
    ) {
      assert(Deno.statSync(`${dir}/${f}`).isFile, `${name} did not write ${f}`);
    }
  }
});

Deno.test("every emitted key is documented in .env.example", () => {
  const documented = new Set(
    [
      ...Deno.readTextFileSync(ENV_EXAMPLE).matchAll(
        /^#?\s*([A-Z][A-Z0-9_]*)=/gm,
      ),
    ].map((m) => m[1]),
  );
  const undocumented = new Set<string>();
  for (const answers of [LOCAL, CADDY, GITHUB, TS]) {
    const dir = tmp();
    run(answers, dir);
    for (
      const [, k] of Deno.readTextFileSync(`${dir}/.env`).matchAll(
        /^#?\s*([A-Z][A-Z0-9_]*)=/gm,
      )
    ) {
      if (!documented.has(k) && !SIDECAR_KEYS.has(k)) undocumented.add(k);
    }
  }
  assertEquals(
    [...undocumented],
    [],
    ".env.example is the reference for every key; these would be undocumented",
  );
});

Deno.test("booleans are emitted canonically", () => {
  // The image accepts 1/yes/on/enabled too, but the healthcheck, the agent-env
  // helper and the smoke suite all compare against a literal. A non-canonical
  // value here would desynchronise them from what the entrypoint decided.
  const dir = tmp();
  run({
    ...LOCAL,
    opencodeEnable: false,
    primaryPort: 3000,
    rootlessDocker: true,
  }, dir);
  const env = envOf(dir);
  for (
    const k of [
      "OPENCODE_ENABLE",
      "AB_DASHBOARD_ENABLE",
      "DOCKER_ROOTLESS_ENABLE",
    ]
  ) {
    assertMatch(env[k], /^(true|false)$/, `${k}=${env[k]} is not canonical`);
  }
});

Deno.test("a public domain with no authentication is refused", () => {
  const dir = tmp();
  const r = run({ ...CADDY, authMode: "none" }, dir);
  assertEquals(r.code, 1);
  assertStringIncludes(r.stdout, "Refusing");
  // Nothing half-written: a refusal must not leave a deployable-looking file.
  assert(
    !existsSync(`${dir}/compose.yaml`),
    "compose.yaml written despite refusing",
  );
  assert(!existsSync(`${dir}/.env`), ".env written despite refusing");
});

Deno.test("google sign-in without an allow list is refused", () => {
  const dir = tmp();
  const r = run({ ...CADDY, allowedEmails: "", allowedEmailDomains: "" }, dir);
  assertEquals(r.code, 1);
  assertStringIncludes(r.stdout, "allow list");
  assert(!existsSync(`${dir}/compose.yaml`));
});

Deno.test("re-running keeps the secrets and the hand edits in .env", () => {
  const dir = tmp();
  run(LOCAL, dir);
  const first = envOf(dir).GATEWAY_PASSWORD;
  assert(first && first.length > 12, "no password generated");

  Deno.writeTextFileSync(`${dir}/.env`, "\nANTHROPIC_API_KEY=sk-ant-kept\n", {
    append: true,
  });
  run(LOCAL, dir, ["--force"]);

  const second = envOf(dir);
  assertEquals(second.GATEWAY_PASSWORD, first, "password rotated on re-run");
  assertEquals(
    second.ANTHROPIC_API_KEY,
    "sk-ant-kept",
    "hand-added key lost on re-run",
  );
});

Deno.test("the cookie secret is persisted, so sessions survive a restart", () => {
  const dir = tmp();
  run(CADDY, dir);
  const s = envOf(dir).OAUTH2_PROXY_COOKIE_SECRET;
  // oauth2-proxy needs a decoded length of 16, 24 or 32 bytes.
  assertEquals(atob(s.replaceAll("-", "+").replaceAll("_", "/")).length, 32);
  run(CADDY, dir, ["--force"]);
  assertEquals(
    envOf(dir).OAUTH2_PROXY_COOKIE_SECRET,
    s,
    "cookie secret rotated",
  );
});

Deno.test("the rootless-Docker flags are all present, or none are", () => {
  const off = tmp(), on = tmp();
  run(LOCAL, off);
  run({ ...LOCAL, rootlessDocker: true }, on);

  const offCompose = Deno.readTextFileSync(`${off}/compose.yaml`);
  for (
    const flag of [
      "SYS_ADMIN",
      "seccomp=unconfined",
      "systempaths=unconfined",
      "/dev/net/tun",
    ]
  ) {
    assert(
      !offCompose.includes(flag),
      `${flag} present while rootless Docker is off`,
    );
  }

  const onCompose = Deno.readTextFileSync(`${on}/compose.yaml`);
  // Each one is load-bearing; three out of four leaves the daemon down with a
  // message, which is a worse failure than not offering it at all.
  for (
    const flag of [
      "SYS_ADMIN",
      "seccomp=unconfined",
      "systempaths=unconfined",
      "/dev/net/tun",
    ]
  ) {
    assertStringIncludes(onCompose, flag);
  }
  assertEquals(envOf(on).DOCKER_ROOTLESS_ENABLE, "true");
});

Deno.test("mode decides the network shape", () => {
  const local = tmp(), caddy = tmp(), ts = tmp();
  run(LOCAL, local);
  run(CADDY, caddy);
  run(TS, ts);

  // Local binds loopback only: nothing is reachable off this machine by accident.
  const l = Deno.readTextFileSync(`${local}/compose.yaml`);
  for (
    const line of l.split("\n").filter((x) => /^\s+- "\d|^\s+- "127/.test(x))
  ) {
    assertMatch(
      line,
      /127\.0\.0\.1:/,
      `local mode published ${line.trim()} on all interfaces`,
    );
  }

  // ACME only ever validates on 80 or 443, so a site on 8443 still needs 80.
  const c = Deno.readTextFileSync(`${caddy}/compose.yaml`);
  assertStringIncludes(c, '- "80:80"');
  assertStringIncludes(c, '- "8443:8443"');
  // Caddy cannot proxy raw TCP here, so SSH has to be published directly or
  // there is no way in but the browser.
  assertStringIncludes(c, ':22"');

  // Sharing the sidecar's namespace means this service cannot declare ports.
  const t = Deno.readTextFileSync(`${ts}/compose.yaml`);
  assertStringIncludes(t, "network_mode: service:tailscale");
  const agentBlock = t.slice(t.indexOf("agent-env:"), t.indexOf("tailscale:"));
  assert(
    !/^\s+ports:/m.test(agentBlock),
    "ports declared alongside network_mode",
  );
});

Deno.test("PUBLIC_URL matches what each mode actually serves", () => {
  const cases: [Record<string, unknown>, string][] = [
    [LOCAL, "http://localhost:8080"],
    [CADDY, "https://agent.example.com:8443"],
    [TS, "https://work.tail1234.ts.net"],
  ];
  for (const [answers, expected] of cases) {
    const dir = tmp();
    run(answers, dir);
    assertEquals(envOf(dir).PUBLIC_URL, expected);
  }
});

Deno.test("the dashboard shares the hostname and takes the next port", () => {
  // Host-scoped cookies are why this works: one sign-in covers both ports, and
  // only one redirect URI is ever registered with Google.
  const dir = tmp();
  run(CADDY, dir);
  const env = envOf(dir);
  assertEquals(
    new URL(env.DASHBOARD_PUBLIC_URL).hostname,
    new URL(env.PUBLIC_URL).hostname,
  );
  assertEquals(env.DASHBOARD_PUBLIC_URL, "https://agent.example.com:8444");
});

Deno.test(".env is written with restrictive permissions", () => {
  if (Deno.build.os === "windows") return;
  const dir = tmp();
  run(LOCAL, dir);
  const mode = Deno.statSync(`${dir}/.env`).mode! & 0o777;
  assertEquals(
    mode,
    0o600,
    `.env is ${mode.toString(8)}, and it holds secrets`,
  );
});

function existsSync(p: string): boolean {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Regressions. Each of these was a real defect found in review on this branch,
// reproduced before it was fixed.
// ---------------------------------------------------------------------------

Deno.test("a re-run keeps every key, not just the ones it knows", () => {
  // The first version carried an allowlist of secrets and dropped the rest, so
  // a MISE_TOOLS or DESKTOP_RESOLUTION added by hand vanished on the next run —
  // while the README said the file was safe to edit.
  const dir = tmp();
  run(LOCAL, dir);
  Deno.writeTextFileSync(
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

Deno.test("behind a TLS proxy, the container does not bind the proxy's port", () => {
  // PUBLIC_URL is the proxy's address. Binding its port made the container
  // fight whatever is already terminating TLS on 443.
  const dir = tmp();
  run(
    { ...LOCAL, behindProxy: true, publicUrl: "https://agent.example.com" },
    dir,
  );
  const compose = Deno.readTextFileSync(`${dir}/compose.yaml`);
  assert(!compose.includes("127.0.0.1:443:"), "bound the proxy's own port");
  assertStringIncludes(compose, "127.0.0.1:8080:8080");
  assertEquals(envOf(dir).PUBLIC_URL, "https://agent.example.com");
});

Deno.test("the tailnet dashboard is served on the port it advertises", () => {
  const dir = tmp();
  run(TS, dir);
  const advertised = Number(new URL(envOf(dir).DASHBOARD_PUBLIC_URL).port);
  const serve = JSON.parse(Deno.readTextFileSync(`${dir}/ts-serve.json`));
  assert(
    Object.keys(serve.TCP).includes(String(advertised)),
    `advertises :${advertised} but serves ${Object.keys(serve.TCP).join(", ")}`,
  );
});

Deno.test("mosh's UDP range is published wherever SSH is", () => {
  for (const answers of [LOCAL, CADDY]) {
    const dir = tmp();
    run(answers, dir);
    assertStringIncludes(
      Deno.readTextFileSync(`${dir}/compose.yaml`),
      "60000-60010:60000-60010/udp",
    );
  }
});

Deno.test("a workspace path is data, not YAML syntax", () => {
  const dir = tmp();
  run({ ...LOCAL, workspaceKind: "path", workspacePath: "/srv/my:code" }, dir);
  assertStringIncludes(
    Deno.readTextFileSync(`${dir}/compose.yaml`),
    '"/srv/my:code:/workspace"',
  );
});

Deno.test("a workspace path cannot inject compose configuration", () => {
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

Deno.test("a port with no room for the dashboard is refused", () => {
  const dir = tmp();
  const r = run({ ...CADDY, httpsPort: 65535 }, dir);
  assertEquals(r.code, 1);
  assertStringIncludes(r.stdout, "no room for the dashboard");
  assert(!existsSync(`${dir}/compose.yaml`));
});

Deno.test("answers from a file face the same validators as typed ones", () => {
  // --answers is automation input, and automation is where a silently-wrong
  // value becomes a deployment nobody typed.
  for (
    const broken of [
      { ...LOCAL, mode: "nonsense" },
      { ...CADDY, httpsPort: "not-a-port" },
      { ...CADDY, domain: "https://not-a-bare-hostname" },
    ]
  ) {
    const dir = tmp();
    const r = run(broken as Record<string, unknown>, dir);
    assertEquals(r.code, 2, `accepted ${JSON.stringify(broken).slice(0, 60)}`);
    assert(!existsSync(`${dir}/compose.yaml`));
  }
});

Deno.test("a setting kept in .env actually reaches the container", () => {
  // Carrying unknown keys into .env was only half the job: compose reads .env
  // for interpolation, so a key missing from the service's environment list
  // silently keeps the image default. The two lists are one list now.
  const dir = tmp();
  run(LOCAL, dir);
  Deno.writeTextFileSync(`${dir}/.env`, "\nMISE_TOOLS=python@3.13\n", {
    append: true,
  });
  run(LOCAL, dir, ["--force"]);
  assertEquals(envOf(dir).MISE_TOOLS, "python@3.13");
  assertStringIncludes(
    Deno.readTextFileSync(`${dir}/compose.yaml`),
    "- MISE_TOOLS",
  );
});

Deno.test("a carried value keeps its quoting", () => {
  // dotenv truncates an unquoted value at the first #, so stripping the quotes
  // and writing the value back raw silently eats the rest of it.
  const dir = tmp();
  run(LOCAL, dir);
  Deno.writeTextFileSync(
    `${dir}/.env`,
    `\nOPENCODE_CONFIG_CONTENT='part # suffix'\n`,
    {
      append: true,
    },
  );
  run(LOCAL, dir, ["--force"]);
  const line = Deno.readTextFileSync(`${dir}/.env`)
    .split("\n")
    .find((l) => l.startsWith("OPENCODE_CONFIG_CONTENT="))!;
  assert(
    /^OPENCODE_CONFIG_CONTENT=['"]part # suffix['"]$/.test(line),
    `value lost its quoting: ${line}`,
  );
});

Deno.test("two services cannot be given the same host port", () => {
  for (
    const [answers, why] of [
      [{ ...LOCAL, sshPort: 8080 }, "ssh vs gateway"],
      [{ ...LOCAL, sshPort: 8081 }, "ssh vs dashboard"],
      [{ ...CADDY, sshPort: 80 }, "ssh vs ACME"],
      [{ ...CADDY, sshPort: 8443 }, "ssh vs gateway through caddy"],
    ] as const
  ) {
    const dir = tmp();
    const r = run(answers as Record<string, unknown>, dir);
    assertEquals(r.code, 1, `accepted a collision: ${why}`);
    assertStringIncludes(r.stdout, "claimed twice");
    assert(!existsSync(`${dir}/compose.yaml`));
  }
});

Deno.test("a non-boolean answer cannot enable a privileged feature", () => {
  // JSON has strings, and "false" is truthy. Inferring from truthiness meant a
  // typo added SYS_ADMIN and relaxed seccomp.

  // The canonical spellings are honoured, and "false" means false.
  const off = tmp();
  assertEquals(run({ ...LOCAL, rootlessDocker: "false" }, off).code, 0);
  assertEquals(envOf(off).DOCKER_ROOTLESS_ENABLE, "false");
  assert(
    !Deno.readTextFileSync(`${off}/compose.yaml`).includes("SYS_ADMIN"),
    'the string "false" still widened the sandbox',
  );

  // Anything else is a typo, and guessing at it is how the sandbox gets
  // widened by accident.
  for (const v of ["no", "0", 0, "", null, "yes"]) {
    const dir = tmp();
    const r = run(
      { ...LOCAL, rootlessDocker: v } as Record<string, unknown>,
      dir,
    );
    assertEquals(r.code, 2, `accepted rootlessDocker=${JSON.stringify(v)}`);
    assert(!existsSync(`${dir}/compose.yaml`));
  }
});

Deno.test("a managed value survives an inline comment", () => {
  const dir = tmp();
  run(LOCAL, dir);
  const env = Deno.readTextFileSync(`${dir}/.env`)
    .replace(
      /^GATEWAY_PASSWORD=.*$/m,
      "GATEWAY_PASSWORD=hunter2 # my password",
    );
  Deno.writeTextFileSync(`${dir}/.env`, env);
  run(LOCAL, dir, ["--force"]);
  assertEquals(envOf(dir).GATEWAY_PASSWORD, "hunter2");
});

Deno.test("port 65535 is fine when nothing needs the port above", () => {
  const withDash = tmp(), without = tmp();
  assertEquals(run({ ...CADDY, httpsPort: 65535 }, withDash).code, 1);
  assertEquals(
    run({ ...CADDY, httpsPort: 65535, dashboard: false }, without).code,
    0,
  );
});

Deno.test("a bare relative workspace path is read as a directory", () => {
  // Compose treats `workspace:/workspace` as a named volume that does not
  // exist, and rejects the whole file.
  const dir = tmp();
  run({ ...LOCAL, workspaceKind: "path", workspacePath: "code" }, dir);
  assertStringIncludes(
    Deno.readTextFileSync(`${dir}/compose.yaml`),
    '"./code:/workspace"',
  );
});

Deno.test("a crafted ACME email cannot write Caddy directives", () => {
  const dir = tmp();
  const r = run({
    ...CADDY,
    acmeEmail: 'me@example.com\n}\n:80 {\n\trespond "x"',
  }, dir);
  assertEquals(r.code, 2);
  assert(!existsSync(`${dir}/Caddyfile`));
});

Deno.test("a malformed domain is rejected", () => {
  for (
    const d of ["-a.example.com", "a..example.com", "example", "a.example.com-"]
  ) {
    const dir = tmp();
    assertEquals(run({ ...CADDY, domain: d }, dir).code, 2, `accepted ${d}`);
  }
});

Deno.test("automation does not overwrite an existing deployment by omission", () => {
  const dir = tmp();
  assertEquals(run(LOCAL, dir).code, 0);
  const r = run(LOCAL, dir);
  assertEquals(r.code, 1, "overwrote without --force");
  assertStringIncludes(r.stdout, "--force");
  assertEquals(run(LOCAL, dir, ["--force"]).code, 0);
});

Deno.test("a reused credential keeps its exact value", () => {
  // Unescaping a quoted value and writing it back re-escaped turned pa\ss into
  // pass — a password that silently stopped being the password.
  const dir = tmp();
  run(LOCAL, dir);
  const env = Deno.readTextFileSync(`${dir}/.env`)
    .replace(/^GATEWAY_PASSWORD=.*$/m, String.raw`GATEWAY_PASSWORD="pa\\ss"`);
  Deno.writeTextFileSync(`${dir}/.env`, env);
  run(LOCAL, dir, ["--force"]);
  const line = Deno.readTextFileSync(`${dir}/.env`)
    .split("\n").find((l) => l.startsWith("GATEWAY_PASSWORD="))!;
  assertEquals(line, String.raw`GATEWAY_PASSWORD="pa\\ss"`);
});

Deno.test("a URL with a query or fragment is rejected", () => {
  // Every derived address appends to PUBLIC_URL, so a suffix here is inherited
  // by the OAuth redirect URI and the dashboard origin alike.
  for (
    const u of [
      "https://a.example.com?x=1",
      "https://a.example.com#frag",
      "https://a.example.com/base",
      "ftp://a.example.com",
    ]
  ) {
    const dir = tmp();
    assertEquals(
      run({ ...LOCAL, behindProxy: true, publicUrl: u }, dir).code,
      2,
      `accepted ${u}`,
    );
  }
});

Deno.test("an OAuth client id needs more than the suffix", () => {
  for (
    const id of [
      ".apps.googleusercontent.com",
      "apps.googleusercontent.com",
      "x.apps.googleusercontent.com.evil",
    ]
  ) {
    const dir = tmp();
    assertEquals(
      run({ ...CADDY, googleClientId: id }, dir).code,
      2,
      `accepted ${id}`,
    );
  }
  const ok = tmp();
  assertEquals(
    run({ ...CADDY, googleClientId: "1234-abc.apps.googleusercontent.com" }, ok)
      .code,
    0,
  );
});

Deno.test("every reused value round-trips byte for byte", () => {
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
    const before = Deno.readTextFileSync(`${dir}/.env`);
    const replaced = new RegExp(`^#?\\s*${key}=.*$`, "m").test(before)
      ? before.replace(new RegExp(`^#?\\s*${key}=.*$`, "m"), `${key}=${raw}`)
      : `${before}\n${key}=${raw}\n`;
    Deno.writeTextFileSync(`${dir}/.env`, replaced);

    run(answers, dir, ["--force"]);
    const line = Deno.readTextFileSync(`${dir}/.env`)
      .split("\n").find((l) => l.startsWith(`${key}=`));
    assertEquals(line, `${key}=${raw}`, `${key} was rewritten`);
  }
});

Deno.test("an answer wrapped in whitespace is not taken literally", () => {
  // new URL() trims for its own parsing, so validation passed and the padded
  // string went on to be written as PUBLIC_URL.
  const dir = tmp();
  run(
    { ...LOCAL, behindProxy: true, publicUrl: " https://a.example.com " },
    dir,
  );
  assertEquals(envOf(dir).PUBLIC_URL, "https://a.example.com");
});

Deno.test("GitHub sign-in writes its own credentials and allow list", () => {
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

Deno.test("GitHub sign-in with no allow list is refused", () => {
  const dir = tmp();
  const r = run(
    { ...GITHUB, githubOrg: "", githubTeam: "", githubUsers: "" },
    dir,
  );
  assertEquals(r.code, 1);
  assertStringIncludes(r.stdout, "needs an allow list");
});

// The entrypoint counts an email rule as a GitHub allow list, so a deployment
// restricted only by address is one the container accepts — and therefore one
// the wizard has to be able to write, and to read back on a re-run.
Deno.test("GitHub sign-in can be restricted by email alone", () => {
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
Deno.test("an allow list of only separators is not an allow list", () => {
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
Deno.test("a team-only allow list must name its organisation", () => {
  const dir = tmp();
  const bad = run({ ...GITHUB, githubOrg: "", githubTeam: "platform" }, dir);
  assertEquals(bad.code, 2);
  assertStringIncludes(bad.stdout, "fully qualified");

  const good = run(
    { ...GITHUB, githubOrg: "", githubTeam: "acme:platform,other:sre" },
    tmp(),
  );
  assertEquals(good.code, 0);
});

// With an org set, plain slugs are what oauth2-proxy wants.
Deno.test("teams inside an organisation stay plain slugs", () => {
  const dir = tmp();
  const r = run({ ...GITHUB, githubOrg: "acme", githubTeam: "platform" }, dir);
  assertEquals(r.code, 0);
  assertEquals(envOf(dir).GITHUB_TEAM, "platform");
});
