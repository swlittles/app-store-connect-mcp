import type { TokenProvider } from "./auth.js";

export interface Linkage {
  type: string;
  id: string;
}

export interface Relationship {
  data?: Linkage | Linkage[] | null;
  meta?: { paging?: { total?: number; limit?: number } };
}

/** A JSON:API resource. `A` is the attributes type, normally taken from the generated schema. */
export interface Resource<A = Record<string, unknown>> {
  type: string;
  id: string;
  attributes?: A;
  relationships?: Record<string, Relationship | undefined>;
}

export interface Document<D> {
  data: D;
  included?: Resource[];
  links?: { self?: string; next?: string };
  meta?: { paging?: { total?: number; limit?: number } };
}

export type Query = Record<string, string | number | boolean | readonly string[] | undefined>;

export interface AscErrorItem {
  status?: string;
  code?: string;
  title?: string;
  detail?: string;
  source?: { pointer?: string; parameter?: string };
}

export interface RateLimit {
  limit?: number;
  remaining?: number;
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

export class AscApiError extends Error {
  override name = "AscApiError";

  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly errors: AscErrorItem[],
    readonly rateLimit?: RateLimit,
  ) {
    super(describeApiError(method, path, status, errors, rateLimit));
  }

  /** True if any error code starts with one of `codes`, e.g. "ENTITY_ERROR.RELATIONSHIP". */
  hasCode(...codes: string[]): boolean {
    return this.errors.some((e) => codes.some((c) => e.code?.startsWith(c)));
  }

  /** True if any error's text contains `text`, case-insensitively. */
  mentions(text: string): boolean {
    const needle = text.toLowerCase();
    return this.errors.some((e) => `${e.title ?? ""} ${e.detail ?? ""}`.toLowerCase().includes(needle));
  }
}

export class AscNetworkError extends Error {
  override name = "AscNetworkError";

  constructor(
    readonly method: string,
    readonly path: string,
    readonly code: string,
    readonly attempts: number,
  ) {
    super(
      `${method} ${path} failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${code}. ` +
        (method === "POST"
          ? "The request may or may not have reached Apple. Check the current state before retrying."
          : "Apple didn't respond. It's safe to retry."),
    );
  }
}

export interface ClientOptions {
  baseUrl: string;
  tokens: TokenProvider;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  /** Called before each retry; useful for progress messages. */
  onRetry?: (info: { method: string; path: string; attempt: number; delayMs: number; reason: string }) => void;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
/** POSTs aren't idempotent, so only retry them when Apple says it didn't do the work. */
const RETRYABLE_STATUS_POST = new Set([429, 503]);
/** Errors that mean the request never left this machine, so even a POST is safe to retry. */
const PRE_SEND_ERRORS = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
const MAX_PAGES = 100;

/**
 * A small App Store Connect API client: JWT auth, retries with jittered backoff, rate-limit
 * tracking, JSON:API pagination, and errors written for a model to act on.
 */
export class AscClient {
  /** The most recent X-Rate-Limit values Apple reported. */
  rateLimit: RateLimit = {};
  requestCount = 0;

  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly origin: string;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.timeoutMs = options.requestTimeoutMs ?? 60_000;
    this.origin = new URL(options.baseUrl).origin;
  }

  get fetcher(): typeof fetch {
    return this.fetchImpl;
  }

  async get<D>(path: string, query?: Query, signal?: AbortSignal): Promise<Document<D>> {
    return (await this.json<Document<D>>("GET", path, { query, signal }))!;
  }

