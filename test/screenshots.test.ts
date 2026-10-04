import { beforeEach, describe, expect, it } from "vitest";
import { fileNames, md5, screenshotBehaviour, seedApp, seedVersion, SET_ID, setOrder } from "./helpers/fixtures.js";
import { makeHarness, tempImages, type Harness } from "./helpers/harness.js";

let h: Harness;

beforeEach(() => {
  h = makeHarness();
  seedApp(h.fake);
  screenshotBehaviour(h);
});

const base = { display_type: "APP_IPHONE_67" };

describe("list_screenshots", () => {
  it("lists sets in display order with positions and IDs", async () => {
    seedVersion(h.fake);
    const { text, isError } = await h.call("list_screenshots");
    expect(isError).toBe(false);
    expect(text).toContain("APP_IPHONE_67 · 3 screenshots · set set-iphone");
    expect(text).toMatch(/1\. old-1\.png 1320×2868 · COMPLETE · id shot-1/);
    expect(text).toMatch(/3\. old-3\.png/);
  });
});

describe("replace_screenshot", () => {
  it("defaults to a dry run that changes nothing", async () => {
    seedVersion(h.fake);
    const [file] = tempImages(["new-2.png"]);
    const { text } = await h.call("replace_screenshot", { ...base, position: 2, file });
    expect(text).toContain("DRY RUN");
    expect(text).toContain("→ Upload new-2.png");
    expect(text).toContain("→ Delete #2 old-2.png (after the new order is in place)");
    expect(h.fake.writes()).toEqual([]);
  });

  it("uploads, waits, reorders, and only then deletes", async () => {
    seedVersion(h.fake);
    const [file] = tempImages(["new-2.png"]);
    const { text, isError } = await h.call("replace_screenshot", { ...base, position: 2, file, dry_run: false });
    expect(isError, text).toBe(false);
    expect(fileNames(h.fake)).toEqual(["old-1.png", "new-2.png", "old-3.png"]);
    expect(h.fake.get("appScreenshots", "shot-2")).toBeUndefined();

    const writes = h.fake.writes().map((r) => `${r.method} ${r.path}`);
    const newId = setOrder(h.fake)[1]!;
    expect(writes).toEqual([
      "POST /v1/appScreenshots",
      `PATCH /v1/appScreenshots/${newId}`,
      `PATCH /v1/appScreenshotSets/${SET_ID}/relationships/appScreenshots`,
      "DELETE /v1/appScreenshots/shot-2",
    ]);
    // The commit carries the file's MD5, and every byte went to the presigned URLs.
    const commit = h.fake.writes()[1]!.body as { data: { attributes: { sourceFileChecksum: string } } };
    expect(commit.data.attributes.sourceFileChecksum).toBe(md5(file!));
    expect(h.fake.uploads.reduce((n, u) => n + u.bytes, 0)).toBe(h.fake.get("appScreenshots", newId)!.attributes.fileSize);
    expect(h.fake.specViolations).toEqual([]);
  });

  it("is idempotent: re-running after success changes nothing", async () => {
    seedVersion(h.fake);
    const [file] = tempImages(["new-2.png"]);
    await h.call("replace_screenshot", { ...base, position: 2, file, dry_run: false });
    const before = h.fake.writes().length;
    const { text } = await h.call("replace_screenshot", { ...base, position: 2, file, dry_run: false });
    expect(text).toContain("already has this image");
    expect(h.fake.writes().length).toBe(before);
  });

  it("recovers from a connection reset during the delete without uploading twice", async () => {
    seedVersion(h.fake);
    const [file] = tempImages(["new-2.png"]);
    h.fake.fail(/^\/v1\/appScreenshots\/shot-2$/, "reset", { method: "DELETE", times: 5 });
    const first = await h.call("replace_screenshot", { ...base, position: 2, file, dry_run: false });
    expect(first.isError).toBe(true);
    // The agent sees what already happened.
    expect(first.text).toContain("✓ Uploaded new-2.png");
    expect(first.text).toContain("✓ Reordered");
    expect(first.text).toContain("ECONNRESET");
    // The listing has no gap: the new image is in place and the old one is parked at the end.
    expect(fileNames(h.fake)).toEqual(["old-1.png", "new-2.png", "old-3.png", "old-2.png"]);

    // The error says exactly how to finish; following it doesn't upload anything again.
    expect(first.text).toContain('call delete_screenshots with screenshots ["shot-2"]');
    const uploadsBefore = h.fake.requests.filter((r) => r.method === "POST").length;
    const again = await h.call("delete_screenshots", { ...base, screenshots: ["shot-2"], dry_run: false });
    expect(again.isError, again.text).toBe(false);
    expect(fileNames(h.fake)).toEqual(["old-1.png", "new-2.png", "old-3.png"]);
    expect(h.fake.requests.filter((r) => r.method === "POST").length).toBe(uploadsBefore);
  });

  it("stops before touching the listing when Apple rejects the image", async () => {
    h = makeHarness();
    seedApp(h.fake);
    screenshotBehaviour(h, { fail: (name) => name === "bad.png" });
    seedVersion(h.fake);
    const [file] = tempImages(["bad.png"]);
    const { text } = await h.call("replace_screenshot", { ...base, position: 1, file, dry_run: false });
    expect(text).toContain("✗ Apple couldn't process bad.png");
    expect(text).toContain("IMAGE_INCORRECT_DIMENSIONS");
    expect(h.fake.writes().some((r) => r.method === "DELETE")).toBe(false);
    expect(h.fake.writes().some((r) => r.path.endsWith("/relationships/appScreenshots"))).toBe(false);
    expect(fileNames(h.fake).slice(0, 3)).toEqual(["old-1.png", "old-2.png", "old-3.png"]);
  });

  it("deletes first when the set is already full", async () => {
    seedVersion(h.fake, { screenshots: 10 });
    const [file] = tempImages(["new-5.png"]);
    const { text, isError } = await h.call("replace_screenshot", { ...base, position: 5, file, dry_run: false });
    expect(isError, text).toBe(false);
    expect(text).toContain("set is full");
    const writes = h.fake.writes().map((r) => `${r.method} ${r.path}`);
    expect(writes[0]).toBe("DELETE /v1/appScreenshots/shot-5");
    expect(fileNames(h.fake)[4]).toBe("new-5.png");
    expect(fileNames(h.fake)).toHaveLength(10);
  });

  it("returns a resumable status when processing takes too long", async () => {
    h = makeHarness();
    seedApp(h.fake);
    screenshotBehaviour(h, { slow: true });
    seedVersion(h.fake);
    const [file] = tempImages(["new-1.png"]);
    const first = await h.call("replace_screenshot", { ...base, position: 1, file, dry_run: false, wait_minutes: 1 });
    expect(first.text).toContain("still processing");
    expect(first.text).toContain('call replace_screenshot again with screenshot_id: "shot-1"');
    expect(h.fake.get("appScreenshots", "shot-1")).toBeDefined();

    // Repeating the position alone is refused: positions may have shifted.
    const ambiguous = await h.call("replace_screenshot", { ...base, position: 1, file, dry_run: false });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain("already in this set at #4");

    // Apple finishes; the same call continues without uploading again.
    for (const s of h.fake.all("appScreenshots")) if ((s.attributes.assetDeliveryState as { state: string }).state === "UPLOAD_COMPLETE") s.attributes.assetDeliveryState = { state: "COMPLETE" };
    const posts = h.fake.requests.filter((r) => r.method === "POST").length;
    const second = await h.call("replace_screenshot", { ...base, screenshot_id: "shot-1", position: 1, file, dry_run: false });
    expect(second.isError, second.text).toBe(false);
    expect(h.fake.requests.filter((r) => r.method === "POST").length).toBe(posts);
    expect(fileNames(h.fake)).toEqual(["new-1.png", "old-2.png", "old-3.png"]);
  });

  it("refuses to edit a version that isn't being prepared", async () => {
    seedVersion(h.fake, { state: "READY_FOR_DISTRIBUTION" });
    const [file] = tempImages(["new.png"]);
    const { text, isError } = await h.call("replace_screenshot", { ...base, position: 1, file, dry_run: false });
    expect(isError).toBe(true);
    expect(text).toContain("prepare_version");
  });

  it("warns about images Apple will reject for this display type", async () => {
    seedVersion(h.fake);
    const [file] = tempImages(["ipad.png"], 2064, 2752);
    const { text } = await h.call("replace_screenshot", { ...base, position: 1, file });
    expect(text).toContain("ipad.png is 2064×2752, but APP_IPHONE_67 expects 1320×2868");
  });
});

