// Synthetic, anonymised App Store Connect data shaped like real responses.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FakeAsc, Res } from "./fake-asc.js";
import { APP_ID, type Harness } from "./harness.js";

export function seedApp(fake: FakeAsc): void {
  fake.add("apps", APP_ID, { name: "Example App", bundleId: "com.example.app", sku: "example-app", primaryLocale: "en-US" });
  fake.add("apps", "1000000002", { name: "Other App", bundleId: "com.example.other", sku: "other-app", primaryLocale: "en-GB" });
}

export function seedTestFlight(fake: FakeAsc, options: { processing?: boolean; compliance?: boolean } = {}): void {
  fake.add("preReleaseVersions", "prv-1", { version: "1.0", platform: "IOS" });
  fake.add("buildBetaDetails", "bbd-1", {
    autoNotifyEnabled: true,
    internalBuildState: options.processing ? "PROCESSING" : options.compliance ? "MISSING_EXPORT_COMPLIANCE" : "READY_FOR_BETA_TESTING",
    externalBuildState: options.processing ? "PROCESSING" : options.compliance ? "MISSING_EXPORT_COMPLIANCE" : "READY_FOR_BETA_SUBMISSION",
  });
  fake.add(
    "builds",
    "aaaaaaaa-0000-4000-8000-000000000001",
    {
      version: "202610010900",
      uploadedDate: "2026-10-01T09:00:00Z",
      processingState: options.processing ? "PROCESSING" : "VALID",
      expired: false,
      usesNonExemptEncryption: options.compliance || options.processing ? null : false,
    },
    { app: APP_ID, preReleaseVersion: "prv-1", buildBetaDetail: "bbd-1" },
  );
  fake.add("betaGroups", "grp-internal", { name: "Internal", isInternalGroup: true, hasAccessToAllBuilds: true, feedbackEnabled: true }, { app: APP_ID });
  fake.add("betaGroups", "grp-friends", { name: "Friends", isInternalGroup: false, publicLinkEnabled: false, feedbackEnabled: true }, { app: APP_ID });
  fake.add("betaGroups", "grp-public", { name: "Public Beta", isInternalGroup: false, publicLinkEnabled: true, publicLink: "https://testflight.apple.com/join/EXAMPLE1", feedbackEnabled: true }, { app: APP_ID });

  // Apple's side effects: a beta review submission flips the external state; a second one conflicts.
  fake.afterCreate.betaAppReviewSubmissions = (f, _req, res) => {
    const buildId = res!.relationships.build as string;
    if (f.get("builds", buildId)?.relationships.betaAppReviewSubmission) {
      return f.error(409, "ENTITY_ERROR", "Build has already been submitted for review");
    }
    res!.attributes.betaReviewState = "WAITING_FOR_REVIEW";
    const detail = f.get("buildBetaDetails", f.get("builds", buildId)!.relationships.buildBetaDetail as string);
    if (detail) detail.attributes.externalBuildState = "WAITING_FOR_BETA_REVIEW";
  };
  fake.afterUpdate.builds = (f, _req, res) => {
    if (res!.attributes.usesNonExemptEncryption === false) {
      const detail = f.get("buildBetaDetails", res!.relationships.buildBetaDetail as string)!;
      detail.attributes.internalBuildState = "READY_FOR_BETA_TESTING";
      detail.attributes.externalBuildState = "READY_FOR_BETA_SUBMISSION";
    }
  };
}

/** Finish processing the seeded build once the fake clock passes `at`. */
export function finishProcessingAt(h: Harness, at: number): void {
  h.clock.onTick.push((now) => {
    if (now < at) return;
    h.fake.get("builds", "aaaaaaaa-0000-4000-8000-000000000001")!.attributes.processingState = "VALID";
    const d = h.fake.get("buildBetaDetails", "bbd-1")!;
    if (d.attributes.internalBuildState === "PROCESSING") {
      d.attributes.internalBuildState = "READY_FOR_BETA_TESTING";
      d.attributes.externalBuildState = "READY_FOR_BETA_SUBMISSION";
    }
  });
}

