/**
 * Tests for generate.ts as a library: the contract a web UI relies on.
 * setup.test.ts covers the wizard end to end; this covers what it calls.
 */

import { test } from "vite-plus/test";
import { assert, assertEquals, assertThrows } from "./test-assert.ts";
import {
  type Answers,
  answersFromCompose,
  generate,
  InvalidAnswers,
  needsClientSecret,
  normaliseSshKeys,
  validate,
  VERSION,
} from "./generate.ts";
import { DEFAULT_FIELDS, type Fields, nextSteps, toAnswers } from "./web/app/model.ts";

const BASIC: Answers = {
  version: VERSION,
  mode: "local",
  publicUrl: "http://localhost:8080",
  authMode: "basic",
  gatewayUser: "dev",
  preset: "opencode",
  rootlessDocker: false,
  sshKeys: "",
  sshPort: 2222,
  workspace: { kind: "volume" },
  timezone: "UTC",
};

const fixed = (bytes: number) => "x".repeat(bytes);

test("the same answers give the same files", () => {
  const a = generate(BASIC, { randomSecret: fixed });
  const b = generate(BASIC, { randomSecret: fixed });
  // Every secret is asked for by the key it is for, so a UI can hold it still.
  const keys: string[] = [];
  generate(BASIC, {
    randomSecret: (n, key) => (keys.push(key), fixed(n)),
  });
  assertEquals(keys, ["GATEWAY_PASSWORD"]);
  assertEquals(a, b);
  assertEquals(Object.keys(a).sort(), [".env", "compose.yaml"]);
});

test("compose.yaml carries the answers it was made from", () => {
  const answers: Answers = {
    ...BASIC,
    preset: "vanilla",
    primaryPort: 3000,
    // A $ that Compose must not interpolate, and a # a naive reader would cut at.
    primaryCommand: "npm run dev -- --port $PORT # and $$ too",
    sshKeys: "ssh-ed25519 AAAA one@host\nssh-ed25519 BBBB two@host",
  };
  const compose = generate(answers, { randomSecret: fixed })["compose.yaml"];
  assertEquals(answersFromCompose(compose), answers);
  // Every $ on the line is doubled, so Compose reads each one literally.
  const line = compose.split("\n").find((l) => l.startsWith("x-agent-env:"))!;
  assert(!/(^|[^$])\$([^$]|$)/.test(line.replace(/\$\$/g, "")), line);
  assert(line.includes("$$PORT"), line);
});

test("a compose.yaml without answers reads as none", () => {
  assertEquals(answersFromCompose("services: {}\n"), null);
  assertEquals(answersFromCompose("x-agent-env: {not json}\n"), null);
  assertEquals(answersFromCompose('x-agent-env: ["a list"]\n'), null);
});

test("an existing .env keeps its secrets", () => {
  const files = generate(BASIC, {
    existingEnv: "GATEWAY_PASSWORD=kept-as-is\nMISE_TOOLS=node\n",
    randomSecret: () => {
      throw new Error("minted a secret that already existed");
    },
  });
  assert(files[".env"].includes("GATEWAY_PASSWORD=kept-as-is\n"));
  assert(files[".env"].includes("MISE_TOOLS=node\n"));
});

test("only compose.yaml and .env are needed in every mode", () => {
  for (const a of [
    BASIC,
    {
      ...BASIC,
      mode: "caddy",
      domain: "agent.example.com",
      httpsPort: 8443,
      publicUrl: "https://agent.example.com:8443",
    },
    {
      ...BASIC,
      mode: "tailscale",
      tsHostname: "work.tail1234.ts.net",
      publicUrl: "https://work.tail1234.ts.net",
      sshPort: undefined,
    },
  ] as Answers[]) {
    const files = generate(a, { randomSecret: fixed });
    // Nothing in compose.yaml may point at a file beside it, or a stack UI
    // that takes only the compose text cannot deploy it.
    assert(
      !/^\s+- \.\//m.test(files["compose.yaml"]),
      `${a.mode} mounts a file from beside compose.yaml`,
    );
  }
});

test("invalid answers are reported per field and refused", () => {
  const bad: Answers = {
    ...BASIC,
    mode: "caddy",
    authMode: "none",
    domain: "not a domain",
    publicUrl: "https://x",
  };
  assertEquals(
    validate(bad).map((p) => p.field),
    ["domain"],
  );
  const refused = { ...bad, domain: "agent.example.com" };
  assertEquals(
    validate(refused).map((p) => p.field),
    ["authMode"],
  );
  const e = assertThrows(() => generate(refused), InvalidAnswers);
  assertEquals(e.problems[0].message, "Refusing to generate that.");
});

