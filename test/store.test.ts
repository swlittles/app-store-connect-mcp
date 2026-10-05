import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { LOC_ID, seedApp, seedTestFlight, seedVersion, VERSION_ID } from "./helpers/fixtures.js";
import { APP_ID, makeHarness, type Harness } from "./helpers/harness.js";
import { AGE_RATING_LEVEL_QUESTIONS, AGE_RATING_YES_NO_QUESTIONS } from "../src/tools/listing.js";

let h: Harness;

beforeEach(() => {
  h = makeHarness();
  seedApp(h.fake);
});

function seedAppInfo(): void {
  h.fake.add("appCategories", "GAMES", {});
  h.fake.add("ageRatingDeclarations", "age-1", {
    ...Object.fromEntries(AGE_RATING_LEVEL_QUESTIONS.map((q) => [q, "NONE"])),
    ...Object.fromEntries(AGE_RATING_YES_NO_QUESTIONS.map((q) => [q, false])),
  });
  h.fake.add("appInfos", "info-1", { state: "PREPARE_FOR_SUBMISSION", appStoreAgeRating: "FOUR_PLUS" }, { app: APP_ID, primaryCategory: "GAMES", ageRatingDeclaration: "age-1" });
  h.fake.add("appInfoLocalizations", "ail-en", { locale: "en-US", name: "Example App", subtitle: "Daily puzzles", privacyPolicyUrl: "https://example.com/privacy" }, { appInfo: "info-1" });
}

