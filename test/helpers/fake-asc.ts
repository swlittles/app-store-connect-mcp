/**
 * An in-memory App Store Connect for tests. It speaks enough JSON:API (includes, filters, sort,
 * pagination, relationship endpoints) for the workflows, and checks every request against Apple's
 * OpenAPI spec, so a typo in a path or query parameter fails the test instead of shipping.
 *
 * All data is synthetic: no real apps, IDs, keys or emails.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

type RelValue = string | string[] | null;

export interface Res {
  type: string;
  id: string;
  attributes: Record<string, unknown>;
  relationships: Record<string, RelValue>;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

/** relationship name -> [target type, to-many?, inverse relationship on the target] */
const SCHEMA: Record<string, Record<string, [string, boolean, string?]>> = {
  apps: {
    betaGroups: ["betaGroups", true, "app"],
    appStoreVersions: ["appStoreVersions", true, "app"],
    appInfos: ["appInfos", true, "app"],
    builds: ["builds", true, "app"],
    buildUploads: ["buildUploads", true, "app"],
    subscriptionGroups: ["subscriptionGroups", true],
    inAppPurchasesV2: ["inAppPurchases", true],
    customerReviews: ["customerReviews", true],
    reviewSubmissions: ["reviewSubmissions", true, "app"],
    betaTesters: ["betaTesters", true, "apps"],
  },
  builds: {
    app: ["apps", false, "builds"],
    preReleaseVersion: ["preReleaseVersions", false],
    buildBetaDetail: ["buildBetaDetails", false],
    betaGroups: ["betaGroups", true, "builds"],
    betaBuildLocalizations: ["betaBuildLocalizations", true, "build"],
    betaAppReviewSubmission: ["betaAppReviewSubmissions", false, "build"],
    appStoreVersion: ["appStoreVersions", false, "build"],
  },
  buildUploads: { app: ["apps", false, "buildUploads"], buildUploadFiles: ["buildUploadFiles", true, "buildUpload"] },
  buildUploadFiles: { buildUpload: ["buildUploads", false, "buildUploadFiles"] },
  betaGroups: { app: ["apps", false, "betaGroups"], builds: ["builds", true, "betaGroups"], betaTesters: ["betaTesters", true, "betaGroups"] },
  betaTesters: { betaGroups: ["betaGroups", true, "betaTesters"], apps: ["apps", true, "betaTesters"] },
  betaBuildLocalizations: { build: ["builds", false, "betaBuildLocalizations"] },
  betaAppReviewSubmissions: { build: ["builds", false, "betaAppReviewSubmission"] },
  appStoreVersions: {
    app: ["apps", false, "appStoreVersions"],
    appStoreVersionLocalizations: ["appStoreVersionLocalizations", true, "appStoreVersion"],
    build: ["builds", false, "appStoreVersion"],
    appStoreReviewDetail: ["appStoreReviewDetails", false, "appStoreVersion"],
  },
  appStoreVersionLocalizations: {
    appStoreVersion: ["appStoreVersions", false, "appStoreVersionLocalizations"],
    appScreenshotSets: ["appScreenshotSets", true, "appStoreVersionLocalization"],
  },
  appScreenshotSets: {
    appStoreVersionLocalization: ["appStoreVersionLocalizations", false, "appScreenshotSets"],
    appScreenshots: ["appScreenshots", true, "appScreenshotSet"],
  },
  appScreenshots: { appScreenshotSet: ["appScreenshotSets", false, "appScreenshots"] },
  appInfos: {
    app: ["apps", false, "appInfos"],
    appInfoLocalizations: ["appInfoLocalizations", true, "appInfo"],
    primaryCategory: ["appCategories", false],
    secondaryCategory: ["appCategories", false],
    ageRatingDeclaration: ["ageRatingDeclarations", false],
  },
  appInfoLocalizations: { appInfo: ["appInfos", false, "appInfoLocalizations"] },
  appStoreReviewDetails: { appStoreVersion: ["appStoreVersions", false, "appStoreReviewDetail"] },
  reviewSubmissions: { app: ["apps", false, "reviewSubmissions"], items: ["reviewSubmissionItems", true, "reviewSubmission"] },
  reviewSubmissionItems: { reviewSubmission: ["reviewSubmissions", false, "items"], appStoreVersion: ["appStoreVersions", false] },
  subscriptionGroups: { subscriptions: ["subscriptions", true, "group"] },
  subscriptions: {
    group: ["subscriptionGroups", false, "subscriptions"],
    introductoryOffers: ["subscriptionIntroductoryOffers", true, "subscription"],
    prices: ["subscriptionPrices", true],
    subscriptionAvailability: ["subscriptionAvailabilities", false],
  },
  subscriptionAvailabilities: { availableTerritories: ["territories", true] },
  subscriptionIntroductoryOffers: { subscription: ["subscriptions", false, "introductoryOffers"], territory: ["territories", false] },
  subscriptionPrices: { subscriptionPricePoint: ["subscriptionPricePoints", false], territory: ["territories", false] },
  customerReviews: { response: ["customerReviewResponses", false, "review"] },
  customerReviewResponses: { review: ["customerReviews", false, "response"] },
};

