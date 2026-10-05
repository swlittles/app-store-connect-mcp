import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { finishProcessingAt, seedApp, seedTestFlight } from "./helpers/fixtures.js";
import { APP_ID, makeHarness, type Harness } from "./helpers/harness.js";

const BUILD_ID = "aaaaaaaa-0000-4000-8000-000000000001";
let h: Harness;

beforeEach(() => {
  h = makeHarness();
  seedApp(h.fake);
});

describe("distribute_build", () => {
  it("sets notes, adds groups, submits for beta review and reports state", async () => {
    seedTestFlight(h.fake);
    const { text, isError } = await h.call("distribute_build", {
      build: "202610010900",
      groups: ["Internal", "friends"],
      notes: "Try the new puzzles",
    });
    expect(isError, text).toBe(false);
    expect(text).toContain('✓ Set "What to Test" (en-US)');
    expect(text).toContain('– "Internal" is internal with access to all builds');
    expect(text).toContain('✓ Add to "Friends" (external)');
    expect(text).toContain("✓ Submitted for beta app review");
    expect(text).toContain("external WAITING_FOR_BETA_REVIEW");
    expect(h.fake.get("betaGroups", "grp-friends")!.relationships.builds).toEqual([BUILD_ID]);
    expect(h.fake.all("betaBuildLocalizations")[0]!.attributes).toMatchObject({ locale: "en-US", whatsNew: "Try the new puzzles" });
    expect(h.fake.specViolations).toEqual([]);
  });

  it("is safe to re-run: the second run writes nothing", async () => {
    seedTestFlight(h.fake);
    const args = { groups: ["Friends"], notes: "Same notes" };
    await h.call("distribute_build", args);
    const writes = h.fake.writes().length;
    const { text, isError } = await h.call("distribute_build", args);
    expect(isError, text).toBe(false);
    expect(h.fake.writes().length).toBe(writes);
    expect(text).toContain('– Already in "Friends"');
    expect(text).toContain("already set");
    expect(text).toContain("– Beta app review already submitted: WAITING_FOR_REVIEW");
  });

  it("treats Apple's 'already submitted' conflict as success", async () => {
    seedTestFlight(h.fake);
    // Another tool submitted it between our check and our POST.
    h.fake.fail(/^\/v1\/betaAppReviewSubmissions$/, { status: 409, body: { errors: [{ status: "409", code: "ENTITY_ERROR", title: "conflict", detail: "Build is already submitted for review." }] } }, { method: "POST" });
    const { text, isError } = await h.call("distribute_build", { groups: ["Friends"] });
    expect(isError, text).toBe(false);
    expect(text).toContain("– Beta app review already submitted or approved");
  });

  it("waits for processing, then distributes", async () => {
    seedTestFlight(h.fake, { processing: true });
    finishProcessingAt(h, h.clock.now + 3 * 60_000);
    const { text, isError } = await h.call("distribute_build", { groups: ["Friends"], wait_minutes: 10, uses_non_exempt_encryption: false });
    expect(isError, text).toBe(false);
    expect(text).toContain('✓ Add to "Friends"');
  });

  it("returns a resumable status when processing outlasts the wait", async () => {
    seedTestFlight(h.fake, { processing: true });
    const { text, isError } = await h.call("distribute_build", { groups: ["Friends"], wait_minutes: 1 });
    expect(isError).toBe(false);
    expect(text).toContain("still processing");
    expect(text).toContain("Run distribute_build again with the same arguments");
    expect(h.fake.writes()).toEqual([]);
  });

  it("stops and asks about export compliance", async () => {
    seedTestFlight(h.fake, { compliance: true });
    const stop = await h.call("distribute_build", { groups: ["Friends"] });
    expect(stop.text).toContain("waiting for an export compliance answer");
    expect(stop.text).toContain("ITSAppUsesNonExemptEncryption");
    expect(h.fake.writes()).toEqual([]);

    const go = await h.call("distribute_build", { groups: ["Friends"], uses_non_exempt_encryption: false });
    expect(go.isError, go.text).toBe(false);
    expect(go.text).toContain("✓ Answer export compliance");
    expect(h.fake.get("builds", BUILD_ID)!.attributes.usesNonExemptEncryption).toBe(false);
  });

  it("names the available groups when one is unknown", async () => {
    seedTestFlight(h.fake);
    const { text, isError } = await h.call("distribute_build", { groups: ["Nope"] });
    expect(isError).toBe(true);
    expect(text).toContain('Unknown beta group: Nope. This app\'s groups: "Internal" (internal), "Friends" (external), "Public Beta" (external)');
  });

  it("plans without writing in a dry run, even in read-only mode", async () => {
    h = makeHarness({ write: false });
    seedApp(h.fake);
    seedTestFlight(h.fake);
    const { text, isError } = await h.call("distribute_build", { groups: ["Friends"], notes: "x", dry_run: true });
    expect(isError, text).toBe(false);
    expect(text).toContain("DRY RUN");
    expect(text).toContain('→ Add to "Friends"');
    expect(text).toContain("→ Submit for beta app review");
    expect(h.fake.writes()).toEqual([]);
  });

  it("refuses to write in read-only mode", async () => {
    h = makeHarness({ write: false });
    seedApp(h.fake);
    seedTestFlight(h.fake);
    const { text, isError } = await h.call("distribute_build", { groups: ["Friends"] });
    expect(isError).toBe(true);
    expect(text).toContain("ASC_WRITE=1");
    expect(h.fake.requests).toEqual([]);
  });
});

