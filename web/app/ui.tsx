/** The configurator's pieces: fields, section bodies, import, the files panel. */

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import {
  ANSWERS_KEY,
  DEFAULT_NAME,
  DESKTOP_SCALES,
  DESKTOP_SIZES,
  GOOGLE_CLIENT_CREATE_URL,
  needsClientSecret,
} from "../../generate.ts";
import {
  type Configurator,
  type FieldName,
  type Fields,
  FIELD_LABELS,
  readImport,
  type SectionId,
  sectionOf,
} from "./model.ts";

type StringField = { [K in FieldName]: Fields[K] extends string ? K : never }[FieldName];
type BoolField = { [K in FieldName]: Fields[K] extends boolean ? K : never }[FieldName];

// ---------------------------------------------------------------------------
// Icons (Bootstrap Icons paths, as claw uses the bi set)
// ---------------------------------------------------------------------------

export const WarnIcon = () => (
  <svg class="icon warn" viewBox="0 0 16 16" aria-label="Needs attention">
    <path
      fill="currentColor"
      d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"
    />
  </svg>
);
export const OkIcon = () => (
  <svg class="icon ok" viewBox="0 0 16 16" aria-label="Looks good">
    <path
      fill="currentColor"
      d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zm-3.97-3.03a.75.75 0 0 0-1.08.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-.01-1.05z"
    />
  </svg>
);

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export interface Option {
  value: string;
  title: string;
  desc?: ComponentChildren;
}

export function Choices(props: {
  c: Configurator;
  name: StringField;
  options: Option[];
  cols?: number;
}) {
  const { c, name } = props;
  return (
    <div class="choices" style={{ "--cols": props.cols ?? props.options.length }}>
      {props.options.map((o) => (
        <label class={`choice ${c.fields[name] === o.value ? "picked" : ""}`}>
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={c.fields[name] === o.value}
            onChange={() => c.set(name, o.value)}
          />
          <strong>{o.title}</strong>
          {o.desc && <small>{o.desc}</small>}
        </label>
      ))}
    </div>
  );
}

export function Text(props: {
  c: Configurator;
  name: StringField;
  label: ComponentChildren;
  hint?: ComponentChildren;
  placeholder?: string;
  error?: string;
  class?: string;
  multiline?: boolean;
  mono?: boolean;
  /** Masked, and kept out of password managers' autofill. */
  secret?: boolean;
}) {
  const { c, name } = props;
  const error = c.errorFor(props.error ?? name);
  const common = {
    name,
    value: c.fields[name],
    placeholder: props.placeholder,
    spellcheck: false,
    class: props.mono ? "mono" : undefined,
    onInput: (e: Event) => c.set(name, (e.currentTarget as HTMLInputElement).value),
  };
  return (
    <label class={`field ${props.class ?? ""} ${error ? "has-error" : ""}`}>
      <span class="label">
        {props.label} {props.hint && <small>{props.hint}</small>}
      </span>
      {props.multiline ? (
        <textarea rows={3} {...common} />
      ) : props.secret ? (
        <input type="password" autocomplete="off" {...common} />
      ) : (
        <input type="text" {...common} />
      )}
      {error && <em class="error">{error}</em>}
    </label>
  );
}

export function Check(props: { c: Configurator; name: BoolField; children: ComponentChildren }) {
  const { c, name } = props;
  return (
    <label class="check">
      <input
        type="checkbox"
        checked={c.fields[name]}
        onChange={(e) => c.set(name, e.currentTarget.checked)}
      />
      <span>{props.children}</span>
    </label>
  );
}

