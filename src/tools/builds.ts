import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { z } from "zod";
import { AscApiError, type Resource } from "../asc/client.js";
import { Included, linkage, linkages } from "../asc/jsonapi.js";
import { poll } from "../asc/jobs.js";
import type {
  AppStoreVersionAttributes,
  BetaAppReviewSubmissionAttributes,
  BetaBuildLocalizationAttributes,
  BetaGroupAttributes,
  BuildAttributes,
  BuildBetaDetailAttributes,
  BuildUploadAttributes,
  BuildUploadFileAttributes,
  Platform,
} from "../asc/types.js";
import { describeFile, performUploadOperations } from "../asc/upload.js";
import { STEP_LEGEND, StepLog, truncate, when } from "./format.js";
import { defineTool, UserError, type ToolContext } from "./framework.js";
import {
  appInput,
  buildInput,
  buildSummary,
  describeMissingBuild,
  findBuild,
  platformInput,
  resolveApp,
  resolveGroups,
  type BuildInfo,
} from "./lookup.js";

const POLL_INTERVAL_MS = 30_000;
const MAX_WAIT_MINUTES = 30;

const waitInput = (defaultMinutes: number) =>
  z
    .number()
    .min(0)
    .max(MAX_WAIT_MINUTES)
    .default(defaultMinutes)
    .describe(
      `Minutes to wait for Apple's processing before returning (0-${MAX_WAIT_MINUTES}, default ${defaultMinutes}). Processing usually takes 5-30 minutes; if it isn't done in time, the result says how to resume.`,
    );

export const listBuilds = defineTool({
  name: "list_builds",
  title: "List builds",
  description: "Lists an app's most recent builds with processing state, TestFlight states and IDs.",
  kind: "read",
  input: {
    app: appInput,
    version: z.string().optional().describe('Only builds of this marketing version, e.g. "1.2".'),
    platform: platformInput,
    limit: z.number().int().min(1).max(50).default(10),
    include_expired: z.boolean().default(false),
  },
  async run({ app, version, platform, limit, include_expired }, ctx) {
    const ref = await resolveApp(ctx, app);
    const doc = await ctx.asc.get<Resource<BuildAttributes>[]>("/v1/builds", {
      "filter[app]": ref.id,
      "filter[preReleaseVersion.version]": version,
      "filter[preReleaseVersion.platform]": platform,
      "filter[expired]": include_expired ? undefined : "false",
      sort: "-uploadedDate",
      include: "buildBetaDetail,preReleaseVersion",
      limit,
    });
    if (!doc.data.length) return `${ref.name} has no ${include_expired ? "" : "unexpired "}builds${version ? ` for version ${version}` : ""}.`;
    const included = new Included(doc.included);
    return [
      `${ref.name}: ${doc.data.length} most recent build${doc.data.length === 1 ? "" : "s"}`,
      ...doc.data.map(
        (b) =>
          `- ${buildSummary({
            build: b,
            detail: included.one(b, "buildBetaDetail", "buildBetaDetails"),
            preRelease: included.one(b, "preReleaseVersion", "preReleaseVersions"),
          })}`,
      ),
    ].join("\n");
  },
});

