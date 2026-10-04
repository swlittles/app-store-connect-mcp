/**
 * An in-memory Apple Ads Platform API and Apple ID token endpoint for tests. It checks the client
 * secret JWT (signature and claims), issues expiring tokens, insists on X-AP-Context where Apple
 * does, and can inject failures. All data is synthetic.
 */
import { verify, type KeyObject } from "node:crypto";

export interface AdsRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

type Fault = { path: RegExp; times: number; status: number; headers?: Record<string, string>; body?: unknown };

export class FakeAds {
  readonly requests: AdsRequest[] = [];
  readonly tokenRequests: { claims: Record<string, unknown>; header: Record<string, unknown> }[] = [];
  readonly accounts: { id: number; name: string; roles: string[] }[] = [{ id: 111111, name: "Example Ads", roles: ["API Account Read Only"] }];
  /** Phrase -> popularity for the SEARCH route. */
  phrases = new Map<string, number>([
    ["chess puzzle", 61],
    ["daily puzzle", 44],
    ["puzzle", 80],
    ["chess", 72],
    ["coffee", 55],
  ]);
  /** App IDs Apple will suggest keywords for (live apps). */
  liveApps = new Set<string>(["1000000001"]);
  tokenLifetimeSeconds = 3600;
  rateLimitRemaining = 100;
  private validTokens = new Set<string>();
  private seq = 0;
  private faults: Fault[] = [];

  constructor(
    private readonly publicKey: KeyObject,
    private readonly creds = { clientId: "SEARCHADS.client-0000", teamId: "SEARCHADS.team-0000", keyId: "00000000-key" },
  ) {}

  /** Make every issued token invalid, as if they'd expired early. */
  revokeTokens(): void {
    this.validTokens.clear();
  }

  fail(path: RegExp, status: number, options: { times?: number; headers?: Record<string, string>; body?: unknown } = {}): void {
    this.faults.push({ path, status, times: options.times ?? 1, headers: options.headers, body: options.body });
  }

