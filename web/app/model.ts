/**
 * The configurator's state: the form as a flat record of fields, turned into
 * generate.ts Answers the way the setup.ts wizard's collect() shapes them, plus
 * the sections the steps group those fields into. The rules — what is valid,
 * what each answer turns into — all live in generate.ts, so the two front ends
 * cannot disagree.
 */

import { useEffect, useMemo, useState } from "preact/hooks";
import { type WgKeypair, wgCryptoAvailable, wgKeypair } from "./wgkeys.ts";
import {
  type Answers,
  answersFromCompose,
  ANSWERS_KEY,
  type AuthMode,
  clientSecretKey,
  type Component,
  desktopOf,
  migrateAnswers,
  sortComponents,
  startupScriptBody,
  needsClientSecret,
  DEFAULT_NAME,
  DESKTOP_SIZES,
  generate,
  isIPv4,
  LEGACY_ANSWERS_FILE,
  hostPathFor,
  type Mode,
  type Problem,
  publicUrlFor,
  randomSecret,
  validate,
  VERSION,
  type Wireguard,
} from "../../generate.ts";

export const DEFAULT_FIELDS = {
  name: DEFAULT_NAME as string,
  mode: "local",
  behindProxy: false,
  publicUrl: "",
  domain: "",
  httpsPort: "443",
  acmeEmail: "",
  tsHostname: "",
  // WireGuard: what peers dial, the sidecar's UDP port, the server's tunnel
  // address, and the peer devices — one label per line. Keys are generated for
  // you; see useConfigurator.
  wgEndpoint: "",
  wgAddress: "10.8.0.1/24",
  wgPeers: "",
  authMode: "basic",
  googleClientId: "",
  // Not an answer: it goes to .env only, and is never saved with the answers.
  googleClientSecret: "",
  githubClientId: "",
  githubUsers: "",
  githubOrg: "",
  githubTeam: "",
  allowedEmails: "",
  allowedEmailDomains: "",
  gatewayUser: "dev",
  // AGENT_ENV_COMPONENTS, one field per choice. The desktop is one of three.
  desktop: "desktop" as "none" | "desktop" | "desktop-selkies",
  terminal: true,
  fileManager: true,
  opencode: false,
  docker: false,
  smb: false,
  primaryPort: "3000",
  primaryCommand: "",
  desktopSizePick: "1920x1080",
  desktopSizeCustom: "",
  desktopScale: "100",
  memoryGiB: "",
  swapGiB: "",
  cpus: "",
  startupScript: "",
  sshKeys: "",
  sshPort: "2222",
  workspaceKind: "volume",
  workspacePath: "",
  puid: "1000",
  pgid: "1000",
  homeKind: "volume",
  homePath: "",
  homeUid: "1000",
  homeGid: "1000",
  timezone: "UTC",
  existingEnv: "",
};
export type Fields = typeof DEFAULT_FIELDS;
export type FieldName = keyof Fields;

/** The screenshots' starting point: a public deployment, half filled in. */
export const DEMO_FIELDS: Partial<Fields> = {
  mode: "caddy",
  domain: "agent.example.com",
  authMode: "google",
  googleClientId: "1234-abc.apps.googleusercontent.com",
  opencode: true,
  sshKeys: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample dtinth@laptop",
  timezone: "Asia/Bangkok",
};

// Only a plain decimal is a number here. Number() also takes "1e2" and "0x10",
// which would reach the checks already converted and pass them; NaN fails them
// instead, the way the wizard refuses the same text.
const num = (v: string): number | undefined => {
  const t = v.trim();
  return t === "" ? undefined : /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
};

/** The map key the server's own generated keypair is held under. */
export const WG_SERVER = "__server__";

