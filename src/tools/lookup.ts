import { z } from "zod";
import { AscApiError, type Resource } from "../asc/client.js";
import { Included, relId } from "../asc/jsonapi.js";
import type {
  AppAttributes,
  AppStoreVersionAttributes,
  AppStoreVersionLocalizationAttributes,
  BetaGroupAttributes,
  BuildAttributes,
  BuildBetaDetailAttributes,
  BuildUploadAttributes,
  Platform,
  PrereleaseVersionAttributes,
} from "../asc/types.js";
import { PLATFORMS } from "../asc/types.js";
import { when } from "./format.js";
import { UserError, type ToolContext } from "./framework.js";

export const appInput = z
  .string()
  .optional()
  .describe("App ID, bundle ID or exact app name. Defaults to ASC_APP_ID, or to the only app the key can see.");

export const platformInput = z.enum(PLATFORMS).optional().describe("Platform. Defaults to IOS.");

export interface AppRef {
  id: string;
  name: string;
  bundleId: string;
  primaryLocale: string;
}

const APP_FIELDS = "name,bundleId,sku,primaryLocale";
const appCache = new Map<string, AppRef>();

function toAppRef(app: Resource<AppAttributes>): AppRef {
  return {
    id: app.id,
    name: app.attributes?.name ?? "?",
    bundleId: app.attributes?.bundleId ?? "?",
    primaryLocale: app.attributes?.primaryLocale ?? "en-US",
  };
}

/** Resolves an app from an ID, bundle ID or name; falls back to ASC_APP_ID or the only app. */
export async function resolveApp(ctx: ToolContext, app?: string): Promise<AppRef> {
  const wanted = app?.trim() || ctx.config.defaultAppId;
  const key = wanted ?? "<only>";
  const cached = appCache.get(key);
  if (cached) return cached;

  let ref: AppRef;
  if (!wanted) {
    const { data } = await ctx.asc.getAll<AppAttributes>("/v1/apps", { "fields[apps]": APP_FIELDS, limit: 50 }, { max: 50 });
    if (data.length === 1) ref = toAppRef(data[0]!);
    else if (data.length === 0) throw new UserError("This API key can't see any apps.");
    else {
      throw new UserError(
        `Which app? Pass app (or set ASC_APP_ID). This key can see:\n${data.map((a) => `- ${a.attributes?.name} (id ${a.id}, ${a.attributes?.bundleId})`).join("\n")}`,
      );
    }
  } else {
    ref = (/^\d+$/.test(wanted) && (await appById(ctx, wanted))) || (await appByBundleOrName(ctx, wanted));
  }
  appCache.set(key, ref);
  return ref;
}

/** Undefined when there's no such app, so an all-digit name (an app called "2048") can still match by name. */
async function appById(ctx: ToolContext, id: string): Promise<AppRef | undefined> {
  try {
    return toAppRef((await ctx.asc.get<Resource<AppAttributes>>(`/v1/apps/${id}`, { "fields[apps]": APP_FIELDS })).data);
  } catch (error) {
    if (error instanceof AscApiError && error.status === 404) return undefined;
    throw error;
  }
}

async function appByBundleOrName(ctx: ToolContext, wanted: string): Promise<AppRef> {
  const byBundle = await ctx.asc.get<Resource<AppAttributes>[]>("/v1/apps", { "filter[bundleId]": wanted, "fields[apps]": APP_FIELDS });
  const exactBundle = byBundle.data.find((a) => a.attributes?.bundleId === wanted);
  if (exactBundle) return toAppRef(exactBundle);
  const byName = await ctx.asc.get<Resource<AppAttributes>[]>("/v1/apps", { "filter[name]": wanted, "fields[apps]": APP_FIELDS });
  const exact = byName.data.filter((a) => a.attributes?.name?.toLowerCase() === wanted.toLowerCase());
  const matches = exact.length ? exact : byName.data;
  if (matches.length === 1) return toAppRef(matches[0]!);
  if (matches.length === 0) throw new UserError(`No app matches "${wanted}". Call list_apps to see the apps this key can access.`);
  throw new UserError(`"${wanted}" matches several apps: ${matches.map((a) => `${a.attributes?.name} (id ${a.id})`).join(", ")}. Pass the app ID.`);
}

/** For tests. */
export function clearLookupCache(): void {
  appCache.clear();
}

// ---------------------------------------------------------------------------------------------
// Builds

export interface BuildInfo {
  build: Resource<BuildAttributes>;
  detail?: Resource<BuildBetaDetailAttributes>;
  preRelease?: Resource<PrereleaseVersionAttributes>;
}

export const buildInput = z
  .string()
  .optional()
  .describe('Build number (CFBundleVersion, e.g. "202610010021"), build resource ID, or "latest" (the default).');

export const buildVersionInput = z
  .string()
  .optional()
  .describe('Marketing version (CFBundleShortVersionString, e.g. "1.2"). Needed only if build numbers repeat across versions.');

/** Which build: a number, ID or "latest", optionally narrowed by platform and marketing version. */
export interface BuildQuery {
  build?: string;
  platform?: Platform;
  version?: string;
}