export function Select(props: {
  c: Configurator;
  name: StringField;
  label: string;
  options: { value: string; label: string }[];
  class?: string;
  error?: string;
}) {
  const { c, name } = props;
  const error = props.error && c.errorFor(props.error);
  return (
    <label class={`field ${props.class ?? ""}`}>
      <span class="label">{props.label}</span>
      <select value={c.fields[name]} onChange={(e) => c.set(name, e.currentTarget.value)}>
        {props.options.map((o) => (
          <option value={o.value}>{o.label}</option>
        ))}
      </select>
      {error && <em class="error">{error}</em>}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Section bodies
// ---------------------------------------------------------------------------

function Where({ c }: { c: Configurator }) {
  const { fields: f } = c;
  return (
    <>
      <Text
        c={c}
        name="name"
        label="Name"
        hint="(the Compose project and hostname)"
        placeholder={DEFAULT_NAME}
        class="c-name"
      />
      <Choices
        c={c}
        name="mode"
        options={[
          {
            value: "local",
            title: "This machine only",
            desc: "Ports bound to 127.0.0.1. Put your own proxy in front to expose it.",
          },
          {
            value: "caddy",
            title: "A public domain",
            desc: "A Caddy sidecar gets a certificate from Let's Encrypt.",
          },
          {
            value: "tailscale",
            title: "A tailnet",
            desc: "Via Tailscale. The tailnet is the boundary; SSH and mosh just work.",
          },
          {
            value: "none",
            title: "None",
            desc: "Dokploy, Coolify and the like route to it. No ports are published.",
          },
        ]}
      />
      {f.mode === "none" && (
        <Text
          c={c}
          name="publicUrl"
          label="The URL the platform serves this at"
          hint="(route it to port 8080)"
          placeholder="https://agent.example.com"
        />
      )}
      {f.mode === "local" && (
        <>
          <Check c={c} name="behindProxy">
            Something else terminates TLS in front of this{" "}
            <small>(nginx, an ingress, a tunnel)</small>
          </Check>
          {f.behindProxy && (
            <Text
              c={c}
              name="publicUrl"
              label="The URL people will actually type"
              placeholder="https://agent.example.com"
            />
          )}
        </>
      )}
      {f.mode === "caddy" && (
        <div class="row">
          <Text
            c={c}
            name="domain"
            label="Domain name"
            hint="(or the host's IPv4 address)"
            placeholder="agent.example.com"
            class="grow"
          />
          <Text c={c} name="httpsPort" label="HTTPS port" class="narrow" />
          <Text
            c={c}
            name="acmeEmail"
            label="Let's Encrypt email"
            hint="(optional)"
            placeholder="you@example.com"
            class="grow"
          />
        </div>
      )}
      {f.mode === "tailscale" && (
        <Text
          c={c}
          name="tsHostname"
          label="Full MagicDNS name of this machine"
          placeholder="work.tail1234.ts.net"
        />
      )}
    </>
  );
}

/** Google's console, in the order it asks for things. */
function GoogleSteps({ c }: { c: Configurator }) {
  const redirect = `${c.answers.publicUrl}/oauth2/callback`;
  const kept = !needsClientSecret("google", c.fields.existingEnv);
  return (
    <ol class="steps oauth-steps">
      <li>
        Open{" "}
        <a href={GOOGLE_CLIENT_CREATE_URL} target="_blank" rel="noreferrer">
          Create OAuth client
        </a>{" "}
        in the Google Cloud console.
      </li>
      <li>
        Pick <b>Web application</b>, and add this under <b>Authorized redirect URIs</b>:
        <span class="copyline">
          <code>{redirect}</code>
          <CopyButton text={redirect} />
        </span>
      </li>
      <li>
        Create it, and paste what it shows:
        <div class="row">
          <Text
            c={c}
            name="googleClientId"
            label="Client ID"
            placeholder="1234-abc.apps.googleusercontent.com"
            class="grow"
            mono
          />
          <Text
            c={c}
            name="googleClientSecret"
            label="Client secret"
            hint="(.env only)"
            placeholder={kept ? "kept from your .env" : "GOCSPX-…"}
            class="grow"
            mono
            secret
          />
        </div>
      </li>
    </ol>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      class="small"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function Who({ c }: { c: Configurator }) {
  const { fields: f, answers: a } = c;
  const oauth = f.authMode === "google" || f.authMode === "github";
  return (
    <>
      <Choices
        c={c}
        name="authMode"
        cols={4}
        options={[
          {
            value: "google",
            title: "Google sign-in",
            desc: "oauth2-proxy, restricted to an allow list.",
          },
          {
            value: "github",
            title: "GitHub sign-in",
            desc: "Restricted to accounts, orgs or teams.",
          },
          {
            value: "basic",
            title: "Username and password",
            desc: "Fine on localhost or behind a VPN.",
          },
          {
            value: "none",
            title: "No authentication",
            desc: "Only when something else is the boundary.",
          },
        ]}
      />
      {c.errorFor("authMode") && (
        <p class="callout danger">
          {c.problems.find((p) => p.field === "authMode")?.detail?.join(" ") ??
            c.errorFor("authMode")}
        </p>
      )}
      {f.authMode === "google" && <GoogleSteps c={c} />}
      {f.authMode === "github" && (
        <>
          <Text
            c={c}
            name="githubClientId"
            label="GitHub OAuth app client ID"
            placeholder="Iv1.0123456789abcdef"
            mono
          />
          <div class="row">
            <Text
              c={c}
              name="githubUsers"
              label="Allowed usernames"
              hint="(comma-separated)"
              class="grow"
            />
            <Text c={c} name="githubOrg" label="Allowed organisation" class="grow" />
            <Text
              c={c}
              name="githubTeam"
              label="Allowed teams"
              hint={f.githubOrg ? "(slugs)" : "(org:team)"}
              class="grow"
            />
          </div>
        </>
      )}
      {oauth && (
        <>
          <div class="row">
            <Text
              c={c}
              name="allowedEmails"
              label="Allowed emails"
              hint="(comma-separated)"
              class="grow"
            />
            <Text
              c={c}
              name="allowedEmailDomains"
              label="Allowed domains"
              hint="(comma-separated)"
              class="grow"
            />
          </div>
          {f.authMode === "github" && (
            <p class="hint">
              Register this redirect URI with the OAuth client:{" "}
              <code>{a.publicUrl}/oauth2/callback</code>
            </p>
          )}
        </>
      )}
      {f.authMode === "basic" && <Text c={c} name="gatewayUser" label="Username" class="narrow" />}
      {f.authMode === "none" && f.mode !== "caddy" && (
        <p class="callout">Anyone who can reach this gets a root-capable shell in the container.</p>
      )}
    </>
  );
}

/** Where `/` goes when OpenCode is not there: a port, and optionally a command run on it. */
export function PrimaryFields({ c }: { c: Configurator }) {
  return (
    <div class="row">
      <Text
        c={c}
        name="primaryPort"
        label={
          <>
            Port <code>/</code> proxies to
          </>
        }
        class="narrow"
      />
      <Text
        c={c}
        name="primaryCommand"
        label="A command to run there"
        hint={
          <>
            (optional; <code>$PORT</code> is the port)
          </>
        }
        placeholder="npm run dev -- --port $PORT"
        class="grow"
        mono
      />
    </div>
  );
}

export const DESKTOP_OPTIONS: Option[] = [
  {
    value: "desktop",
    title: "noVNC",
    desc: "Works everywhere; several people can drive it at once.",
  },
  {
    value: "desktop-selkies",
    title: "Selkies (prototype)",
    desc: "Audio and smoother video; needs https or localhost; one person drives.",
  },
  {
    value: "none",
    title: "No desktop",
  },
];

/** Screen size and text scale, for whichever desktop is on. */
export function DesktopGeometry({ c }: { c: Configurator }) {
  const { fields: f } = c;
  return (
    <div class="row">
      <Select
        c={c}
        name="desktopSizePick"
        label="Screen size"
        class="grow"
        options={[...DESKTOP_SIZES, { value: "custom", label: "Something else…" }]}
      />
      {f.desktopSizePick === "custom" && (
        <Text
          c={c}
          name="desktopSizeCustom"
          label="Width × height"
          placeholder="2200x1300"
          error="desktopSize"
          class="grow"
        />
      )}
      <Select
        c={c}
        name="desktopScale"
        label="Text and window size"
        class="grow"
        error="desktopScale"
        options={DESKTOP_SCALES.map((s) => ({
          value: String(s),
          label: s === 100 ? "100% (normal)" : s === 200 ? "200% (HiDPI)" : `${s}%`,
        }))}
      />
    </div>
  );
}

/** Memory, swap and CPUs, without their heading. */
export function LimitFields({ c }: { c: Configurator }) {
  const { fields: f } = c;
  return (
    <div class="row">
      <Text c={c} name="memoryGiB" label="Memory" hint="(GiB)" placeholder="8" class="narrow" />
      <Text
        c={c}
        name="swapGiB"
        label="Swap on top"
        hint="(GiB; 0 for none)"
        placeholder={f.memoryGiB.trim() ? `${f.memoryGiB.trim()} (Docker's default)` : "—"}
      />
      <Text c={c} name="cpus" label="CPUs" placeholder="2" class="narrow" />
    </div>
  );
}

function Runs({ c }: { c: Configurator }) {
  const { fields: f } = c;
  return (
    <>
      <h3>At /</h3>
      <Check c={c} name="opencode">
        OpenCode <small> — installed for you; its web UI is at /</small>
      </Check>
      {!f.opencode && <PrimaryFields c={c} />}
      <h3>Desktop</h3>
      <Choices c={c} name="desktop" cols={3} options={DESKTOP_OPTIONS} />
      {f.desktop !== "none" && <DesktopGeometry c={c} />}
      <h3>Also</h3>
      <Check c={c} name="terminal">
        A terminal in the browser
      </Check>
      <Check c={c} name="fileManager">
        A file manager in the browser
      </Check>
      <Check c={c} name="docker">
        Let the agent run its own containers (rootless Docker)
        <small> — adds host flags that widen the sandbox</small>
      </Check>
      <Check c={c} name="smb">
        Share the workspace over SMB
        <small>
          {" "}
          — for the Files app or Finder; the password is on the /~env/ page
          {f.mode !== "tailscale" && "; port 445 is not published, so forward it yourself"}
        </small>
      </Check>
      {c.errorFor("components") && <p class="callout danger">{c.errorFor("components")}</p>}
      <h3>
        Limits <small>(optional; blank means none)</small>
      </h3>
      <LimitFields c={c} />
    </>
  );
}

function Storage({ c }: { c: Configurator }) {
  const { fields: f } = c;
  return (
    <>
      <div class="row">
        <Text
          c={c}
          name="sshKeys"
          label="SSH public keys"
          hint="(one per line)"
          placeholder="ssh-ed25519 AAAA… you@host"
          multiline
          mono
          class="grow"
        />
        {f.mode !== "tailscale" && f.mode !== "none" && (
          <Text c={c} name="sshPort" label="SSH host port" class="narrow" />
        )}
      </div>
      <h3>
        <code>/workspace</code>
      </h3>
      <Choices
        c={c}
        name="workspaceKind"
        cols={2}
        options={[
          { value: "volume", title: "Docker volume", desc: "Managed by Docker." },
          { value: "path", title: "Host directory", desc: "Edit the same files from outside." },
        ]}
      />
      {f.workspaceKind === "path" && (
        <div class="row">
          <Text
            c={c}
            name="workspacePath"
            label="Host directory"
            placeholder="/srv/code"
            class="grow"
            mono
          />
          <Text c={c} name="puid" label="Owner UID" class="narrow" />
          <Text c={c} name="pgid" label="Owner GID" class="narrow" />
        </div>
      )}
      <h3>
        <code>/home/dev</code>
      </h3>
      <Choices
        c={c}
        name="homeKind"
        cols={2}
        options={[
          { value: "volume", title: "Docker volume", desc: "Managed by Docker." },
          {
            value: "path",
            title: "Host directory",
            desc: "Back up or inspect logins and dotfiles.",
          },
        ]}
      />
      {f.homeKind === "path" && (
        <div class="row">
          <Text
            c={c}
            name="homePath"
            label="Host directory"
            placeholder="/srv/home"
            class="grow"
            mono
          />
          {f.workspaceKind === "volume" && (
            <>
              <Text c={c} name="homeUid" label="Owner UID" class="narrow" />
              <Text c={c} name="homeGid" label="Owner GID" class="narrow" />
            </>
          )}
        </div>
      )}
      <Text c={c} name="timezone" label="Time zone" class="narrow" />
    </>
  );
}

export function SectionBody({ c, id }: { c: Configurator; id: SectionId }) {
  switch (id) {
    case "where":
      return <Where c={c} />;
    case "who":
      return <Who c={c} />;
    case "runs":
      return <Runs c={c} />;
    case "storage":
      return <Storage c={c} />;
    case "files":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** A box that takes pasted text, or the text of a file picked into it. */
function Paste(props: {
  label: ComponentChildren;
  hint: ComponentChildren;
  value: string;
  onInput: (v: string) => void;
  accept?: string;
  error?: string;
  rows: number;
}) {
  return (
    <label class={`field ${props.error ? "has-error" : ""}`}>
      <span class="label">
        {props.label} <small>{props.hint}</small>
      </span>
      <textarea
        class="mono"
        rows={props.rows}
        spellcheck={false}
        value={props.value}
        placeholder="Paste it here, or choose the file below."
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
      <input
        type="file"
        accept={props.accept}
        onChange={async (e) => {
          const file = e.currentTarget.files?.[0];
          if (file) props.onInput(await file.text());
        }}
      />
      {props.error && <em class="error">{props.error}</em>}
    </label>
  );
}

/**
 * Bring an existing deployment back: its compose.yaml for the answers, its
 * .env for the secrets in use. Neither leaves the page.
 */
export function ImportDialog({ c, onClose }: { c: Configurator; onClose: () => void }) {
  const [compose, setCompose] = useState("");
  const [env, setEnv] = useState(c.fields.existingEnv);
  const [error, setError] = useState<string>();
  const submit = (e: Event) => {
    e.preventDefault();
    const read = readImport(compose);
    if ("error" in read) {
      setError(read.error);
      return;
    }
    c.importDeployment(read.answers, env);
    onClose();
  };
  return (
    <div
      class="overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <form class="card dialog" onSubmit={submit}>
        <h2 id="import-title">Import an existing deployment</h2>
        <p class="muted">
          Its answers come back into the form, and the secrets already in use are kept. Nothing you
          paste leaves this page.
        </p>
        <Paste
          label={<code>compose.yaml</code>}
          hint={<>— the answers, from its {ANSWERS_KEY} line</>}
          value={compose}
          onInput={(v) => {
            setCompose(v);
            setError(undefined);
          }}
          accept=".yaml,.yml,.json"
          error={error}
          rows={6}
        />
        <Paste
          label={<code>.env</code>}
          hint="— optional; its secrets and extra keys are kept"
          value={env}
          onInput={setEnv}
          rows={4}
        />
        <footer class="dialog-foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" class="primary" disabled={!compose.trim() && !env.trim()}>
            Import
          </button>
        </footer>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const FILE_NAMES = ["compose.yaml", ".env"];

function download(name: string, body: string): void {
  // Not text/plain: browsers append ".txt" to a name like ".env" for that.
  const blob = new Blob([body], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  // Some browsers drop a leading dot; "env" saved this way still needs renaming.
  a.download = name;
  a.click();
  // Revoked on the next tick, not now: some browsers start the download
  // asynchronously and would find the URL already gone.
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

export function FilesPanel({ c, class: cls }: { c: Configurator; class?: string }) {
  const [current, setCurrent] = useState("compose.yaml");
  const [copied, setCopied] = useState(false);
  const body = c.files?.[current];
  return (
    <section class={`files card ${cls ?? ""}`}>
      <div class="files-head">
        <div class="filetabs" role="tablist">
          {FILE_NAMES.map((n) => (
            <button role="tab" aria-selected={n === current} onClick={() => setCurrent(n)}>
              {n}
            </button>
          ))}
        </div>
        <div class="actions">
          <button
            class="small"
            disabled={!body}
            onClick={async () => {
              await navigator.clipboard.writeText(body ?? "");
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button class="small" disabled={!body} onClick={() => download(current, body ?? "")}>
            Download
          </button>
          <button
            class="small"
            disabled={!body}
            onClick={c.rerollSecrets}
            title="Pick fresh random values for the generated password and cookie secret. Keys from an imported .env are left alone."
          >
            Re-roll secrets
          </button>
        </div>
      </div>
      {body ? (
        <pre>
          <code>{body}</code>
        </pre>
      ) : (
        <div class="files-empty">
          <WarnIcon />
          <p>
            {c.problems.length === 1 ? "One thing" : `${c.problems.length} things`} to fix before
            these files can be written.
          </p>
        </div>
      )}
    </section>
  );
}

export function ProblemList({ c, onGo }: { c: Configurator; onGo?: (id: SectionId) => void }) {
  if (!c.problems.length) return null;
  return (
    <ul class="problems">
      {c.problems.map((p) => {
        const id = sectionOf(p);
        const label = p.field && !p.detail ? FIELD_LABELS[p.field] : undefined;
        return (
          <li>
            <WarnIcon />
            <span>
              {label && <strong>{label}: </strong>}
              {label ? p.message : <strong>{p.message}</strong>} {p.detail?.join(" ")}
            </span>
            {onGo && id && (
              <button class="small" onClick={() => onGo(id)}>
                Go
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
