import { sign, type KeyObject } from "node:crypto";

/** Apple rejects tokens that live longer than 20 minutes. */
const TOKEN_LIFETIME_SECONDS = 19 * 60;
/** Refresh this long before expiry so a token never expires mid-request. */
const REFRESH_MARGIN_SECONDS = 60;

export interface TokenOptions {
  keyId: string;
  issuerId?: string;
  privateKey: KeyObject;
  now?: () => number;
}

/** Signs and caches the ES256 JWT that App Store Connect expects. */
export class TokenProvider {
  private cached?: { token: string; expiresAt: number };

  constructor(private readonly options: TokenOptions) {}

  token(): string {
    const now = Math.floor((this.options.now?.() ?? Date.now()) / 1000);
    if (this.cached && this.cached.expiresAt - REFRESH_MARGIN_SECONDS > now) return this.cached.token;

    const exp = now + TOKEN_LIFETIME_SECONDS;
    const header = { alg: "ES256", kid: this.options.keyId, typ: "JWT" };
    // Team keys identify the issuer; individual keys have no issuer and use sub: "user".
    const payload = this.options.issuerId
      ? { iss: this.options.issuerId, iat: now, exp, aud: "appstoreconnect-v1" }
      : { sub: "user", iat: now, exp, aud: "appstoreconnect-v1" };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    // JWS needs the raw r||s signature, not DER.
    const signature = sign("sha256", Buffer.from(signingInput), {
      key: this.options.privateKey,
      dsaEncoding: "ieee-p1363",
    });
    const token = `${signingInput}.${signature.toString("base64url")}`;
    this.cached = { token, expiresAt: exp };
    return token;
  }

  /** Drops the cached token, e.g. after a 401. */
  invalidate(): void {
    this.cached = undefined;
  }
}

function base64url(text: string): string {
  return Buffer.from(text).toString("base64url");
}
