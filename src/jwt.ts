import { sign, type KeyObject } from "node:crypto";

/** Signs a compact ES256 JWT. JWS needs the raw r||s signature, not DER. */
export function signEs256Jwt(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyObject): string {
  const signingInput = `${base64url(JSON.stringify({ alg: "ES256", ...header }))}.${base64url(JSON.stringify(payload))}`;
  const signature = sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function base64url(text: string): string {
  return Buffer.from(text).toString("base64url");
}