/** Peer labels from the textarea: one per non-blank line, trimmed. */
export function wgPeerNames(wgPeers: string): string[] {
  return wgPeers
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * The nth peer's tunnel address: the server's address with its last octet
 * stepped by n. So 10.8.0.1/24 gives peers 10.8.0.2, 10.8.0.3, … — enough for
 * the common /24, and the operator can edit compose.yaml for anything larger.
 */
export function wgPeerAddress(serverAddress: string, n: number): string {
  const host = serverAddress.split("/")[0];
  const octets = host.split(".");
  if (octets.length !== 4) return host;
  octets[3] = String((Number(octets[3]) || 1) + n + 1);
  return octets.join(".");
}

/** The wireguard answers the fields describe, with the public keys left to the
 *  hook to fill in from its generated keystore. */
function wireguardOf(f: Fields): Wireguard {
  const endpoint = f.wgEndpoint.trim();
  // The published UDP port is the endpoint's port — one source of truth, so the
  // port peers dial and the port the sidecar listens on cannot drift apart.
  const port = num(endpoint.slice(endpoint.lastIndexOf(":") + 1));
  return {
    endpoint,
    listenPort: port && !Number.isNaN(port) ? port : 51820,
    address: f.wgAddress.trim(),
    serverPublicKey: "",
    peers: wgPeerNames(f.wgPeers).map((name, i) => ({
      name,
      publicKey: "",
      address: wgPeerAddress(f.wgAddress.trim(), i),
    })),
  };
}

/** The components the fields choose, in AGENT_ENV_COMPONENTS order. */
export function componentsOf(f: Fields): Component[] {
  const list: string[] = [];
  if (f.desktop !== "none") list.push(f.desktop);
  if (f.terminal) list.push("terminal");
  if (f.fileManager) list.push("files");
  if (f.opencode) list.push("opencode");
  if (f.docker) list.push("docker");
  if (f.smb) list.push("smb");
  return sortComponents(list);
}

export function toAnswers(f: Fields): Answers {
  const mode = f.mode as Mode;
  const authMode = f.authMode as AuthMode;
  const components = componentsOf(f);
  const opencode = components.includes("opencode");
  const behindProxy = mode === "local" ? f.behindProxy : undefined;
  const a: Answers = {
    version: VERSION,
    name: f.name.trim() || DEFAULT_NAME,
    mode,
    behindProxy,
    publicUrl: "",
    domain: mode === "caddy" ? f.domain.trim() : undefined,
    httpsPort: mode === "caddy" ? num(f.httpsPort) : undefined,
    acmeEmail: mode === "caddy" ? f.acmeEmail.trim() : undefined,
    tsHostname: mode === "tailscale" ? f.tsHostname.trim() : undefined,
    wireguard: mode === "wireguard" ? wireguardOf(f) : undefined,
    authMode,
    components,
    desktopSize:
      f.desktopSizePick === "custom"
        ? f.desktopSizeCustom
            .trim()
            .toLowerCase()
            .replace(/\s*[x×]\s*/, "x")
        : f.desktopSizePick,
    desktopScale: Number(f.desktopScale),
    primaryPort: opencode ? undefined : num(f.primaryPort),
    primaryCommand: opencode ? undefined : f.primaryCommand.trim() || undefined,
    memoryGiB: num(f.memoryGiB),
    swapGiB: num(f.swapGiB),
    cpus: num(f.cpus),
    startupScript: startupScriptBody(f) || undefined,
    sshKeys: f.sshKeys.trim(),
    sshPort:
      mode === "tailscale" || mode === "wireguard" || mode === "none" ? undefined : num(f.sshPort),
    workspace:
      f.workspaceKind === "path"
        ? {
            kind: "path",
            path: f.workspacePath.trim() && hostPathFor(f.workspacePath.trim()),
            puid: num(f.puid) ?? 1000,
            pgid: num(f.pgid) ?? 1000,
          }
        : { kind: "volume" },
    home:
      f.homeKind === "path"
        ? {
            kind: "path",
            path: f.homePath.trim() && hostPathFor(f.homePath.trim()),
            puid: num(f.homeUid) ?? 1000,
            pgid: num(f.homeGid) ?? 1000,
          }
        : { kind: "volume" },
    timezone: f.timezone.trim() || "UTC",
  };
  if (authMode === "google") a.googleClientId = f.googleClientId.trim();
  if (authMode === "github") {
    a.githubClientId = f.githubClientId.trim();
    a.githubUsers = f.githubUsers.trim();
    a.githubOrg = f.githubOrg.trim();
    a.githubTeam = f.githubTeam.trim();
  }
  if (authMode === "google" || authMode === "github") {
    a.allowedEmails = f.allowedEmails.trim();
    a.allowedEmailDomains = f.allowedEmailDomains.trim();
  }
  if (authMode === "basic") a.gatewayUser = f.gatewayUser.trim() || "dev";
  a.publicUrl = publicUrlFor({
    ...a,
    publicUrl: behindProxy || mode === "none" ? f.publicUrl.trim() : "",
  });
  return a;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export type SectionId = "where" | "who" | "runs" | "storage" | "files";

export interface Section {
  id: SectionId;
  title: string;
  /** Problems whose field is one of these belong to this section. */
  fields: string[];
  summary: (a: Answers) => string;
}

const MODE_LABEL: Record<Mode, string> = {
  local: "This machine",
  caddy: "Public domain",
  tailscale: "Tailnet",
  wireguard: "WireGuard",
  none: "Platform",
};
const AUTH_LABEL: Record<AuthMode, string> = {
  google: "Google",
  github: "GitHub",
  basic: "Password",
  none: "No auth",
};
const count = (v: string | undefined) => (v ?? "").split(",").filter((x) => x.trim()).length;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export const SECTIONS: Section[] = [
  {
    id: "where",
    title: "Where",
    fields: [
      "name",
      "mode",
      "publicUrl",
      "domain",
      "httpsPort",
      "acmeEmail",
      "tsHostname",
      "wgEndpoint",
      "wgAddress",
      "wgPeers",
      "wgServerPublicKey",
      "wireguard",
    ],
    summary: (a) =>
      `${a.name ?? DEFAULT_NAME} · ${MODE_LABEL[a.mode]} · ${a.publicUrl.replace(/^https?:\/\//, "")}`,
  },
  {
    id: "who",
    title: "Who",
    fields: [
      "authMode",
      "googleClientId",
      "githubClientId",
      "githubUsers",
      "githubOrg",
      "githubTeam",
      "allowedEmails",
      "allowedEmailDomains",
      "gatewayUser",
    ],
    summary: (a) => {
      if (a.authMode === "basic") return `Password · user ${a.gatewayUser}`;
      if (a.authMode === "none") return "No auth";
      const n =
        count(a.allowedEmails) +
        count(a.allowedEmailDomains) +
        count(a.githubUsers) +
        count(a.githubOrg) +
        count(a.githubTeam);
      return `${AUTH_LABEL[a.authMode]} · ${n ? plural(n, "rule") : "no allow list"}`;
    },
  },
  {
    id: "runs",
    title: "What runs",
    fields: [
      "components",
      "primaryPort",
      "primaryCommand",
      "desktopSize",
      "desktopScale",
      "memoryGiB",
      "swapGiB",
      "cpus",
      "startupScript",
    ],
    summary: (a) =>
      [
        a.components.includes("opencode") ? "OpenCode" : "",
        desktopOf(a.components)
          ? `${desktopOf(a.components) === "desktop-selkies" ? "Selkies" : "noVNC"} ${a.desktopSize?.replace("x", "×")}`
          : "No desktop",
        a.components.includes("terminal") ? "Terminal" : "",
        a.components.includes("files") ? "Files" : "",
        a.components.includes("docker") ? "Docker" : "",
        a.components.includes("smb") ? "SMB" : "",
        a.memoryGiB !== undefined ? `${a.memoryGiB} GiB` : "",
        a.cpus !== undefined ? plural(a.cpus, "CPU") : "",
        a.startupScript ? "Startup script" : "",
      ]
        .filter(Boolean)
        .join(" · "),
  },
  {
    id: "storage",
    title: "Access & storage",
    fields: [
      "sshKeys",
      "sshPort",
      "workspacePath",
      "puid",
      "pgid",
      "homePath",
      "homeUid",
      "homeGid",
    ],
    summary: (a) => {
      const keys = a.sshKeys.split("\n").filter((l) => l.trim()).length;
      const vols = [a.workspace, a.home ?? { kind: "volume" }].filter(
        (w) => w.kind === "volume",
      ).length;
      return `${plural(keys, "SSH key")} · ${vols === 2 ? "2 volumes" : vols === 1 ? "1 volume, 1 bind" : "2 binds"}`;
    },
  },
];

/** How a problem names its field when it is shown away from the field itself. */
export const FIELD_LABELS: Record<string, string> = {
  name: "Environment name",
  publicUrl: "Public URL",
  domain: "Domain name",
  httpsPort: "HTTPS port",
  acmeEmail: "Let's Encrypt email",
  tsHostname: "MagicDNS name",
  wgEndpoint: "WireGuard endpoint",
  wgAddress: "Server tunnel address",
  wgPeers: "Peers",
  wireguard: "WireGuard",
  googleClientId: "Google client ID",
  githubClientId: "GitHub client ID",
  githubTeam: "Allowed teams",
  primaryPort: "Primary port",
  primaryCommand: "Command",
  components: "Components",
  desktopSize: "Screen size",
  desktopScale: "Text size",
  memoryGiB: "Memory limit",
  swapGiB: "Swap",
  cpus: "CPU limit",
  sshPort: "SSH port",
  workspacePath: "Workspace directory",
  puid: "Owner UID",
  pgid: "Owner GID",
  homePath: "Home directory",
  homeUid: "Owner UID",
  homeGid: "Owner GID",
};

export function sectionOf(p: Problem): SectionId | undefined {
  return SECTIONS.find((s) => p.field && s.fields.includes(p.field))?.id;
}

// ---------------------------------------------------------------------------
// The hook every layout uses
// ---------------------------------------------------------------------------

/**
 * Secrets are minted once per key and then held, so the password on screen
 * does not change with every keystroke, or with a reload of this tab. They are
 * kept in sessionStorage, not localStorage: a credential should not outlive
 * the visit on this machine. Across visits, importing the .env in use is the
 * way to keep them. Re-rolling clears this.
 */
const SECRETS_KEY = "agent-env-configurator:secrets";
const STORAGE_KEY = "agent-env-configurator:answers";
// WireGuard keypairs, held the same way and for the same reason as secrets: a
// peer's key must not change with every keystroke, and the private halves must
// never reach localStorage, where the answers (and so compose.yaml) are kept.
const WGKEYS_KEY = "agent-env-configurator:wgkeys";

function loadSecrets(): Map<string, string> {
  try {
    return new Map(
      Object.entries(
        JSON.parse(sessionStorage.getItem(SECRETS_KEY) ?? "{}") as Record<string, string>,
      ),
    );
  } catch {
    return new Map();
  }
}
function saveSecrets(minted: Map<string, string>): void {
  try {
    sessionStorage.setItem(SECRETS_KEY, JSON.stringify(Object.fromEntries(minted)));
  } catch {
    // Blocked storage: secrets still hold for as long as the page is open.
  }
}

export type WgKeystore = Record<string, WgKeypair>;
function loadWgKeys(): WgKeystore {
  try {
    return JSON.parse(sessionStorage.getItem(WGKEYS_KEY) ?? "{}") as WgKeystore;
  } catch {
    return {};
  }
}
function saveWgKeys(keys: WgKeystore): void {
  try {
    sessionStorage.setItem(WGKEYS_KEY, JSON.stringify(keys));
  } catch {
    // Blocked storage: the keys still hold for as long as the page is open.
  }
}

/** Saved answers, back into the form's fields: the inverse of `toAnswers`. */
export function fieldsFromAnswers(a: Partial<Answers>): Partial<Fields> {
  const f: Partial<Fields> = {};
  const str = (v: string | number | undefined) => (v === undefined ? undefined : String(v));
  const put = <K extends FieldName>(k: K, v: Fields[K] | undefined) => {
    if (v !== undefined && v !== null) f[k] = v;
  };
  put("name", a.name);
  put("mode", a.mode);
  put("behindProxy", a.behindProxy);
  if (a.behindProxy || a.mode === "none") put("publicUrl", a.publicUrl);
  put("domain", a.domain);
  put("httpsPort", str(a.httpsPort));
  put("acmeEmail", a.acmeEmail);
  put("tsHostname", a.tsHostname);
  if (a.wireguard) {
    put("wgEndpoint", a.wireguard.endpoint);
    put("wgAddress", a.wireguard.address);
    put("wgPeers", a.wireguard.peers.map((p) => p.name).join("\n"));
  }
  put("authMode", a.authMode);
  put("googleClientId", a.googleClientId);
  put("githubClientId", a.githubClientId);
  put("githubUsers", a.githubUsers);
  put("githubOrg", a.githubOrg);
  put("githubTeam", a.githubTeam);
  put("allowedEmails", a.allowedEmails);
  put("allowedEmailDomains", a.allowedEmailDomains);
  put("gatewayUser", a.gatewayUser);
  if (Array.isArray(a.components)) {
    const has = (c: Component) => a.components!.includes(c);
    put("desktop", desktopOf(a.components) ?? "none");
    put("terminal", has("terminal"));
    put("fileManager", has("files"));
    put("opencode", has("opencode"));
    put("docker", has("docker"));
    put("smb", has("smb"));
  }
  put("primaryPort", str(a.primaryPort));
  put("primaryCommand", a.primaryCommand);
  if (a.desktopSize) {
    const known = DESKTOP_SIZES.some((s) => s.value === a.desktopSize);
    put("desktopSizePick", known ? a.desktopSize : "custom");
    if (!known) put("desktopSizeCustom", a.desktopSize);
  }
  put("desktopScale", str(a.desktopScale));
  put("memoryGiB", str(a.memoryGiB));
  put("swapGiB", str(a.swapGiB));
  put("cpus", str(a.cpus));
  put("startupScript", a.startupScript);
  put("sshKeys", a.sshKeys);
  put("sshPort", str(a.sshPort));
  put("timezone", a.timezone);
  if (a.workspace) {
    put("workspaceKind", a.workspace.kind);
    put("workspacePath", a.workspace.path);
    put("puid", str(a.workspace.puid));
    put("pgid", str(a.workspace.pgid));
  }
  if (a.home) {
    put("homeKind", a.home.kind);
    put("homePath", a.home.path);
    put("homeUid", str(a.home.puid));
    put("homeGid", str(a.home.pgid));
  }
  return f;
}

/**
 * The answers in what was pasted, or why there are none. An older deployment
 * keeps them in agent-env.setup.json rather than compose.yaml, and that file
 * is accepted in the same box, since it is the same thing to the person.
 */
export function readImport(text: string): { answers: Partial<Answers> | null } | { error: string } {
  // Nothing pasted: only the .env is being brought in, and the form stays as it is.
  if (!text.trim()) return { answers: null };
  const fromCompose = answersFromCompose(text);
  if (fromCompose) return { answers: fromCompose };
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v) && "mode" in v) {
      return { answers: migrateAnswers(v as Partial<Answers>) };
    }
  } catch {
    // Not the legacy file either; say what was expected below.
  }
  return {
    error: `No ${ANSWERS_KEY} answers in this. Paste a compose.yaml made by this page or setup.ts, or the ${LEGACY_ANSWERS_FILE} an older version wrote beside it.`,
  };
}