describe("get_build and list_builds", () => {
  it("explains a build that's still in the upload pipeline", async () => {
    seedTestFlight(h.fake);
    h.fake.add("buildUploads", "up-1", { cfBundleVersion: "202610011200", cfBundleShortVersionString: "1.0", platform: "IOS", state: { state: "PROCESSING" }, createdDate: "2026-10-01T12:00:00Z" }, { app: APP_ID });
    const { text } = await h.call("get_build", { build: "202610011200" });
    expect(text).toContain("Apple is still processing it (upload state PROCESSING)");
  });

  it("shows groups, notes and compliance", async () => {
    seedTestFlight(h.fake);
    await h.call("distribute_build", { groups: ["Friends"], notes: "Hello testers" });
    const { text } = await h.call("get_build", {});
    expect(text).toContain("build 202610010900 (v1.0)");
    expect(text).toContain("Groups: Friends (external");
    expect(text).toContain('en-US: "Hello testers"');
    expect(text).toContain("exempt (no non-exempt encryption)");
  });

  it("lists builds newest first", async () => {
    seedTestFlight(h.fake);
    h.fake.add("builds", "aaaaaaaa-0000-4000-8000-000000000002", { version: "202610020900", uploadedDate: "2026-10-02T09:00:00Z", processingState: "VALID", expired: false }, { app: APP_ID, preReleaseVersion: "prv-1" });
    const { text } = await h.call("list_builds", {});
    const first = text.indexOf("202610020900");
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(text.indexOf("202610010900"));
  });
});

describe("finding builds", () => {
  it("prefers the iOS build when a Mac build has the same number", async () => {
    seedTestFlight(h.fake);
    h.fake.add("preReleaseVersions", "prv-mac", { version: "1.0", platform: "MAC_OS" });
    h.fake.add("builds", "aaaaaaaa-0000-4000-8000-0000000000aa", { version: "202610010900", uploadedDate: "2026-10-01T10:00:00Z", processingState: "VALID", expired: false }, { app: APP_ID, preReleaseVersion: "prv-mac" });
    const { text } = await h.call("get_build", { build: "202610010900" });
    expect(text).toContain(`id ${BUILD_ID}`);
    expect((await h.call("get_build", { build: "202610010900", platform: "MAC_OS" })).text).toContain("id aaaaaaaa-0000-4000-8000-0000000000aa");
  });

  it("refuses a build ID that belongs to another app", async () => {
    seedTestFlight(h.fake);
    h.fake.add("builds", "aaaaaaaa-0000-4000-8000-0000000000bb", { version: "7", uploadedDate: "2026-10-01T10:00:00Z", processingState: "VALID" }, { app: "1000000002" });
    const { text, isError } = await h.call("distribute_build", { build: "aaaaaaaa-0000-4000-8000-0000000000bb", groups: ["Friends"] });
    expect(isError).toBe(true);
    expect(text).toContain("belongs to a different app (id 1000000002)");
    expect(h.fake.writes()).toEqual([]);
  });

  it("names the filter when no build matches it", async () => {
    seedTestFlight(h.fake);
    const { text } = await h.call("get_build", { version: "1.3" });
    expect(text).toContain("no builds matching version 1.3");
  });

  it("finds an app whose name is all digits", async () => {
    h.fake.add("apps", "1000000003", { name: "2048", bundleId: "com.example.twentyfortyeight", sku: "2048", primaryLocale: "en-US" });
    const { text, isError } = await h.call("get_app_status", { app: "2048" });
    expect(isError, text).toBe(false);
    expect(text).toContain("2048 · id 1000000003");
  });

  it("shows open review submissions even when Apple lists old ones first", async () => {
    for (let i = 0; i < 6; i++) h.fake.add("reviewSubmissions", `rs-old-${i}`, { platform: "IOS", state: "COMPLETE", submittedDate: "2026-01-01T00:00:00Z" }, { app: APP_ID });
    h.fake.add("reviewSubmissions", "rs-open", { platform: "IOS", state: "WAITING_FOR_REVIEW", submittedDate: "2026-10-01T00:00:00Z" }, { app: APP_ID });
    const { text } = await h.call("get_app_status", {});
    expect(text).toContain("WAITING_FOR_REVIEW");
    expect(text).not.toContain("rs-old-0");
  });
});