export const getBuild = defineTool({
  name: "get_build",
  title: "Get build",
  description:
    "Shows one build in detail: processing and TestFlight states, export compliance, beta review, groups, What to Test notes and the App Store version it's attached to. " +
    "Set wait_minutes to wait for Apple to finish processing a fresh upload.",
  kind: "read",
  input: { app: appInput, build: buildInput, platform: platformInput, wait_minutes: waitInput(0) },
  async run({ app, build, platform, wait_minutes }, ctx) {
    const ref = await resolveApp(ctx, app);
    const { info, done } = await waitForProcessing(ctx, ref.id, build, platform, wait_minutes);
    if (!info) return await describeMissingBuild(ctx, ref.id, build);

    const doc = await ctx.asc.get<Resource<BuildAttributes>>(`/v1/builds/${info.build.id}`, {
      include: "buildBetaDetail,preReleaseVersion,betaGroups,betaBuildLocalizations,betaAppReviewSubmission,appStoreVersion",
    });
    const b = doc.data;
    const inc = new Included(doc.included);
    const detail = inc.one<BuildBetaDetailAttributes>(b, "buildBetaDetail", "buildBetaDetails");
    const groups = inc.many<BetaGroupAttributes>(b, "betaGroups", "betaGroups");
    const notes = inc.many<BetaBuildLocalizationAttributes>(b, "betaBuildLocalizations", "betaBuildLocalizations");
    const review = inc.one<BetaAppReviewSubmissionAttributes>(b, "betaAppReviewSubmission", "betaAppReviewSubmissions");
    const storeVersion = inc.one<AppStoreVersionAttributes>(b, "appStoreVersion", "appStoreVersions");
    const a = b.attributes ?? {};

    const out = [buildSummary({ build: b, detail, preRelease: inc.one(b, "preReleaseVersion", "preReleaseVersions") })];
    if (!done) out.push(`Still processing after ${wait_minutes} min. Call get_build again with build "${info.build.id}" and wait_minutes to keep waiting.`);
    out.push(
      `Export compliance: ${a.usesNonExemptEncryption === undefined || a.usesNonExemptEncryption === null ? "not answered" : a.usesNonExemptEncryption ? "uses non-exempt encryption" : "exempt (no non-exempt encryption)"}`,
      `Beta review: ${review ? `${review.attributes?.betaReviewState} (submitted ${when(review.attributes?.submittedDate)})` : "not submitted"}`,
      `Groups: ${groups.length ? groups.map((g) => `${g.attributes?.name} (${g.attributes?.isInternalGroup ? "internal" : "external"}, id ${g.id})`).join(", ") : "none"}`,
      `What to Test: ${notes.length ? notes.map((n) => `${n.attributes?.locale}: "${truncate(n.attributes?.whatsNew, 200)}"`).join("; ") : "none"}`,
      `App Store version: ${storeVersion ? `${storeVersion.attributes?.versionString} (id ${storeVersion.id})` : "not attached"}`,
      `Expires: ${when(a.expirationDate)}${detail?.attributes?.autoNotifyEnabled === false ? " · tester auto-notify off" : ""}`,
    );
    return out.join("\n");
  },
});

/** Waits (within the budget) for a build to exist and finish processing. */
async function waitForProcessing(
  ctx: ToolContext,
  appId: string,
  build: string | undefined,
  platform: Platform | undefined,
  minutes: number,
): Promise<{ info?: BuildInfo; done: boolean }> {
  const isDone = (b?: BuildInfo) => b !== undefined && b.build.attributes?.processingState !== "PROCESSING";
  if (minutes <= 0) {
    const info = await findBuild(ctx, appId, build, platform);
    return { info, done: isDone(info) };
  }
  const { value, done } = await poll(() => findBuild(ctx, appId, build, platform), isDone, {
    timeoutMs: minutes * 60_000,
    intervalMs: POLL_INTERVAL_MS,
    sleep: ctx.sleep,
    now: ctx.now,
    signal: ctx.signal,
    onTick: (elapsed) =>
      ctx.progress(`Waiting for Apple to process build ${build ?? "latest"} (${Math.round(elapsed / 60_000)} of ${minutes} min)…`),
  });
  return { info: value, done };
}

// ---------------------------------------------------------------------------------------------
// distribute_build

