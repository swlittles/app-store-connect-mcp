import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadAdsConfig } from "../src/ads/config.js";
import { runtimeFromEnv } from "../src/server.js";
import { timeRange } from "../src/tools/ads.js";
import { seedApp, seedVersion } from "./helpers/fixtures.js";
import { APP_ID, makeHarness } from "./helpers/harness.js";

const ecPem = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "sec1" }).toString();

describe("Apple Ads auth", () => {
  it("signs a client secret Apple accepts and caches the access token", async () => {
    const h = makeHarness({ ads: true });
    await h.call("ads_status", {});
    await h.call("keyword_popularity", { phrases: ["chess"] });
    const fake = h.ads!.fake;
    // The fake verified the ES256 signature and claims; check the claims ourselves too.
    expect(fake.tokenRequests).toHaveLength(1);
    const { header, claims } = fake.tokenRequests[0]!;
    expect(header).toMatchObject({ alg: "ES256", kid: "00000000-key" });
    expect(claims).toMatchObject({ iss: "SEARCHADS.team-0000", sub: "SEARCHADS.client-0000", aud: "https://appleid.apple.com" });
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(180 * 86400);
  });

  it("refreshes the token shortly before it expires", async () => {
    const h = makeHarness({ ads: true });
    await h.call("keyword_popularity", { phrases: ["chess"] });
    h.clock.now += (3600 - 30) * 1000; // inside the 60-second refresh margin
    await h.call("keyword_popularity", { phrases: ["chess"] });
    expect(h.ads!.fake.tokenRequests).toHaveLength(2);
  });

  it("gets a new token once after a 401", async () => {
    const h = makeHarness({ ads: true });
    await h.call("keyword_popularity", { phrases: ["chess"] });
    h.ads!.fake.revokeTokens();
    const { isError, text } = await h.call("keyword_popularity", { phrases: ["chess"] });
    expect(isError, text).toBe(false);
    expect(h.ads!.fake.tokenRequests).toHaveLength(2);
  });

  it("sends X-AP-Context only on ad-account-scoped calls", async () => {
    const h = makeHarness({ ads: true });
    await h.call("ads_status", {});
    await h.call("keyword_popularity", { phrases: ["chess"] });
    const reqs = h.ads!.fake.requests;
    expect(reqs.find((r) => r.path === "/v1/me")!.headers["x-ap-context"]).toBeUndefined();
    expect(reqs.find((r) => r.path === "/v1/acls")!.headers["x-ap-context"]).toBeUndefined();
    expect(reqs.find((r) => r.path === "/v1/suggestions/phrases/query")!.headers["x-ap-context"]).toBe("adAccountId=111111");
  });
});

describe("ad account discovery", () => {
  it("uses the only account without being told", async () => {
    const h = makeHarness({ ads: true });
    const { text } = await h.call("ads_status", {});
    expect(text).toContain("Keyword tools use ad account 111111 (the only one available)");
  });

  it("asks which account when there are several", async () => {
    const h = makeHarness({ ads: true });
    h.ads!.fake.accounts.push({ id: 222222, name: "Second", roles: ["Admin"] });
    const { text, isError } = await h.call("keyword_popularity", { phrases: ["chess"] });
    expect(isError).toBe(true);
    expect(text).toContain("set ADS_AD_ACCOUNT_ID to one of: Example Ads (111111), Second (222222)");
  });

  it("skips discovery when ADS_AD_ACCOUNT_ID is set", async () => {
    const h = makeHarness({ ads: { adAccountId: "111111" } });
    await h.call("keyword_popularity", { phrases: ["chess"] });
    expect(h.ads!.fake.queries("/v1/acls")).toHaveLength(0);
  });
});