describe("testers", () => {
  beforeEach(() => {
    seedTestFlight(h.fake);
    h.fake.add("betaTesters", "tester-1", { email: "already@example.com", firstName: "Ada", state: "ACCEPTED", inviteType: "EMAIL" }, { betaGroups: ["grp-friends"], apps: [APP_ID] });
    h.fake.add("betaTesters", "tester-2", { email: "elsewhere@example.com", state: "INVITED", inviteType: "EMAIL" }, { betaGroups: [], apps: [] });
    h.fake.afterCreate.betaTesters = (f, req) => {
      const email = (req.body as { data: { attributes: { email: string } } }).data.attributes.email;
      if (f.all("betaTesters").some((t) => t.attributes.email === email)) return f.error(409, "ENTITY_ERROR.ATTRIBUTE.INVALID", "Tester already exists");
    };
  });

  it("invites new people, adds existing ones, skips members", async () => {
    const { text, isError } = await h.call("invite_testers", {
      group: "Friends",
      testers: ["already@example.com", "elsewhere@example.com", { email: "new@example.com", first_name: "Grace" }],
    });
    expect(isError, text).toBe(false);
    expect(text).toContain('– already@example.com is already in "Friends"');
    expect(text).toContain("✓ Added existing tester elsewhere@example.com");
    expect(text).toContain("✓ Invited new@example.com");
    const members = h.fake.get("betaGroups", "grp-friends")!.relationships.betaTesters as string[];
    expect(members).toHaveLength(3);
  });

  it("lists testers with their groups", async () => {
    const { text } = await h.call("list_testers", { group: "Friends" });
    expect(text).toContain("already@example.com (Ada) · ACCEPTED · EMAIL · groups: Friends · id tester-1");
  });

  it("removes testers from a group only after a confirmed run", async () => {
    const plan = await h.call("remove_testers", { group: "Friends", emails: ["already@example.com"] });
    expect(plan.text).toContain("DRY RUN");
    expect(h.fake.writes()).toEqual([]);
    await h.call("remove_testers", { group: "Friends", emails: ["already@example.com"], dry_run: false });
    expect(h.fake.get("betaGroups", "grp-friends")!.relationships.betaTesters).toEqual([]);
  });

  it("creates a group once", async () => {
    const first = await h.call("create_beta_group", { name: "QA", public_link: true });
    expect(first.text).toMatch(/Created external group "QA"/);
    const second = await h.call("create_beta_group", { name: "qa" });
    expect(second.text).toContain('Group "QA" already exists');
  });
});

