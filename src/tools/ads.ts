// Read-only Apple Ads Platform API tools for keyword research. The /query endpoints are POSTs, but
// they only read, so these are read tools and ASC_WRITE doesn't gate them.
import { z } from "zod";
import { AdsApiError, type AclsResponse } from "../ads/client.js";
import type { AppInfoLocalizationAttributes } from "../asc/types.js";
import { plural } from "./format.js";
import { defineTool, UserError, type ToolContext } from "./framework.js";
import { resolveAppInfo } from "./listing.js";
import { appInput, resolveApp, resolveVersion, versionLocalizations } from "./lookup.js";

/** How many phrases go into one IN filter. Apple doesn't document a maximum. */
const PHRASES_PER_REQUEST = 100;

interface QueryResponse<T> {
  result?: T;
  pagination?: { offset?: number; pageSize?: number; totalCount?: number };
}
interface PhraseSuggestion {
  phrase: string;
  popularity?: number;
}
interface KeywordSuggestion {
  text: string;
  popularity?: number;
}
interface SearchTermRow {
  week?: string;
  month?: string;
  countryOrRegion?: string;
  genre?: string;
  searchTerm?: string;
  rankInGenre?: number;
  searchPopularityInGenre?: number;
  searchPopularity1to100?: number;
  searchPopularity1to5?: number;
}

// ---------------------------------------------------------------------------------------------