test("owner IDs must be IDs the entrypoint can use", () => {
  for (const bad of [Number.NaN, -1, 1.5]) {
    const a: Answers = {
      ...BASIC,
      workspace: { kind: "path", path: "/srv", puid: bad, pgid: 1000 },
    };
    assertEquals(
      validate(a).map((p) => p.field),
      ["puid"],
      `accepted ${bad}`,
    );
  }
});

test("a bare relative path is a bind mount for any caller", () => {
  const files = generate(
    { ...BASIC, workspace: { kind: "path", path: "code", puid: 1000, pgid: 1000 } },
    { randomSecret: fixed },
  );
  assert(files["compose.yaml"].includes('"./code:/workspace"'));
});

test("authorized_keys text is accepted as pasted", () => {
  assertEquals(
    normaliseSshKeys("# work\nssh-ed25519 AAAA a@b\r\n\n  ssh-rsa BBBB c@d  \n"),
    "ssh-ed25519 AAAA a@b\nssh-rsa BBBB c@d",
  );
  const files = generate({ ...BASIC, sshKeys: "ssh-ed25519 AAAA a@b\nssh-rsa BBBB c@d" });
  assert(
    files["compose.yaml"].includes('"SSH_AUTHORIZED_KEYS=ssh-ed25519 AAAA a@b\\nssh-rsa BBBB c@d"'),
  );
  assert(!files[".env"].includes("SSH_AUTHORIZED_KEYS"));
});

test("the home directory can be a bind mount, and sets the container's owner", () => {
  const files = generate(
    { ...BASIC, home: { kind: "path", path: "home", puid: 1234, pgid: 4321 } },
    { randomSecret: fixed },
  );
  const compose = files["compose.yaml"];
  assert(compose.includes('"./home:/home/dev"'));
  assert(!compose.includes("home:/home/dev\n"));
  assert(!/^ {2}home:$/m.test(compose), "declared a volume nothing uses");
  assert(compose.includes('"PUID=1234"') && compose.includes('"PGID=4321"'));
});

test("with both bind-mounted, /workspace's owner wins and home needs a path", () => {
  const a: Answers = {
    ...BASIC,
    workspace: { kind: "path", path: "/srv/code", puid: 10, pgid: 20 },
    home: { kind: "path", path: "/srv/home", puid: 30, pgid: 40 },
  };
  const compose = generate(a, { randomSecret: fixed })["compose.yaml"];
  assert(compose.includes('"PUID=10"') && compose.includes('"PGID=20"'));
  assertEquals(
    validate({ ...a, home: { kind: "path", path: "" } }).map((p) => p.field),
    ["homePath"],
  );
});

test("the Selkies desktop is written to compose.yaml, and noVNC leaves no trace", () => {
  const selkies = generate({ ...BASIC, desktopBackend: "selkies" }, { randomSecret: fixed });
  assert(selkies["compose.yaml"].includes("DESKTOP_BACKEND=selkies"));
  const novnc = generate(
    { ...BASIC, desktopBackend: "novnc" },
    { existingEnv: "DESKTOP_BACKEND=selkies\n" },
  );
  assert(!novnc[".env"].includes("DESKTOP_BACKEND"));
  assert(!novnc["compose.yaml"].includes("DESKTOP_BACKEND"));
});

test("Selkies is refused on plain http away from localhost, and only then", () => {
  const proxied = { ...BASIC, behindProxy: true, desktopBackend: "selkies" as const };
  const bad = validate({ ...proxied, publicUrl: "http://box.lan:8080" });
  assertEquals(
    bad.map((p) => p.field),
    ["desktopBackend"],
  );
  assertEquals(validate({ ...proxied, publicUrl: "https://box.example.com" }), []);
  assertEquals(validate({ ...proxied, publicUrl: "http://localhost:9000" }), []);
  assertEquals(validate({ ...BASIC, desktopBackend: "selkies" }), []);
  assertEquals(
    validate({ ...proxied, publicUrl: "http://box.lan:8080", desktopBackend: "novnc" }),
    [],
  );
});