const BUILD_INCLUDE = "buildBetaDetail,preReleaseVersion";

function toBuildInfo(build: Resource<BuildAttributes>, included: Included): BuildInfo {
  return {
    build,
    detail: included.one<BuildBetaDetailAttributes>(build, "buildBetaDetail", "buildBetaDetails"),
    preRelease: included.one<PrereleaseVersionAttributes>(build, "preReleaseVersion", "preReleaseVersions"),
  };
}

export function isResourceId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Finds a build by number, ID or "latest". Returns undefined if Apple doesn't know the build yet
 * (it may still be in the upload pipeline; see describeMissingBuild).
 */
export async function findBuild(ctx: ToolContext, appId: string, q: BuildQuery): Promise<BuildInfo | undefined> {
  const wanted = q.build?.trim() || "latest";
  if (isResourceId(wanted)) {
    try {
      const doc = await ctx.asc.get<Resource<BuildAttributes>>(`/v1/builds/${wanted}`, { include: `${BUILD_INCLUDE},app`, "fields[apps]": "bundleId" });
      const owner = relId(doc.data, "app");
      if (owner && owner !== appId) throw new UserError(`Build ${wanted} belongs to a different app (id ${owner}). Pass that app, or a build of this one.`);
      return toBuildInfo(doc.data, new Included(doc.included));
    } catch (error) {
      if (error instanceof AscApiError && error.status === 404) return undefined;
      throw error;
    }
  }
  const query: Record<string, string | number> = {
    "filter[app]": appId,
    include: BUILD_INCLUDE,
    sort: "-uploadedDate",
    limit: q.platform ? 5 : 20,
  };
  if (wanted !== "latest") query["filter[version]"] = wanted;
  if (q.platform) query["filter[preReleaseVersion.platform]"] = q.platform;
  if (q.version) query["filter[preReleaseVersion.version]"] = q.version;
  const doc = await ctx.asc.get<Resource<BuildAttributes>[]>("/v1/builds", query);
  const builds = doc.data.map((b) => toBuildInfo(b, new Included(doc.included)));
  // Without a platform, prefer iOS: Mac builds often share the iOS build number or are newer. Apps
  // with no iOS builds still get their newest build.
  return q.platform ? builds[0] : (builds.find((b) => (b.preRelease?.attributes?.platform ?? "IOS") === "IOS") ?? builds[0]);
}

export async function requireBuild(ctx: ToolContext, appId: string, q: BuildQuery): Promise<BuildInfo> {
  const found = await findBuild(ctx, appId, q);
  if (found) return found;
  throw new UserError(await describeMissingBuild(ctx, appId, q));
}

/** Explains why a build isn't there yet, using the build upload pipeline's state if it can. */
export async function describeMissingBuild(ctx: ToolContext, appId: string, q: BuildQuery): Promise<string> {
  const build = q.build;
  const filters = [q.version && `version ${q.version}`, q.platform && q.platform].filter(Boolean).join(", ");
  if (!build || build === "latest") {
    return filters
      ? `This app has no builds matching ${filters}. Check the version and platform, or upload one with upload_build.`
      : "This app has no builds yet. Upload one with upload_build (or Xcode/Transporter).";
  }
  if (!isResourceId(build)) {
    try {
      const uploads = await ctx.asc.get<Resource<BuildUploadAttributes>[]>(`/v1/apps/${appId}/buildUploads`, {
        "filter[cfBundleVersion]": build,
        "filter[cfBundleShortVersionString]": q.version,
        sort: "-uploadedDate",
        limit: 1,
      });
      const upload = uploads.data[0];
      if (upload) {
        const state = upload.attributes?.state;
        const errors = (state?.errors ?? []).map((e) => `${e.code ?? "?"}: ${e.description ?? ""}`.trim());
        if (state?.state === "FAILED") return `Build ${build} failed Apple's upload processing: ${errors.join("; ") || "no detail given"}.`;
        if (state?.state === "AWAITING_UPLOAD") {
          return `Build ${build} was registered ${when(upload.attributes?.createdDate)}, but no file has arrived yet. Xcode registers builds when it exports them, so it may never have been uploaded. Upload it with upload_build, or wait if an upload is running.`;
        }
        return `Build ${build} was uploaded ${when(upload.attributes?.uploadedDate ?? upload.attributes?.createdDate)} and Apple is still processing it (upload state ${state?.state ?? "?"}). Try again in a few minutes, or call get_build with wait_minutes.`;
      }
    } catch {
      // The upload lookup is a nicety; fall through to the generic message.
    }
  }
  return `No build ${build}${filters ? ` (${filters})` : ""} found. If it was uploaded in the last few minutes, Apple may not have registered it yet; call get_build with wait_minutes to wait.`;
}

