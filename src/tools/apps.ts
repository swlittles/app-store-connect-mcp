import { z } from "zod";
import type { Resource } from "../asc/client.js";
import { Included } from "../asc/jsonapi.js";
import type {
  AppAttributes,
  AppStoreVersionAttributes,
  BuildAttributes,
  BuildUploadAttributes,
  ReviewSubmissionAttributes,
} from "../asc/types.js";
import { when } from "./format.js";
import { defineTool, UserError, type ToolContext } from "./framework.js";
import { appInput, buildSummary, resolveApp, versionState, type BuildInfo } from "./lookup.js";

export const listApps = defineTool({
  name: "list_apps",
  title: "List apps",
  description: "Lists the apps this API key can see, with their IDs, bundle IDs and SKUs. Start here to find an app ID.",
  kind: "read",
  input: {
    name: z.string().optional().describe("Only apps whose name contains this text."),
  },
  async run({ name }, ctx) {
    const { data } = await ctx.asc.getAll<AppAttributes>("/v1/apps", {
      "fields[apps]": "name,bundleId,sku,primaryLocale",
      "filter[name]": name,
      sort: "name",
    });
    if (!data.length) return name ? `No apps match "${name}".` : "This API key can't see any apps.";
    return [
      `${data.length} app${data.length === 1 ? "" : "s"}:`,
      ...data.map((a) => `- ${a.attributes?.name} · id ${a.id} · ${a.attributes?.bundleId} · sku ${a.attributes?.sku} · ${a.attributes?.primaryLocale}`),
    ].join("\n");
  },
});

export const getAppStatus = defineTool({
  name: "get_app_status",
  title: "Get app status",
  description:
    "One-call overview of an app: App Store versions and their states, the build attached to each, the latest builds and their TestFlight states, uploads still processing, and open review submissions.",
  kind: "read",
  input: { app: appInput },
  async run({ app }, ctx) {
    const ref = await resolveApp(ctx, app);
    const [versions, builds, uploads, submissions] = await Promise.all([
      listVersionsWithBuilds(ctx, ref.id),
      ctx.asc.get<Resource<BuildAttributes>[]>("/v1/builds", {
        "filter[app]": ref.id,
        sort: "-uploadedDate",
        limit: 5,
        include: "buildBetaDetail,preReleaseVersion",
      }),
      ctx.asc
        .get<Resource<BuildUploadAttributes>[]>(`/v1/apps/${ref.id}/buildUploads`, { sort: "-uploadedDate", limit: 5 })
        .catch(() => undefined),
      ctx.asc.get<Resource<ReviewSubmissionAttributes>[]>("/v1/reviewSubmissions", {
        "filter[app]": ref.id,
        limit: 5,
      }),
    ]);

    const out = [`${ref.name} · id ${ref.id} · ${ref.bundleId} · primary locale ${ref.primaryLocale}`, "", "App Store versions:"];
    out.push(...(versions.length ? versions : ["- none"]));

    out.push("", "Latest builds:");
    const included = new Included(builds.included);
    if (!builds.data.length) out.push("- none");
    for (const b of builds.data) {
      const info: BuildInfo = {
        build: b,
        detail: included.one(b, "buildBetaDetail", "buildBetaDetails"),
        preRelease: included.one(b, "preReleaseVersion", "preReleaseVersions"),
      };
      out.push(`- ${buildSummary(info)}`);
    }

    const pending = (uploads?.data ?? []).filter((u) => u.attributes?.state?.state && u.attributes.state.state !== "COMPLETE");
    if (pending.length) {
      out.push("", "Uploads Apple is still processing:");
      for (const u of pending) {
        const s = u.attributes?.state;
        const errors = (s?.errors ?? []).map((e) => `${e.code}: ${e.description ?? ""}`).join("; ");
        out.push(`- ${u.attributes?.cfBundleShortVersionString} (${u.attributes?.cfBundleVersion}) · ${s?.state}${errors ? ` · ${errors}` : ""} · upload id ${u.id}`);
      }
    }

    const open = submissions.data.filter((s) => s.attributes?.state !== "COMPLETE");
    out.push("", "Review submissions:");
    if (!submissions.data.length) out.push("- none");
    for (const s of open.length ? open : submissions.data.slice(0, 2)) {
      out.push(`- ${s.attributes?.platform} · ${s.attributes?.state} · submitted ${when(s.attributes?.submittedDate)} · id ${s.id}`);
    }
    return out.join("\n");
  },
});