test("screen size and text scale become DESKTOP_RESOLUTION and DESKTOP_DPI", () => {
  const big = generate(
    { ...BASIC, desktopSize: "3840x2160", desktopScale: 200 },
    { randomSecret: fixed },
  );
  assert(big["compose.yaml"].includes("DESKTOP_RESOLUTION=3840x2160x24"));
  assert(big["compose.yaml"].includes("DESKTOP_DPI=192"));
  // The defaults say nothing, so a value written into .env by hand is left alone;
  // choosing a size or scale replaces it.
  const kept = generate(
    { ...BASIC, desktopSize: "1920x1080", desktopScale: 100 },
    { existingEnv: "DESKTOP_RESOLUTION=800x600x24\n" },
  );
  assert(kept[".env"].includes("DESKTOP_RESOLUTION=800x600x24"));
  const chosen = generate(
    { ...BASIC, desktopSize: "1280x720" },
    { existingEnv: "DESKTOP_RESOLUTION=800x600x24\n" },
  );
  assert(!chosen[".env"].includes("800x600"));
  assert(chosen["compose.yaml"].includes("DESKTOP_RESOLUTION=1280x720x24"));
});

test("a screen size or scale the display cannot use is refused", () => {
  const fields = (a: object) => validate({ ...BASIC, ...a }).map((p) => p.field);
  assertEquals(fields({ desktopSize: "big" }), ["desktopSize"]);
  assertEquals(fields({ desktopSize: "100x100" }), ["desktopSize"]);
  assertEquals(fields({ desktopScale: 90 }), ["desktopScale"]);
  assertEquals(fields({ desktopScale: 150.5 }), ["desktopScale"]);
  assertEquals(fields({ desktopSize: "2200x1300", desktopScale: 125 }), []);
});

// The page's fields are text. Number() would read "0x10" as 16 and "1e2" as
// 100 before the checks saw them, so the page has to refuse what the wizard
// refuses.
test("the page takes only plain decimals for a number", () => {
  const fields = (f: Partial<Fields>) =>
    validate(toAnswers({ ...DEFAULT_FIELDS, ...f })).map((p) => p.field);
  assertEquals(fields({ memoryGiB: "0x10" }), ["memoryGiB"]);
  assertEquals(fields({ cpus: "1e2" }), ["cpus"]);
  assertEquals(fields({ sshPort: "0x50" }), ["sshPort"]);
  assertEquals(fields({ memoryGiB: " 1.5 ", swapGiB: "0", cpus: "0.5" }), []);
  assertEquals(toAnswers({ ...DEFAULT_FIELDS, memoryGiB: "", cpus: "" }).memoryGiB, undefined);
});

// A pasted client secret is for .env alone: compose.yaml carries the answers,
// and anyone who can read the compose file must not get the secret with it.
test("a pasted client secret goes to .env and nowhere else", () => {
  const google: Answers = {
    ...BASIC,
    authMode: "google",
    googleClientId: "1234-abc.apps.googleusercontent.com",
    allowedEmails: "me@example.com",
  };
  const pasted = generate(google, { clientSecret: " GOCSPX-a$b " });
  assert(pasted[".env"].includes("GOOGLE_CLIENT_SECRET='GOCSPX-a$b'"));
  assert(!pasted["compose.yaml"].includes("GOCSPX"));
  // It replaces the one in .env; blank keeps it.
  const existingEnv = "GOOGLE_CLIENT_SECRET=GOCSPX-old\n";
  assert(
    generate(google, { existingEnv, clientSecret: "GOCSPX-new" })[".env"].includes("=GOCSPX-new"),
  );
  assert(generate(google, { existingEnv, clientSecret: " " })[".env"].includes("=GOCSPX-old"));
  // A sign-in with no client secret has nowhere to put one.
  assert(!generate(BASIC, { clientSecret: "GOCSPX-x" })[".env"].includes("GOCSPX"));
});

// The placeholder counts however it is quoted, so the reminder to replace it
// does not vanish because an editor added quotes.
test("a quoted placeholder still needs the secret", () => {
  assert(needsClientSecret("google", ""));
  assert(needsClientSecret("google", "GOOGLE_CLIENT_SECRET=CHANGEME-google-client-secret\n"));
  assert(needsClientSecret("google", 'GOOGLE_CLIENT_SECRET="CHANGEME-google-client-secret"\n'));
  assert(needsClientSecret("github", "GITHUB_CLIENT_SECRET='CHANGEME'\n"));
  assert(!needsClientSecret("google", 'GOOGLE_CLIENT_SECRET="GOCSPX-real"\n'));
  assert(!needsClientSecret("basic", ""));
  const steps = nextSteps(
    { ...BASIC, authMode: "google", googleClientId: "1.apps.googleusercontent.com" },
    'GOOGLE_CLIENT_SECRET="CHANGEME-google-client-secret"\n',
  );
  assert(steps[0].includes("GOOGLE_CLIENT_SECRET"));
});