export const adsStatus = defineTool({
  name: "ads_status",
  title: "Apple Ads status",
  description:
    "Checks the Apple Ads connection: the API user and org, the ad accounts it can access with its roles, and the status of the ad account the keyword tools use. Run this first when setting up Apple Ads.",
  kind: "read",
  requires: "ads",
  input: {},
  async run(_args, ctx) {
    const me = await ctx.ads.getUnscoped<{ result?: { userId?: number; orgId?: number } }>("/me");
    const acls = await ctx.ads.getUnscoped<AclsResponse>("/acls");
    const orgId = me.result?.orgId;
    const org = orgId
      ? await ctx.ads.getUnscoped<{ result?: { name?: string; currency?: string; systemStatus?: string } }>(`/orgs/${orgId}`).catch(() => undefined)
      : undefined;
    const out = [
      `Apple Ads user ${me.result?.userId ?? "?"} in org ${org?.result?.name ? `"${org.result.name}" ` : ""}(${orgId ?? "?"})${org?.result?.systemStatus ? ` · ${org.result.systemStatus}` : ""}`,
    ];
    const accounts = acls.result?.acls ?? [];
    out.push("", `Ad accounts (${accounts.length}):`);
    for (const a of accounts) out.push(`- ${a.adAccount.name ?? "?"} · id ${a.adAccount.id} · roles: ${(a.roles ?? []).join(", ") || "none"}`);
    if (!accounts.length) out.push("- none. The keyword tools need an ad account; create one in Apple Ads or ask the admin for access.");

    try {
      const id = await ctx.ads.adAccountId();
      const account = await ctx.ads.get<{
        result?: { name?: string; systemStatus?: string; systemStatusReasons?: string[]; productFeatures?: string[]; delegations?: { resourceType?: string; resourceName?: string }[] };
      }>(`/ad-accounts/${id}`);
      const r = account.result ?? {};
      out.push(
        "",
        `Keyword tools use ad account ${id}${ctx.ads.config.adAccountId ? " (ADS_AD_ACCOUNT_ID)" : " (the only one available)"}: ${r.name ?? "?"} · ${r.systemStatus ?? "?"}${
          r.systemStatusReasons?.length ? ` (${r.systemStatusReasons.join(", ")})` : ""
        }`,
        `  product features: ${(r.productFeatures ?? []).join(", ") || "none"} · linked: ${(r.delegations ?? []).map((d) => `${d.resourceType} ${d.resourceName ?? ""}`.trim()).join(", ") || "nothing"}`,
      );
    } catch (error) {
      out.push("", `Ad account for keyword tools: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
    if (ctx.ads.rateLimit.remaining !== undefined) out.push("", `Rate limit: ${ctx.ads.rateLimit.remaining} of ${ctx.ads.rateLimit.limit ?? "?"} requests left in this window.`);
    return out.join("\n");
  },
});

// ---------------------------------------------------------------------------------------------

export const keywordPopularity = defineTool({
  name: "keyword_popularity",
  title: "Keyword popularity",
  description:
    "Looks up Apple's App Store search popularity (0-100) for search phrases, through the Apple Ads phrase search. Use it to choose words for the 100-character keyword field. " +
    "Pass phrases to look up, like for phrases containing some text, or app to check the words already in the app's keyword field, name and subtitle. " +
    "Phrases Apple returns no score for usually have too little search volume to measure. Apple doesn't document which storefront the scores describe.",
  kind: "read",
  requires: "ads",
  input: {
    phrases: z.array(z.string().min(1)).max(500).optional().describe('Exact phrases to look up, e.g. ["chess puzzle", "daily puzzle"].'),
    like: z.string().min(2).optional().describe("Find phrases that contain this text, most popular first."),
    app: appInput.describe("Also check this app's current keyword field, name and subtitle (needs App Store Connect configured)."),
    locale: z.string().optional().describe("Listing locale for app. Defaults to the primary locale."),
    limit: z.number().int().min(1).max(500).default(50).describe("Maximum phrases to show for like."),
  },
  async run(args, ctx) {
    if (!args.phrases?.length && !args.like && args.app === undefined) throw new UserError("Pass phrases, like, or app.");
    const out: string[] = [];

    if (args.app !== undefined) {
      const listing = await listingTerms(ctx, args.app, args.locale);
      const scores = await lookupPhrases(ctx, [...listing.keywords, ...listing.nameTerms]);
      out.push(`${listing.label}: keyword field ${listing.keywordField.length}/100 characters`);
      out.push(...table(listing.keywords, scores, (k) => (listing.nameWords.has(k.toLowerCase()) ? "already in name or subtitle; Apple indexes those words, so this one is wasted" : "")));
      if (listing.nameTerms.length) {
        out.push("", "Name and subtitle:");
        out.push(...table(listing.nameTerms, scores));
      }
    }

    if (args.phrases?.length) {
      const phrases = dedupe(args.phrases);
      const scores = await lookupPhrases(ctx, phrases);
      if (out.length) out.push("");
      out.push(`Popularity of ${plural(phrases.length, "phrase")} (0-100):`);
      out.push(...table(phrases, scores));
    }

    if (args.like) {
      const res = await ctx.ads.query<QueryResponse<PhraseSuggestion[]>>("/suggestions/phrases/query", {
        filters: [
          { field: "queryType", operator: "EQUALS", value: ["SEARCH"] },
          { field: "phrase", operator: "LIKE", value: [args.like] },
        ],
        sorting: [{ field: "popularity", order: "DESC" }],
        pagination: { offset: 0, pageSize: args.limit },
      });
      const rows = (res.result ?? []).slice(0, args.limit);
      if (out.length) out.push("");
      out.push(`Phrases containing "${args.like}" (${rows.length}${res.pagination?.totalCount && res.pagination.totalCount > rows.length ? ` of ${res.pagination.totalCount}` : ""}), most popular first:`);
      out.push(...(rows.length ? rows.map((r) => `  ${pad(r.popularity)}  ${r.phrase}`) : ["  none found"]));
    }
    return out.join("\n");
  },
});

/** Exact SEARCH lookups, batched. Returns lowercased phrase -> popularity. */
async function lookupPhrases(ctx: ToolContext, phrases: string[]): Promise<Map<string, number | undefined>> {
  const scores = new Map<string, number | undefined>();
  const unique = dedupe(phrases);
  for (let i = 0; i < unique.length; i += PHRASES_PER_REQUEST) {
    const batch = unique.slice(i, i + PHRASES_PER_REQUEST);
    const res = await ctx.ads.query<QueryResponse<PhraseSuggestion[]>>("/suggestions/phrases/query", {
      filters: [
        { field: "queryType", operator: "EQUALS", value: ["SEARCH"] },
        { field: "phrase", operator: "IN", value: batch },
      ],
      pagination: { offset: 0, pageSize: batch.length },
    });
    for (const r of res.result ?? []) scores.set(r.phrase.toLowerCase(), r.popularity);
  }
  return scores;
}

function table(phrases: string[], scores: Map<string, number | undefined>, note: (phrase: string) => string = () => ""): string[] {
  const found = phrases.filter((p) => scores.get(p.toLowerCase()) !== undefined);
  const missing = phrases.filter((p) => scores.get(p.toLowerCase()) === undefined);
  found.sort((a, b) => (scores.get(b.toLowerCase()) ?? 0) - (scores.get(a.toLowerCase()) ?? 0));
  const lines = found.map((p) => {
    const n = note(p);
    return `  ${pad(scores.get(p.toLowerCase()))}  ${p}${n ? `  (${n})` : ""}`;
  });
  if (missing.length) {
    lines.push(
      `  no data: ${missing
        .map((p) => {
          const n = note(p);
          return n ? `${p} (${n})` : p;
        })
        .join(", ")}`,
    );
  }
  return lines.length ? lines : ["  (nothing to look up)"];
}

async function listingTerms(ctx: ToolContext, app: string | undefined, locale: string | undefined) {
  const ref = await resolveApp(ctx, app);
  const wanted = locale ?? ref.primaryLocale;
  const version = await resolveVersion(ctx, ref.id, {}).catch(() => resolveVersion(ctx, ref.id, { version: "live" }));
  const loc = (await versionLocalizations(ctx, version.id)).find((l) => l.attributes?.locale === wanted);
  const keywordField = loc?.attributes?.keywords ?? "";
  const { info, included } = await resolveAppInfo(ctx, ref.id);
  const infoLoc = included
    .many<AppInfoLocalizationAttributes>(info, "appInfoLocalizations", "appInfoLocalizations")
    .find((l) => l.attributes?.locale === wanted);
  const nameTerms = [infoLoc?.attributes?.name, infoLoc?.attributes?.subtitle].filter((t): t is string => Boolean(t?.trim()));
  const nameWords = new Set(nameTerms.flatMap((t) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter(Boolean));
  return {
    label: `${ref.name} ${version.attributes?.versionString} (${wanted})`,
    keywordField,
    keywords: keywordField.split(",").map((k) => k.trim()).filter(Boolean),
    nameTerms,
    nameWords,
  };
}

function dedupe(phrases: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of phrases.map((x) => x.trim().replace(/\s+/g, " ")).filter(Boolean)) {
    if (!seen.has(p.toLowerCase())) {
      seen.add(p.toLowerCase());
      out.push(p);
    }
  }
  return out;
}

function pad(n: number | undefined): string {
  return String(n ?? "?").padStart(3);
}

// ---------------------------------------------------------------------------------------------

const GENRES = [
  "BUSINESS",
  "EDUCATION",
  "ENTERTAINMENT",
  "FINANCE",
  "FOOD_DRINK",
  "GAMES",
  "HEALTH_FITNESS",
  "LIFESTYLE",
  "NEW_PUBLICATION",
  "PHOTO_VIDEO",
  "PRODUCTIVITY_UTILITIES",
  "SHOPPING",
  "SOCIAL_NETWORKING",
  "SPORTS",
  "TRAVEL",
] as const;

export const searchTermTrends = defineTool({
  name: "search_term_trends",
  title: "Search term trends",
  description:
    "Shows the most-searched App Store terms in a genre and country, by week or month, with rank and popularity scores (Apple Ads insights). " +
    "Apple only reports roughly the top 500 terms per genre and country, so this finds popular terms; it can't score an arbitrary term (use keyword_popularity for that).",
  kind: "read",
  requires: "ads",
  input: {
    genre: z.enum(GENRES),
    country: z.string().length(2).default("US").describe("Two-letter App Store country or region code, e.g. US, GB."),
    term: z.string().optional().describe("Only terms matching this text."),
    match: z.enum(["contains", "starts_with", "equals"]).default("contains"),
    granularity: z.enum(["weekly", "monthly"]).default("weekly"),
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD; weekly ranges start on a Sunday. Default: the last full week or month (UTC)."),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    sort: z.enum(["rank", "popularity"]).default("rank"),
    limit: z.number().int().min(1).max(1000).default(50),
  },
  async run(args, ctx) {
    const range = timeRange(args.granularity, args.start, args.end, ctx.now());
    const filters: Record<string, unknown>[] = [
      { field: "countryOrRegion", operator: "EQUALS", value: args.country.toUpperCase() },
      { field: "genre", operator: "EQUALS", value: args.genre },
    ];
    if (args.term) {
      filters.push({ field: "searchTerm", operator: args.match.toUpperCase(), value: args.term });
    }
    const res = await ctx.ads.query<QueryResponse<{ rows?: SearchTermRow[] }>>("/insights/apps/search-term-popularity/query", {
      filters,
      timeRange: range,
      fields: ["rankInGenre", "searchPopularityInGenre", "searchPopularity1to100", "searchPopularity1to5"],
      sorting: [args.sort === "rank" ? { field: "rankInGenre", order: "ASC" } : { field: "searchPopularity1to100", order: "DESC" }],
      pagination: { offset: 0, pageSize: args.limit },
    });
    const rows = res.result?.rows ?? [];
    const head = `${args.genre} in ${args.country.toUpperCase()}, ${args.granularity} ${range.start} to ${range.end}${args.term ? `, terms ${args.match.replace("_", " ")} "${args.term}"` : ""}`;
    if (!rows.length) return `${head}: no terms. Apple only reports about the top 500 terms per genre and country, so a less popular term won't appear.`;
    return [
      `${head}: ${plural(rows.length, "term")}`,
      "  rank  pop/100  in genre  tier  term",
      ...rows.map(
        (r) =>
          `  ${String(r.rankInGenre ?? "?").padStart(4)}  ${String(r.searchPopularity1to100 ?? "?").padStart(7)}  ${String(r.searchPopularityInGenre ?? "?").padStart(8)}  ${String(r.searchPopularity1to5 ?? "?").padStart(4)}  ${r.searchTerm}${
            r.week || r.month ? `  (${r.week ?? r.month})` : ""
          }`,
      ),
    ].join("\n");
  },
});

/** The requested range, or the last full Sun-Sat week / calendar month in UTC. */
export function timeRange(granularity: "weekly" | "monthly", start: string | undefined, end: string | undefined, now: number) {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  if (granularity === "weekly") {
    if (start) {
      if (new Date(`${start}T00:00:00Z`).getUTCDay() !== 0) throw new UserError(`Weekly ranges start on a Sunday; ${start} isn't one.`);
      const e = end ?? day(new Date(Date.parse(`${start}T00:00:00Z`) + 6 * 86_400_000));
      return { start, end: e, granularity: "WEEKLY_SUN_SAT" };
    }
    const today = new Date(now);
    const lastSaturday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - ((today.getUTCDay() + 1) % 7 || 7)));
    const sunday = new Date(lastSaturday.getTime() - 6 * 86_400_000);
    return { start: day(sunday), end: day(lastSaturday), granularity: "WEEKLY_SUN_SAT" };
  }
  if (start) {
    const s = new Date(`${start}T00:00:00Z`);
    const e = end ?? day(new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 0)));
    return { start, end: e, granularity: "MONTHLY" };
  }
  const today = new Date(now);
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
  return { start: day(first), end: day(last), granularity: "MONTHLY" };
}