/** URL path segment -> resource type, where they differ. */
const PATH_TYPES: Record<string, string> = { inAppPurchasesV2: "inAppPurchases" };

// ---------------------------------------------------------------------------------------------
// Spec conformance

interface Route {
  method: string;
  regex: RegExp;
  template: string;
  params: Set<string>;
}

let routes: Route[] | undefined;

function specRoutes(): Route[] {
  if (routes) return routes;
  const spec = JSON.parse(gunzipSync(readFileSync(new URL("../../spec/openapi.oas.json.gz", import.meta.url))).toString("utf8"));
  routes = [];
  for (const [template, item] of Object.entries<Record<string, { parameters?: { name?: string; in?: string }[] }>>(spec.paths)) {
    const regex = new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`);
    for (const [method, op] of Object.entries(item)) {
      if (method === "parameters") continue;
      const params = new Set((op.parameters ?? []).filter((p) => p.in === "query" && p.name).map((p) => p.name!));
      routes.push({ method: method.toUpperCase(), regex, template, params });
    }
  }
  return routes;
}

export function checkAgainstSpec(method: string, path: string, query: Record<string, string>): string | undefined {
  const matches = specRoutes().filter((r) => r.regex.test(path));
  if (!matches.length) return `${path} isn't in the App Store Connect API spec`;
  const route = matches.find((r) => r.method === method);
  if (!route) return `${method} isn't allowed on ${matches[0]!.template}`;
  const unknown = Object.keys(query).filter((k) => k !== "cursor" && !route.params.has(k));
  if (unknown.length) return `${method} ${route.template} has no query parameter ${unknown.join(", ")}`;
  return undefined;
}

// ---------------------------------------------------------------------------------------------

type Fault = { method?: string; path: RegExp; times: number; respond: "reset" | { status: number; body?: unknown; headers?: Record<string, string> } };
type Hook = (fake: FakeAsc, req: RecordedRequest, res: Res | undefined) => Response | void;

export class FakeAsc {
  readonly db = new Map<string, Map<string, Res>>();
  readonly requests: RecordedRequest[] = [];
  readonly uploads: { url: string; bytes: number }[] = [];
  readonly specViolations: string[] = [];
  private faults: Fault[] = [];
  private seq = 1;
  /** Called after a create (POST /v1/{type}) or update; lets tests model Apple's side effects. */
  readonly afterCreate: Record<string, Hook> = {};
  readonly afterUpdate: Record<string, Hook> = {};
  rateLimitRemaining = 3500;
  pageSize = 200;

  constructor(readonly origin = "https://api.appstoreconnect.apple.com") {}

  add(type: string, id: string, attributes: Record<string, unknown> = {}, relationships: Record<string, RelValue> = {}): Res {
    const res: Res = { type, id, attributes: { ...attributes }, relationships: {} };
    this.table(type).set(id, res);
    for (const [rel, value] of Object.entries(relationships)) this.setRel(res, rel, value);
    return res;
  }

  get(type: string, id: string): Res | undefined {
    return this.db.get(type)?.get(id);
  }

  all(type: string): Res[] {
    return [...this.table(type).values()];
  }

  /** Inject failures: the next `times` matching requests get `respond` instead. */
  fail(path: RegExp, respond: Fault["respond"], options: { method?: string; times?: number } = {}): void {
    this.faults.push({ path, respond, method: options.method, times: options.times ?? 1 });
  }

  writes(): RecordedRequest[] {
    return this.requests.filter((r) => r.method !== "GET");
  }

  newId(prefix = "id"): string {
    return `${prefix}-${String(this.seq++).padStart(4, "0")}`;
  }

  // -------------------------------------------------------------------------------------------

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.host === "upload.fake.example") {
      const body = init?.body as Buffer | undefined;
      this.uploads.push({ url: url.href, bytes: body?.length ?? 0 });
      const fault = this.takeFault(method, url.pathname);
      if (fault === "reset") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      if (fault) return new Response(null, { status: fault.status });
      return new Response(null, { status: 200 });
    }
    if (url.origin !== this.origin) throw new Error(`Fake ASC got a request for ${url.origin}`);
    if (!new Headers(init?.headers).get("authorization")?.startsWith("Bearer ")) return this.error(401, "NOT_AUTHORIZED", "no token");

    const query = Object.fromEntries(url.searchParams);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const req: RecordedRequest = { method, path: url.pathname, query, body };
    this.requests.push(req);

    const violation = checkAgainstSpec(method, url.pathname, query);
    if (violation) {
      this.specViolations.push(violation);
      return this.error(400, "SPEC_VIOLATION", violation);
    }
    const fault = this.takeFault(method, url.pathname);
    if (fault === "reset") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    if (fault) return this.json(fault.status, fault.body ?? { errors: [{ status: String(fault.status), code: "FAULT", title: "Injected", detail: "injected fault" }] }, fault.headers);

    try {
      return this.route(req, url);
    } catch (error) {
      if (error instanceof Response) return error;
      throw error;
    }
  };

  private takeFault(method: string, path: string) {
    const fault = this.faults.find((f) => f.times > 0 && f.path.test(path) && (!f.method || f.method === method));
    if (!fault) return undefined;
    fault.times--;
    return fault.respond;
  }

  private route(req: RecordedRequest, url: URL): Response {
    const parts = req.path.split("/").filter(Boolean).slice(1); // drop "v1"
    const [seg0, id, seg2, seg3] = parts;
    const type = PATH_TYPES[seg0!] ?? seg0!;

    if (seg2 === "relationships" && seg3) return this.relationshipRoute(req, type, id!, seg3);

    if (req.method === "GET") {
      if (!id) return this.list(this.all(type), req, url);
      const res = this.must(type, id);
      if (!seg2) return this.json(200, { data: this.serialize(res, this.includes(req)), included: this.included([res], req) });
      const relName = seg2;
      const [targetType, many] = this.relInfo(type, relName);
      const value = res.relationships[relName];
      if (many) {
        const items = ((value as string[] | undefined) ?? []).map((rid) => this.get(targetType, rid)).filter((r): r is Res => !!r);
        return this.list(items, req, url);
      }
      const target = typeof value === "string" ? this.get(targetType, value) : undefined;
      return this.json(200, { data: target ? this.serialize(target, this.includes(req)) : null, included: target ? this.included([target], req) : [] });
    }

    if (req.method === "POST" && !id) {
      const data = (req.body as { data: { attributes?: Record<string, unknown>; relationships?: Record<string, { data: unknown }> } }).data;
      const res: Res = { type, id: this.newId(type.slice(0, 4)), attributes: { ...data.attributes }, relationships: {} };
      for (const [k, v] of Object.entries(res.attributes)) if (v === undefined) delete res.attributes[k];
      const hook = this.afterCreate[type];
      // Hooks may veto the create (e.g. a 409) before it's stored.
      const vetoRels: Record<string, RelValue> = {};
      for (const [rel, value] of Object.entries(data.relationships ?? {})) {
        const d = value.data as { id: string } | { id: string }[] | null;
        vetoRels[rel] = Array.isArray(d) ? d.map((x) => x.id) : d ? d.id : null;
      }
      res.relationships = { ...vetoRels };
      const vetoed = hook?.(this, req, res);
      if (vetoed) return vetoed;
      res.relationships = {};
      this.table(type).set(res.id, res);
      for (const [rel, value] of Object.entries(vetoRels)) this.setRel(res, rel, value);
      return this.json(201, { data: this.serialize(res, []) });
    }

    if (req.method === "PATCH" && id) {
      const res = this.must(type, id);
      const data = (req.body as { data: { attributes?: Record<string, unknown>; relationships?: Record<string, { data: { id: string } | null }> } }).data;
      Object.assign(res.attributes, data.attributes ?? {});
      for (const [rel, value] of Object.entries(data.relationships ?? {})) this.setRel(res, rel, value.data ? value.data.id : null);
      const custom = this.afterUpdate[type]?.(this, req, res);
      if (custom) return custom;
      return this.json(200, { data: this.serialize(res, []) });
    }

    if (req.method === "DELETE" && id) {
      const res = this.must(type, id);
      for (const rel of Object.keys(res.relationships)) this.setRel(res, rel, this.relInfo(type, rel)[1] ? [] : null);
      this.table(type).delete(id);
      return this.noContent();
    }
    return this.error(405, "METHOD_NOT_ALLOWED", `${req.method} ${req.path}`);
  }

  private relationshipRoute(req: RecordedRequest, type: string, id: string, rel: string): Response {
    const res = this.must(type, id);
    const [, many] = this.relInfo(type, rel);
    if (req.method === "GET") {
      const value = res.relationships[rel];
      const [targetType] = this.relInfo(type, rel);
      if (!many) return this.json(200, { data: typeof value === "string" ? { type: targetType, id: value } : null });
      const ids = (value as string[] | undefined) ?? [];
      const limit = Number(req.query.limit ?? 50);
      return this.json(200, { data: ids.slice(0, limit).map((rid) => ({ type: targetType, id: rid })), meta: { paging: { total: ids.length, limit } } });
    }
    const data = (req.body as { data: { id: string } | { id: string }[] | null }).data;
    if (!many) {
      this.setRel(res, rel, data && !Array.isArray(data) ? data.id : null);
      return this.noContent();
    }
    const ids = (Array.isArray(data) ? data : []).map((d) => d.id);
    const current = (res.relationships[rel] as string[] | undefined) ?? [];
    if (req.method === "POST") this.setRel(res, rel, [...current, ...ids.filter((x) => !current.includes(x))]);
    else if (req.method === "DELETE") this.setRel(res, rel, current.filter((x) => !ids.includes(x)));
    else if (req.method === "PATCH") {
      // Apple's reorder takes the complete list.
      if (ids.length !== current.length || !ids.every((x) => current.includes(x))) {
        return this.error(409, "ENTITY_ERROR.RELATIONSHIP.INVALID", "The list must contain exactly the current members.");
      }
      res.relationships[rel] = ids;
    }
    return this.noContent();
  }

  // -------------------------------------------------------------------------------------------

  private list(items: Res[], req: RecordedRequest, url: URL): Response {
    let rows = items.filter((r) => this.matches(r, req.query));
    const sort = req.query.sort;
    if (sort) {
      const desc = sort.startsWith("-");
      const key = sort.replace(/^-/, "");
      rows = [...rows].sort((a, b) => String(a.attributes[key] ?? "").localeCompare(String(b.attributes[key] ?? "")) * (desc ? -1 : 1));
    }
    const limit = Math.min(Number(req.query.limit ?? 50), this.pageSize);
    const offset = Number(req.query.cursor ?? 0);
    const page = rows.slice(offset, offset + limit);
    const links: Record<string, string> = { self: url.href };
    if (offset + limit < rows.length) {
      const next = new URL(url.href);
      next.searchParams.set("cursor", String(offset + limit));
      links.next = next.href;
    }
    return this.json(200, {
      data: page.map((r) => this.serialize(r, this.includes(req))),
      included: this.included(page, req),
      links,
      meta: { paging: { total: rows.length, limit } },
    });
  }

  private matches(r: Res, query: Record<string, string>): boolean {
    for (const [key, raw] of Object.entries(query)) {
      const m = /^filter\[(.+)\]$/.exec(key);
      if (!m) continue;
      const wanted = raw.split(",");
      const path = m[1]!.split(".");
      let values: unknown[] = [r];
      for (const [i, seg] of path.entries()) {
        const last = i === path.length - 1;
        values = values.flatMap((v) => {
          const res = v as Res;
          if (seg === "id" && last) return [res.id];
          if (seg in res.relationships || (SCHEMA[res.type]?.[seg] && !(seg in res.attributes))) {
            const rel = res.relationships[seg];
            const ids = Array.isArray(rel) ? rel : rel ? [rel] : [];
            if (last) return ids;
            const [targetType] = this.relInfo(res.type, seg);
            return ids.map((x) => this.get(targetType, x)).filter(Boolean);
          }
          const attr = res.attributes[seg];
          return [attr && typeof attr === "object" && "state" in (attr as object) ? (attr as { state: unknown }).state : attr];
        });
      }
      if (!values.some((v) => wanted.includes(String(v)))) return false;
    }
    return true;
  }

  private includes(req: RecordedRequest): string[] {
    return req.query.include ? req.query.include.split(",") : [];
  }

  private included(rows: Res[], req: RecordedRequest): Res[] {
    const out = new Map<string, Res>();
    for (const r of rows) {
      for (const rel of this.includes(req)) {
        if (!SCHEMA[r.type]?.[rel]) continue;
        const [targetType] = this.relInfo(r.type, rel);
        const value = r.relationships[rel];
        for (const id of Array.isArray(value) ? value : value ? [value] : []) {
          const t = this.get(targetType, id);
          if (t) out.set(`${t.type}/${t.id}`, t);
        }
      }
    }
    return [...out.values()].map((r) => this.serialize(r, [])) as unknown as Res[];
  }

  private serialize(r: Res, include: string[]): unknown {
    const relationships: Record<string, unknown> = {};
    for (const rel of Object.keys(SCHEMA[r.type] ?? {})) {
      const [targetType, many] = this.relInfo(r.type, rel);
      const entry: Record<string, unknown> = { links: { related: `${this.origin}/v1/${r.type}/${r.id}/${rel}` } };
      // Like Apple, linkage data only appears for included relationships.
      if (include.includes(rel)) {
        const value = r.relationships[rel];
        entry.data = many ? ((value as string[] | undefined) ?? []).map((id) => ({ type: targetType, id })) : typeof value === "string" ? { type: targetType, id: value } : null;
      }
      relationships[rel] = entry;
    }
    return { type: r.type, id: r.id, attributes: r.attributes, relationships };
  }

  setRel(res: Res, rel: string, value: RelValue): void {
    const [targetType, many, inverse] = this.relInfo(res.type, rel);
    const before = res.relationships[rel];
    const beforeIds = Array.isArray(before) ? before : before ? [before] : [];
    const afterIds = Array.isArray(value) ? value : value ? [value] : [];
    res.relationships[rel] = many ? afterIds : (afterIds[0] ?? null);
    if (!inverse) return;
    for (const id of beforeIds.filter((x) => !afterIds.includes(x))) {
      const t = this.get(targetType, id);
      if (!t) continue;
      const [, invMany] = this.relInfo(targetType, inverse);
      t.relationships[inverse] = invMany ? ((t.relationships[inverse] as string[] | undefined) ?? []).filter((x) => x !== res.id) : null;
    }
    for (const id of afterIds.filter((x) => !beforeIds.includes(x))) {
      const t = this.get(targetType, id);
      if (!t) continue;
      const [, invMany] = this.relInfo(targetType, inverse);
      if (invMany) {
        const list = (t.relationships[inverse] as string[] | undefined) ?? [];
        if (!list.includes(res.id)) t.relationships[inverse] = [...list, res.id];
      } else t.relationships[inverse] = res.id;
    }
  }

  private relInfo(type: string, rel: string): [string, boolean, string?] {
    const info = SCHEMA[type]?.[rel];
    if (!info) throw this.error(400, "PARAMETER_ERROR.INVALID", `Fake ASC doesn't know ${type}.${rel}`);
    return info;
  }

  private must(type: string, id: string): Res {
    const res = this.get(type, id);
    if (!res) throw this.error(404, "NOT_FOUND", `There is no resource of type '${type}' with id '${id}'`);
    return res;
  }

  private table(type: string): Map<string, Res> {
    let t = this.db.get(type);
    if (!t) this.db.set(type, (t = new Map()));
    return t;
  }

  json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    this.rateLimitRemaining--;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-rate-limit": `user-hour-lim:3600;user-hour-rem:${this.rateLimitRemaining};`, ...headers },
    });
  }

  noContent(): Response {
    this.rateLimitRemaining--;
    return new Response(null, { status: 204, headers: { "x-rate-limit": `user-hour-lim:3600;user-hour-rem:${this.rateLimitRemaining};` } });
  }

  error(status: number, code: string, detail: string): Response {
    return this.json(status, { errors: [{ status: String(status), code, title: code, detail }] });
  }
}