export const distributeBuild = defineTool({
  name: "distribute_build",
  title: "Distribute a TestFlight build",
  description:
    "Ships a build to TestFlight testers in one call: waits for processing, answers export compliance if you say how, sets the What to Test notes, " +
    "adds the build to beta groups, and submits it for beta app review when an external group needs it. " +
    "Every step checks the current state first, so re-running after a timeout or error picks up where it stopped.",
  kind: "write",
  input: {
    app: appInput,
    build: buildInput,
    platform: platformInput,
    groups: z.array(z.string()).default([]).describe("Beta group names or IDs. Internal groups with access to all builds get it automatically."),
    notes: z.string().max(4000).optional().describe('"What to Test" text shown to testers.'),
    notes_locale: z.string().default("en-US"),
    submit_for_beta_review: z
      .boolean()
      .optional()
      .describe("Submit for beta app review. Defaults to true when any target group is external, since external testers need an approved build."),
    uses_non_exempt_encryption: z
      .boolean()
      .optional()
      .describe("Export compliance answer, used only if the build is waiting on it. false means the app uses no encryption or only exempt encryption such as HTTPS."),
    wait_minutes: waitInput(5),
  },
  async run(args, ctx) {
    const ref = await resolveApp(ctx, args.app);
    const groups = await resolveGroups(ctx, ref.id, args.groups);
    const log = new StepLog();

    // 1. Find the build and wait for processing.
    const { info } = ctx.dryRun
      ? { info: await findBuild(ctx, ref.id, args.build, args.platform) }
      : await waitForProcessing(ctx, ref.id, args.build, args.platform, args.wait_minutes);
    if (!info) {
      return `${await describeMissingBuild(ctx, ref.id, args.build)}\nNothing else was changed. Run distribute_build again with the same arguments once it appears.`;
    }
    const build = info.build;
    const number = build.attributes?.version ?? "?";
    const state = build.attributes?.processingState;
    if (state === "PROCESSING" && !ctx.dryRun) {
      return `Build ${number} (id ${build.id}) is still processing after ${args.wait_minutes} min. Nothing was changed yet. Run distribute_build again with the same arguments to continue (it's safe to repeat).`;
    }
    if (state === "FAILED" || state === "INVALID") {
      throw new UserError(`Build ${number} (id ${build.id}) is ${state}: Apple rejected the binary. Check the email Apple sent, fix the problem and upload a new build.`);
    }
    if (build.attributes?.expired) throw new UserError(`Build ${number} has expired and can't be distributed. Upload a new build.`);
    log.done(`Found ${buildSummary(info)}`);
    if (state === "PROCESSING") log.warn("Build is still processing; a real run waits for it first.");

    // 2. Export compliance.
    const detailState = info.detail?.attributes?.internalBuildState;
    const answered = build.attributes?.usesNonExemptEncryption !== undefined && build.attributes?.usesNonExemptEncryption !== null;
    if (detailState === "MISSING_EXPORT_COMPLIANCE" && !answered) {
      if (args.uses_non_exempt_encryption === undefined) {
        log.fail("Build is waiting for an export compliance answer.");
        return finish(log, [
          "Stopped: ask the user whether the app uses non-exempt encryption, then run again with uses_non_exempt_encryption set.",
          "Tip: add ITSAppUsesNonExemptEncryption = NO to Info.plist so future builds never ask.",
        ]);
      }
      if (args.uses_non_exempt_encryption) {
        throw new UserError(
          "This build uses non-exempt encryption, which needs an encryption declaration with documentation. Upload that in App Store Connect (App Information > App Encryption Documentation), then run distribute_build again.",
        );
      }
      if (!ctx.dryRun) {
        await ctx.asc.patch(`/v1/builds/${build.id}`, {
          data: { type: "builds", id: build.id, attributes: { usesNonExemptEncryption: false } },
        });
      }
      log.step(ctx.dryRun, "Answer export compliance: no non-exempt encryption");
    } else {
      log.skip(`Export compliance ${answered || detailState !== "MISSING_EXPORT_COMPLIANCE" ? "already settled" : "not needed"}`);
    }

    // 3. What to Test.
    if (args.notes !== undefined) await upsertBetaNotes(ctx, build.id, args.notes_locale, args.notes, log);

    // 4. Groups.
    for (const group of groups) {
      const name = group.attributes?.name;
      if (group.attributes?.isInternalGroup && group.attributes.hasAccessToAllBuilds) {
        log.skip(`"${name}" is internal with access to all builds, so it gets this build automatically`);
        continue;
      }
      if (await buildInGroup(ctx, ref.id, build.id, group.id)) {
        log.skip(`Already in "${name}"`);
        continue;
      }
      if (!ctx.dryRun) await ctx.asc.post(`/v1/betaGroups/${group.id}/relationships/builds`, linkages("builds", [build.id]));
      log.step(ctx.dryRun, `Add to "${name}" (${group.attributes?.isInternalGroup ? "internal" : "external"})`);
    }

    // 5. Beta app review.
    const hasExternal = groups.some((g) => !g.attributes?.isInternalGroup);
    const submit = args.submit_for_beta_review ?? hasExternal;
    if (submit) await submitBetaReview(ctx, build.id, log);
    else log.skip("Beta app review not needed (no external groups)");

    // 6. Report.
    if (ctx.dryRun) return finish(log, []);
    const detail = await ctx.asc.get<Resource<BuildBetaDetailAttributes>>(`/v1/builds/${build.id}/buildBetaDetail`);
    const d = detail.data.attributes;
    return finish(log, [`Build ${number} (id ${build.id}): internal ${d?.internalBuildState ?? "?"}, external ${d?.externalBuildState ?? "?"}.`]);
  },
});

