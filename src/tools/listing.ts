import { z } from "zod";
import { AscApiError, type Linkage, type Resource } from "../asc/client.js";
import { Included, linkage, relId } from "../asc/jsonapi.js";
import type {
  AgeRatingDeclarationAttributes,
  AppInfoAttributes,
  AppInfoLocalizationAttributes,
  AppStoreReviewDetailAttributes,
  AppStoreVersionLocalizationAttributes,
} from "../asc/types.js";
import { upsertBetaNotes } from "./builds.js";
import { STEP_LEGEND, StepLog, truncate } from "./format.js";
import { defineTool, UserError, type ToolContext } from "./framework.js";
import {
  appInput,
  buildInput,
  EDITABLE_VERSION_STATES,
  platformInput,
  requireBuild,
  resolveApp,
  resolveVersion,
  versionInput,
  versionLocalizations,
  versionState,
} from "./lookup.js";

/** Apple's character limits for store metadata. */
export const LIMITS = {
  name: 30,
  subtitle: 30,
  keywords: 100,
  promotionalText: 170,
  description: 4000,
  whatsNew: 4000,
} as const;

const SECRET_FIELDS = new Set(["demoAccountPassword"]);

type Attributes = Record<string, unknown>;

/**
 * Creates a resource or patches only the attributes that differ, logging a readable diff.
 * Returns true if anything changed (or would change, in a dry run).
 */
async function upsert(
  ctx: ToolContext,
  log: StepLog,
  options: {
    type: string;
    label: string;
    existing?: Resource<Attributes>;
    changes: Attributes;
    createAttributes?: Attributes;
    relationships?: Record<string, { data: Linkage }>;
  },
): Promise<boolean> {
  const current = options.existing?.attributes ?? {};
  const changed = Object.fromEntries(
    Object.entries(options.changes).filter(([key, value]) => value !== undefined && !same(current[key], value)),
  );
  const keys = Object.keys(changed);
  if (!keys.length) {
    log.skip(`${options.label}: already up to date`);
    return false;
  }
  for (const key of keys) {
    const show = (v: unknown) => (SECRET_FIELDS.has(key) ? (v ? "••••" : "empty") : v === null || v === undefined || v === "" ? "empty" : `"${truncate(String(v), 120)}"`);
    log.step(ctx.dryRun, `${options.label} ${key}: ${options.existing ? `${show(current[key])} → ` : ""}${show(changed[key])}`);
  }
  if (ctx.dryRun) return true;
  if (options.existing) {
    await ctx.asc.patch(`/v1/${options.type}/${options.existing.id}`, {
      data: { type: options.type, id: options.existing.id, attributes: changed },
    });
  } else {
    await ctx.asc.post(`/v1/${options.type}`, {
      data: { type: options.type, attributes: { ...options.createAttributes, ...changed }, relationships: options.relationships },
    });
  }
  return true;
}

function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === null || v === undefined ? "" : v);
  return norm(a) === norm(b);
}

function count(text: string | undefined | null, limit: number): string {
  return `${text?.length ?? 0}/${limit}`;
}

/** The app info record to read or edit: the one being prepared if there is one, else the live one. */
async function resolveAppInfo(ctx: ToolContext, appId: string) {
  const doc = await ctx.asc.get<Resource<AppInfoAttributes>[]>(`/v1/apps/${appId}/appInfos`, {
    include: "appInfoLocalizations,primaryCategory,primarySubcategoryOne,primarySubcategoryTwo,secondaryCategory,ageRatingDeclaration",
    "limit[appInfoLocalizations]": 50,
  });
  const state = (i: Resource<AppInfoAttributes>) => i.attributes?.state ?? i.attributes?.appStoreState ?? "";
  const editable = doc.data.find((i) => EDITABLE_VERSION_STATES.has(state(i)) || state(i) === "PREPARE_FOR_SUBMISSION");
  const info = editable ?? doc.data[0];
  if (!info) throw new UserError("This app has no app info record.");
  return { info, editable: editable !== undefined, included: new Included(doc.included), state: state(info) };
}

