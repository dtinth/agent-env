/**
 * WireGuard key generation for the browser configurator, using Web Crypto's
 * X25519 — the same curve WireGuard uses, so the raw 32-byte keys are exactly
 * what a wg config wants, in standard base64. generate.ts stays synchronous and
 * never touches crypto; these run in the hook and hand it the results.
 *
 * The setup.ts wizard does the equivalent with node:crypto.
 */

export interface WgKeypair {
  /** base64 private key — stays on the device / in .env, never in compose. */
  priv: string;
  /** base64 public key — safe to publish; goes in compose and client configs. */
  pub: string;
}

/** Whether this browser can generate WireGuard keys at all. */
export function wgCryptoAvailable(): boolean {
  return typeof crypto !== "undefined" && !!crypto.subtle;
}

/** base64url (what JWK uses) to the padded standard base64 wg writes. */
function toStdBase64(b64url: string): string {
  const b64 = b64url.replaceAll("-", "+").replaceAll("_", "/");
  return b64 + "=".repeat((4 - (b64.length % 4)) % 4);
}

/**
 * A fresh WireGuard keypair. One X25519 key exported as JWK yields both halves:
 * `d` is the private key and `x` the public, each the raw 32 bytes base64url.
 */
export async function wgKeypair(): Promise<WgKeypair> {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (!jwk.d || !jwk.x) throw new Error("X25519 key export did not return both halves");
  return { priv: toStdBase64(jwk.d), pub: toStdBase64(jwk.x) };
}