export function nextSteps(a: Answers, env: string): string[] {
  const steps: string[] = [];
  const key = clientSecretKey(a.authMode);
  // Only while .env still has the placeholder: a pasted or kept secret is done.
  if (key && needsClientSecret(a.authMode, env)) {
    const which = a.authMode === "google" ? "Google" : "GitHub";
    steps.push(`Put your ${which} client secret in .env (${key}).`);
  }
  // The form walks through Google's; GitHub's is still to do.
  if (a.authMode === "github")
    steps.push(`Register the redirect URI ${a.publicUrl}/oauth2/callback.`);
  if (a.mode === "caddy" && !isIPv4(a.domain ?? ""))
    steps.push(`Point an A record for ${a.domain} at the host.`);
  if (a.mode === "none")
    steps.push(`Have the platform route ${a.publicUrl} to port 8080 of the agent-env service.`);
  if (a.mode === "tailscale")
    steps.push("Put a tagged, reusable Tailscale auth key in .env (TS_AUTHKEY).");
  if (a.mode === "wireguard") {
    steps.push(`Open UDP port ${a.wireguard?.listenPort ?? 51820} to the host.`);
    steps.push("Install each wireguard/<peer>.conf on that device, then bring the tunnel up.");
  }
  // Never published: SMB cannot sit behind the sign-in. On a tunnel (tailnet or
  // WireGuard) the sidecar shares the container's network; else it is up to you.
  if (a.components.includes("smb") && a.mode !== "tailscale" && a.mode !== "wireguard")
    steps.push(
      "SMB (port 445) is not published. Forward it to the container yourself, on a network you trust.",
    );
  steps.push("Save both files in one directory and run docker compose up -d.");
  steps.push(`Then open ${a.publicUrl}.`);
  return steps;
}