// ---------------------------------------------------------------------------------------------

export const getListing = defineTool({
  name: "get_listing",
  title: "Get store listing",
  description:
    "Shows the App Store listing: app name, subtitle, privacy URL and categories, the version's localized description, keywords, promotional text, what's new and URLs (with character counts against Apple's limits), the age rating, and the App Review contact details.",
  kind: "read",
  input: {
    app: appInput,
    version: versionInput,
    platform: platformInput,
    locale: z.string().optional().describe('Localization, or "all". Defaults to the primary locale.'),
    full: z.boolean().default(false).describe("Show full descriptions instead of the first 300 characters."),
  },
  async run({ app, version, platform, locale, full }, ctx) {
    const ref = await resolveApp(ctx, app);
    // With no version given, show the one being prepared, or the live one if nothing is.
    const v = version
      ? await resolveVersion(ctx, ref.id, { version, platform })
      : await resolveVersion(ctx, ref.id, { platform }).catch(() => resolveVersion(ctx, ref.id, { version: "live", platform }));
    const wantLocale = (l?: string) => locale === "all" || l === (locale ?? ref.primaryLocale);
    const cut = (t: string | undefined | null) => (full ? (t ?? "") : truncate(t, 300));
    const out: string[] = [`${ref.name} · id ${ref.id} · ${ref.bundleId}`];

    const { info, included, state } = await resolveAppInfo(ctx, ref.id);
    const primary = included.one(info, "primaryCategory", "appCategories")?.id ?? relId(info, "primaryCategory");
    const secondary = included.one(info, "secondaryCategory", "appCategories")?.id ?? relId(info, "secondaryCategory");
    out.push("", `App info (${state}, id ${info.id}): primary category ${primary ?? "none"}${secondary ? `, secondary ${secondary}` : ""} · age rating ${info.attributes?.appStoreAgeRating ?? "?"}`);
    for (const l of included.many<AppInfoLocalizationAttributes>(info, "appInfoLocalizations", "appInfoLocalizations").filter((l) => wantLocale(l.attributes?.locale))) {
      const a = l.attributes ?? {};
      out.push(`  ${a.locale}: name "${a.name ?? ""}" (${count(a.name, LIMITS.name)}) · subtitle "${a.subtitle ?? ""}" (${count(a.subtitle, LIMITS.subtitle)}) · privacy policy ${a.privacyPolicyUrl ?? "none"}`);
    }
    const age = included.one<AgeRatingDeclarationAttributes>(info, "ageRatingDeclaration", "ageRatingDeclarations");
    if (age?.attributes) {
      const flagged = Object.entries(age.attributes).filter(([, value]) => value !== null && value !== "NONE" && value !== false);
      out.push(`  Age rating declaration (id ${age.id}): ${flagged.length ? flagged.map(([k, value]) => `${k}=${value}`).join(", ") : "everything NONE/false"}`);
    }

    out.push("", `Version ${v.attributes?.versionString} (${versionState(v)}, id ${v.id}) · copyright "${v.attributes?.copyright ?? ""}" · release ${v.attributes?.releaseType ?? "?"}`);
    for (const l of (await versionLocalizations(ctx, v.id)).filter((l) => wantLocale(l.attributes?.locale))) {
      const a = l.attributes ?? {};
      out.push(
        `  ${a.locale} (id ${l.id}):`,
        `    description (${count(a.description, LIMITS.description)}): ${cut(a.description) || "empty"}`,
        `    keywords (${count(a.keywords, LIMITS.keywords)}): ${a.keywords || "empty"}`,
        `    promotional text (${count(a.promotionalText, LIMITS.promotionalText)}): ${a.promotionalText || "empty"}`,
        `    what's new (${count(a.whatsNew, LIMITS.whatsNew)}): ${cut(a.whatsNew) || "empty"}`,
        `    support URL: ${a.supportUrl || "none"} · marketing URL: ${a.marketingUrl || "none"}`,
      );
    }

    const review = await getReviewDetail(ctx, v.id);
    if (review?.attributes) {
      const r = review.attributes;
      out.push(
        "",
        `App Review information (id ${review.id}): contact ${[r.contactFirstName, r.contactLastName].filter(Boolean).join(" ") || "none"}, ${r.contactEmail || "no email"}, ${r.contactPhone || "no phone"}`,
        `  demo account: ${r.demoAccountRequired ? `required, user "${r.demoAccountName ?? ""}", password ${r.demoAccountPassword ? "set" : "NOT set"}` : "not required"}`,
        `  notes: ${truncate(r.notes, 300) || "none"}`,
      );
    } else {
      out.push("", "App Review information: not filled in (set it with set_review_details)");
    }
    return out.join("\n");
  },
});