describe("subscriptions", () => {
  beforeEach(() => {
    h.fake.add("subscriptionGroups", "sg-1", { referenceName: "Example+" }, { subscriptions: [] });
    h.fake.add("subscriptions", "sub-yearly", { name: "Yearly", productId: "com.example.app.yearly", subscriptionPeriod: "ONE_YEAR", state: "APPROVED", groupLevel: 1 }, { group: "sg-1" });
    h.fake.get("apps", APP_ID)!.relationships.subscriptionGroups = ["sg-1"];
    for (let i = 0; i < 175; i++) {
      const territory = `T${String(i).padStart(2, "0")}`.slice(0, 3);
      h.fake.add("territories", territory, { currency: "USD" });
      h.fake.add("subscriptionIntroductoryOffers", `offer-${i}`, { offerMode: "FREE_TRIAL", duration: "ONE_WEEK", numberOfPeriods: 1 }, { subscription: "sub-yearly", territory });
    }
    h.fake.pageSize = 50; // force pagination through links.next
  });

  it("summarizes offers across every page", async () => {
    const { text, isError } = await h.call("list_subscriptions", {});
    expect(isError, text).toBe(false);
    expect(text).toContain("Yearly · com.example.app.yearly · ONE_YEAR · APPROVED");
    expect(text).toContain("FREE_TRIAL ONE_WEEK in 175 territories");
  });

  it("removes a free trial everywhere, reports partial failures, and finishes on re-run", async () => {
    const plan = await h.call("remove_intro_offers", { subscription: "com.example.app.yearly" });
    expect(plan.text).toContain("175 introductory offers now; 175 match");
    expect(h.fake.writes()).toEqual([]);

    h.fake.fail(/^\/v1\/subscriptionIntroductoryOffers\/offer-(3|4)$/, { status: 403, body: { errors: [{ status: "403", code: "FORBIDDEN_ERROR", title: "Forbidden", detail: "nope" }] } }, { method: "DELETE", times: 2 });
    const first = await h.call("remove_intro_offers", { subscription: "com.example.app.yearly", dry_run: false });
    expect(first.text).toContain("✓ deleted: 173");
    expect(first.text).toMatch(/✗ T0[34]/);
    expect(first.text).toContain("Run the same call again to finish");
    expect(first.text).toContain("Now: FREE_TRIAL ONE_WEEK in 2 territories");

    const second = await h.call("remove_intro_offers", { subscription: "sub-yearly", dry_run: false });
    expect(second.text).toContain("✓ deleted: 2");
    expect(second.text).toContain("Now: no introductory offers");
    expect(h.fake.all("subscriptionIntroductoryOffers")).toEqual([]);
  });

  it("add_free_trial counts a 409 as done only if the offer really exists", async () => {
    h.fake.add("subscriptionAvailabilities", "avail-1", {}, { availableTerritories: ["USA", "GBR"] });
    h.fake.get("subscriptions", "sub-yearly")!.relationships.subscriptionAvailability = "avail-1";
    h.fake.db.get("subscriptionIntroductoryOffers")!.clear();
    h.fake.get("subscriptions", "sub-yearly")!.relationships.introductoryOffers = [];
    h.fake.add("territories", "USA", { currency: "USD" });
    h.fake.add("territories", "GBR", { currency: "GBP" });
    // An ended offer in GBR doesn't count; a validation 409 in USA must surface as a failure.
    h.fake.add("subscriptionIntroductoryOffers", "old-gbr", { offerMode: "FREE_TRIAL", duration: "ONE_WEEK", numberOfPeriods: 1, endDate: "2025-01-01" }, { subscription: "sub-yearly", territory: "GBR" });
    h.fake.afterCreate.subscriptionIntroductoryOffers = (f, _req, res) => {
      if (res!.relationships.territory === "USA") return f.error(409, "ENTITY_ERROR", "No price for this territory");
    };
    const { text } = await h.call("add_free_trial", { subscription: "sub-yearly", duration: "ONE_WEEK", dry_run: false });
    expect(text).toContain("2 territories, 0 already have");
    expect(text).toContain("✓ added: 1");
    expect(text).toMatch(/✗ USA: .*No price for this territory/);
  });

  it("finds subscriptions beyond the 50 Apple includes per group", async () => {
    for (let i = 1; i < 60; i++) {
      h.fake.add("subscriptions", `sub-${i}`, { name: `Extra ${i}`, productId: `com.example.app.extra${i}`, subscriptionPeriod: "ONE_MONTH", state: "APPROVED", groupLevel: i + 1 }, { group: "sg-1" });
    }
    // Like Apple, cut the included subscriptions at limit[subscriptions].
    const original = h.fake.fetch;
    (h.asc as unknown as { fetchImpl: typeof fetch }).fetchImpl = async (input, init) => {
      const res = await original(input, init);
      if (new URL(String(input)).pathname !== `/v1/apps/${APP_ID}/subscriptionGroups`) return res;
      const doc = (await res.json()) as { data: { relationships: { subscriptions: { data?: { id: string }[] } } }[]; included?: { id: string }[] };
      for (const g of doc.data) g.relationships.subscriptions.data = g.relationships.subscriptions.data?.slice(0, 50);
      const kept = new Set(doc.data.flatMap((g) => (g.relationships.subscriptions.data ?? []).map((d) => d.id)));
      doc.included = doc.included?.filter((r) => kept.has(r.id));
      return new Response(JSON.stringify(doc), { status: res.status, headers: res.headers });
    };
    const { text, isError } = await h.call("remove_intro_offers", { subscription: "com.example.app.extra59" });
    expect(isError, text).toBe(false);
    expect(text).toContain("Extra 59 (com.example.app.extra59)");
  });

  it("finds the current price among more than 10 price entries", async () => {
    h.fake.add("territories", "USA", { currency: "USD" });
    const prices: string[] = [];
    for (let i = 1; i <= 12; i++) {
      h.fake.add("subscriptionPricePoints", `pp-${i}`, { customerPrice: `${i}.99` });
      h.fake.add("subscriptionPrices", `price-${i}`, { startDate: `2025-${String(i).padStart(2, "0")}-01` }, { subscriptionPricePoint: `pp-${i}`, territory: "USA" });
      prices.push(`price-${i}`);
    }
    h.fake.get("subscriptions", "sub-yearly")!.relationships.prices = prices;
    const { text, isError } = await h.call("list_subscriptions", {});
    expect(isError, text).toBe(false);
    expect(text).toContain("12.99 USD in USA");
  });

  it("stops a bulk job early when the hourly rate limit runs low", async () => {
    h.fake.rateLimitRemaining = 80;
    const { text } = await h.call("remove_intro_offers", { subscription: "sub-yearly", dry_run: false });
    expect(text).toMatch(/Not attempted: \d+ \(only \d+ API requests left this hour/);
    expect(text).toContain("Run the same call again to finish");
  });
});

describe("listing", () => {
  beforeEach(() => {
    seedVersion(h.fake);
    seedAppInfo();
  });

  it("shows metadata with character counts and masks nothing it shouldn't show", async () => {
    h.fake.add("appStoreReviewDetails", "rd-1", { contactFirstName: "Sam", contactEmail: "review@example.com", demoAccountRequired: true, demoAccountName: "demo", demoAccountPassword: "hunter2" }, { appStoreVersion: VERSION_ID });
    const { text } = await h.call("get_listing", {});
    expect(text).toContain('name "Example App" (11/30)');
    expect(text).toContain("keywords (11/100): puzzle,game");
    expect(text).toContain("primary category GAMES");
    expect(text).toContain('demo account: required, user "demo", password set');
    expect(text).not.toContain("hunter2");
  });

  it("patches only what changed and shows a diff", async () => {
    const { text, isError } = await h.call("update_listing", { keywords: "puzzle,game", subtitle: "Brain teasers", promotional_text: "New levels!" });
    expect(isError, text).toBe(false);
    expect(text).toContain('✓ en-US promotionalText: empty → "New levels!"');
    expect(text).toContain('✓ en-US app info subtitle: "Daily puzzles" → "Brain teasers"');
    expect(text).not.toContain("keywords:");
    const patch = h.fake.writes().find((r) => r.path === `/v1/appStoreVersionLocalizations/${LOC_ID}`)!;
    expect((patch.body as { data: { attributes: object } }).data.attributes).toEqual({ promotionalText: "New levels!" });
  });

  it("creates a missing localization", async () => {
    const { text, isError } = await h.call("update_listing", { locale: "fr-FR", description: "Un jeu de puzzle." });
    expect(isError, text).toBe(false);
    expect(h.fake.all("appStoreVersionLocalizations").map((l) => l.attributes.locale)).toContain("fr-FR");
  });

  it("enforces Apple's character limits before calling the API", async () => {
    await expect(h.call("update_listing", { keywords: "x".repeat(101) })).rejects.toThrow();
  });

  it("never echoes the demo password", async () => {
    const { text } = await h.call("set_review_details", { demo_account_required: true, demo_account_name: "demo", demo_account_password: "s3cret!" });
    expect(text).toContain("demoAccountPassword: ••••");
    expect(text).not.toContain("s3cret!");
  });

  it("sets What's New for the App Store version", async () => {
    const { text } = await h.call("set_whats_new", { target: "app_store", text: "Bug fixes" });
    expect(text).toContain('whatsNew: empty → "Bug fixes"');
  });
});

describe("prepare_version and submit_for_review", () => {
  it("renames the version being prepared and attaches a build", async () => {
    seedVersion(h.fake);
    seedTestFlight(h.fake);
    const { text, isError } = await h.call("prepare_version", { version_string: "1.0.1", build: "latest" });
    expect(isError, text).toBe(false);
    expect(text).toContain("Rename the version being prepared from 1.0 to 1.0.1");
    expect(text).toContain("Build 202610010900 is version 1.0, but this App Store version is 1.0.1");
    expect(h.fake.get("appStoreVersions", VERSION_ID)!.relationships.build).toBe("aaaaaaaa-0000-4000-8000-000000000001");
  });

  it("creates a version when none is being prepared", async () => {
    seedVersion(h.fake, { state: "READY_FOR_DISTRIBUTION" });
    const { text, isError } = await h.call("prepare_version", { version_string: "1.1" });
    expect(isError, text).toBe(false);
    expect(text).toMatch(/Created version 1\.1/);
  });

  it("stops at pre-flight problems", async () => {
    seedVersion(h.fake);
    seedAppInfo();
    const { text } = await h.call("submit_for_review", { dry_run: false });
    expect(text).toContain("✗ No build is attached");
    expect(text).toContain("✗ App Review information isn't filled in");
    expect(text).toContain("Not submitted");
    expect(h.fake.writes()).toEqual([]);
  });

  it("submits a complete version through a review submission", async () => {
    seedVersion(h.fake);
    seedAppInfo();
    seedTestFlight(h.fake);
    h.fake.get("appStoreVersions", VERSION_ID)!.relationships.build = "aaaaaaaa-0000-4000-8000-000000000001";
    h.fake.add("appStoreReviewDetails", "rd-1", { contactFirstName: "Sam", contactLastName: "Lee", contactEmail: "review@example.com", contactPhone: "+1 555 0100", demoAccountRequired: false }, { appStoreVersion: VERSION_ID });
    h.fake.afterUpdate.reviewSubmissions = (_f, _req, res) => {
      if (res!.attributes.submitted) res!.attributes.state = "WAITING_FOR_REVIEW";
    };

    const plan = await h.call("submit_for_review", {});
    expect(plan.text).toContain("✓ Pre-flight checks passed");
    expect(plan.text).toContain("→ Submit to App Review");
    expect(h.fake.writes()).toEqual([]);

    const { text, isError } = await h.call("submit_for_review", { dry_run: false });
    expect(isError, text).toBe(false);
    expect(text).toContain("✓ Submitted to App Review: WAITING_FOR_REVIEW");
    expect(h.fake.writes().map((r) => `${r.method} ${r.path.replace(/revi-\d+/, "{id}")}`)).toEqual([
      "POST /v1/reviewSubmissions",
      "POST /v1/reviewSubmissionItems",
      "PATCH /v1/reviewSubmissions/{id}",
    ]);

    const again = await h.call("submit_for_review", { dry_run: false });
    expect(again.text).toContain("Already submitted");
    expect(h.fake.specViolations).toEqual([]);
  });
});

describe("submit_for_review re-runs", () => {
  const BUILD_ID = "aaaaaaaa-0000-4000-8000-000000000001";

  function seedSubmittable(): void {
    seedVersion(h.fake);
    seedAppInfo();
    seedTestFlight(h.fake);
    h.fake.get("appStoreVersions", VERSION_ID)!.relationships.build = BUILD_ID;
    h.fake.add("appStoreReviewDetails", "rd-1", { contactFirstName: "Sam", contactLastName: "Lee", contactEmail: "review@example.com", contactPhone: "+1 555 0100", demoAccountRequired: false }, { appStoreVersion: VERSION_ID });
    // Like Apple: a new submission is a draft, adding the version makes it READY_FOR_REVIEW, and submitting sends it.
    h.fake.afterCreate.reviewSubmissions = (_f, _req, res) => {
      res!.attributes.state = "READY_FOR_REVIEW";
    };
    h.fake.afterCreate.reviewSubmissionItems = (f, _req, res) => {
      const v = f.get("appStoreVersions", res!.relationships.appStoreVersion as string)!;
      v.attributes.appVersionState = v.attributes.appStoreState = "READY_FOR_REVIEW";
    };
    h.fake.afterUpdate.reviewSubmissions = (_f, _req, res) => {
      if (res!.attributes.submitted) res!.attributes.state = "WAITING_FOR_REVIEW";
    };
  }

  function failFinalStep(): void {
    h.fake.fail(/^\/v1\/reviewSubmissions\/[^/]+$/, { status: 409, body: { errors: [{ status: "409", code: "STATE_ERROR", title: "Invalid state", detail: "App Privacy answers are missing." }] } }, { method: "PATCH" });
  }

  it("resumes the draft submission after the final step fails", async () => {
    seedSubmittable();
    failFinalStep();
    const first = await h.call("submit_for_review", { dry_run: false });
    expect(first.isError).toBe(true);
    expect(h.fake.get("appStoreVersions", VERSION_ID)!.attributes.appVersionState).toBe("READY_FOR_REVIEW");

    const again = await h.call("submit_for_review", { dry_run: false });
    expect(again.isError, again.text).toBe(false);
    expect(again.text).toContain("Reusing review submission");
    expect(again.text).toContain("The version is already in the submission");
    expect(again.text).toContain("✓ Submitted to App Review: WAITING_FOR_REVIEW");
    expect(h.fake.all("reviewSubmissions")).toHaveLength(1);
    expect(h.fake.specViolations).toEqual([]);
  });

  it("cancel_review_submission takes the version out of a draft that was never sent", async () => {
    seedSubmittable();
    failFinalStep();
    await h.call("submit_for_review", { dry_run: false });
    const plan = await h.call("cancel_review_submission", {});
    expect(plan.text).toContain("Would remove 1 item (version 1.0) from draft review submission");
    const { text, isError } = await h.call("cancel_review_submission", { dry_run: false });
    expect(isError, text).toBe(false);
    expect(text).toContain("Removed 1 item (version 1.0)");
    expect(h.fake.all("reviewSubmissionItems")).toEqual([]);
    expect(h.fake.writes().filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([expect.stringMatching(/^\/v1\/reviewSubmissionItems\//)]);
    expect(h.fake.specViolations).toEqual([]);
  });

  it("pre-flight doesn't count screenshots Apple rejected", async () => {
    seedSubmittable();
    for (const s of h.fake.all("appScreenshots")) s.attributes.assetDeliveryState = { state: "FAILED" };
    const { text } = await h.call("submit_for_review", {});
    expect(text).toContain("✗ en-US: no screenshots that Apple has finished processing");
  });

  it("isn't fooled by a submission in review that doesn't hold this version", async () => {
    seedSubmittable();
    h.fake.add("reviewSubmissions", "rs-other", { platform: "IOS", state: "WAITING_FOR_REVIEW", submittedDate: "2026-10-01T00:00:00Z" }, { app: APP_ID });
    h.fake.add("reviewSubmissionItems", "rsi-other", { state: "READY_FOR_REVIEW" }, { reviewSubmission: "rs-other" });
    const { text, isError } = await h.call("submit_for_review", { dry_run: false });
    expect(isError, text).toBe(false);
    expect(text).not.toContain("Already submitted");
    expect(text).toContain("✓ Submitted to App Review");
  });
});

describe("customer reviews and reports", () => {
  beforeEach(() => {
    h.fake.add("customerReviews", "rev-1", { rating: 2, title: "Too hard", body: "Level 3 is impossible", reviewerNickname: "puzzler", territory: "USA", createdDate: "2026-10-01T00:00:00Z" });
    h.fake.get("apps", APP_ID)!.relationships.customerReviews = ["rev-1"];
  });

  it("lists reviews and replies once, then requires replace", async () => {
    const list = await h.call("get_reviews", {});
    expect(list.text).toContain('★★☆☆☆ "Too hard" · puzzler · USA');
    const plan = await h.call("reply_to_review", { review_id: "rev-1", text: "Thanks! Try the hint button." });
    expect(plan.text).toContain("DRY RUN");
    const reply = await h.call("reply_to_review", { review_id: "rev-1", text: "Thanks! Try the hint button.", dry_run: false });
    expect(reply.text).toContain("Replied to");
    const again = await h.call("reply_to_review", { review_id: "rev-1", text: "Something else", dry_run: false });
    expect(again.text).toContain("Pass replace: true");
    const replaced = await h.call("reply_to_review", { review_id: "rev-1", text: "Something else", replace: true, dry_run: false });
    expect(replaced.text).toContain("Replaced the reply");
    expect(h.fake.all("customerReviewResponses")).toHaveLength(1);
  });

  it("replaces a reply without deleting it first, so a failed post keeps the old one", async () => {
    await h.call("reply_to_review", { review_id: "rev-1", text: "Thanks!", dry_run: false });
    h.fake.fail(/^\/v1\/customerReviewResponses$/, { status: 500 }, { method: "POST" });
    const failed = await h.call("reply_to_review", { review_id: "rev-1", text: "Updated", replace: true, dry_run: false });
    expect(failed.isError).toBe(true);
    expect(h.fake.all("customerReviewResponses").map((r) => r.attributes.responseBody)).toEqual(["Thanks!"]);
    const replaced = await h.call("reply_to_review", { review_id: "rev-1", text: "Updated", replace: true, dry_run: false });
    expect(replaced.text).toContain("Replaced the reply");
    expect(h.fake.all("customerReviewResponses").map((r) => r.attributes.responseBody)).toEqual(["Updated"]);
    expect(h.fake.writes().filter((r) => r.method === "DELETE")).toEqual([]);
  });

  it("unzips a sales report and totals it", async () => {
    const tsv = ["Provider\tSKU\tUnits\tDeveloper Proceeds\tCurrency of Proceeds", "APPLE\texample\t3\t0.70\tUSD", "APPLE\texample\t2\t0.60\tEUR"].join("\n");
    const original = h.fake.fetch;
    const fetchWithReport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/salesReports") {
        expect(url.searchParams.get("filter[vendorNumber]")).toBe("80000000");
        return new Response(gzipSync(tsv), { status: 200, headers: { "content-type": "application/a-gzip" } });
      }
      return original(input, init);
    };
    (h.asc as unknown as { fetchImpl: typeof fetch }).fetchImpl = fetchWithReport;
    const { text, isError } = await h.call("download_report", { report_date: "2026-10-01", vendor_number: "80000000" });
    expect(isError, text).toBe(false);
    expect(text).toContain("2 rows");
    expect(text).toContain("Total units: 5");
    expect(text).toContain("Developer proceeds: 2.10 USD, 1.20 EUR");
  });

  it("defaults the finance region to Z1 for FINANCE_DETAIL and ZZ otherwise", async () => {
    const regions: (string | null)[] = [];
    const original = h.fake.fetch;
    (h.asc as unknown as { fetchImpl: typeof fetch }).fetchImpl = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/financeReports") {
        regions.push(url.searchParams.get("filter[regionCode]"));
        return new Response(gzipSync("Start Date\tQuantity\n2026-09-01\t1"), { status: 200, headers: { "content-type": "application/a-gzip" } });
      }
      return original(input, init);
    };
    for (const report_type of ["FINANCE_DETAIL", "FINANCIAL"]) {
      const { text, isError } = await h.call("download_report", { kind: "finance", report_type, report_date: "2026-09", vendor_number: "80000000" });
      expect(isError, text).toBe(false);
    }
    expect(regions).toEqual(["Z1", "ZZ"]);
  });
});

describe("asc_request", () => {
  it("allows GET in read-only mode and blocks writes", async () => {
    h = makeHarness({ write: false });
    seedApp(h.fake);
    const get = await h.call("asc_request", { path: "/v1/apps", query: { "fields[apps]": "name" } });
    expect(get.isError).toBe(false);
    expect(get.text).toContain("Example App");
    const post = await h.call("asc_request", { method: "POST", path: "/v1/betaGroups", body: {} });
    expect(post.isError).toBe(true);
    expect(post.text).toContain("ASC_WRITE=1");
  });

  it("needs confirm for DELETE and refuses foreign hosts", async () => {
    const del = await h.call("asc_request", { method: "DELETE", path: "/v1/appScreenshots/x" });
    expect(del.text).toContain("confirm: true");
    const foreign = await h.call("asc_request", { path: "https://evil.example/v1/apps" });
    expect(foreign.isError).toBe(true);
  });
});