const CURRENT_VERSION_STATES = [
  "ACCEPTED",
  "DEVELOPER_REJECTED",
  "IN_REVIEW",
  "INVALID_BINARY",
  "METADATA_REJECTED",
  "PENDING_APPLE_RELEASE",
  "PENDING_DEVELOPER_RELEASE",
  "PREPARE_FOR_SUBMISSION",
  "PROCESSING_FOR_DISTRIBUTION",
  "READY_FOR_DISTRIBUTION",
  "READY_FOR_REVIEW",
  "REJECTED",
  "WAITING_FOR_EXPORT_COMPLIANCE",
  "WAITING_FOR_REVIEW",
] as const satisfies readonly NonNullable<AppStoreVersionAttributes["appVersionState"]>[];

async function listVersionsWithBuilds(ctx: ToolContext, appId: string): Promise<string[]> {
  // Every state except superseded versions, so the current ones show however long the history is.
  const doc = await ctx.asc.get<Resource<AppStoreVersionAttributes>[]>(`/v1/apps/${appId}/appStoreVersions`, {
    "filter[appVersionState]": CURRENT_VERSION_STATES.join(","),
    include: "build",
    "fields[builds]": "version,processingState",
    limit: 8,
  });
  const included = new Included(doc.included);
  const sorted = [...doc.data].sort((a, b) => (b.attributes?.createdDate ?? "").localeCompare(a.attributes?.createdDate ?? ""));
  return sorted.map((v) => {
    const build = included.one<BuildAttributes>(v, "build", "builds");
    return `- ${v.attributes?.platform} ${v.attributes?.versionString} · ${versionState(v)} · ${
      build ? `build ${build.attributes?.version} (${build.attributes?.processingState})` : "no build attached"
    } · release ${v.attributes?.releaseType ?? "?"} · id ${v.id}`;
  });
}

const MAX_RAW_OUTPUT = 20_000;

export const ascRequest = defineTool({
  name: "asc_request",
  title: "Raw App Store Connect request",
  description:
    "Escape hatch for anything the workflow tools don't cover: calls the App Store Connect API directly and returns the JSON. " +
    "path is relative to https://api.appstoreconnect.apple.com, e.g. /v1/apps/123/appInfos. GET works in read-only mode; POST, PATCH and DELETE need ASC_WRITE=1, and DELETE also needs confirm: true. " +
    "Prefer the workflow tools: they check state, retry safely and wait for Apple's processing.",
  kind: "read", // Gated per method below, so GETs work without ASC_WRITE.
  gatesOwnWrites: true,
  idempotent: false,
  input: {
    method: z.enum(["GET", "POST", "PATCH", "DELETE"]).default("GET"),
    path: z.string().describe("API path, e.g. /v1/apps or /v1/builds/{id}. Must start with /v1/, /v2/ or /v3/."),
    query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe('Query parameters, e.g. {"filter[app]": "123", "limit": 50}.'),
    body: z.unknown().optional().describe("JSON:API request body for POST and PATCH."),
    confirm: z.boolean().optional().describe("Must be true for DELETE."),
    all_pages: z.boolean().optional().describe("For GET collections: follow links.next and return every page (at most 2,000 items)."),
  },
  async run({ method, path, query, body, confirm, all_pages }, ctx) {
    if (!/^\/v[1-3]\//.test(path)) throw new UserError("path must start with /v1/, /v2/ or /v3/ (no host).");
    if (method !== "GET" && !ctx.config.write) {
      throw new UserError(`${method} changes App Store Connect, and this server is read-only. Ask the user to restart it with ASC_WRITE=1.`);
    }
    if (method === "DELETE" && confirm !== true) {
      throw new UserError(`DELETE ${path} needs confirm: true. Make sure the user wants this deleted first; it can't be undone.`);
    }
    let result: unknown;
    if (method === "GET" && all_pages) {
      result = await ctx.asc.getAll(path, query, { max: 2000, signal: ctx.signal });
    } else {
      result = await ctx.asc.json(method, path, { query, body, signal: ctx.signal });
    }
    if (result === undefined) return `${method} ${path}: done (no content).`;
    const text = JSON.stringify(result, null, 1);
    return text.length > MAX_RAW_OUTPUT
      ? `${text.slice(0, MAX_RAW_OUTPUT)}\n… truncated (${text.length} characters). Narrow it with fields[type]=, limit or filters.`
      : text;
  },
});
