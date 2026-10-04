import { z } from "zod";
import { AscApiError, type Resource } from "../asc/client.js";
import { Included } from "../asc/jsonapi.js";
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
  } else if (/^\d+$/.test(wanted)) {
    try {
      const doc = await ctx.asc.get<Resource<AppAttributes>>(`/v1/apps/${wanted}`, { "fields[apps]": APP_FIELDS });
      ref = toAppRef(doc.data);
    } catch (error) {
      if (error instanceof AscApiError && error.status === 404) throw new UserError(`No app with ID ${wanted} is visible to this API key.`);
      throw error;
    }
  } else {
    const byBundle = await ctx.asc.get<Resource<AppAttributes>[]>("/v1/apps", { "filter[bundleId]": wanted, "fields[apps]": APP_FIELDS });
    const exactBundle = byBundle.data.find((a) => a.attributes?.bundleId === wanted);
    if (exactBundle) ref = toAppRef(exactBundle);
    else {
      const byName = await ctx.asc.get<Resource<AppAttributes>[]>("/v1/apps", { "filter[name]": wanted, "fields[apps]": APP_FIELDS });
      const exact = byName.data.filter((a) => a.attributes?.name?.toLowerCase() === wanted.toLowerCase());
      const matches = exact.length ? exact : byName.data;
      if (matches.length === 1) ref = toAppRef(matches[0]!);
      else if (matches.length === 0) throw new UserError(`No app matches "${wanted}". Call list_apps to see the apps this key can access.`);
      else throw new UserError(`"${wanted}" matches several apps: ${matches.map((a) => `${a.attributes?.name} (id ${a.id})`).join(", ")}. Pass the app ID.`);
    }
  }
  appCache.set(key, ref);
  return ref;
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

export async function getBuildById(ctx: ToolContext, id: string): Promise<BuildInfo> {
  const doc = await ctx.asc.get<Resource<BuildAttributes>>(`/v1/builds/${id}`, { include: BUILD_INCLUDE });
  return toBuildInfo(doc.data, new Included(doc.included));
}

/**
 * Finds a build by number, ID or "latest". Returns undefined if Apple doesn't know the build yet
 * (it may still be in the upload pipeline; see describeMissingBuild).
 */
export async function findBuild(
  ctx: ToolContext,
  appId: string,
  build: string | undefined,
  platform?: Platform,
): Promise<BuildInfo | undefined> {
  const wanted = build?.trim() || "latest";
  if (isResourceId(wanted)) {
    try {
      return await getBuildById(ctx, wanted);
    } catch (error) {
      if (error instanceof AscApiError && error.status === 404) return undefined;
      throw error;
    }
  }
  const query: Record<string, string | number> = {
    "filter[app]": appId,
    include: BUILD_INCLUDE,
    sort: "-uploadedDate",
    limit: 5,
  };
  if (wanted !== "latest") query["filter[version]"] = wanted;
  if (platform) query["filter[preReleaseVersion.platform]"] = platform;
  const doc = await ctx.asc.get<Resource<BuildAttributes>[]>("/v1/builds", query);
  const first = doc.data[0];
  return first ? toBuildInfo(first, new Included(doc.included)) : undefined;
}

export async function requireBuild(ctx: ToolContext, appId: string, build: string | undefined, platform?: Platform): Promise<BuildInfo> {
  const found = await findBuild(ctx, appId, build, platform);
  if (found) return found;
  throw new UserError(await describeMissingBuild(ctx, appId, build));
}

/** Explains why a build isn't there yet, using the build upload pipeline's state if it can. */
export async function describeMissingBuild(ctx: ToolContext, appId: string, build: string | undefined): Promise<string> {
  if (!build || build === "latest") return "This app has no builds yet. Upload one with upload_build (or Xcode/Transporter).";
  if (!isResourceId(build)) {
    try {
      const uploads = await ctx.asc.get<Resource<BuildUploadAttributes>[]>(`/v1/apps/${appId}/buildUploads`, {
        "filter[cfBundleVersion]": build,
        limit: 1,
      });
      const upload = uploads.data[0];
      if (upload) {
        const state = upload.attributes?.state;
        const errors = (state?.errors ?? []).map((e) => `${e.code ?? "?"}: ${e.description ?? ""}`.trim());
        if (state?.state === "FAILED") return `Build ${build} failed Apple's upload processing: ${errors.join("; ") || "no detail given"}.`;
        return `Build ${build} was uploaded ${when(upload.attributes?.uploadedDate ?? upload.attributes?.createdDate)} and Apple is still processing it (upload state ${state?.state ?? "?"}). Try again in a few minutes, or call get_build with wait_minutes.`;
      }
    } catch {
      // The upload lookup is a nicety; fall through to the generic message.
    }
  }
  return `No build ${build} found. If it was uploaded in the last few minutes, Apple may not have registered it yet; call get_build with wait_minutes to wait.`;
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

/** Version states in which metadata, screenshots and the build can still be changed. */
export const EDITABLE_VERSION_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
]);
const LIVE_STATES = new Set(["READY_FOR_DISTRIBUTION", "READY_FOR_SALE", "ACCEPTED"]);

export const versionInput = z
  .string()
  .optional()
  .describe('App Store version string (e.g. "1.2"), "editable" (the version being prepared; the default) or "live".');

export function versionState(v: Resource<AppStoreVersionAttributes>): string {
  return v.attributes?.appVersionState ?? v.attributes?.appStoreState ?? "?";
}

export async function listVersions(ctx: ToolContext, appId: string, platform: Platform = "IOS") {
  const { data } = await ctx.asc.getAll<AppStoreVersionAttributes>(
    `/v1/apps/${appId}/appStoreVersions`,
    { "filter[platform]": platform, limit: 50 },
    { max: 50 },
  );
  return data.sort((a, b) => (b.attributes?.createdDate ?? "").localeCompare(a.attributes?.createdDate ?? ""));
}

export async function resolveVersion(
  ctx: ToolContext,
  appId: string,
  options: { version?: string; platform?: Platform; editable?: boolean },
): Promise<Resource<AppStoreVersionAttributes>> {
  const versions = await listVersions(ctx, appId, options.platform);
  const wanted = options.version?.trim() || "editable";
  const describeAll = () =>
    versions.length ? versions.slice(0, 6).map((v) => `${v.attributes?.versionString} (${versionState(v)})`).join(", ") : "none";

  let found: Resource<AppStoreVersionAttributes> | undefined;
  if (wanted === "editable") found = versions.find((v) => EDITABLE_VERSION_STATES.has(versionState(v)));
  else if (wanted === "live") found = versions.find((v) => LIVE_STATES.has(versionState(v)));
  else found = versions.find((v) => v.attributes?.versionString === wanted);

  if (!found) {
    if (wanted === "editable") {
      throw new UserError(`No version is being prepared for ${options.platform ?? "IOS"} (versions: ${describeAll()}). Create one with prepare_version.`);
    }
    throw new UserError(`No ${wanted === "live" ? "live" : `"${wanted}"`} version for ${options.platform ?? "IOS"}. Versions: ${describeAll()}.`);
  }
  if (options.editable && !EDITABLE_VERSION_STATES.has(versionState(found))) {
    throw new UserError(
      `Version ${found.attributes?.versionString} is ${versionState(found)}, so it can't be edited. ` +
        "Only versions in PREPARE_FOR_SUBMISSION (or rejected) can change; create a new version with prepare_version.",
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