describe("upload_build", () => {
  it("uploads through the build upload API and commits with an MD5", async () => {
    seedTestFlight(h.fake);
    h.fake.afterCreate.buildUploadFiles = (_f, _req, res) => {
      const size = res!.attributes.fileSize as number;
      res!.attributes.uploadOperations = [{ method: "PUT", url: `https://upload.fake.example/${res!.id}`, offset: 0, length: size, requestHeaders: [] }];
    };
    const dir = mkdtempSync(join(tmpdir(), "asc-ipa-"));
    const ipa = join(dir, "Example.ipa");
    writeFileSync(ipa, Buffer.alloc(4096, 7));
    const { text, isError } = await h.call("upload_build", { file: ipa, version: "1.0", build_number: "202610011300" });
    expect(isError, text).toBe(false);
    expect(h.fake.writes().map((r) => `${r.method} ${r.path.replace(/\/[^/]+-\d+$/, "/{id}")}`)).toEqual([
      "POST /v1/buildUploads",
      "POST /v1/buildUploadFiles",
      "PATCH /v1/buildUploadFiles/{id}",
    ]);
    const commit = h.fake.writes()[2]!.body as { data: { attributes: { uploaded: boolean; sourceFileChecksums: { file: { algorithm: string } } } } };
    expect(commit.data.attributes.uploaded).toBe(true);
    expect(commit.data.attributes.sourceFileChecksums.file.algorithm).toBe("MD5");
    expect(h.fake.uploads[0]!.bytes).toBe(4096);
    expect(text).toContain("Next: distribute_build");
  });

  it("tells versions apart when build numbers repeat", async () => {
    seedTestFlight(h.fake);
    h.fake.add("preReleaseVersions", "prv-2", { version: "1.1", platform: "IOS" });
    h.fake.afterCreate.buildUploadFiles = (_f, _req, res) => {
      res!.attributes.uploadOperations = [{ method: "PUT", url: `https://upload.fake.example/${res!.id}`, offset: 0, length: res!.attributes.fileSize, requestHeaders: [] }];
    };
    const dir = mkdtempSync(join(tmpdir(), "asc-ipa-"));
    const ipa = join(dir, "Example.ipa");
    writeFileSync(ipa, Buffer.alloc(64));
    // 1.0 (202610010900) exists; 1.1 with the same build number is a different build.
    const { text } = await h.call("upload_build", { file: ipa, version: "1.1", build_number: "202610010900" });
    expect(text).not.toContain("already in App Store Connect");
    expect(h.fake.writes()[0]!.path).toBe("/v1/buildUploads");
  });

  it("won't discard an upload another tool may still be sending", async () => {
    seedTestFlight(h.fake);
    h.fake.add("buildUploads", "up-busy", { cfBundleVersion: "202610011400", cfBundleShortVersionString: "1.0", platform: "IOS", state: { state: "AWAITING_UPLOAD" }, createdDate: new Date(h.clock.now - 10 * 60_000).toISOString() }, { app: APP_ID });
    // A real upload in flight has a file (Xcode's export placeholders don't).
    h.fake.add("buildUploadFiles", "file-busy", { fileName: "Example.ipa", fileSize: 64, assetType: "ASSET" }, { buildUpload: "up-busy" });
    const dir = mkdtempSync(join(tmpdir(), "asc-ipa-"));
    const ipa = join(dir, "Example.ipa");
    writeFileSync(ipa, Buffer.alloc(64));
    const { text, isError } = await h.call("upload_build", { file: ipa, version: "1.0", build_number: "202610011400" });
    expect(isError).toBe(true);
    expect(text).toContain("started 10 min ago");
    expect(h.fake.writes()).toEqual([]);
  });

  it("discards a failed attempt so the next run can upload straight away", async () => {
    seedTestFlight(h.fake);
    h.fake.afterCreate.buildUploadFiles = (_f, _req, res) => {
      res!.attributes.uploadOperations = [{ method: "PUT", url: `https://upload.fake.example/${res!.id}`, offset: 0, length: res!.attributes.fileSize, requestHeaders: [] }];
    };
    h.fake.fail(/^\/v1\/buildUploadFiles\//, { status: 409, body: { errors: [{ status: "409", code: "STATE_ERROR", title: "Upload slot expired" }] } }, { method: "PATCH" });
    const dir = mkdtempSync(join(tmpdir(), "asc-ipa-"));
    const ipa = join(dir, "Example.ipa");
    writeFileSync(ipa, Buffer.alloc(64));
    const args = { file: ipa, version: "1.0", build_number: "202610011500" };
    const first = await h.call("upload_build", args);
    expect(first.isError).toBe(true);
    expect(first.text).toContain("the attempt was discarded");
    expect(h.fake.all("buildUploads")).toEqual([]);
    const second = await h.call("upload_build", args);
    expect(second.isError, second.text).toBe(false);
  });

  it("doesn't upload a build number that already exists", async () => {
    seedTestFlight(h.fake);
    const dir = mkdtempSync(join(tmpdir(), "asc-ipa-"));
    const ipa = join(dir, "Example.ipa");
    writeFileSync(ipa, Buffer.alloc(10));
    const { text } = await h.call("upload_build", { file: ipa, version: "1.0", build_number: "202610010900" });
    expect(text).toContain("already in App Store Connect");
    expect(h.fake.writes()).toEqual([]);
  });
});