export function buildSummary(info: BuildInfo): string {
  const a = info.build.attributes ?? {};
  const d = info.detail?.attributes;
  const version = info.preRelease?.attributes?.version;
  const parts = [
    `build ${a.version ?? "?"}${version ? ` (v${version}${info.preRelease?.attributes?.platform && info.preRelease.attributes.platform !== "IOS" ? ` ${info.preRelease.attributes.platform}` : ""})` : ""}`,
    `id ${info.build.id}`,
    a.processingState ?? "?",
    `uploaded ${when(a.uploadedDate)}`,
  ];
  if (d) parts.push(`internal ${d.internalBuildState ?? "?"}`, `external ${d.externalBuildState ?? "?"}`);
  if (a.expired) parts.push("EXPIRED");
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------------------------
// App Store versions

/**
 * Version states in which metadata, screenshots and the build can still be changed.
 * READY_FOR_REVIEW is a version in a draft review submission that hasn't been sent yet.
 */
export const EDITABLE_VERSION_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "READY_FOR_REVIEW",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
]);
const LIVE_STATES = new Set(["READY_FOR_DISTRIBUTION"]);

export const versionInput = z
  .string()
  .optional()
  .describe('App Store version string (e.g. "1.2"), "editable" (the version being prepared; the default) or "live".');

export function versionState(v: Resource<AppStoreVersionAttributes>): string {
  return v.attributes?.appVersionState ?? v.attributes?.appStoreState ?? "?";
}

/** Queries versions with server-side filters, so apps with long histories still find the right one. */
export async function queryVersions(
  ctx: ToolContext,
  appId: string,
  platform: Platform = "IOS",
  filter: { versionString?: string; states?: readonly string[] } = {},
) {
  const { data } = await ctx.asc.getAll<AppStoreVersionAttributes>(
    `/v1/apps/${appId}/appStoreVersions`,
    {
      "filter[platform]": platform,
      "filter[versionString]": filter.versionString,
      "filter[appVersionState]": filter.states?.join(","),
      limit: 50,
    },
    { max: 50 },
  );
  return data.sort((a, b) => (b.attributes?.createdDate ?? "").localeCompare(a.attributes?.createdDate ?? ""));
}

export async function resolveVersion(
  ctx: ToolContext,
  appId: string,
  options: { version?: string; platform?: Platform; editable?: boolean },
): Promise<Resource<AppStoreVersionAttributes>> {
  const platform = options.platform ?? "IOS";
  const wanted = options.version?.trim() || "editable";
  const filter =
    wanted === "editable"
      ? { states: [...EDITABLE_VERSION_STATES] }
      : wanted === "live"
        ? { states: [...LIVE_STATES] }
        : { versionString: wanted };
  const found = (await queryVersions(ctx, appId, platform, filter))[0];

  if (!found) {
    const recent = (await queryVersions(ctx, appId, platform)).slice(0, 6);
    const describeAll = recent.length ? recent.map((v) => `${v.attributes?.versionString} (${versionState(v)})`).join(", ") : "none";
    if (wanted === "editable") {
      throw new UserError(`No version is being prepared for ${platform} (recent versions: ${describeAll}). Create one with prepare_version.`);
    }
    throw new UserError(`No ${wanted === "live" ? "live" : `"${wanted}"`} version for ${platform}. Recent versions: ${describeAll}.`);
  }
  if (options.editable && !EDITABLE_VERSION_STATES.has(versionState(found))) {
    throw new UserError(
      `Version ${found.attributes?.versionString} is ${versionState(found)}, so it can't be edited. ` +
        "Only versions in PREPARE_FOR_SUBMISSION, READY_FOR_REVIEW (not yet submitted) or rejected can change; create a new version with prepare_version.",
    );
  }
  return found;
}

export async function versionLocalizations(ctx: ToolContext, versionId: string) {
  const { data } = await ctx.asc.getAll<AppStoreVersionLocalizationAttributes>(
    `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
  );
  return data;
}

export async function requireLocalization(ctx: ToolContext, versionId: string, locale: string) {
  const all = await versionLocalizations(ctx, versionId);
  const found = all.find((l) => l.attributes?.locale === locale);
  if (!found) {
    throw new UserError(
      `This version has no ${locale} localization (it has: ${all.map((l) => l.attributes?.locale).join(", ") || "none"}). Add it with update_listing first.`,
    );
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Beta groups

export async function listGroups(ctx: ToolContext, appId: string) {
  const { data } = await ctx.asc.getAll<BetaGroupAttributes>("/v1/betaGroups", { "filter[app]": appId });
  return data;
}

/** Resolves group names (case-insensitive) or IDs to groups; lists the options when one is unknown. */
export async function resolveGroups(ctx: ToolContext, appId: string, wanted: readonly string[]) {
  const groups = await listGroups(ctx, appId);
  const unknown: string[] = [];
  const found = wanted.map((w) => {
    const g =
      groups.find((x) => x.id === w) ?? groups.find((x) => x.attributes?.name?.toLowerCase() === w.trim().toLowerCase());
    if (!g) unknown.push(w);
    return g;
  });
  if (unknown.length) {
    throw new UserError(
      `Unknown beta group${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. This app's groups: ${
        groups.map((g) => `"${g.attributes?.name}" (${g.attributes?.isInternalGroup ? "internal" : "external"})`).join(", ") || "none"
      }. Create one with create_beta_group.`,
    );
  }
  return found as Resource<BetaGroupAttributes>[];
}
