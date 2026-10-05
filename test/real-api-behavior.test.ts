// Regression tests for behavior seen against the real App Store Connect API (sandbox app, 2026-10-04).
import { describe, expect, it } from "vitest";
import { seedApp, seedTestFlight, seedVersion, VERSION_ID } from "./helpers/fixtures.js";
import { APP_ID, makeHarness } from "./helpers/harness.js";
import { AGE_RATING_LEVEL_QUESTIONS } from "../src/tools/listing.js";

const NULL_AGE_RATING = Object.fromEntries(
  [
    "alcoholTobaccoOrDrugUseOrReferences", "contests", "gamblingSimulated", "gunsOrOtherWeapons", "horrorOrFearThemes",
    "matureOrSuggestiveThemes", "medicalOrTreatmentInformation", "profanityOrCrudeHumor", "sexualContentGraphicAndNudity",
    "sexualContentOrNudity", "violenceCartoonOrFantasy", "violenceRealistic", "violenceRealisticProlongedGraphicOrSadistic",
    "advertising", "ageAssurance", "gambling", "healthOrWellnessTopics", "lootBox", "parentalControls", "unrestrictedWebAccess",
    "userGeneratedContent", "messagingAndChat",
  ].map((k) => [k, null]),
);

function freshApp() {
  const h = makeHarness();
  seedApp(h.fake);
  seedVersion(h.fake);
  h.fake.add("ageRatingDeclarations", "age-1", { ...NULL_AGE_RATING, ageRatingOverride: "NONE" });
  h.fake.add("appInfos", "info-1", { state: "PREPARE_FOR_SUBMISSION", appStoreAgeRating: null }, { app: APP_ID, ageRatingDeclaration: "age-1" });
  h.fake.add("appInfoLocalizations", "ail-en", { locale: "en-US", name: "Example App" }, { appInfo: "info-1" });
  // Apple rejects partial updates while the questionnaire is unanswered.
  h.fake.afterUpdate.ageRatingDeclarations = (f, req) => {
    const sent = (req.body as { data: { attributes: Record<string, unknown> } }).data.attributes;
    const missing = Object.keys(NULL_AGE_RATING).filter((k) => !(k in sent));
    if (missing.length) return f.error(409, "ENTITY_ERROR.ATTRIBUTE.REQUIRED", `You must provide a value for the attribute '${missing[0]}' with this request`);
  };
  return h;
}

describe("age rating on a fresh app", () => {
  it("shows the questionnaire as unanswered, not as all NONE", async () => {
    const h = freshApp();
    const { text } = await h.call("get_listing", {});
    expect(text).toContain("age rating not rated yet");
    expect(text).toContain("not answered yet");
  });

  it("refuses a partial answer and names what's missing", async () => {
    const h = freshApp();
    const { text, isError } = await h.call("update_age_rating", { answers: { messagingAndChat: true } });
    expect(isError).toBe(true);
    expect(text).toContain("Still unanswered: alcoholTobaccoOrDrugUseOrReferences");
    expect(h.fake.writes()).toEqual([]);
  });

  it("fill_unanswered answers everything in one request", async () => {
    const h = freshApp();
    const { text, isError } = await h.call("update_age_rating", { answers: { messagingAndChat: true }, fill_unanswered: true });
    expect(isError, text).toBe(false);
    expect(text).toContain("messagingAndChat: empty → true");
    expect(h.fake.get("ageRatingDeclarations", "age-1")!.attributes.violenceRealistic).toBe("NONE");
  });

  it("fill_unanswered with no answers answers messagingAndChat too", async () => {
    // Seen on two real apps: Apple rejects the PATCH without messagingAndChat (but not socialMedia).
    const h = freshApp();
    const { text, isError } = await h.call("update_age_rating", { fill_unanswered: true });
    expect(isError, text).toBe(false);
    const patch = h.fake.writes().find((r) => r.method === "PATCH")!;
    const sent = (patch.body as { data: { attributes: Record<string, unknown> } }).data.attributes;
    expect(sent.messagingAndChat).toBe(false);
    expect(Object.keys(sent)).toHaveLength(22);
    expect(sent).not.toHaveProperty("socialMedia");
  });

  it("fill_unanswered sends the answers already given too", async () => {
    // Seen on the real API: with the content questions answered and the newer yes/no ones empty,
    // a PATCH with only the empty ones fails ("You must provide a value for the attribute ...").
    const h = freshApp();
    const age = h.fake.get("ageRatingDeclarations", "age-1")!;
    for (const q of AGE_RATING_LEVEL_QUESTIONS) age.attributes[q] = "NONE";
    age.attributes.violenceCartoonOrFantasy = "INFREQUENT_OR_MILD";
    const { text, isError } = await h.call("update_age_rating", { fill_unanswered: true });
    expect(isError, text).toBe(false);
    const sent = (h.fake.writes().find((r) => r.method === "PATCH")!.body as { data: { attributes: Record<string, unknown> } }).data.attributes;
    expect(Object.keys(sent)).toHaveLength(22);
    expect(sent.violenceCartoonOrFantasy).toBe("INFREQUENT_OR_MILD");
    // The diff only shows what changed.
    expect(text).toContain("advertising: empty → false");
    expect(text).not.toContain("violenceCartoonOrFantasy");
  });

  it("blocks submission while the questionnaire is unanswered", async () => {
    const h = freshApp();
    const { text } = await h.call("submit_for_review", {});
    expect(text).toContain("age rating questionnaire has 22 unanswered questions");
  });
});