// ---------------------------------------------------------------------------------------------

export const keywordSuggestions = defineTool({
  name: "keyword_suggestions",
  title: "Keyword suggestions",
  description:
    "Asks Apple Ads for keyword ideas for an app, most popular first, optionally seeded with terms and scoped to countries. Apple generally only suggests keywords for apps that are live on the App Store.",
  kind: "read",
  requires: "ads",
  input: {
    app: z.string().describe("App Store app ID (numeric), or a bundle ID or name when App Store Connect is configured."),
    terms: z.array(z.string()).max(50).optional().describe("Seed terms to get related suggestions for."),
    countries: z.array(z.string().length(2)).max(50).optional().describe('Two-letter codes, e.g. ["US", "GB"].'),
    limit: z.number().int().min(1).max(500).default(50),
  },
  async run(args, ctx) {
    const appId = /^\d+$/.test(args.app.trim()) ? args.app.trim() : (await resolveApp(ctx, args.app)).id;
    const filters: Record<string, unknown>[] = [
      { field: "promotedObjectId", operator: "EQUALS", value: [appId] },
      { field: "promotedObjectType", operator: "EQUALS", value: ["APPSTORE_APP"] },
    ];
    if (args.terms?.length) filters.push({ field: "terms", operator: "IN", value: args.terms });
    if (args.countries?.length) filters.push({ field: "countriesOrRegions", operator: "IN", value: args.countries.map((c) => c.toUpperCase()) });
    let res: QueryResponse<KeywordSuggestion[]>;
    try {
      res = await ctx.ads.query<QueryResponse<KeywordSuggestion[]>>("/suggestions/keywords/query", {
        filters,
        sorting: [{ field: "popularity", order: "DESC" }],
        pagination: { offset: 0, pageSize: args.limit },
      });
    } catch (error) {
      if (error instanceof AdsApiError && [400, 403, 404].includes(error.status)) {
        throw new UserError(
          `Apple Ads wouldn't suggest keywords for app ${appId}. Suggestions generally need an app that's live on the App Store and available to your ad account. ` +
            `Until then, use keyword_popularity to score your own ideas.\n${error.message}`,
        );
      }
      throw error;
    }
    const rows = res.result ?? [];
    if (!rows.length) return `Apple Ads had no keyword suggestions for app ${appId}.`;
    return [`Keyword suggestions for app ${appId}${args.countries?.length ? ` in ${args.countries.join(", ")}` : ""}, most popular first:`, ...rows.map((r) => `  ${pad(r.popularity)}  ${r.text}`)].join("\n");
  },
});

export const ADS_TOOLS = [adsStatus, keywordPopularity, searchTermTrends, keywordSuggestions];