describe("keyword_popularity", () => {
  it("sorts by popularity, lists phrases without data, and ignores case duplicates", async () => {
    const h = makeHarness({ ads: true });
    const { text, isError } = await h.call("keyword_popularity", { phrases: ["chess puzzle", "Puzzle", "zzz nothing", "puzzle"] });
    expect(isError, text).toBe(false);
    expect(text).toContain("Popularity of 3 phrases");
    expect(text.indexOf(" 80  Puzzle")).toBeLessThan(text.indexOf(" 61  chess puzzle"));
    expect(text).toContain("no data: zzz nothing");
  });

  it("batches large lookups", async () => {
    const h = makeHarness({ ads: true });
    const phrases = Array.from({ length: 150 }, (_, i) => `phrase ${i}`);
    await h.call("keyword_popularity", { phrases: [...phrases, "chess"] });
    const calls = h.ads!.fake.queries("/v1/suggestions/phrases/query");
    expect(calls.map((c) => ((c.body as { filters: { value: string[] }[] }).filters[1]!.value).length)).toEqual([100, 51]);
  });

  it("finds phrases containing some text", async () => {
    const h = makeHarness({ ads: true });
    const { text } = await h.call("keyword_popularity", { like: "puzzle" });
    expect(text).toMatch(/Phrases containing "puzzle" \(3\)/);
    expect(text.indexOf("puzzle")).toBeLessThan(text.indexOf("daily puzzle"));
  });

  it("scores the app's keyword field and flags words already in the name", async () => {
    const h = makeHarness({ ads: true });
    seedApp(h.fake);
    seedVersion(h.fake);
    h.fake.get("appStoreVersionLocalizations", "loc-en")!.attributes.keywords = "chess,coffee,puzzle";
    h.fake.add("appInfos", "info-1", { state: "PREPARE_FOR_SUBMISSION" }, { app: APP_ID });
    h.fake.add("appInfoLocalizations", "ail-en", { locale: "en-US", name: "Example Chess", subtitle: "Daily puzzle" }, { appInfo: "info-1" });
    const { text, isError } = await h.call("keyword_popularity", { app: APP_ID });
    expect(isError, text).toBe(false);
    expect(text).toContain("keyword field 19/100 characters");
    expect(text).toContain("72  chess  (already in name or subtitle");
    expect(text).toContain("55  coffee");
    expect(text).not.toContain("55  coffee  (");
  });

  it("collapses extra spaces inside keyword-field terms, like the lookup does", async () => {
    const h = makeHarness({ ads: true });
    seedApp(h.fake);
    seedVersion(h.fake);
    h.fake.get("appStoreVersionLocalizations", "loc-en")!.attributes.keywords = "chess  puzzle, coffee";
    h.fake.add("appInfos", "info-1", { state: "PREPARE_FOR_SUBMISSION" }, { app: APP_ID });
    h.fake.add("appInfoLocalizations", "ail-en", { locale: "en-US", name: "Example  App" }, { appInfo: "info-1" });
    const { text, isError } = await h.call("keyword_popularity", { app: APP_ID });
    expect(isError, text).toBe(false);
    expect(text).toContain(" 61  chess puzzle");
    expect(text).not.toContain("no data: chess");
    expect(text).toContain("no data: Example App");
  });
});