describe("first version", () => {
  it("explains that What's New isn't allowed on an app's first version", async () => {
    const h = freshApp();
    h.fake.afterUpdate.appStoreVersionLocalizations = (f, req) => {
      if ("whatsNew" in (req.body as { data: { attributes: object } }).data.attributes) {
        return f.error(409, "STATE_ERROR", "Attribute 'whatsNew' cannot be edited at this time");
      }
    };
    const { text, isError } = await h.call("set_whats_new", { target: "app_store", text: "First release." });
    expect(isError).toBe(true);
    expect(text).toContain("Apple doesn't allow What's New on an app's first version");
  });

  it("clears a URL with an empty string", async () => {
    const h = freshApp();
    const { text, isError } = await h.call("update_listing", { support_url: "" });
    expect(isError, text).toBe(false);
    expect(text).toContain('supportUrl: "https://example.com/support" → empty');
    // Apple wants null, not "", to clear a field.
    const patch = h.fake.writes().find((r) => r.method === "PATCH")!;
    expect((patch.body as { data: { attributes: object } }).data.attributes).toEqual({ supportUrl: null });
    void VERSION_ID;
  });
});

describe("App Review details", () => {
  it("asks for the full contact before editing existing details", async () => {
    const h = freshApp();
    h.fake.add("appStoreReviewDetails", "rd-1", { notes: "old" }, { appStoreVersion: VERSION_ID });
    const { text, isError } = await h.call("set_review_details", { notes: "" });
    expect(isError).toBe(true);
    expect(text).toContain("Also pass: contact_first_name, contact_last_name, contact_email, contact_phone");
    expect(h.fake.writes()).toEqual([]);
  });

  it("rejects a phone number without a country code", async () => {
    const h = freshApp();
    await expect(h.call("set_review_details", { contact_phone: "555 0100" })).rejects.toThrow(/country code/);
  });
});

describe("TestFlight details", () => {
  it("lists a group's testers with a single relationship filter", async () => {
    const h = makeHarness();
    seedApp(h.fake);
    seedTestFlight(h.fake);
    h.fake.add("betaTesters", "t1", { email: "a@example.com", state: "INVITED", inviteType: "EMAIL" }, { betaGroups: ["grp-friends"], apps: [APP_ID] });
    const { text, isError } = await h.call("list_testers", { group: "Friends" });
    expect(isError, text).toBe(false);
    expect(text).toContain("a@example.com");
  });

  it("ignores the placeholder upload Xcode creates when exporting", async () => {
    const h = makeHarness();
    seedApp(h.fake);
    seedTestFlight(h.fake);
    h.fake.add("buildUploads", "placeholder", { cfBundleVersion: "202610041413", cfBundleShortVersionString: "1.0", platform: "IOS", state: { state: "AWAITING_UPLOAD" }, createdDate: new Date(h.clock.now - 60_000).toISOString() }, { app: APP_ID, buildUploadFiles: [] });
    const status = await h.call("get_app_status", {});
    expect(status.text).not.toContain("202610041413");
    const missing = await h.call("get_build", { build: "202610041413" });
    expect(missing.text).toContain("no file has arrived yet");
  });

  it("says when beta review was skipped on purpose", async () => {
    const h = makeHarness();
    seedApp(h.fake);
    seedTestFlight(h.fake);
    const { text } = await h.call("distribute_build", { groups: ["Friends"], submit_for_beta_review: false });
    expect(text).toContain("Beta app review skipped (submit_for_beta_review: false)");
  });
});