export const VERSION_ID = "ver-1";
export const LOC_ID = "loc-en";
export const SET_ID = "set-iphone";

export function md5(path: string): string {
  return createHash("md5").update(readFileSync(path)).digest("hex");
}

export function seedVersion(fake: FakeAsc, options: { screenshots?: number; state?: string } = {}): Res[] {
  fake.add("appStoreVersions", VERSION_ID, { platform: "IOS", versionString: "1.0", appVersionState: options.state ?? "PREPARE_FOR_SUBMISSION", appStoreState: options.state ?? "PREPARE_FOR_SUBMISSION", releaseType: "AFTER_APPROVAL", createdDate: "2026-09-30T00:00:00Z" }, { app: APP_ID });
  fake.add("appStoreVersionLocalizations", LOC_ID, { locale: "en-US", description: "A puzzle game.", keywords: "puzzle,game", supportUrl: "https://example.com/support" }, { appStoreVersion: VERSION_ID });
  fake.add("appScreenshotSets", SET_ID, { screenshotDisplayType: "APP_IPHONE_67" }, { appStoreVersionLocalization: LOC_ID });
  const shots: Res[] = [];
  for (let i = 1; i <= (options.screenshots ?? 3); i++) {
    shots.push(
      fake.add(
        "appScreenshots",
        `shot-${i}`,
        { fileName: `old-${i}.png`, fileSize: 1000, sourceFileChecksum: `oldchecksum${i}`, imageAsset: { width: 1320, height: 2868 }, assetDeliveryState: { state: "COMPLETE" } },
        { appScreenshotSet: SET_ID },
      ),
    );
  }
  return shots;
}

/** Model Apple's screenshot upload: reservation returns an upload URL; processing completes on the next clock tick. */
export function screenshotBehaviour(h: Harness, options: { fail?: (fileName: string) => boolean; slow?: boolean } = {}): void {
  h.fake.afterCreate.appScreenshots = (_f, _req, res) => {
    const size = res!.attributes.fileSize as number;
    res!.attributes.assetDeliveryState = { state: "AWAITING_UPLOAD" };
    res!.attributes.uploadOperations = [
      { method: "PUT", url: `https://upload.fake.example/${res!.id}/0`, offset: 0, length: Math.ceil(size / 2), requestHeaders: [{ name: "Content-Type", value: "image/png" }] },
      { method: "PUT", url: `https://upload.fake.example/${res!.id}/1`, offset: Math.ceil(size / 2), length: size - Math.ceil(size / 2), requestHeaders: [] },
    ];
  };
  h.fake.afterUpdate.appScreenshots = (_f, _req, res) => {
    if (res!.attributes.uploaded) {
      res!.attributes.assetDeliveryState = { state: "UPLOAD_COMPLETE" };
      delete res!.attributes.uploadOperations;
    }
  };
  h.clock.onTick.push(() => {
    if (options.slow) return;
    for (const s of h.fake.all("appScreenshots")) {
      const state = s.attributes.assetDeliveryState as { state: string };
      if (state.state !== "UPLOAD_COMPLETE") continue;
      s.attributes.assetDeliveryState = options.fail?.(s.attributes.fileName as string)
        ? { state: "FAILED", errors: [{ code: "IMAGE_INCORRECT_DIMENSIONS", description: "The dimensions of one or more screenshots are wrong." }] }
        : { state: "COMPLETE" };
      s.attributes.imageAsset = { width: 1320, height: 2868 };
    }
  });
}

export function setOrder(fake: FakeAsc): string[] {
  return (fake.get("appScreenshotSets", SET_ID)!.relationships.appScreenshots as string[]).slice();
}

export function fileNames(fake: FakeAsc): string[] {
  return setOrder(fake).map((id) => fake.get("appScreenshots", id)!.attributes.fileName as string);
}