function finish(log: StepLog, tail: string[]): string {
  return [STEP_LEGEND, log.toString(), ...tail].join("\n");
}

async function buildInGroup(ctx: ToolContext, appId: string, buildId: string, groupId: string): Promise<boolean> {
  const doc = await ctx.asc.get<Resource[]>("/v1/builds", {
    "filter[app]": appId,
    "filter[id]": buildId,
    "filter[betaGroups]": groupId,
    "fields[builds]": "version",
    limit: 1,
  });
  return doc.data.length > 0;
}

/** Creates or updates the "What to Test" text for one locale. */
export async function upsertBetaNotes(ctx: ToolContext, buildId: string, locale: string, text: string, log: StepLog): Promise<void> {
  const find = async () => {
    const { data } = await ctx.asc.getAll<BetaBuildLocalizationAttributes>(`/v1/builds/${buildId}/betaBuildLocalizations`);
    return data.find((l) => l.attributes?.locale === locale);
  };
  const existing = await find();
  const label = `"What to Test" (${locale}): "${truncate(text, 80)}"`;
  if (existing?.attributes?.whatsNew === text) {
    log.skip(`${label} already set`);
    return;
  }
  if (!ctx.dryRun) {
    const patch = (id: string) =>
      ctx.asc.patch(`/v1/betaBuildLocalizations/${id}`, { data: { type: "betaBuildLocalizations", id, attributes: { whatsNew: text } } });
    if (existing) await patch(existing.id);
    else {
      try {
        await ctx.asc.post("/v1/betaBuildLocalizations", {
          data: { type: "betaBuildLocalizations", attributes: { locale, whatsNew: text }, relationships: { build: linkage("builds", buildId) } },
        });
      } catch (error) {
        // Created by an earlier attempt whose response was lost: update it instead.
        const again = error instanceof AscApiError && error.status === 409 ? await find() : undefined;
        if (!again) throw error;
        await patch(again.id);
      }
    }
  }
  log.step(ctx.dryRun, `${existing ? "Update" : "Set"} ${label}`);
}

