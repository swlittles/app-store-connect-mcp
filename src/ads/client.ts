import { networkErrorCode } from "../asc/client.js";
import { signEs256Jwt } from "../jwt.js";
import { ADS_API_BASE, ADS_AUTH_URL, type AdsConfig } from "./config.js";

/** Client secrets may live up to 180 days; we sign a fresh, short-lived one for every token. */
const CLIENT_SECRET_LIFETIME_SECONDS = 10 * 60;
/** Refresh the access token this long before it expires. */
const REFRESH_MARGIN_SECONDS = 60;

export interface AdsErrorDetail {
  code?: string;
  message?: string | null;
}

export class AdsApiError extends Error {
  override name = "AdsApiError";

  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly details: AdsErrorDetail[],
    message: string | undefined,
  ) {
    super(describeAdsError(method, path, status, code, message, details));
  }
}

export interface AdsRateLimit {
  limit?: number;
  remaining?: number;
  resetSeconds?: number;
}

export interface AdsClientOptions {
  config: AdsConfig;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxAttempts?: number;
}

/**
 * A small client for the Apple Ads Platform API: OAuth client-credentials tokens (cached, refreshed
 * before expiry and after a 401), retries on 429 and 5xx using Apple's rate-limit headers, and
 * X-AP-Context for ad-account-scoped calls. Every call this server makes is a read; the POST
 * /query endpoints are reads too, so retrying them is safe.
 */
export class AdsClient {
  rateLimit: AdsRateLimit = {};
  requestCount = 0;

  private token?: { value: string; expiresAt: number };
  private tokenRequest?: Promise<string>;
  private accountId?: Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxAttempts: number;

