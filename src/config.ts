import { createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export const DEFAULT_BASE_URL = "https://api.appstoreconnect.apple.com";

export interface Config {
  keyId: string;
  /** Missing for individual keys, which authenticate with `sub: "user"` instead. */
  issuerId?: string;
  privateKey: KeyObject;
  /** Writes are refused unless ASC_WRITE=1. */
  write: boolean;
  defaultAppId?: string;
  vendorNumber?: string;
  baseUrl: string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * Reads configuration from the environment. Never puts key material in error messages:
 * a bad key reports which variable is wrong, not what it contained.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const keyId = env.ASC_KEY_ID?.trim();
  const issuerId = env.ASC_ISSUER_ID?.trim() || undefined;
  const missing: string[] = [];
  if (!keyId) missing.push("ASC_KEY_ID");
  if (!env.ASC_KEY_PATH && !env.ASC_KEY) missing.push("ASC_KEY_PATH (or ASC_KEY)");
  if (missing.length) {
    throw new ConfigError(
      `App Store Connect isn't configured: set ${missing.join(" and ")}` +
        (issuerId ? "" : ", plus ASC_ISSUER_ID for a team key") +
        ". Create a key in App Store Connect under Users and Access > Integrations > App Store Connect API.",
    );
  }

  let pem: string;
  let source: string;
  if (env.ASC_KEY) {
    source = "ASC_KEY";
    // Allow the PEM to be passed with literal "\n" sequences, as many MCP client configs require.
    pem = env.ASC_KEY.includes("\\n") ? env.ASC_KEY.replace(/\\n/g, "\n") : env.ASC_KEY;
  } else {
    source = "ASC_KEY_PATH";
    const path = env.ASC_KEY_PATH!.replace(/^~(?=$|\/)/, homedir());
    try {
      pem = readFileSync(path, "utf8");
    } catch (error) {
      throw new ConfigError(`Couldn't read ASC_KEY_PATH (${path}): ${(error as NodeJS.ErrnoException).code ?? "read error"}`);
    }
  }

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: pem.trim(), format: "pem" });
  } catch {
    throw new ConfigError(`${source} isn't a valid PEM private key. Use the .p8 file App Store Connect gave you.`);
  }
  if (privateKey.asymmetricKeyType !== "ec") {
    throw new ConfigError(`${source} must be an EC (P-256) key, which is what App Store Connect .p8 files contain.`);
  }

  return {
    keyId: keyId!,
    issuerId,
    privateKey,
    write: isTruthy(env.ASC_WRITE),
    defaultAppId: env.ASC_APP_ID?.trim() || undefined,
    vendorNumber: env.ASC_VENDOR_NUMBER?.trim() || undefined,
    baseUrl: (env.ASC_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
  };
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