async function submitBetaReview(ctx: ToolContext, buildId: string, log: StepLog): Promise<void> {
  const current = await ctx.asc
    .get<Resource<BetaAppReviewSubmissionAttributes> | null>(`/v1/builds/${buildId}/betaAppReviewSubmission`)
    .catch((error) => {
      if (error instanceof AscApiError && error.status === 404) return { data: null };
      throw error;
    });
  if (current.data) {
    log.skip(`Beta app review already submitted: ${current.data.attributes?.betaReviewState}`);
    return;
  }
  if (ctx.dryRun) {
    log.plan("Submit for beta app review");
    return;
  }
  try {
    await ctx.asc.post("/v1/betaAppReviewSubmissions", {
      data: { type: "betaAppReviewSubmissions", relationships: { build: linkage("builds", buildId) } },
    });
    log.done("Submitted for beta app review (later builds of an approved version are usually approved automatically)");
  } catch (error) {
    if (error instanceof AscApiError && (error.status === 409 || error.status === 422) && (error.mentions("already") || error.mentions("approved"))) {
      log.skip("Beta app review already submitted or approved");
      return;
    }
    if (error instanceof AscApiError) {
      log.fail("Beta app review submission was rejected:");
      throw new UserError(
        `${log.toString()}\n${error.message}\nExternal testing needs Test Information filled in first (beta app description, feedback email, review contact). Fix that in App Store Connect > TestFlight > Test Information, then run distribute_build again; finished steps will be skipped.`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// upload_build

const PLATFORM_FOR_ALTOOL: Record<Platform, string> = { IOS: "ios", MAC_OS: "macos", TV_OS: "appletvos", VISION_OS: "visionos" };

export const uploadBuild = defineTool({
  name: "upload_build",
  title: "Upload a build",
  description:
    "Uploads an exported .ipa (or macOS .pkg) to App Store Connect. method \"api\" uses Apple's build upload API (no Xcode needed); \"altool\" shells out to xcrun altool on a Mac. " +
    "Make the .ipa first with xcodebuild archive + xcodebuild -exportArchive (method app-store-connect, destination export). Every upload needs a new, higher build number (CFBundleVersion). " +
    "After it's processed, use distribute_build to send it to testers.",
  kind: "write",
  input: {
    app: appInput,
    file: z.string().describe("Absolute path to the .ipa or .pkg."),
    version: z.string().optional().describe("CFBundleShortVersionString, e.g. 1.2. Read from the .ipa if omitted (macOS only)."),
    build_number: z.string().optional().describe("CFBundleVersion. Read from the .ipa if omitted (macOS only)."),
    platform: platformInput,
    method: z.enum(["api", "altool"]).default("api"),
    wait_minutes: waitInput(0),
  },
  async run(args, ctx) {
    const ref = await resolveApp(ctx, args.app);
    const ext = extname(args.file).toLowerCase();
    if (ext !== ".ipa" && ext !== ".pkg") throw new UserError("file must be an exported .ipa (or a .pkg for macOS).");
    const platform: Platform = args.platform ?? (ext === ".pkg" ? "MAC_OS" : "IOS");
    const file = await describeFile(args.file).catch((error: Error) => {
      throw new UserError(error.message);
    });

    let version = args.version;
    let buildNumber = args.build_number;
    if (!version || !buildNumber) {
      const plist = await readIpaInfoPlist(args.file);
      version ??= plist?.CFBundleShortVersionString;
      buildNumber ??= plist?.CFBundleVersion;
      if (!version || !buildNumber) throw new UserError("Couldn't read the version and build number from the file. Pass version and build_number.");
    }
    const log = new StepLog();
    log.done(`${file.fileName}: ${(file.size / 1e6).toFixed(1)} MB, version ${version} (${buildNumber}), ${platform}`);

    // Already uploaded?
    const existing = await findBuild(ctx, ref.id, buildNumber, platform);
    if (existing) {
      log.skip(`Build ${buildNumber} is already in App Store Connect: ${buildSummary(existing)}`);
      return finish(log, ["Next: distribute_build to send it to testers."]);
    }

    if (args.method === "altool") {
      if (ctx.dryRun) {
        log.plan("Upload with xcrun altool --upload-app");
        return finish(log, []);
      }
      await ctx.progress("Uploading with altool…");
      const output = await uploadWithAltool(ctx, args.file, PLATFORM_FOR_ALTOOL[platform]);
      log.done(`Uploaded with altool. ${output}`);
      return finish(log, await afterUpload(ctx, ref.id, buildNumber, platform, args.wait_minutes));
    }

    // Build upload API. Look for an earlier attempt first.
    const uploads = await ctx.asc.get<Resource<BuildUploadAttributes>[]>(`/v1/apps/${ref.id}/buildUploads`, {
      "filter[cfBundleVersion]": buildNumber,
      "filter[platform]": platform,
      limit: 5,
    });
    for (const upload of uploads.data) {
      const s = upload.attributes?.state;
      if (s?.state === "COMPLETE" || s?.state === "PROCESSING") {
        log.skip(`Build ${buildNumber} was already uploaded (upload ${upload.id}, ${s.state})`);
        return finish(log, await afterUpload(ctx, ref.id, buildNumber, platform, args.wait_minutes));
      }
      if (s?.state === "FAILED") {
        const errors = (s.errors ?? []).map((e) => `${e.code}: ${e.description ?? ""}`).join("; ");
        throw new UserError(`An earlier upload of build ${buildNumber} failed: ${errors || "no detail"}. Fix the problem and upload with a new build number.`);
      }
      // AWAITING_UPLOAD: an interrupted attempt. Its upload URLs may have expired, so start over.
      if (!ctx.dryRun) await ctx.asc.deleteIfExists(`/v1/buildUploads/${upload.id}`);
      log.step(ctx.dryRun, `Discard unfinished upload ${upload.id} from an earlier attempt`);
    }
    if (ctx.dryRun) {
      log.plan("Reserve a build upload, send the file, commit it");
      return finish(log, []);
    }

    const created = await ctx.asc.post<Resource<BuildUploadAttributes>>("/v1/buildUploads", {
      data: {
        type: "buildUploads",
        attributes: { cfBundleShortVersionString: version, cfBundleVersion: buildNumber, platform },
        relationships: { app: linkage("apps", ref.id) },
      },
    });
    const uploadId = created!.data.id;
    const reserved = await ctx.asc.post<Resource<BuildUploadFileAttributes>>("/v1/buildUploadFiles", {
      data: {
        type: "buildUploadFiles",
        attributes: { fileName: file.fileName, fileSize: file.size, uti: ext === ".pkg" ? "com.apple.pkg" : "com.apple.ipa", assetType: "ASSET" },
        relationships: { buildUpload: linkage("buildUploads", uploadId) },
      },
    });
    const fileId = reserved!.data.id;
    const operations = reserved!.data.attributes?.uploadOperations ?? [];
    log.done(`Reserved upload ${uploadId} (${operations.length} parts)`);
    await performUploadOperations(operations, file.path, {
      fetch: ctx.asc.fetcher,
      signal: ctx.signal,
      sleep: ctx.sleep,
      onPart: (n, total) => void ctx.progress(`Uploaded part ${n} of ${total}`, n, total),
    });
    log.done("Sent the file");
    await ctx.asc.patch(`/v1/buildUploadFiles/${fileId}`, {
      data: {
        type: "buildUploadFiles",
        id: fileId,
        attributes: { uploaded: true, sourceFileChecksums: { file: { hash: file.md5, algorithm: "MD5" } } },
      },
    });
    log.done("Committed the upload");
    return finish(log, await afterUpload(ctx, ref.id, buildNumber, platform, args.wait_minutes, uploadId));
  },
});

async function afterUpload(
  ctx: ToolContext,
  appId: string,
  buildNumber: string,
  platform: Platform,
  minutes: number,
  uploadId?: string,
): Promise<string[]> {
  if (uploadId && minutes > 0) {
    const { value } = await poll(
      () => ctx.asc.get<Resource<BuildUploadAttributes>>(`/v1/buildUploads/${uploadId}`),
      (doc) => ["COMPLETE", "FAILED"].includes(doc.data.attributes?.state?.state ?? ""),
      { timeoutMs: minutes * 60_000, intervalMs: POLL_INTERVAL_MS, sleep: ctx.sleep, now: ctx.now, signal: ctx.signal },
    );
    const s = value.data.attributes?.state;
    if (s?.state === "FAILED") {
      throw new UserError(`Apple rejected build ${buildNumber}: ${(s.errors ?? []).map((e) => `${e.code}: ${e.description ?? ""}`).join("; ") || "no detail"}`);
    }
  }
  const { info, done } = await waitForProcessing(ctx, appId, buildNumber, platform, uploadId ? 0 : minutes);
  if (info && done) return [`Processed: ${buildSummary(info)}`, "Next: distribute_build to send it to testers."];
  return [
    `Apple is processing build ${buildNumber}; this usually takes 5-30 minutes.`,
    `Next: distribute_build with build "${buildNumber}" waits for processing and then ships it (or get_build with wait_minutes to just wait).`,
  ];
}

async function readIpaInfoPlist(path: string): Promise<{ CFBundleShortVersionString?: string; CFBundleVersion?: string } | undefined> {
  try {
    const listing = (await run("unzip", ["-Z1", path])).toString("utf8").split("\n");
    const entry = listing.find((line) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(line));
    if (!entry) return undefined;
    const plist = await run("unzip", ["-p", path, entry]);
    const json = await run("plutil", ["-convert", "json", "-o", "-", "--", "-"], plist);
    return JSON.parse(json.toString("utf8"));
  } catch {
    return undefined;
  }
}

async function uploadWithAltool(ctx: ToolContext, file: string, platform: string): Promise<string> {
  // altool needs the key as a file. Use ASC_KEY_PATH when given; otherwise write a private temp copy.
  let keyPath = process.env.ASC_KEY_PATH;
  let tempDir: string | undefined;
  if (!keyPath) {
    tempDir = mkdtempSync(join(tmpdir(), "asc-key-"));
    keyPath = join(tempDir, `AuthKey_${ctx.config.keyId}.p8`);
    writeFileSync(keyPath, ctx.config.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    chmodSync(keyPath, 0o600);
  }
  const args = ["altool", "--upload-app", "-f", file, "-t", platform, "--api-key", ctx.config.keyId, "--p8-file-path", keyPath];
  if (ctx.config.issuerId) args.push("--api-issuer", ctx.config.issuerId);
  else args.push("--api-key-subject", "user");
  try {
    const output = (await run("xcrun", args)).toString("utf8");
    return truncate(output.split("\n").filter((l) => /error|upload|success|No errors/i.test(l)).slice(-3).join(" "), 300);
  } catch (error) {
    throw new UserError(`altool upload failed: ${truncate((error as Error).message, 1500)}`);
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

function run(command: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${command} exited with ${code}: ${Buffer.concat(err).toString("utf8") || Buffer.concat(out).toString("utf8")}`));
    });
    child.stdin.end(input);
  });
}