  constructor(private readonly options: AdsClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? Date.now;
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  get config(): AdsConfig {
    return this.options.config;
  }

  /** GET an org-level endpoint that doesn't take X-AP-Context (/me, /acls, /orgs/{id}). */
  getUnscoped<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  /** GET an ad-account-scoped endpoint. */
  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path, undefined, await this.adAccountId());
  }

  /** POST a /query endpoint (a read) in the ad account's scope. */
  async query<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body, await this.adAccountId());
  }

  /** ADS_AD_ACCOUNT_ID, or the only ad account this user can access. */
  adAccountId(): Promise<string> {
    if (this.options.config.adAccountId) return Promise.resolve(this.options.config.adAccountId);
    this.accountId ??= this.discoverAccount().catch((error) => {
      this.accountId = undefined;
      throw error;
    });
    return this.accountId;
  }

  private async discoverAccount(): Promise<string> {
    const acls = await this.getUnscoped<AclsResponse>("/acls");
    const accounts = acls.result?.acls ?? [];
    if (accounts.length === 1) return String(accounts[0]!.adAccount.id);
    if (!accounts.length) {
      throw new AdsSetupError("This Apple Ads user can't access any ad accounts. Ask the account admin to give the API user a role on an ad account.");
    }
    throw new AdsSetupError(
      `This Apple Ads user can access several ad accounts; set ADS_AD_ACCOUNT_ID to one of: ${accounts
        .map((a) => `${a.adAccount.name} (${a.adAccount.id})`)
        .join(", ")}.`,
    );
  }

  private async accessToken(force = false): Promise<string> {
    const nowSeconds = Math.floor(this.now() / 1000);
    if (!force && this.token && this.token.expiresAt - REFRESH_MARGIN_SECONDS > nowSeconds) return this.token.value;
    // One token request at a time, even with parallel tool calls.
    this.tokenRequest ??= this.fetchToken().finally(() => {
      this.tokenRequest = undefined;
    });
    return this.tokenRequest;
  }

  private async fetchToken(): Promise<string> {
    const { clientId, teamId, keyId, privateKey } = this.options.config;
    const iat = Math.floor(this.now() / 1000);
    const clientSecret = signEs256Jwt(
      { alg: "ES256", kid: keyId },
      { iss: teamId, sub: clientId, aud: "https://appleid.apple.com", iat, exp: iat + CLIENT_SECRET_LIFETIME_SECONDS },
      privateKey,
    );
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, scope: "searchadsorg" });
    let res: Response;
    try {
      res = await this.fetchImpl(ADS_AUTH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new AdsSetupError(`Couldn't reach Apple's sign-in server for an Apple Ads token: ${networkErrorCode(error)}.`);
    }
    const text = await res.text();
    if (!res.ok) {
      // Apple's OAuth errors are like {"error":"invalid_client"}; never echo the secret we sent.
      const reason = (() => {
        try {
          return (JSON.parse(text) as { error?: string }).error;
        } catch {
          return undefined;
        }
      })();
      throw new AdsSetupError(
        `Apple refused the Apple Ads credentials (HTTP ${res.status}${reason ? `, ${reason}` : ""}). ` +
          "Check ADS_CLIENT_ID, ADS_TEAM_ID and ADS_KEY_ID against Apple Ads > Account Settings > API, and that the public key uploaded there matches ADS_KEY_PATH.",
      );
    }
    const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new AdsSetupError("Apple's token response had no access_token.");
    this.token = { value: json.access_token, expiresAt: iat + (json.expires_in ?? 3600) };
    return json.access_token;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, adAccountId?: string): Promise<T> {
    const url = new URL(`${ADS_API_BASE}${path.startsWith("/") ? path : `/${path}`}`);
    if (url.origin !== new URL(ADS_API_BASE).origin) throw new Error(`Refusing to call ${url.origin}.`);
    let refreshed = false;
    let backoff = 2_000;
    // Pace proactively, as Apple recommends: if the window is nearly used up, wait for it to reset.
    if (this.rateLimit.remaining !== undefined && this.rateLimit.remaining < 2 && this.rateLimit.resetSeconds) {
      await this.sleep(Math.min(this.rateLimit.resetSeconds, 60) * 1000);
      this.rateLimit.remaining = undefined;
    }
    for (let attempt = 1; ; attempt++) {
      const headers: Record<string, string> = { Authorization: `Bearer ${await this.accessToken()}`, Accept: "application/json" };
      if (adAccountId) headers["X-AP-Context"] = `adAccountId=${adAccountId}`;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      let res: Response;
      try {
        this.requestCount++;
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        if (attempt >= this.maxAttempts) throw new Error(`Apple Ads ${method} ${path} failed after ${attempt} attempts: ${networkErrorCode(error)}.`);
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, 16_000);
        continue;
      }
      this.readRateLimit(res.headers);
      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : {}) as T;
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await res.body?.cancel();
        await this.accessToken(true);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxAttempts) {
        await res.body?.cancel();
        // Apple sends RateLimit-Reset on every response; it only says when to retry a 429, not a 5xx.
        const retryAfter = Number(res.headers.get("retry-after") ?? (res.status === 429 ? res.headers.get("ratelimit-reset") : null));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 120) * 1000 : backoff);
        backoff = Math.min(backoff * 2, 16_000);
        continue;
      }
      const text = await res.text().catch(() => "");
      let error: { code?: string; message?: string | null; details?: AdsErrorDetail[] } | undefined;
      try {
        error = (JSON.parse(text) as { error?: typeof error }).error;
      } catch {
        // not JSON
      }
      throw new AdsApiError(method, path, res.status, error?.code, error?.details ?? [], error?.message ?? (text.slice(0, 300) || undefined));
    }
  }

  private readRateLimit(headers: Headers): void {
    const num = (name: string) => {
      const v = headers.get(name);
      return v === null || !Number.isFinite(Number(v)) ? undefined : Number(v);
    };
    const remaining = num("ratelimit-remaining");
    if (remaining === undefined) return;
    this.rateLimit = { limit: num("ratelimit-limit"), remaining, resetSeconds: num("ratelimit-reset") };
  }
}

/** A setup problem whose message is written for the agent to relay as-is. */
export class AdsSetupError extends Error {
  override name = "AdsSetupError";
}

export interface AclsResponse {
  result?: { acls?: { adAccount: { id: number | string; name?: string; orgId?: number | string }; roles?: string[] }[] };
}

function describeAdsError(method: string, path: string, status: number, code: string | undefined, message: string | undefined | null, details: AdsErrorDetail[]): string {
  const lines = [`Apple Ads returned HTTP ${status} for ${method} ${path}${code ? `: ${code}` : ""}${message ? ` (${message})` : ""}`];
  for (const d of details) lines.push(`- ${d.code ?? "?"}: ${d.message ?? ""}`);
  const hint =
    status === 401
      ? "Apple rejected the access token. Check the ADS_* credentials and that the API user's invitation was accepted."
      : status === 403
        ? "The API user's role doesn't allow this, or the ad account isn't set up for it (some endpoints need an App Store ad account with a linked app)."
        : status === 429
          ? "Apple Ads rate limit reached. Wait a minute and try again."
          : undefined;
  if (hint) lines.push(`Hint: ${hint}`);
  return lines.join("\n");
}