async function getReviewDetail(ctx: ToolContext, versionId: string) {
  try {
    const doc = await ctx.asc.get<Resource<AppStoreReviewDetailAttributes> | null>(`/v1/appStoreVersions/${versionId}/appStoreReviewDetail`);
    return doc.data ?? undefined;
  } catch (error) {
    if (error instanceof AscApiError && error.status === 404) return undefined;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------

export const updateListing = defineTool({
  name: "update_listing",
  title: "Update store listing",
  description:
    "Updates App Store metadata for one locale. Only fields you pass change, and only if they differ; the result shows each change as old → new. " +
    "Name, subtitle and privacy URLs live on the app info; description, keywords, promotional text, what's new and URLs on the version. " +
    "Adds the localization if it doesn't exist yet. Only versions being prepared can change, except promotional text, which can change on the live version (pass version: \"live\").",
  kind: "write",
  input: {
    app: appInput,
    version: versionInput,
    platform: platformInput,
    locale: z.string().optional().describe("Defaults to the primary locale."),
    name: z.string().max(LIMITS.name).optional(),
    subtitle: z.string().max(LIMITS.subtitle).optional(),
    privacy_policy_url: z.string().url().optional(),
    privacy_choices_url: z.string().url().optional(),
    description: z.string().max(LIMITS.description).optional(),
    keywords: z.string().max(LIMITS.keywords).optional().describe("Comma-separated, 100 characters in total."),
    promotional_text: z.string().max(LIMITS.promotionalText).optional(),
    whats_new: z.string().max(LIMITS.whatsNew).optional(),
    support_url: z.string().url().optional(),
    marketing_url: z.string().url().optional(),
    copyright: z.string().optional().describe('Version copyright, e.g. "2026 Example Inc."'),
    primary_category: z.string().optional().describe("Category ID such as GAMES, UTILITIES, PRODUCTIVITY, HEALTH_AND_FITNESS."),
    primary_subcategories: z
      .array(z.string())
      .max(2)
      .optional()
      .describe("Games only: up to two subcategories of the primary category, e.g. [\"GAMES_PUZZLE\", \"GAMES_BOARD\"]."),
    secondary_category: z.string().optional(),
  },
  async run(args, ctx) {
    const ref = await resolveApp(ctx, args.app);
    const locale = args.locale ?? ref.primaryLocale;
    const log = new StepLog();

    const versionChanges = {
      description: args.description,
      keywords: args.keywords,
      promotionalText: args.promotional_text,
      whatsNew: args.whats_new,
      supportUrl: args.support_url,
      marketingUrl: args.marketing_url,
    };
    const infoChanges = {
      name: args.name,
      subtitle: args.subtitle,
      privacyPolicyUrl: args.privacy_policy_url,
      privacyChoicesUrl: args.privacy_choices_url,
    };
    const has = (o: Record<string, unknown>) => Object.values(o).some((value) => value !== undefined);
    const categoryChange = Boolean(args.primary_category || args.secondary_category || args.primary_subcategories);
    if (!has(versionChanges) && !has(infoChanges) && args.copyright === undefined && !categoryChange) {
      throw new UserError("Pass at least one field to change.");
    }

    if (has(versionChanges) || args.copyright !== undefined) {
      const onlyPromo = Object.entries(versionChanges).every(([k, value]) => k === "promotionalText" || value === undefined) && args.copyright === undefined;
      const v = await resolveVersion(ctx, ref.id, { version: args.version, platform: args.platform, editable: !onlyPromo });
      log.info(`Version ${v.attributes?.versionString} (${versionState(v)})`);
      if (has(versionChanges)) {
        const existing = (await versionLocalizations(ctx, v.id)).find((l) => l.attributes?.locale === locale);
        await upsert(ctx, log, {
          type: "appStoreVersionLocalizations",
          label: `${locale}`,
          existing: existing as Resource<Attributes> | undefined,
          changes: versionChanges,
          createAttributes: { locale },
          relationships: { appStoreVersion: linkage("appStoreVersions", v.id) },
        });
      }
      if (args.copyright !== undefined) {
        await upsert(ctx, log, { type: "appStoreVersions", label: "version", existing: v as Resource<Attributes>, changes: { copyright: args.copyright } });
      }
    }

    if (has(infoChanges) || categoryChange) {
      const { info, editable, included } = await resolveAppInfo(ctx, ref.id);
      if (!editable) {
        throw new UserError(`${log.toString()}\nThe app's name, subtitle, privacy URLs and categories can only change while a new version is being prepared. Create one with prepare_version.`);
      }
      if (has(infoChanges)) {
        const existing = included
          .many<AppInfoLocalizationAttributes>(info, "appInfoLocalizations", "appInfoLocalizations")
          .find((l) => l.attributes?.locale === locale);
        if (!existing && !infoChanges.name) throw new UserError(`Adding the ${locale} localization needs a name.`);
        await upsert(ctx, log, {
          type: "appInfoLocalizations",
          label: `${locale} app info`,
          existing: existing as Resource<Attributes> | undefined,
          changes: infoChanges,
          createAttributes: { locale },
          relationships: { appInfo: linkage("appInfos", info.id) },
        });
      }
      const relationships: Record<string, { data: Linkage }> = {};
      if (args.primary_category && relId(info, "primaryCategory") !== args.primary_category) {
        relationships.primaryCategory = linkage("appCategories", args.primary_category);
      }
      if (args.secondary_category && relId(info, "secondaryCategory") !== args.secondary_category) {
        relationships.secondaryCategory = linkage("appCategories", args.secondary_category);
      }
      const subRels = ["primarySubcategoryOne", "primarySubcategoryTwo"] as const;
      args.primary_subcategories?.forEach((sub, i) => {
        if (relId(info, subRels[i]!) !== sub) relationships[subRels[i]!] = linkage("appCategories", sub);
      });
      if (Object.keys(relationships).length) {
        if (!ctx.dryRun) await ctx.asc.patch(`/v1/appInfos/${info.id}`, { data: { type: "appInfos", id: info.id, relationships } });
        log.step(ctx.dryRun, `Categories: ${Object.entries(relationships).map(([k, value]) => `${k} → ${value.data.id}`).join(", ")}`);
      } else if (categoryChange) {
        log.skip("Categories already set");
      }
    }
    return [`${ref.name} · ${locale}`, STEP_LEGEND, log.toString()].join("\n");
  },
});

export const setWhatsNew = defineTool({
  name: "set_whats_new",
  title: "Set what's new",
  description:
    'Sets release notes. target "app_store" sets the version\'s "What\'s New in This Version"; target "testflight" sets a build\'s "What to Test".',
  kind: "write",
  input: {
    app: appInput,
    target: z.enum(["app_store", "testflight"]),
    text: z.string().min(1).max(LIMITS.whatsNew),
    locale: z.string().optional().describe("Defaults to the primary locale (app_store) or en-US (testflight)."),
    version: versionInput,
    build: buildInput,
    platform: platformInput,
  },
  async run(args, ctx) {
    const ref = await resolveApp(ctx, args.app);
    const log = new StepLog();
    if (args.target === "testflight") {
      const info = await requireBuild(ctx, ref.id, { build: args.build, platform: args.platform });
      await upsertBetaNotes(ctx, info.build.id, args.locale ?? "en-US", args.text, log);
      return [`${ref.name} build ${info.build.attributes?.version}`, STEP_LEGEND, log.toString()].join("\n");
    }
    const locale = args.locale ?? ref.primaryLocale;
    const v = await resolveVersion(ctx, ref.id, { version: args.version, platform: args.platform, editable: true });
    const existing = (await versionLocalizations(ctx, v.id)).find((l) => l.attributes?.locale === locale);
    if (!existing) throw new UserError(`Version ${v.attributes?.versionString} has no ${locale} localization. Add it with update_listing first.`);
    await upsert(ctx, log, {
      type: "appStoreVersionLocalizations",
      label: locale,
      existing: existing as Resource<Attributes>,
      changes: { whatsNew: args.text },
    });
    return [`${ref.name} ${v.attributes?.versionString}`, STEP_LEGEND, log.toString()].join("\n");
  },
});

export const setReviewDetails = defineTool({
  name: "set_review_details",
  title: "Set App Review details",
  description:
    "Sets the App Review information for the version being prepared: contact name, phone and email, demo account, and notes for the reviewer. Only fields you pass change. The password is never echoed back.",
  kind: "write",
  input: {
    app: appInput,
    version: versionInput,
    platform: platformInput,
    contact_first_name: z.string().optional(),
    contact_last_name: z.string().optional(),
    contact_phone: z.string().optional().describe("Include the country code, e.g. +1 555 010 0000."),
    contact_email: z.string().email().optional(),
    demo_account_required: z.boolean().optional(),
    demo_account_name: z.string().optional(),
    demo_account_password: z.string().optional(),
    notes: z.string().max(4000).optional(),
  },
  async run(args, ctx) {
    const ref = await resolveApp(ctx, args.app);
    const v = await resolveVersion(ctx, ref.id, { version: args.version, platform: args.platform, editable: true });
    const existing = await getReviewDetail(ctx, v.id);
    const changes = {
      contactFirstName: args.contact_first_name,
      contactLastName: args.contact_last_name,
      contactPhone: args.contact_phone,
      contactEmail: args.contact_email,
      demoAccountRequired: args.demo_account_required,
      demoAccountName: args.demo_account_name,
      demoAccountPassword: args.demo_account_password,
      notes: args.notes,
    };
    if (Object.values(changes).every((value) => value === undefined)) throw new UserError("Pass at least one field to change.");
    const log = new StepLog();
    await upsert(ctx, log, {
      type: "appStoreReviewDetails",
      label: "App Review",
      existing: existing as Resource<Attributes> | undefined,
      changes,
      relationships: { appStoreVersion: linkage("appStoreVersions", v.id) },
    });
    return [`${ref.name} ${v.attributes?.versionString}`, STEP_LEGEND, log.toString()].join("\n");
  },
});

export const updateAgeRating = defineTool({
  name: "update_age_rating",
  title: "Update age rating",
  description:
    "Changes answers in the age rating questionnaire of the app info being prepared. Pass only the answers to change, using Apple's attribute names " +
    '(see get_listing), e.g. {"violenceCartoonOrFantasy": "INFREQUENT_OR_MILD", "gambling": false}. Values are NONE, INFREQUENT_OR_MILD, FREQUENT_OR_INTENSE, or true/false.',
  kind: "write",
  input: {
    app: appInput,
    answers: z.record(z.union([z.string(), z.boolean(), z.null()])),
  },
  async run(args, ctx) {
    const ref = await resolveApp(ctx, args.app);
    const { info, editable, included } = await resolveAppInfo(ctx, ref.id);
    if (!editable) throw new UserError("The age rating can only change while a new version is being prepared. Create one with prepare_version.");
    const declaration = included.one<AgeRatingDeclarationAttributes>(info, "ageRatingDeclaration", "ageRatingDeclarations");
    if (!declaration) throw new UserError("Couldn't find the age rating declaration for the app info being prepared.");
    const log = new StepLog();
    await upsert(ctx, log, { type: "ageRatingDeclarations", label: "Age rating", existing: declaration as Resource<Attributes>, changes: args.answers });
    return [ref.name, STEP_LEGEND, log.toString()].join("\n");
  },
});
