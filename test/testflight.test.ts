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