describe("search_term_trends", () => {
  it("defaults to the last full Sunday-to-Saturday week", () => {
    // 2026-10-01 is a Thursday, so the last full week is Sep 20 (Sun) to Sep 26 (Sat).
    expect(timeRange("weekly", undefined, undefined, Date.parse("2026-10-01T12:00:00Z"))).toEqual({ start: "2026-09-20", end: "2026-09-26", granularity: "WEEKLY_SUN_SAT" });
    // September isn't published until Oct 5, so early October defaults to August.
    expect(timeRange("monthly", undefined, undefined, Date.parse("2026-10-01T12:00:00Z"))).toEqual({ start: "2026-08-01", end: "2026-08-31", granularity: "MONTHLY" });
  });

  it("only defaults to weeks and months Apple has published", () => {
    const week = (now: string) => timeRange("weekly", undefined, undefined, Date.parse(now));
    const month = (now: string) => timeRange("monthly", undefined, undefined, Date.parse(now));
    // The week of Sep 27 - Oct 3 is published on Monday Oct 5 at 07:00 UTC.
    expect(week("2026-10-04T12:00:00Z")).toMatchObject({ start: "2026-09-20", end: "2026-09-26" }); // Sunday
    expect(week("2026-10-05T06:00:00Z")).toMatchObject({ start: "2026-09-20", end: "2026-09-26" }); // Monday, before 07:00
    expect(week("2026-10-05T08:00:00Z")).toMatchObject({ start: "2026-09-27", end: "2026-10-03" }); // Monday, after 07:00
    expect(week("2026-10-10T23:00:00Z")).toMatchObject({ start: "2026-09-27", end: "2026-10-03" }); // Saturday
    expect(month("2026-10-05T23:00:00Z")).toMatchObject({ start: "2026-08-01", end: "2026-08-31" });
    expect(month("2026-10-06T00:00:00Z")).toMatchObject({ start: "2026-09-01", end: "2026-09-30" });
    expect(month("2027-01-03T12:00:00Z")).toMatchObject({ start: "2026-11-01", end: "2026-11-30" });
  });

  it("rejects dates that don't exist instead of rolling them over", async () => {
    // 2026-02-29 would roll over to Sunday Mar 1; 2026-13-01 used to throw a RangeError.
    expect(() => timeRange("weekly", "2026-02-29", undefined, 0)).toThrow(/2026-02-29 isn't a valid date/);
    expect(() => timeRange("monthly", "2026-13-01", undefined, 0)).toThrow(/2026-13-01 isn't a valid date/);
    expect(() => timeRange("weekly", "2026-03-01", "2026-03-32", 0)).toThrow(/2026-03-32 isn't a valid date/);
    const h = makeHarness({ ads: true });
    const { text, isError } = await h.call("search_term_trends", { genre: "GAMES", granularity: "monthly", start: "2026-13-01" });
    expect(isError).toBe(true);
    expect(text).toContain("isn't a valid date");
    expect(text).not.toContain("Unexpected");
  });

  it("returns ranked terms and explains the top-500 limit when empty", async () => {
    const h = makeHarness({ ads: true });
    const { text, isError } = await h.call("search_term_trends", { genre: "GAMES", term: "chess" });
    expect(isError, text).toBe(false);
    expect(text).toContain("GAMES in US, weekly 2026-09-20 to 2026-09-26");
    expect(text).toMatch(/12\s+70\s+88\s+4\s+chess/);
    const body = h.ads!.fake.queries("/v1/insights/apps/search-term-popularity/query")[0]!.body as { filters: { field: string; operator: string }[] };
    expect(body.filters).toContainEqual({ field: "searchTerm", operator: "CONTAINS", value: "chess" });
  });

  it("says a recent range may not be published yet when there are no terms", async () => {
    const h = makeHarness({ ads: true });
    h.ads!.fake.fail(/search-term-popularity/, 200, { times: 2, body: { result: { rows: [] } } });
    const recent = await h.call("search_term_trends", { genre: "GAMES" });
    expect(recent.text).toContain("may not be out yet");
    expect(recent.text).toContain("top 500 terms");
    const old = await h.call("search_term_trends", { genre: "GAMES", start: "2026-08-02" });
    expect(old.text).not.toContain("may not be out yet");
    expect(old.text).toContain("top 500 terms");
  });

  it("rejects a weekly range that doesn't start on Sunday", async () => {
    const h = makeHarness({ ads: true });
    const { text, isError } = await h.call("search_term_trends", { genre: "GAMES", start: "2026-09-21" });
    expect(isError).toBe(true);
    expect(text).toContain("start on a Sunday");
  });
});

describe("keyword_suggestions", () => {
  it("returns suggestions for a live app", async () => {
    const h = makeHarness({ ads: true });
    const { text } = await h.call("keyword_suggestions", { app: APP_ID, countries: ["us"] });
    expect(text).toContain(" 72  chess");
  });

  it("explains when Apple won't suggest for an app that isn't live", async () => {
    const h = makeHarness({ ads: true });
    const { text, isError } = await h.call("keyword_suggestions", { app: "1000000099" });
    expect(isError).toBe(true);
    expect(text).toContain("need an app that's live on the App Store");
  });
});

describe("reliability and safety", () => {
  it("waits out a 429 using Retry-After", async () => {
    const h = makeHarness({ ads: true });
    h.ads!.fake.fail(/suggestions\/phrases/, 429, { headers: { "Retry-After": "7" } });
    const { isError } = await h.call("keyword_popularity", { phrases: ["chess"] });
    expect(isError).toBe(false);
    expect(h.ads!.sleeps).toContain(7000);
  });

  it("waits for RateLimit-Reset only after a 429, and backs off after a 5xx", async () => {
    // The fake sends RateLimit-Reset: 30 on every response, as Apple does.
    const h = makeHarness({ ads: true });
    h.ads!.fake.fail(/suggestions\/phrases/, 503);
    expect((await h.call("keyword_popularity", { phrases: ["chess"] })).isError).toBe(false);
    expect(h.ads!.sleeps).toEqual([2000]);
    h.ads!.fake.fail(/suggestions\/phrases/, 429);
    expect((await h.call("keyword_popularity", { phrases: ["chess"] })).isError).toBe(false);
    expect(h.ads!.sleeps).toEqual([2000, 30_000]);
  });

  it("works in read-only mode and without App Store Connect", async () => {
    const h = makeHarness({ ads: true, write: false, noAsc: true });
    expect((await h.call("ads_status", {})).isError).toBe(false);
    expect((await h.call("keyword_popularity", { phrases: ["chess"] })).isError).toBe(false);
    // Using the app option does need App Store Connect, and says so.
    const withApp = await h.call("keyword_popularity", { app: APP_ID });
    expect(withApp.isError).toBe(true);
    expect(withApp.text).toContain("App Store Connect isn't configured");
  });

  it("offers the Ads tools only when ADS_* is set", () => {
    const names = (env: NodeJS.ProcessEnv) => (runtimeFromEnv(env).tools ?? []).map((t) => t.name);
    expect(names({})).not.toContain("keyword_popularity");
    expect(names({ ADS_CLIENT_ID: "SEARCHADS.x" })).toContain("keyword_popularity");
    expect(names({ ADS_CLIENT_ID: "SEARCHADS.x", ASC_DISABLED_TOOLS: "ads" })).not.toContain("keyword_popularity");
  });

  it("names missing variables, never values", () => {
    const runtime = runtimeFromEnv({ ADS_CLIENT_ID: "SEARCHADS.secretish-client" });
    expect(() => runtime.ads!()).toThrow(/ADS_TEAM_ID, ADS_KEY_ID, ADS_KEY_PATH \(or ADS_KEY\)/);
    try {
      runtime.ads!();
    } catch (error) {
      expect((error as Error).message).not.toContain("secretish");
    }
  });
});

describe("loadAdsConfig", () => {
  it("returns nothing when Apple Ads isn't configured", () => {
    expect(loadAdsConfig({})).toBeUndefined();
  });

  it("accepts an inline PEM with escaped newlines", () => {
    const config = loadAdsConfig({ ADS_CLIENT_ID: "c", ADS_TEAM_ID: "t", ADS_KEY_ID: "k", ADS_KEY: ecPem().replace(/\n/g, "\\n"), ADS_AD_ACCOUNT_ID: "123" });
    expect(config?.adAccountId).toBe("123");
  });

  it("rejects a non-EC key without printing it", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => loadAdsConfig({ ADS_CLIENT_ID: "c", ADS_TEAM_ID: "t", ADS_KEY_ID: "k", ADS_KEY: rsa })).toThrow(/ADS_KEY must be an EC \(P-256\) key/);
  });
});