  /** GETs a collection and follows `links.next` until it runs out (or `max` items are collected). */
  async getAll<A>(
    path: string,
    query?: Query,
    options: { max?: number; signal?: AbortSignal } = {},
  ): Promise<{ data: Resource<A>[]; included: Resource[] }> {
    const data: Resource<A>[] = [];
    const included: Resource[] = [];
    let next: string | undefined = path;
    let q: Query | undefined = { limit: 200, ...query };
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const doc: Document<Resource<A>[]> = await this.get<Resource<A>[]>(next, q, options.signal);
      data.push(...doc.data);
      if (doc.included) included.push(...doc.included);
      if (options.max !== undefined && data.length >= options.max) return { data: data.slice(0, options.max), included };
      next = doc.links?.next;
      q = undefined; // links.next already carries the query
    }
    // Never return a partial list as if it were complete: callers use these to decide what exists.
    if (next) throw new Error(`${path} has more than ${MAX_PAGES} pages; narrow the query.`);
    return { data, included };
  }

  async post<D>(path: string, body: unknown, signal?: AbortSignal): Promise<Document<D> | undefined> {
    return this.json<Document<D>>("POST", path, { body, signal });
  }

  async patch<D>(path: string, body: unknown, signal?: AbortSignal): Promise<Document<D> | undefined> {
    return this.json<Document<D>>("PATCH", path, { body, signal });
  }

  async delete(path: string, body?: unknown, signal?: AbortSignal): Promise<void> {
    await this.json("DELETE", path, { body, signal });
  }

  /**
   * DELETE that treats "already gone" as success, so a retried bulk job can't fail on items an
   * earlier run removed.
   */
  async deleteIfExists(path: string, signal?: AbortSignal): Promise<"deleted" | "absent"> {
    try {
      await this.delete(path, undefined, signal);
      return "deleted";
    } catch (error) {
      if (error instanceof AscApiError && error.status === 404) return "absent";
      throw error;
    }
  }

  /** GETs a binary response, e.g. a gzipped sales report. */
  async getBinary(path: string, query: Query, accept: string, signal?: AbortSignal): Promise<Buffer> {
    const res = await this.send("GET", path, { query, accept, signal });
    return Buffer.from(await res.arrayBuffer());
  }

  /** Low-level JSON request used by the escape-hatch tool. */
  async json<T>(
    method: Method,
    path: string,
    init: { query?: Query; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T | undefined> {
    const res = await this.send(method, path, { ...init, accept: "application/json" });
    if (res.status === 204) return undefined;
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : undefined;
  }

  private async send(
    method: Method,
    path: string,
    init: { query?: Query; body?: unknown; accept: string; signal?: AbortSignal },
  ): Promise<Response> {
    const url = this.url(path, init.query);
    const label = url.pathname + url.search;
    let authRetried = false;

    for (let attempt = 1; ; attempt++) {
      init.signal?.throwIfAborted();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.options.tokens.token()}`,
        Accept: init.accept,
      };
      if (init.body !== undefined) headers["Content-Type"] = "application/json";

      let res: Response;
      try {
        this.requestCount++;
        const timeout = AbortSignal.timeout(this.timeoutMs);
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
        });
      } catch (error) {
        if (init.signal?.aborted) throw error;
        const code = networkErrorCode(error);
        const retryable = method !== "POST" || PRE_SEND_ERRORS.has(code);
        if (!retryable || attempt >= this.maxAttempts) throw new AscNetworkError(method, label, code, attempt);
        await this.backoff(method, label, attempt, code);
        continue;
      }

      this.readRateLimit(res.headers);
      if (res.ok) return res;

      if (res.status === 401 && !authRetried) {
        // A stale token (or clock skew) gets one fresh token before we give up.
        authRetried = true;
        this.options.tokens.invalidate();
        await res.body?.cancel();
        continue;
      }

      const retryable = (method === "POST" ? RETRYABLE_STATUS_POST : RETRYABLE_STATUS).has(res.status);
      if (retryable && attempt < this.maxAttempts) {
        await res.body?.cancel();
        await this.backoff(method, label, attempt, `HTTP ${res.status}`, retryAfterMs(res.headers), res.status === 429);
        continue;
      }

      throw new AscApiError(method, label, res.status, await readErrors(res), { ...this.rateLimit });
    }
  }

  private url(path: string, query?: Query): URL {
    // links.next is absolute. Never send the token to any host but Apple's API.
    const url = /^https?:\/\//.test(path) ? new URL(path) : new URL(path.startsWith("/") ? path : `/${path}`, this.origin);
    if (url.origin !== this.origin) throw new Error(`Refusing to call ${url.origin}: only ${this.origin} is allowed.`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    return url;
  }

  private async backoff(
    method: string,
    path: string,
    attempt: number,
    reason: string,
    retryAfter?: number,
    rateLimited = false,
  ): Promise<void> {
    const base = rateLimited ? 5_000 : 1_000;
    // Full jitter, capped at 30s; Retry-After wins when Apple sends it.
    const delayMs = retryAfter ?? Math.round(Math.min(30_000, base * 2 ** (attempt - 1)) * (0.5 + this.random() / 2));
    this.options.onRetry?.({ method, path, attempt, delayMs, reason });
    await this.sleep(delayMs);
  }

  private readRateLimit(headers: Headers): void {
    // Format: "user-hour-lim:3600;user-hour-rem:3545;"
    const raw = headers.get("x-rate-limit");
    if (!raw) return;
    const limit = /user-hour-lim:(\d+)/.exec(raw)?.[1];
    const remaining = /user-hour-rem:(\d+)/.exec(raw)?.[1];
    if (limit) this.rateLimit.limit = Number(limit);
    if (remaining) this.rateLimit.remaining = Number(remaining);
  }
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(seconds, 120) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.min(Math.max(0, date - Date.now()), 120_000);
}

async function readErrors(res: Response): Promise<AscErrorItem[]> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { errors?: AscErrorItem[] };
    if (Array.isArray(body.errors) && body.errors.length) return body.errors;
  } catch {
    // not JSON
  }
  return [{ status: String(res.status), title: res.statusText || `HTTP ${res.status}`, detail: text.slice(0, 300) || undefined }];
}

export function networkErrorCode(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "TIMEOUT";
    const cause = (error as Error & { cause?: { code?: string } }).cause;
    if (cause?.code) return cause.code;
    const code = (error as NodeJS.ErrnoException).code;
    if (code) return code;
    return error.message;
  }
  return String(error);
}

function describeApiError(
  method: string,
  path: string,
  status: number,
  errors: AscErrorItem[],
  rateLimit?: RateLimit,
): string {
  const lines = errors.map((e) => {
    const where = e.source?.pointer ?? e.source?.parameter;
    return `- ${e.code ?? e.status ?? status}: ${e.detail ?? e.title ?? "no detail"}${where ? ` (at ${where})` : ""}`;
  });
  const hint = errorHint(status, errors, rateLimit);
  return `App Store Connect returned HTTP ${status} for ${method} ${path}\n${lines.join("\n")}${hint ? `\nHint: ${hint}` : ""}`;
}

function errorHint(status: number, errors: AscErrorItem[], rateLimit?: RateLimit): string | undefined {
  const codes = errors.map((e) => e.code ?? "").join(" ");
  if (status === 401) {
    return "Apple rejected the API token. Check ASC_KEY_ID and ASC_ISSUER_ID (leave ASC_ISSUER_ID unset for an individual key), that the key hasn't been revoked, and that this computer's clock is right.";
  }
  if (codes.includes("REQUIRED_AGREEMENTS")) {
    return "An agreement is missing or expired. The Account Holder must accept it in App Store Connect under Business.";
  }
  if (status === 403) {
    return "The API key's role doesn't allow this. App Manager covers everything this server does; Developer and Marketing roles can't manage testers or submissions. Never use an Admin key.";
  }
  if (status === 404) return "Not found. The ID may be wrong, deleted, or belong to a different app or team.";
  if (status === 409) return "App Store Connect refused the change in the resource's current state. Re-read the state, then decide whether a retry makes sense.";
  if (status === 429) {
    return `Rate limit reached (about 3,600 requests per hour per key${rateLimit?.remaining !== undefined ? `; ${rateLimit.remaining} left` : ""}). Wait a few minutes, then re-run; workflow tools skip work that's already done.`;
  }
  if (status >= 500) return "Apple's servers had a problem. Re-read the state before retrying.";
  return undefined;
}
