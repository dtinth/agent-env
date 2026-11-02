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
  migrateAnswers,
  needsClientSecret,
  REMOVED_KEYS,
  normaliseSshKeys,
  validate,
  VERSION,
} from "./generate.ts";
import {
  DEFAULT_FIELDS,
  type Fields,
  fieldsFromAnswers,
  nextSteps,
  toAnswers,
} from "./web/app/model.ts";

const BASIC: Answers = {
  version: VERSION,
  boundary: "host",
  tls: "upstream",
  publish: "loopback",
  ssh: "host-port",
  publicUrl: "http://localhost:8080",
  authMode: "basic",
  gatewayUser: "dev",
  components: ["desktop", "terminal", "files", "opencode"],
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
    components: ["desktop", "terminal", "files"],
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

test("only compose.yaml and .env are needed in every reachability", () => {
  for (const [label, a] of [
    ["loopback", BASIC],
    [
      "public",
      {
        ...BASIC,
        tls: "gateway",
        publish: "public",
        domain: "agent.example.com",
        httpsPort: 8443,
        publicUrl: "https://agent.example.com:8443",
      },
    ],
    [
      "tailscale",
      {
        ...BASIC,
        boundary: "tailscale",
        ssh: "tunnel",
        tsHostname: "work.tail1234.ts.net",
        publicUrl: "https://work.tail1234.ts.net",
        sshPort: undefined,
      },
    ],
  ] as [string, Answers][]) {
    const files = generate(a, { randomSecret: fixed });
    // Nothing in compose.yaml may point at a file beside it, or a stack UI
    // that takes only the compose text cannot deploy it.
    assert(
      !/^\s+- \.\//m.test(files["compose.yaml"]),
      `${label} mounts a file from beside compose.yaml`,
    );
  }
});

test("a public endpoint with no auth is a strong warning, not a hard refusal", () => {
  const bad: Answers = {
    ...BASIC,
    tls: "gateway",
    publish: "public",
    authMode: "none",
    domain: "not a domain",
  };
  // A broken domain is a hard error, reported on its field, and still throws.
  assertEquals(
    validate(bad)
      .filter((p) => p.severity !== "warn")
      .map((p) => p.field),
    ["domain"],
  );
  assertThrows(() => generate(bad), InvalidAnswers);
  // With a valid domain the only thing left is the no-auth caution — a warning,
  // so generation succeeds rather than throwing.
  const warned = { ...bad, domain: "agent.example.com" };
  const problems = validate(warned);
  assertEquals(
    problems.map((p) => p.field),
    ["authMode"],
  );
  assertEquals(problems[0].severity, "warn");
  assert(generate(warned)["compose.yaml"].includes("AUTH_MODE=none"));
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

test("the components are always written out, in the image's order", () => {
  const compose = (a: Partial<Answers>) =>
    generate({ ...BASIC, ...a }, { randomSecret: fixed })["compose.yaml"];
  assert(compose({}).includes('"AGENT_ENV_COMPONENTS=desktop,terminal,files,opencode"'));
  assert(
    compose({ components: ["files", "desktop-selkies"] }).includes(
      '"AGENT_ENV_COMPONENTS=desktop-selkies,files"',
    ),
  );
  // An empty list is an answer too: nothing but SSH, sign-in and /~env/.
  assert(compose({ components: [] }).includes('"AGENT_ENV_COMPONENTS="'));
});

test("the settings components replaced are never written, and an old .env loses them", () => {
  const existingEnv = [
    "AGENT_ENV_PRESET=opencode",
    "DESKTOP_ENABLE=true",
    "DESKTOP_BACKEND=selkies",
    "TTYD_ENABLE=true",
    "DUFS_ENABLE=true",
    "DOCKER_ROOTLESS_ENABLE=false",
    "ANTHROPIC_API_KEY=sk-kept",
    "",
  ].join("\n");
  for (const a of [
    BASIC,
    { ...BASIC, components: ["desktop-selkies", "docker"] },
    { ...BASIC, components: [] },
  ] as Answers[]) {
    for (const files of [
      generate(a, { randomSecret: fixed }),
      generate(a, { randomSecret: fixed, existingEnv }),
    ]) {
      for (const k of REMOVED_KEYS) {
        assert(!files[".env"].includes(k), `${k} in .env`);
        assert(!files["compose.yaml"].includes(`${k}=`), `${k} in compose.yaml`);
        assert(!files["compose.yaml"].includes(`- ${k}\n`), `${k} passed through`);
      }
    }
  }
  assert(generate(BASIC, { existingEnv })[".env"].includes("ANTHROPIC_API_KEY=sk-kept"));
});

test("version 1 answers become components", () => {
  const v1 = (legacy: object, env = "") =>
    migrateAnswers({ ...BASIC, components: undefined, ...legacy } as never, env).components;
  assertEquals(v1({ preset: "vanilla", rootlessDocker: false }), ["desktop", "terminal", "files"]);
  assertEquals(v1({ preset: "opencode", rootlessDocker: false }), [
    "desktop",
    "terminal",
    "files",
    "opencode",
  ]);
  assertEquals(v1({ preset: "vanilla", desktopBackend: "selkies", rootlessDocker: true }), [
    "desktop-selkies",
    "terminal",
    "files",
    "docker",
  ]);
  // The legacy keys do not survive the trip.
  const migrated = migrateAnswers({ ...BASIC, preset: "opencode" } as never);
  assert(!("preset" in migrated) && !("rootlessDocker" in migrated));
  // A compose.yaml written by version 1 reads back in the new shape.
  const { components: _, ...rest } = BASIC;
  const old = `x-agent-env: ${JSON.stringify({ ...rest, version: 1, preset: "opencode", desktopBackend: "selkies", rootlessDocker: true })}\n`;
  assertEquals(answersFromCompose(old)?.components, [
    "desktop-selkies",
    "terminal",
    "files",
    "opencode",
    "docker",
  ]);
});

test("the settings in an old .env say what was running", () => {
  const from = (env: string) =>
    migrateAnswers({ preset: "vanilla", rootlessDocker: false } as never, env).components;
  assertEquals(from("DESKTOP_ENABLE=false\n"), ["terminal", "files"]);
  assertEquals(from("TTYD_ENABLE=false\nDUFS_ENABLE=0\n"), ["desktop"]);
  assertEquals(from("DESKTOP_BACKEND=selkies\n"), ["desktop-selkies", "terminal", "files"]);
  assertEquals(from("DOCKER_ROOTLESS_ENABLE=true\n"), ["desktop", "terminal", "files", "docker"]);
  assertEquals(from("AGENT_ENV_PRESET=opencode\n"), ["desktop", "terminal", "files", "opencode"]);
  // A .env on its own is enough, with nothing else to go on.
  assertEquals(migrateAnswers({}, "TTYD_ENABLE=false\n").components, ["desktop", "files"]);
  // Neither: the answers are left alone, and the defaults apply.
  assertEquals(migrateAnswers({}, "MISE_TOOLS=node\n"), {});
  // The page reads the same mapping into its form.
  const f = fieldsFromAnswers(
    migrateAnswers({ preset: "opencode" } as never, "DESKTOP_ENABLE=false\n"),
  );
  assertEquals(f.desktop, "none");
  assertEquals(f.opencode, true);
});

test("one desktop at most", () => {
  assertEquals(
    validate({ ...BASIC, components: ["desktop", "desktop-selkies"] }).map((p) => p.field),
    ["components"],
  );
  assertEquals(
    validate({ ...BASIC, components: ["dekstop"] as never }).map((p) => p.field),
    ["components"],
  );
});

test("the SMB share is allowed in every reachability, and never published", () => {
  const ts: Answers = {
    ...BASIC,
    boundary: "tailscale",
    ssh: "tunnel",
    tsHostname: "work.tail1234.ts.net",
    publicUrl: "https://work.tail1234.ts.net",
    sshPort: undefined,
    components: ["files", "smb"],
  };
  assertEquals(validate(ts), []);
  const compose = generate(ts, { randomSecret: fixed })["compose.yaml"];
  assert(compose.includes('"AGENT_ENV_COMPONENTS=files,smb"'));
  assert(!compose.includes("445"), "published SMB");
  for (const [label, a] of [
    ["loopback", { ...BASIC, components: ["smb"] }],
    [
      "public",
      {
        ...BASIC,
        tls: "gateway",
        publish: "public",
        authMode: "basic",
        domain: "agent.example.com",
        publicUrl: "https://agent.example.com",
        components: ["smb"],
      },
    ],
  ] as [string, Answers][]) {
    assertEquals(validate(a), []);
    const out = generate(a, { randomSecret: fixed })["compose.yaml"];
    assert(out.includes("smb"), `${label} dropped smb`);
    assert(!out.includes("445"), `${label} published SMB`);
  }
});

test("a command for / is refused while OpenCode is at /", () => {
  assertEquals(
    validate({ ...BASIC, primaryCommand: "node app.js" }).map((p) => p.field),
    ["primaryCommand"],
  );
  const files = generate(
    { ...BASIC, components: ["terminal"], primaryCommand: "node app.js" },
    { randomSecret: fixed },
  );
  assert(files["compose.yaml"].includes('"PRIMARY_COMMAND=node app.js"'));
  assert(files["compose.yaml"].includes('"PRIMARY_PORT=3000"'));
  assert(!generate(BASIC, { randomSecret: fixed })["compose.yaml"].includes("PRIMARY_PORT"));
});

test("the docker host flags come with the docker component, and only with it", () => {
  const flags = [
    "SYS_ADMIN",
    "seccomp=unconfined",
    "apparmor=unconfined",
    "systempaths=unconfined",
    "/dev/net/tun",
  ];
  const on = generate({ ...BASIC, components: ["docker"] }, { randomSecret: fixed });
  const off = generate(BASIC, { randomSecret: fixed });
  for (const flag of flags) {
    assert(on["compose.yaml"].includes(flag), `${flag} missing`);
    assert(!off["compose.yaml"].includes(flag), `${flag} without docker`);
  }
});

test("Selkies is refused on plain http away from localhost, and only then", () => {
  const selkies: Answers = { ...BASIC, components: ["desktop-selkies"] };
  // A host loopback deployment reached through a proxy carries that proxy's URL.
  const proxied = selkies;
  const bad = validate({ ...proxied, publicUrl: "http://box.lan:8080" });
  assertEquals(
    bad.map((p) => p.field),
    ["components"],
  );
  assertEquals(validate({ ...proxied, publicUrl: "https://box.example.com" }), []);
  assertEquals(validate({ ...proxied, publicUrl: "http://localhost:9000" }), []);
  assertEquals(validate(selkies), []);
  assertEquals(
    validate({ ...proxied, publicUrl: "http://box.lan:8080", components: ["desktop"] }),
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
  // Without a desktop there is no screen to size.
  const none = generate(
    { ...BASIC, components: ["terminal"], desktopSize: "3840x2160", desktopScale: 200 },
    { randomSecret: fixed },
  );
  assert(!none["compose.yaml"].includes("DESKTOP_"));
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

test("the page's choices become components", () => {
  assertEquals(toAnswers(DEFAULT_FIELDS).components, ["desktop", "terminal", "files"]);
  const ts = { ...DEFAULT_FIELDS, boundary: "tailscale", tsHostname: "w.tail1.ts.net" };
  const picked: Fields = {
    ...ts,
    desktop: "desktop-selkies",
    terminal: false,
    opencode: true,
    docker: true,
    smb: true,
  };
  assertEquals(toAnswers(picked).components, [
    "desktop-selkies",
    "files",
    "opencode",
    "docker",
    "smb",
  ]);
  // SMB is not tied to the tailnet: it stays on under another boundary.
  assertEquals(toAnswers({ ...picked, boundary: "host" }).components.includes("smb"), true);
  // And back, for a deployment imported into the form.
  assertEquals(
    toAnswers({ ...DEFAULT_FIELDS, ...fieldsFromAnswers(toAnswers(picked)) }).components,
    toAnswers(picked).components,
  );
});

test("the web maps wireguard fields to peers with assigned addresses", () => {
  const f: Fields = {
    ...DEFAULT_FIELDS,
    boundary: "wireguard",
    wgEndpoint: "198.51.100.9:51820",
    wgAddress: "10.9.0.1/24",
    wgPeers: "laptop\nphone",
  };
  const a = toAnswers(f);
  assertEquals(a.boundary, "wireguard");
  // The gateway is reached over the tunnel on the server's address.
  assertEquals(a.publicUrl, "http://10.9.0.1:8080");
  // The listen port is the endpoint's, so the two cannot drift apart.
  assertEquals(a.wireguard?.listenPort, 51820);
  // Peers take sequential addresses after the server's.
  assertEquals(
    a.wireguard?.peers.map((p) => [p.name, p.address]),
    [
      ["laptop", "10.9.0.2"],
      ["phone", "10.9.0.3"],
    ],
  );
  // Keys are the hook's to generate and fold in; toAnswers leaves them blank.
  assertEquals(a.wireguard?.serverPublicKey, "");
  assertEquals(a.wireguard?.peers[0].publicKey, "");
  // And the peers round-trip back into the form.
  assertEquals(fieldsFromAnswers(a).wgPeers, "laptop\nphone");
});

test("the web carries a public domain on wireguard only when it is filled in", () => {
  const base: Fields = {
    ...DEFAULT_FIELDS,
    boundary: "wireguard",
    wgEndpoint: "198.51.100.9:51820",
    wgAddress: "10.9.0.1/24",
    wgPeers: "laptop",
  };
  // Blank domain: the tunnel is the only way in, plain http over it.
  const tunnel = toAnswers({ ...base, domain: "" });
  assertEquals(tunnel.domain, undefined);
  assertEquals(tunnel.publicUrl, "http://10.9.0.1:8080");
  // A domain: TLS on a public 443, and the web address is that domain.
  const withDomain = toAnswers({ ...base, domain: "box.example.com", acmeEmail: "me@example.com" });
  assertEquals(withDomain.domain, "box.example.com");
  assertEquals(withDomain.acmeEmail, "me@example.com");
  assertEquals(withDomain.publicUrl, "https://box.example.com");
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

// --- WireGuard -------------------------------------------------------------

const WG: Answers = {
  ...BASIC,
  boundary: "wireguard",
  tls: "upstream",
  publish: "loopback",
  ssh: "tunnel",
  sshPort: undefined,
  publicUrl: "http://10.8.0.1:8080",
  authMode: "basic",
  wireguard: {
    endpoint: "203.0.113.7:51820",
    listenPort: 51820,
    address: "10.8.0.1/24",
    serverPublicKey: "U" + "A".repeat(42) + "=",
    peers: [
      { name: "laptop", publicKey: "L" + "A".repeat(42) + "=", address: "10.8.0.2" },
      { name: "phone", publicKey: "P" + "A".repeat(42) + "=", address: "10.8.0.3" },
    ],
  },
};

test("wireguard mode mirrors tailscale: a sidecar owns the netns, nothing else is published", () => {
  const out = generate(WG);
  const compose = out["compose.yaml"];
  // The agent-env container shares the sidecar's namespace and has no ports.
  assert(compose.includes("network_mode: service:wireguard"));
  const agentBlock = compose.slice(compose.indexOf("agent-env:"), compose.indexOf("wireguard:"));
  assert(!/^\s+ports:/m.test(agentBlock), "agent-env declared ports alongside network_mode");
  assert(!/^\s+hostname:/m.test(agentBlock), "agent-env took a hostname it cannot have");
  // Only the sidecar publishes, and only the one UDP port peers dial.
  assert(compose.includes('- "51820:51820/udp"'));
  // The gateway is reached over the tunnel on the server's address.
  assert(compose.includes('- "PUBLIC_URL=http://10.8.0.1:8080"'));
});

test("the server's private key is the one secret, carried into the inlined wg config", () => {
  const out = generate(WG);
  // It is a sidecar key: never handed to the agent-env container.
  const compose = out["compose.yaml"];
  const agentBlock = compose.slice(compose.indexOf("agent-env:"), compose.indexOf("wireguard:"));
  assert(!agentBlock.includes("WG_PRIVATE_KEY"), "the private key leaked into the container");
  // No placeholder in .env; compose fills it from .env into the wg config and
  // refuses to start until it is set.
  assert(!/^WG_PRIVATE_KEY=/m.test(out[".env"]));
  assert(compose.includes("PrivateKey = ${WG_PRIVATE_KEY:?set WG_PRIVATE_KEY in .env}"));
  // The peers' public keys are in the server config; no private key is.
  assert(compose.includes("PublicKey = L" + "A".repeat(42) + "="));
  assert(compose.includes("AllowedIPs = 10.8.0.2/32"));

  // A supplied server key is written to .env and still only referenced in compose.
  const withKey = generate(WG, { wireguard: { serverPrivateKey: "s3rv3rpr1v" } });
  assert(withKey[".env"].includes("WG_PRIVATE_KEY=s3rv3rpr1v"));
  assert(!withKey["compose.yaml"].includes("s3rv3rpr1v"));
});

test("a client config is emitted only for a peer whose private key is supplied", () => {
  // No private keys: only the two deployment files.
  assertEquals(Object.keys(generate(WG)).sort(), [".env", "compose.yaml"]);

  // One supplied: just that peer's config, holding its own private key and the
  // server's public key and endpoint — and routing only the gateway.
  const out = generate(WG, { wireguard: { clientPrivateKeys: { laptop: "l4pt0ppr1v" } } });
  assertEquals(Object.keys(out).sort(), [".env", "compose.yaml", "wireguard/laptop.conf"]);
  const conf = out["wireguard/laptop.conf"];
  assert(conf.includes("PrivateKey = l4pt0ppr1v"));
  assert(conf.includes("Address = 10.8.0.2/32"));
  assert(conf.includes("PublicKey = U" + "A".repeat(42) + "="));
  assert(conf.includes("Endpoint = 203.0.113.7:51820"));
  assert(conf.includes("AllowedIPs = 10.8.0.1/32"));
});

test("wireguard answers are validated like every other mode", () => {
  const bad = (wg: Partial<Answers["wireguard"] & object>) =>
    validate({ ...WG, wireguard: { ...WG.wireguard!, ...wg } }).length > 0;
  assert(bad({ endpoint: "no-port" }), "accepted an endpoint without a port");
  assert(bad({ endpoint: "203.0.113.7:99999" }), "accepted an out-of-range port");
  assert(bad({ address: "10.8.0.1" }), "accepted a server address with no prefix");
  assert(bad({ serverPublicKey: "" }), "accepted a missing server key");
  assert(
    bad({ peers: [{ name: "a b", publicKey: "x", address: "10.8.0.2" }] }),
    "accepted a peer label with a space",
  );
  assert(
    bad({
      peers: [
        { name: "a", publicKey: "x", address: "10.8.0.2" },
        { name: "b", publicKey: "y", address: "10.8.0.2" },
      ],
    }),
    "accepted two peers on one address",
  );
  // A server with no peers yet is a valid starting point.
  assertEquals(validate({ ...WG, wireguard: { ...WG.wireguard!, peers: [] } }).length, 0);
});

// An optional public domain beside the tunnel: the gateway terminates TLS on a
// public 443, like caddy mode, while the tunnel still carries ssh and mosh.
const WG_DOMAIN: Answers = {
  ...WG,
  tls: "gateway",
  publicUrl: "https://box.example.com",
  authMode: "google",
  googleClientId: "1234-abc.apps.googleusercontent.com",
  allowedEmails: "me@example.com",
  domain: "box.example.com",
  acmeEmail: "me@example.com",
};

test("a public domain on wireguard publishes TLS through the sidecar, ssh stays on the tunnel", () => {
  assertEquals(validate(WG_DOMAIN), []);
  const compose = generate(WG_DOMAIN)["compose.yaml"];
  // The web address is the domain over TLS, and the gateway is told to certify it.
  assert(compose.includes("PUBLIC_URL=https://box.example.com"));
  assert(compose.includes("GATEWAY_TLS_DOMAIN=box.example.com"));
  assert(compose.includes("ACME_EMAIL=me@example.com"));
  // The sidecar — which owns the namespace — publishes 80 and 443 beside the
  // UDP port; agent-env still declares none, and ssh is never published.
  const sidecar = compose.slice(compose.indexOf("wireguard:"));
  assert(sidecar.includes('- "51820:51820/udp"'));
  assert(sidecar.includes('- "80:80"'));
  assert(sidecar.includes('- "443:443"'));
  const agentBlock = compose.slice(compose.indexOf("agent-env:"), compose.indexOf("wireguard:"));
  assert(!/^\s+ports:/m.test(agentBlock), "agent-env published ports it cannot");
  assert(!compose.includes(':22"'), "ssh was published; it should stay on the tunnel");
});

test("a public domain on wireguard warns about AUTH_MODE=none, like a public host", () => {
  const warned = validate({ ...WG_DOMAIN, authMode: "none" }).find((p) => p.field === "authMode");
  assert(warned, "a public domain with no auth drew no caution");
  assertEquals(warned.severity, "warn");
  // Without a domain the tunnel is the boundary, so no auth draws no caution.
  assert(
    !validate({ ...WG, authMode: "none" }).some((p) => p.field === "authMode"),
    "the tunnel-only deployment was flagged for having no auth",
  );
});

// A required secret the operator alone can supply gets no CHANGEME placeholder:
// compose passes it as ${KEY:?} so `up` fails loudly until it is set, rather
// than the image booting with a real-looking value that only breaks later.
test("a required secret bails compose rather than getting a placeholder", () => {
  const google: Answers = {
    ...BASIC,
    authMode: "google",
    googleClientId: "1234-abc.apps.googleusercontent.com",
    allowedEmails: "me@example.com",
  };
  const out = generate(google);
  // No live secret line in .env, only a commented, uncomment-ready reminder.
  assert(!/^GOOGLE_CLIENT_SECRET=/m.test(out[".env"]));
  assert(/^# GOOGLE_CLIENT_SECRET=/m.test(out[".env"]));
  // compose enforces it: `docker compose up` refuses to start until it is set.
  assert(out["compose.yaml"].includes('- "GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET:?'));

  // A supplied secret is written to .env and still guarded in compose.
  const supplied = generate(google, { clientSecret: "GOCSPX-real" });
  assert(supplied[".env"].includes("GOOGLE_CLIENT_SECRET=GOCSPX-real"));
  assert(supplied["compose.yaml"].includes('- "GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET:?'));

  // The tailscale sidecar's auth key is required the same way.
  const ts = generate({
    ...BASIC,
    boundary: "tailscale",
    ssh: "tunnel",
    sshPort: undefined,
    tsHostname: "work.tail1234.ts.net",
  });
  assert(!/^TS_AUTHKEY=/m.test(ts[".env"]));
  assert(ts["compose.yaml"].includes('- "TS_AUTHKEY=${TS_AUTHKEY:?'));
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

test("the startup script is mounted into provision.d, with every $ literal", () => {
  const startupScript = 'echo "$HOME" ${USER}\n\n[ -d ~/src/x ] || git clone https://x ~/src/x';
  const compose = generate({ ...BASIC, startupScript }, { randomSecret: fixed })["compose.yaml"];
  assert(compose.includes("      - source: startup-script"), compose);
  assert(compose.includes("        target: /etc/agent-env/provision.d/10-startup"), compose);
  const block = compose.slice(compose.indexOf("  startup-script:\n"));
  assert(
    block.startsWith(
      '  startup-script:\n    content: |\n      echo "$$HOME" $${USER}\n\n      [ -d ~/src/x ]',
    ),
    block,
  );
  assertEquals(answersFromCompose(compose)?.startupScript, startupScript);

  const none = generate({ ...BASIC, startupScript: " \n" }, { randomSecret: fixed });
  assert(!none["compose.yaml"].includes("startup-script"), none["compose.yaml"]);
  assert(!generate(BASIC, { randomSecret: fixed })["compose.yaml"].includes("startup-script"));
});

test("a startup script that starts indented still reads back as written", () => {
  const compose = generate(
    { ...BASIC, startupScript: "\r\n  \r\n  indented\r\nnot\r\n\r\n" },
    { randomSecret: fixed },
  )["compose.yaml"];
  // YAML would take the block's indentation from "  indented" and end it at "not".
  const block = compose.slice(compose.indexOf("  startup-script:\n"));
  assert(
    block.startsWith("  startup-script:\n    content: |2\n        indented\n      not\n"),
    block,
  );
});

test("the page's startup script is an answer, and blank is none", () => {
  const f: Fields = { ...DEFAULT_FIELDS, startupScript: "mise use -g ripgrep\n" };
  assertEquals(toAnswers(f).startupScript, "mise use -g ripgrep");
  assertEquals(fieldsFromAnswers(toAnswers(f)).startupScript, "mise use -g ripgrep");
  assertEquals(toAnswers({ ...DEFAULT_FIELDS, startupScript: "\n  \n" }).startupScript, undefined);
});

// --- Axis migration & the SSH axis -----------------------------------------

test("version-2 answers migrate onto the three axes", () => {
  const caddy = migrateAnswers({ mode: "caddy", domain: "x.example.com" });
  assertEquals(
    [caddy.boundary, caddy.tls, caddy.publish, caddy.ssh],
    ["host", "gateway", "public", "host-port"],
  );
  // behindProxy dissolves into host/upstream/loopback, like a bare local run.
  const proxied = migrateAnswers({ mode: "local", behindProxy: true });
  assertEquals(
    [proxied.boundary, proxied.tls, proxied.publish, proxied.ssh],
    ["host", "upstream", "loopback", "host-port"],
  );
  const none = migrateAnswers({ mode: "none" });
  assertEquals(
    [none.boundary, none.tls, none.publish, none.ssh],
    ["host", "upstream", "expose", "tunnel"],
  );
  const ts = migrateAnswers({ mode: "tailscale" });
  assertEquals([ts.boundary, ts.tls, ts.ssh], ["tailscale", "upstream", "tunnel"]);
  const wg = migrateAnswers({ mode: "wireguard" });
  assertEquals([wg.boundary, wg.tls, wg.ssh], ["wireguard", "upstream", "tunnel"]);
  const wgDomain = migrateAnswers({ mode: "wireguard", domain: "box.example.com" });
  assertEquals([wgDomain.boundary, wgDomain.tls], ["wireguard", "gateway"]);
  // The old keys do not survive the migration.
  assert(!("mode" in caddy) && !("behindProxy" in proxied));
  // A v3 object already carrying a boundary is left untouched.
  assertEquals(migrateAnswers({ boundary: "tailscale", tls: "upstream" }).boundary, "tailscale");
});

test("ssh is its own axis: a host port rides the sidecar under a tunnel, off publishes nothing", () => {
  // A host SSH port alongside a WireGuard tunnel is published on the sidecar,
  // which owns the namespace — not on the agent-env service.
  const forwarded = generate({ ...WG, ssh: "host-port", sshPort: 2222 })["compose.yaml"];
  const agentBlock = forwarded.slice(
    forwarded.indexOf("agent-env:"),
    forwarded.indexOf("wireguard:"),
  );
  assert(!/^\s+ports:/m.test(agentBlock), "agent-env published ssh itself");
  const sidecar = forwarded.slice(forwarded.indexOf("wireguard:"));
  assert(sidecar.includes('- "2222:22"'), "ssh host port not on the sidecar");
  assert(sidecar.includes("60000-60010"), "mosh range not on the sidecar");
  // Off: no ssh, no mosh, nothing published for either.
  const off = generate({ ...BASIC, ssh: "off", sshPort: undefined })["compose.yaml"];
  assert(!off.includes(':22"'), "ssh published with ssh: off");
  assert(!off.includes("60000-60010"), "mosh published with ssh: off");
});
