import { z } from "zod";
import { AscApiError, type Resource } from "../asc/client.js";
import { Included, linkage, relId } from "../asc/jsonapi.js";
import type {
  AppInfoAttributes,
  AppInfoLocalizationAttributes,
  AppScreenshotSetAttributes,
  AppStoreReviewDetailAttributes,
  AppStoreVersionAttributes,
  BuildAttributes,
  Platform,
  ReviewSubmissionAttributes,
  ReviewSubmissionItemAttributes,
} from "../asc/types.js";
import { STEP_LEGEND, StepLog, when } from "./format.js";
import { defineTool, UserError, type ToolContext } from "./framework.js";
import {
  appInput,
  EDITABLE_VERSION_STATES,
  queryVersions,
  platformInput,
  requireBuild,
  resolveApp,
  resolveVersion,
  versionInput,
  versionLocalizations,
  versionState,
} from "./lookup.js";

export const prepareVersion = defineTool({
  name: "prepare_version",
  title: "Prepare an App Store version",
  description:
    "Makes sure an App Store version with this version string is being prepared: reuses it if it exists, renames the version currently being prepared, or creates a new one " +
    "(Apple copies the metadata from the previous version). Optionally attaches a build and sets the release type.",
  kind: "write",
  input: {
    app: appInput,
    version_string: z.string().regex(/^\d+(\.\d+){0,2}$/, "Use a version like 1.2 or 1.2.3"),
    platform: platformInput,
    build: z.string().optional().describe('Build to attach: number, ID or "latest". Must be processed (VALID).'),
    release_type: z.enum(["MANUAL", "AFTER_APPROVAL", "SCHEDULED"]).optional(),
    earliest_release_date: z.string().datetime().optional().describe("For SCHEDULED: ISO 8601 date-time."),
  },
  async run(args, ctx) {
    const ref = await resolveApp(ctx, args.app);
    const platform: Platform = args.platform ?? "IOS";
    const log = new StepLog();
    let version = (await queryVersions(ctx, ref.id, platform, { versionString: args.version_string }))[0];
    const editable = (await queryVersions(ctx, ref.id, platform, { states: [...EDITABLE_VERSION_STATES] }))[0];

    if (version) {
      if (!EDITABLE_VERSION_STATES.has(versionState(version))) {
        throw new UserError(`Version ${args.version_string} already exists and is ${versionState(version)}. Use a higher version string.`);
      }
      log.skip(`Version ${args.version_string} is already being prepared (id ${version.id})`);
    } else if (editable) {
      if (!ctx.dryRun) {
        await ctx.asc.patch(`/v1/appStoreVersions/${editable.id}`, {
          data: { type: "appStoreVersions", id: editable.id, attributes: { versionString: args.version_string } },
        });
      }
      log.step(ctx.dryRun, `Rename the version being prepared from ${editable.attributes?.versionString} to ${args.version_string}`);
      version = { ...editable, attributes: { ...editable.attributes, versionString: args.version_string } };
    } else {
      if (ctx.dryRun) log.plan(`Create version ${args.version_string} (${platform})`);
      else {
        try {
          const created = await ctx.asc.post<Resource<AppStoreVersionAttributes>>("/v1/appStoreVersions", {
            data: {
              type: "appStoreVersions",
              attributes: { platform, versionString: args.version_string },
              relationships: { app: linkage("apps", ref.id) },
            },
          });
          version = created!.data;
          log.done(`Created version ${args.version_string} (id ${version.id})`);
        } catch (error) {
          // A lost response from an earlier attempt: the version exists now.
          const again = (await queryVersions(ctx, ref.id, platform, { versionString: args.version_string }))[0];
          if (!(error instanceof AscApiError) || !again) throw error;
          version = again;
          log.skip(`Version ${args.version_string} already exists (id ${version.id})`);
        }
      }
    }

    if (args.release_type || args.earliest_release_date) {
      const attributes: Record<string, string> = {};
      if (args.release_type && version?.attributes?.releaseType !== args.release_type) attributes.releaseType = args.release_type;
      if (args.earliest_release_date) attributes.earliestReleaseDate = args.earliest_release_date;
      if (Object.keys(attributes).length) {
        if (!ctx.dryRun && version) await ctx.asc.patch(`/v1/appStoreVersions/${version.id}`, { data: { type: "appStoreVersions", id: version.id, attributes } });
        log.step(ctx.dryRun, `Release: ${Object.entries(attributes).map(([k, v]) => `${k} ${v}`).join(", ")}`);
      } else log.skip(`Release type already ${args.release_type}`);
    }

    if (args.build) {
      const info = await requireBuild(ctx, ref.id, { build: args.build, platform });
      const b = info.build.attributes;
      if (b?.processingState !== "VALID") throw new UserError(`${log.toString()}\nBuild ${b?.version} is ${b?.processingState}; only processed (VALID) builds can be attached.`);
      const buildVersion = info.preRelease?.attributes?.version;
      if (buildVersion && buildVersion !== args.version_string) {
        log.warn(`Build ${b?.version} is version ${buildVersion}, not ${args.version_string}; Apple will refuse it. Upload a build with CFBundleShortVersionString ${args.version_string}.`);
      }
      const attached = version ? await ctx.asc.get<Resource | null>(`/v1/appStoreVersions/${version.id}/relationships/build`).catch(() => ({ data: null })) : { data: null };
      if (attached.data?.id === info.build.id) log.skip(`Build ${b?.version} is already attached`);
      else {
        if (!ctx.dryRun && version) {
          await ctx.asc.patch(`/v1/appStoreVersions/${version.id}/relationships/build`, linkage("builds", info.build.id));
        }
        log.step(ctx.dryRun, `Attach build ${b?.version} (id ${info.build.id})`);
      }
    }
    return [`${ref.name} ${platform}`, STEP_LEGEND, log.toString(), "Next: update_listing, upload_screenshots, set_review_details, then submit_for_review."].join("\n");
  },
});

