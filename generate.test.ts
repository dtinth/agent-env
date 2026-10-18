/**
 * Tests for generate.ts as a library: the contract a web UI relies on.
 * setup.test.ts covers the wizard end to end; this covers what it calls.
 */

import { test } from "vite-plus/test";
import { assert, assertEquals, assertThrows } from "./test-assert.ts";
import { type Answers, generate, InvalidAnswers, validate, VERSION } from "./generate.ts";

const BASIC: Answers = {
  version: VERSION,
  mode: "local",
  publicUrl: "http://localhost:8080",
  authMode: "basic",
  gatewayUser: "opencode",
  opencodeEnable: true,
  dashboard: true,
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
  assertEquals(Object.keys(a).sort(), [".env", "agent-env.setup.json", "compose.yaml"]);
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
