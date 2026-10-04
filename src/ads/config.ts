import type { KeyObject } from "node:crypto";
import { ConfigError, readEcKey } from "../config.js";

/** Pinned hosts: the token and API calls only ever go to Apple. */
export const ADS_AUTH_URL = "https://appleid.apple.com/auth/oauth2/token";
export const ADS_API_BASE = "https://api.ads.apple.com/v1";

export interface AdsConfig {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: KeyObject;
  /** Optional; when unset, the only ad account the user can access is used. */
  adAccountId?: string;
}

const ADS_VARS = ["ADS_CLIENT_ID", "ADS_TEAM_ID", "ADS_KEY_ID", "ADS_KEY_PATH", "ADS_KEY", "ADS_AD_ACCOUNT_ID"];

/** True if the user has started configuring Apple Ads, so the Ads tools should be offered. */
export function adsRequested(env: NodeJS.ProcessEnv): boolean {
  return ADS_VARS.some((v) => env[v]?.trim());
}

/**
 * Reads the optional Apple Ads configuration. Returns undefined when none of the ADS_* variables
 * are set; throws ConfigError (naming variables, never values) when they're incomplete.
 */
export function loadAdsConfig(env: NodeJS.ProcessEnv = process.env): AdsConfig | undefined {
  if (!adsRequested(env)) return undefined;
  const clientId = env.ADS_CLIENT_ID?.trim();
  const teamId = env.ADS_TEAM_ID?.trim();
  const keyId = env.ADS_KEY_ID?.trim();
  const missing = [
    !clientId && "ADS_CLIENT_ID",
    !teamId && "ADS_TEAM_ID",
    !keyId && "ADS_KEY_ID",
    !env.ADS_KEY_PATH?.trim() && !env.ADS_KEY?.trim() && "ADS_KEY_PATH (or ADS_KEY)",
  ].filter(Boolean);
  if (missing.length) {
    throw new ConfigError(
      `Apple Ads isn't fully configured: set ${missing.join(", ")}. ` +
        "The values come from Apple Ads > Account Settings > API after you upload a public key; see docs/apple-ads-key.md.",
    );
  }
  const privateKey = readEcKey(env, "ADS_KEY", "ADS_KEY_PATH", "the private-key.pem you generated for Apple Ads");
  const adAccountId = env.ADS_AD_ACCOUNT_ID?.trim() || undefined;
  if (adAccountId && !/^\d+$/.test(adAccountId)) throw new ConfigError("ADS_AD_ACCOUNT_ID must be a numeric ad account ID.");
  return { clientId: clientId!, teamId: teamId!, keyId: keyId!, privateKey, adAccountId };
}