// ---------------------------------------------------------------------------------------------

const OPEN_SUBMISSION_STATES = new Set(["READY_FOR_REVIEW", "UNRESOLVED_ISSUES"]);
const ACTIVE_SUBMISSION_STATES = new Set(["WAITING_FOR_REVIEW", "IN_REVIEW"]);

/** Checks the things App Review rejects submissions for that the API can see. */
async function preflight(ctx: ToolContext, appId: string, primaryLocale: string, version: Resource<AppStoreVersionAttributes>): Promise<string[]> {
  const problems: string[] = [];
  const build = await ctx.asc.get<Resource<BuildAttributes> | null>(`/v1/appStoreVersions/${version.id}/build`).catch(() => ({ data: null }));
  if (!build.data) problems.push("No build is attached (use prepare_version with build).");
  else if (build.data.attributes?.processingState !== "VALID") problems.push(`The attached build is ${build.data.attributes?.processingState}.`);

  const locs = await versionLocalizations(ctx, version.id);
  if (!locs.length) problems.push("The version has no localizations.");
  for (const l of locs) {
    const a = l.attributes ?? {};
    const missing = [!a.description && "description", !a.keywords && "keywords", !a.supportUrl && "support URL"].filter(Boolean);
    if (missing.length) problems.push(`${a.locale}: missing ${missing.join(", ")}.`);
  }
  const primary = locs.find((l) => l.attributes?.locale === primaryLocale) ?? locs[0];
  if (primary) {
    const sets = await ctx.asc.get<Resource<AppScreenshotSetAttributes>[]>(`/v1/appStoreVersionLocalizations/${primary.id}/appScreenshotSets`, {
      include: "appScreenshots",
      "limit[appScreenshots]": 1,
    });
    const withShots = sets.data.filter((s) => (s.relationships?.appScreenshots?.data as unknown[] | undefined)?.length);
    if (!withShots.length) problems.push(`${primary.attributes?.locale}: no screenshots.`);
  }

  const infos = await ctx.asc.get<Resource<AppInfoAttributes>[]>(`/v1/apps/${appId}/appInfos`, { include: "appInfoLocalizations,primaryCategory" });
  const included = new Included(infos.included);
  const info = infos.data.find((i) => EDITABLE_VERSION_STATES.has(i.attributes?.state ?? i.attributes?.appStoreState ?? "")) ?? infos.data[0];
  if (info) {
    if (!relId(info, "primaryCategory")) problems.push("No primary category.");
    for (const l of included.many<AppInfoLocalizationAttributes>(info, "appInfoLocalizations", "appInfoLocalizations")) {
      if (!l.attributes?.privacyPolicyUrl) problems.push(`${l.attributes?.locale}: no privacy policy URL.`);
    }
  }

  const review = await ctx.asc
    .get<Resource<AppStoreReviewDetailAttributes> | null>(`/v1/appStoreVersions/${version.id}/appStoreReviewDetail`)
    .catch(() => ({ data: null }));
  const r = review.data?.attributes;
  if (!r) problems.push("App Review information isn't filled in (use set_review_details).");
  else {
    const missing = [!r.contactFirstName && "first name", !r.contactLastName && "last name", !r.contactEmail && "email", !r.contactPhone && "phone"].filter(Boolean);
    if (missing.length) problems.push(`App Review contact is missing: ${missing.join(", ")}.`);
    if (r.demoAccountRequired && (!r.demoAccountName || !r.demoAccountPassword)) problems.push("A demo account is required but its user name or password is empty.");
  }
  return problems;
}