  queries(path: string): AdsRequest[] {
    return this.requests.filter((r) => r.path === path);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));

    if (url.origin === "https://appleid.apple.com" && url.pathname === "/auth/oauth2/token") return this.token(method, headers, String(init?.body ?? ""));
    if (url.origin !== "https://api.ads.apple.com") throw new Error(`Fake Ads got a request for ${url.origin}`);

    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const path = url.pathname;
    this.requests.push({ method, path, headers, body });

    const token = headers.authorization?.replace(/^Bearer /, "");
    if (!token || !this.validTokens.has(token)) return this.error(401, "UNAUTHORIZED", "Invalid or expired token");

    const fault = this.faults.find((f) => f.times > 0 && f.path.test(path));
    if (fault) {
      fault.times--;
      return this.json(fault.status, fault.body ?? { error: { code: "FAULT", message: "injected" } }, fault.headers);
    }

    const unscoped = path === "/v1/me" || path === "/v1/acls" || path.startsWith("/v1/orgs/");
    const context = /^adAccountId=(\d+)$/.exec(headers["x-ap-context"] ?? "")?.[1];
    if (!unscoped) {
      if (!context) return this.error(400, "MISSING_CONTEXT", "X-AP-Context header is required");
      if (!this.accounts.some((a) => String(a.id) === context)) return this.error(403, "FORBIDDEN", "No access to this ad account");
    }

    if (method === "GET" && path === "/v1/me") return this.json(200, { result: { userId: 4242, orgId: 9090 } });
    if (method === "GET" && path === "/v1/acls") {
      return this.json(200, { result: { acls: this.accounts.map((a) => ({ adAccount: { id: a.id, name: a.name, orgId: 9090 }, roles: a.roles })) } });
    }
    if (method === "GET" && path === "/v1/orgs/9090") return this.json(200, { result: { id: 9090, name: "Example Org", currency: "USD", systemStatus: "ACTIVE" } });
    const account = /^\/v1\/ad-accounts\/(\d+)$/.exec(path);
    if (method === "GET" && account) {
      return this.json(200, { result: { id: Number(account[1]), name: "Example Ads", systemStatus: "ACTIVE", systemStatusReasons: [], productFeatures: ["APPSTORE_APP_MANUAL"], delegations: [] } });
    }
    if (method === "POST" && path === "/v1/suggestions/phrases/query") return this.phraseQuery(body);
    if (method === "POST" && path === "/v1/suggestions/keywords/query") return this.keywordQuery(body);
    if (method === "POST" && path === "/v1/insights/apps/search-term-popularity/query") return this.insightsQuery(body);
    return this.error(404, "NOT_FOUND", `${method} ${path}`);
  };

  private token(method: string, headers: Record<string, string>, raw: string): Response {
    if (method !== "POST" || headers["content-type"] !== "application/x-www-form-urlencoded") return this.oauthError(400, "invalid_request");
    const form = new URLSearchParams(raw);
    if (form.get("grant_type") !== "client_credentials" || form.get("scope") !== "searchadsorg") return this.oauthError(400, "invalid_request");
    if (form.get("client_id") !== this.creds.clientId) return this.oauthError(401, "invalid_client");
    const [h, p, sig] = (form.get("client_secret") ?? "").split(".");
    if (!h || !p || !sig) return this.oauthError(401, "invalid_client");
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    const signed = verify("sha256", Buffer.from(`${h}.${p}`), { key: this.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
    const ok =
      signed &&
      header.alg === "ES256" &&
      header.kid === this.creds.keyId &&
      claims.iss === this.creds.teamId &&
      claims.sub === this.creds.clientId &&
      claims.aud === "https://appleid.apple.com" &&
      claims.exp > claims.iat &&
      claims.exp - claims.iat <= 180 * 86400;
    if (!ok) return this.oauthError(401, "invalid_client");
    this.tokenRequests.push({ header, claims });
    const token = `ads-token-${++this.seq}`;
    this.validTokens.add(token);
    return new Response(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: this.tokenLifetimeSeconds, scope: "searchadsorg" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  private phraseQuery(body: { filters?: { field: string; operator: string; value: unknown }[]; pagination?: { pageSize?: number } }): Response {
    const f = (field: string) => body.filters?.find((x) => x.field === field);
    const route = (f("queryType")?.value as string[] | undefined)?.[0];
    if (route !== "SEARCH") return this.error(400, "INVALID_FILTER", "queryType is required");
    const phrase = f("phrase");
    if (!phrase) return this.error(400, "INVALID_FILTER", "phrase is required for SEARCH");
    const values = phrase.value as string[];
    let rows: { phrase: string; popularity: number }[];
    if (phrase.operator === "IN") {
      if (values.length > 100) return this.error(400, "INVALID_FILTER", "Too many values");
      rows = values.filter((v) => this.phrases.has(v.toLowerCase())).map((v) => ({ phrase: v.toLowerCase(), popularity: this.phrases.get(v.toLowerCase())! }));
    } else if (phrase.operator === "LIKE") {
      rows = [...this.phrases].filter(([k]) => k.includes(values[0]!.toLowerCase())).map(([k, v]) => ({ phrase: k, popularity: v }));
      rows.sort((a, b) => b.popularity - a.popularity);
    } else return this.error(400, "INVALID_OPERATOR", phrase.operator);
    const size = body.pagination?.pageSize ?? 20;
    return this.json(200, { result: rows.slice(0, size), pagination: { offset: 0, pageSize: size, totalCount: rows.length } });
  }

  private keywordQuery(body: { filters?: { field: string; value: unknown }[] }): Response {
    const id = (body.filters?.find((x) => x.field === "promotedObjectId")?.value as string[] | undefined)?.[0];
    if (!id) return this.error(400, "INVALID_FILTER", "promotedObjectId is required");
    if (!this.liveApps.has(id)) return this.error(400, "INVALID_PROMOTED_OBJECT", "App is not available for advertising");
    return this.json(200, { result: [{ text: "chess", popularity: 72 }, { text: "chess puzzles", popularity: 50 }], pagination: { offset: 0, pageSize: 20, totalCount: 2 } });
  }

  private insightsQuery(body: { timeRange?: { start: string; end: string; granularity: string }; fields?: string[] }): Response {
    const t = body.timeRange;
    if (!t || !["WEEKLY_SUN_SAT", "MONTHLY"].includes(t.granularity)) return this.error(400, "INVALID_TIME_RANGE", "granularity");
    if (t.granularity === "WEEKLY_SUN_SAT" && new Date(`${t.start}T00:00:00Z`).getUTCDay() !== 0) return this.error(400, "INVALID_TIME_RANGE", "start must be a Sunday");
    return this.json(200, {
      result: {
        rows: [
          { week: t.end, countryOrRegion: "US", genre: "GAMES", searchTerm: "chess", rankInGenre: 12, searchPopularityInGenre: 88, searchPopularity1to100: 70, searchPopularity1to5: 4 },
          { week: t.end, countryOrRegion: "US", genre: "GAMES", searchTerm: "chess puzzle", rankInGenre: 140, searchPopularityInGenre: 51, searchPopularity1to100: 40, searchPopularity1to5: 3 },
        ],
      },
      pagination: { offset: 0, pageSize: 50 },
    });
  }

  json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    this.rateLimitRemaining = Math.max(0, this.rateLimitRemaining - 1);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "RateLimit-Limit": "100", "RateLimit-Remaining": String(this.rateLimitRemaining), "RateLimit-Reset": "30", ...headers },
    });
  }

  private error(status: number, code: string, message: string): Response {
    return this.json(status, { error: { code, message, details: [] } });
  }

  private oauthError(status: number, error: string): Response {
    return new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
  }
}