describe("upload_screenshots", () => {
  it("replace mode makes the set exactly the files, in order", async () => {
    seedVersion(h.fake);
    const files = tempImages(["1.png", "2.png", "10.png"]);
    const folder = files[0]!.replace(/\/[^/]+$/, "");
    const { text, isError } = await h.call("upload_screenshots", { ...base, folder, dry_run: false });
    expect(isError, text).toBe(false);
    expect(fileNames(h.fake)).toEqual(["1.png", "2.png", "10.png"]); // natural order
  });

  it("skips files that are already uploaded when re-run", async () => {
    seedVersion(h.fake);
    const files = tempImages(["a.png", "b.png"]);
    await h.call("upload_screenshots", { ...base, files, dry_run: false });
    const posts = h.fake.requests.filter((r) => r.method === "POST").length;
    const again = await h.call("upload_screenshots", { ...base, files, dry_run: false });
    expect(again.text).toContain("a.png is already uploaded");
    expect(h.fake.requests.filter((r) => r.method === "POST").length).toBe(posts);
  });

  it("append mode keeps existing screenshots and adds to the end", async () => {
    seedVersion(h.fake, { screenshots: 2 });
    const files = tempImages(["extra.png"]);
    const { isError, text } = await h.call("upload_screenshots", { ...base, files, mode: "append", dry_run: false });
    expect(isError, text).toBe(false);
    expect(fileNames(h.fake)).toEqual(["old-1.png", "old-2.png", "extra.png"]);
  });

  it("creates the screenshot set if it doesn't exist", async () => {
    seedVersion(h.fake);
    const files = tempImages(["ipad-1.png"], 2064, 2752);
    const { isError, text } = await h.call("upload_screenshots", { display_type: "APP_IPAD_PRO_3GEN_129", files, dry_run: false });
    expect(isError, text).toBe(false);
    expect(text).toContain("Created the APP_IPAD_PRO_3GEN_129 set");
  });

  it("rejects more than 10 screenshots", async () => {
    seedVersion(h.fake);
    const files = tempImages(Array.from({ length: 11 }, (_, i) => `${i}.png`));
    const { isError, text } = await h.call("upload_screenshots", { ...base, files, dry_run: false });
    expect(isError).toBe(true);
    expect(text).toContain("at most 10");
  });
});