/** Where the form starts: this browser's last answers, or the wizard's defaults. */
function initialFields(): { fields: Fields; restored: boolean; chosen: boolean } {
  const base = {
    ...DEFAULT_FIELDS,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
  // ?demo and ?demo=ready start from a half-filled and a complete public
  // deployment, for screenshots; nothing is read from or saved to storage.
  const demo = new URLSearchParams(location.search).get("demo");
  if (demo !== null) {
    return {
      fields: {
        ...base,
        ...DEMO_FIELDS,
        ...(demo === "ready" ? { allowedEmailDomains: "example.com" } : {}),
      },
      restored: false,
      chosen: true,
    };
  }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      return {
        fields: {
          ...base,
          ...fieldsFromAnswers(migrateAnswers(JSON.parse(saved) as Partial<Answers>)),
        },
        restored: true,
        chosen: true,
      };
    }
  } catch {
    // Unreadable or unavailable: start fresh.
  }
  return { fields: base, restored: false, chosen: false };
}

export function useConfigurator() {
  const [start] = useState(initialFields);
  const [fields, setFields] = useState<Fields>(start.fields);
  // Answers set on purpose, so the mode's default gate leaves them alone.
  const [touched] = useState(() => new Set<string>(start.chosen ? ["authMode"] : []));
  const [minted, setMinted] = useState(loadSecrets);
  // WireGuard keypairs, by peer name (WG_SERVER for the server's own). Minted
  // lazily by the effect below — Web Crypto is async, so keys cannot be made
  // inside the synchronous generate() the way plain secrets are.
  const [wgKeys, setWgKeys] = useState<WgKeystore>(loadWgKeys);
  // Answers came back from a previous visit, but the secrets beside them did
  // not. Decided once, before generate() mints any: from then on this tab has
  // secrets of its own, and they are still not the deployment's. It lasts
  // until that .env is imported or new secrets are chosen on purpose.
  const [missingSecrets, setMissingSecrets] = useState(
    () => start.restored && loadSecrets().size === 0,
  );

  const stableSecret = (bytes: number, key: string): string => {
    if (!minted.has(key)) {
      minted.set(key, randomSecret(bytes));
      saveSecrets(minted);
    }
    return minted.get(key)!;
  };
  const rerollSecrets = () => {
    const fresh = new Map<string, string>();
    saveSecrets(fresh);
    setMinted(fresh);
    // New WireGuard keys too: a reroll means a clean slate, and every client
    // config is reissued from the fresh server key.
    saveWgKeys({});
    setWgKeys({});
    setMissingSecrets(false);
  };
  const keepNewSecrets = () => setMissingSecrets(false);

  // Mint any WireGuard keypairs the current peers need but do not have yet: the
  // server's own, and one per peer label. Existing ones are kept, so a peer's
  // key — and the config already handed to that device — holds steady. Unused
  // keys are left in the store, harmless, in case a peer comes back.
  const wgSupported = wgCryptoAvailable();
  useEffect(() => {
    if (fields.mode !== "wireguard" || !wgSupported) return;
    const needed = [WG_SERVER, ...wgPeerNames(fields.wgPeers)];
    const missing = needed.filter((n) => !wgKeys[n]);
    if (!missing.length) return;
    let cancelled = false;
    (async () => {
      const made: WgKeystore = {};
      for (const name of missing) made[name] = await wgKeypair();
      if (cancelled) return;
      setWgKeys((prev) => {
        const next = { ...prev, ...made };
        saveWgKeys(next);
        return next;
      });
    })().catch(() => {
      // A browser without X25519: wgSupported is false and the UI says so.
    });
    return () => {
      cancelled = true;
    };
  }, [fields.mode, fields.wgPeers, wgKeys, wgSupported]);

  /**
   * Replace the answers with imported ones, if any were given, and keep the
   * secrets of the .env given. A .env on its own leaves the answers alone.
   */
  const importDeployment = (answers: Partial<Answers> | null, env: string) => {
    // Either way the .env's secrets are the ones meant, so a client secret
    // typed earlier gives way to the one it has.
    // An older .env says what was running in settings the image no longer
    // takes; they become components here, and are dropped from the new .env.
    if (!answers) {
      setFields((f) => ({
        ...f,
        ...fieldsFromAnswers(migrateAnswers({ components: componentsOf(f) }, env)),
        existingEnv: env,
        googleClientSecret: "",
      }));
      return;
    }
    touched.add("authMode");
    setFields((f) => ({
      ...DEFAULT_FIELDS,
      timezone: f.timezone,
      ...fieldsFromAnswers(migrateAnswers(answers, env)),
      existingEnv: env,
    }));
  };

  const set = <K extends FieldName>(name: K, value: Fields[K]) => {
    touched.add(name);
    setFields((f) => {
      const next = { ...f, [name]: value };
      // As the wizard does: the mode decides the sensible gate until it is picked.
      if (name === "mode" && !touched.has("authMode")) {
        next.authMode =
          value === "tailscale"
            ? "none"
            : value === "caddy" || value === "none"
              ? "google"
              : "basic";
      }
      return next;
    });
  };

  const answers = useMemo(() => {
    const a = toAnswers(fields);
    // Fold in the generated public keys. A peer whose key is still being minted
    // has none yet, so it stays out of the answers until the effect lands —
    // which is near-instant — rather than showing as an invalid empty key.
    if (a.mode === "wireguard" && a.wireguard) {
      a.wireguard = {
        ...a.wireguard,
        serverPublicKey: wgKeys[WG_SERVER]?.pub ?? "",
        peers: a.wireguard.peers.flatMap((p) =>
          wgKeys[p.name] ? [{ ...p, publicKey: wgKeys[p.name].pub }] : [],
        ),
      };
    }
    return a;
  }, [fields, wgKeys]);
  const problems = useMemo(() => validate(answers), [answers]);
  // An invalid form has no files. Keeping the last valid ones would let Copy
  // and Download export a deployment that no longer matches the answers.
  const files = useMemo(
    () =>
      problems.length
        ? null
        : generate(answers, {
            existingEnv: fields.existingEnv,
            randomSecret: stableSecret,
            clientSecret: answers.authMode === "google" ? fields.googleClientSecret : undefined,
            wireguard:
              answers.mode === "wireguard"
                ? {
                    serverPrivateKey: wgKeys[WG_SERVER]?.priv,
                    // Every peer in the answers has a key by now (the answers
                    // drop any that do not), so each gets a client config.
                    clientPrivateKeys: Object.fromEntries(
                      (answers.wireguard?.peers ?? []).flatMap((p) =>
                        wgKeys[p.name] ? [[p.name, wgKeys[p.name].priv]] : [],
                      ),
                    ),
                  }
                : undefined,
          }),
    [answers, problems, fields.existingEnv, fields.googleClientSecret, minted, wgKeys],
  );
  useEffect(() => {
    if (!files || new URLSearchParams(location.search).has("demo")) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(answers));
    } catch {
      // Private mode or blocked storage: the page works without it.
    }
  }, [files]);
  const errorFor = (field: string) => problems.find((p) => p.field === field)?.message;
  const problemsIn = (id: SectionId) => problems.filter((p) => sectionOf(p) === id);

  return {
    fields,
    set,
    answers,
    problems,
    files,
    errorFor,
    problemsIn,
    rerollSecrets,
    importDeployment,
    keepNewSecrets,
    restoredWithoutSecrets: missingSecrets && !fields.existingEnv.trim(),
    // False only on a browser without Web Crypto X25519, where wireguard mode
    // cannot mint keys; the UI tells the person to use the setup.ts wizard.
    wgSupported,
  };
}
export type Configurator = ReturnType<typeof useConfigurator>;