export const submitForReview = defineTool({
  name: "submit_for_review",
  title: "Submit for App Review",
  description:
    "Submits the version being prepared to App Review. First checks what the API can see (build attached and processed, descriptions, keywords, support URL, screenshots, privacy policy URL, review contact) and stops if something is missing. " +
    "Then creates or reuses a review submission, adds the version and submits it. Things the API can't check: the App Privacy questionnaire, pricing and availability, agreements and tax forms.",
  kind: "destructive",
  idempotent: true,
  input: {
    app: appInput,
    version: versionInput,
    platform: platformInput,
    skip_checks: z.boolean().default(false).describe("Submit even if the pre-flight checks find problems; Apple will still validate."),
  },
  async run(args, ctx) {
    const ref = await resolveApp(ctx, args.app);
    const platform: Platform = args.platform ?? "IOS";
    const log = new StepLog();

    const submissions = await ctx.asc.get<Resource<ReviewSubmissionAttributes>[]>("/v1/reviewSubmissions", {
      "filter[app]": ref.id,
      "filter[platform]": platform,
      "filter[state]": [...OPEN_SUBMISSION_STATES, ...ACTIVE_SUBMISSION_STATES].join(","),
    });
    const active = submissions.data.find((s) => ACTIVE_SUBMISSION_STATES.has(s.attributes?.state ?? ""));
    if (active) {
      return `Already submitted: review submission ${active.id} is ${active.attributes?.state} (submitted ${when(active.attributes?.submittedDate)}). Nothing to do.`;
    }

    const version = await resolveVersion(ctx, ref.id, { version: args.version, platform, editable: true });
    log.info(`${ref.name} ${version.attributes?.versionString} (${versionState(version)}, id ${version.id})`);

    const problems = await preflight(ctx, ref.id, ref.primaryLocale, version);
    if (problems.length) {
      problems.forEach((p) => log.fail(p));
      if (!args.skip_checks) {
        return [STEP_LEGEND, log.toString(), "Not submitted. Fix these (or pass skip_checks: true if you're sure), then try again."].join("\n");
      }
      log.warn("Submitting anyway (skip_checks)");
    } else {
      log.done("Pre-flight checks passed");
    }
    log.info("Not checkable through the API: App Privacy answers, pricing and availability, agreements, content rights, export compliance documents.");

    let submission = submissions.data.find((s) => OPEN_SUBMISSION_STATES.has(s.attributes?.state ?? ""));
    if (submission) log.skip(`Reusing review submission ${submission.id} (${submission.attributes?.state})`);
    else if (ctx.dryRun) log.plan("Create a review submission");
    else {
      const created = await ctx.asc.post<Resource<ReviewSubmissionAttributes>>("/v1/reviewSubmissions", {
        data: { type: "reviewSubmissions", attributes: { platform }, relationships: { app: linkage("apps", ref.id) } },
      });
      submission = created!.data;
      log.done(`Created review submission ${submission.id}`);
    }

    if (submission) {
      const items = await ctx.asc.get<Resource<ReviewSubmissionItemAttributes>[]>(`/v1/reviewSubmissions/${submission.id}/items`, {
        include: "appStoreVersion",
      });
      const hasVersion = items.data.some((i) => relId(i, "appStoreVersion") === version.id);
      if (hasVersion) log.skip("The version is already in the submission");
      else if (!ctx.dryRun) {
        try {
          await ctx.asc.post("/v1/reviewSubmissionItems", {
            data: {
              type: "reviewSubmissionItems",
              relationships: { reviewSubmission: linkage("reviewSubmissions", submission.id), appStoreVersion: linkage("appStoreVersions", version.id) },
            },
          });
          log.done("Added the version to the submission");
        } catch (error) {
          if (!(error instanceof AscApiError && error.status === 409 && error.mentions("already"))) throw error;
          log.skip("The version is already in the submission");
        }
      } else log.plan("Add the version to the submission");
    } else {
      log.plan("Add the version to the submission");
    }

    if (ctx.dryRun) {
      log.plan("Submit to App Review");
      return [STEP_LEGEND, log.toString()].join("\n");
    }
    const submitted = await ctx.asc.patch<Resource<ReviewSubmissionAttributes>>(`/v1/reviewSubmissions/${submission!.id}`, {
      data: { type: "reviewSubmissions", id: submission!.id, attributes: { submitted: true } },
    });
    log.done(`Submitted to App Review: ${submitted?.data.attributes?.state ?? "WAITING_FOR_REVIEW"}`);
    return [STEP_LEGEND, log.toString(), "Track it with get_app_status."].join("\n");
  },
});

export const cancelReviewSubmission = defineTool({
  name: "cancel_review_submission",
  title: "Cancel App Review submission",
  description: "Withdraws the app's active review submission (waiting for or in review), so the version can be edited again.",
  kind: "destructive",
  input: { app: appInput, platform: platformInput },
  async run(args, ctx) {
    const ref = await resolveApp(ctx, args.app);
    const submissions = await ctx.asc.get<Resource<ReviewSubmissionAttributes>[]>("/v1/reviewSubmissions", {
      "filter[app]": ref.id,
      "filter[platform]": args.platform ?? "IOS",
      "filter[state]": "WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES",
    });
    const s = submissions.data[0];
    if (!s) return `${ref.name} has no review submission to cancel.`;
    if (ctx.dryRun) return `Would cancel review submission ${s.id} (${s.attributes?.state}, submitted ${when(s.attributes?.submittedDate)}).`;
    await ctx.asc.patch(`/v1/reviewSubmissions/${s.id}`, { data: { type: "reviewSubmissions", id: s.id, attributes: { canceled: true } } });
    return `Cancelling review submission ${s.id}. Apple moves it to CANCELING and then back to editable; check with get_app_status.`;
  },
});