describe("reorder_screenshots", () => {
  it("moves listed positions to the front and keeps the rest in order", async () => {
    seedVersion(h.fake, { screenshots: 4 });
    const { isError, text } = await h.call("reorder_screenshots", { ...base, order: [3], dry_run: false });
    expect(isError, text).toBe(false);
    expect(fileNames(h.fake)).toEqual(["old-3.png", "old-1.png", "old-2.png", "old-4.png"]);
    expect(h.fake.writes().map((r) => r.method)).toEqual(["PATCH"]);
  });
});

describe("interrupted appends", () => {
  it("re-running an append after a timeout doesn't duplicate the image", async () => {
    h = makeHarness();
    seedApp(h.fake);
    screenshotBehaviour(h, { slow: true });
    seedVersion(h.fake, { screenshots: 2 });
    const files = tempImages(["extra.png"]);
    const first = await h.call("upload_screenshots", { ...base, files, mode: "append", dry_run: false, wait_minutes: 1 });
    expect(first.text).toContain("still processing");
    for (const s of h.fake.all("appScreenshots")) s.attributes.assetDeliveryState = { state: "COMPLETE" };
    const second = await h.call("upload_screenshots", { ...base, files, mode: "append", dry_run: false });
    expect(second.isError, second.text).toBe(false);
    expect(fileNames(h.fake)).toEqual(["old-1.png", "old-2.png", "extra.png"]);
  });
});

describe("review regressions", () => {
  it("a full set interrupted mid-replace finishes without deleting a second screenshot", async () => {
    h = makeHarness();
    seedApp(h.fake);
    screenshotBehaviour(h, { slow: true });
    seedVersion(h.fake, { screenshots: 10 });
    const [file] = tempImages(["new-3.png"]);
    const first = await h.call("replace_screenshot", { ...base, position: 3, file, dry_run: false, wait_minutes: 1 });
    expect(first.text).toContain('screenshot_id: "shot-3"');
    expect(h.fake.get("appScreenshots", "shot-3")).toBeUndefined(); // full set: deleted first

    for (const s of h.fake.all("appScreenshots")) s.attributes.assetDeliveryState = { state: "COMPLETE" };
    const second = await h.call("replace_screenshot", { ...base, screenshot_id: "shot-3", position: 3, file, dry_run: false });
    expect(second.isError, second.text).toBe(false);
    expect(fileNames(h.fake)).toEqual(["old-1.png", "old-2.png", "new-3.png", "old-4.png", "old-5.png", "old-6.png", "old-7.png", "old-8.png", "old-9.png", "old-10.png"]);
  });

  it("an upload that never finished doesn't block the set, and replace cleans it up", async () => {
    seedVersion(h.fake, { screenshots: 2 });
    h.fake.add("appScreenshots", "stuck", { fileName: "stuck.png", fileSize: 10, assetDeliveryState: { state: "AWAITING_UPLOAD" } }, { appScreenshotSet: SET_ID });
    const reorder = await h.call("reorder_screenshots", { ...base, order: [2], dry_run: false });
    expect(reorder.isError, reorder.text).toBe(false);
    expect(fileNames(h.fake)).toEqual(["old-2.png", "old-1.png", "stuck.png"]);

    const [file] = tempImages(["fresh.png"]);
    const replace = await h.call("replace_screenshot", { ...base, position: 1, file, dry_run: false });
    expect(replace.isError, replace.text).toBe(false);
    expect(fileNames(h.fake)).toEqual(["fresh.png", "old-1.png"]);
  });
});
