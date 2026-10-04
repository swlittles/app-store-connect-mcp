import { z } from "zod";
import { AscApiError, type Resource } from "../asc/client.js";
import { Included, linkage, relId } from "../asc/jsonapi.js";
import { runBulk, type BulkResult } from "../asc/jobs.js";
import type {
  InAppPurchaseAttributes,
  SubscriptionAttributes,
  SubscriptionGroupAttributes,
  SubscriptionIntroductoryOfferAttributes,
  SubscriptionPriceAttributes,
  SubscriptionPricePointAttributes,
} from "../asc/types.js";
import { plural, StepLog, STEP_LEGEND } from "./format.js";
import { defineTool, UserError, type ToolContext } from "./framework.js";
import { appInput, resolveApp, type AppRef } from "./lookup.js";

type Offer = Resource<SubscriptionIntroductoryOfferAttributes>;

const subscriptionInput = z.string().describe("Subscription ID or product ID (e.g. com.example.app.yearly).");

async function listSubscriptions(ctx: ToolContext, app: AppRef) {
  const doc = await ctx.asc.getAll<SubscriptionGroupAttributes>(`/v1/apps/${app.id}/subscriptionGroups`, {
    include: "subscriptions",
    "limit[subscriptions]": 50,
  });
  const included = new Included(doc.included);
  return doc.data.map((group) => ({ group, subscriptions: included.many<SubscriptionAttributes>(group, "subscriptions", "subscriptions") }));
}

async function resolveSubscription(ctx: ToolContext, app: AppRef, wanted: string): Promise<Resource<SubscriptionAttributes>> {
  const all = (await listSubscriptions(ctx, app)).flatMap((g) => g.subscriptions);
  const found = all.find((s) => s.id === wanted || s.attributes?.productId === wanted);
  if (!found) {
    throw new UserError(`No subscription "${wanted}" in ${app.name}. It has: ${all.map((s) => `${s.attributes?.productId} (id ${s.id})`).join(", ") || "none"}.`);
  }
  return found;
}

async function listOffers(ctx: ToolContext, subscriptionId: string): Promise<Offer[]> {
  const { data } = await ctx.asc.getAll<SubscriptionIntroductoryOfferAttributes>(`/v1/subscriptions/${subscriptionId}/introductoryOffers`, {
    include: "territory",
    "fields[territories]": "currency",
  });
  return data;
}

function describeOffer(a: SubscriptionIntroductoryOfferAttributes | undefined): string {
  if (!a) return "?";
  const periods = a.numberOfPeriods && a.numberOfPeriods > 1 ? ` ×${a.numberOfPeriods}` : "";
  const dates = a.startDate || a.endDate ? ` (${a.startDate ?? "now"} to ${a.endDate ?? "no end"})` : "";
  return `${a.offerMode} ${a.duration}${periods}${dates}`;
}

/** Groups offers by what they are, e.g. "FREE_TRIAL ONE_WEEK: 175 territories". */
function summarizeOffers(offers: Offer[]): string {
  if (!offers.length) return "no introductory offers";
  const kinds = new Map<string, number>();
  for (const o of offers) kinds.set(describeOffer(o.attributes), (kinds.get(describeOffer(o.attributes)) ?? 0) + 1);
  return [...kinds].map(([kind, n]) => `${kind} in ${plural(n, "territory", "territories")}`).join("; ");
}

export const listSubscriptionsTool = defineTool({
  name: "list_subscriptions",
  title: "List subscriptions and in-app purchases",
  description:
    "Lists subscription groups and their subscriptions (product ID, period, state, price in one territory, introductory offers summarized across territories), plus one-time in-app purchases.",
  kind: "read",
  input: {
    app: appInput,
    territory: z.string().length(3).default("USA").describe("Territory for the price shown (ISO 3166-1 alpha-3)."),
  },
  async run({ app, territory }, ctx) {
    const ref = await resolveApp(ctx, app);
    const groups = await listSubscriptions(ctx, ref);
    const out = [`${ref.name}`];
    if (!groups.length) out.push("No subscription groups.");
    for (const { group, subscriptions } of groups) {
      out.push("", `Group "${group.attributes?.referenceName}" (id ${group.id}): ${plural(subscriptions.length, "subscription")}`);
      const sorted = [...subscriptions].sort((a, b) => (a.attributes?.groupLevel ?? 0) - (b.attributes?.groupLevel ?? 0));
      for (const s of sorted) {
        const [price, offers] = await Promise.all([currentPrice(ctx, s.id, territory), listOffers(ctx, s.id)]);
        const a = s.attributes ?? {};
        out.push(
          `- ${a.name} · ${a.productId} · ${a.subscriptionPeriod} · ${a.state} · level ${a.groupLevel ?? "?"} · ${price ? `${price} in ${territory}` : `no ${territory} price`} · id ${s.id}`,
          `    intro offers: ${summarizeOffers(offers)}`,
        );
      }
    }
    const iaps = await ctx.asc.getAll<InAppPurchaseAttributes>(`/v1/apps/${ref.id}/inAppPurchasesV2`).catch(() => undefined);
    if (iaps?.data.length) {
      out.push("", "In-app purchases:");
      for (const p of iaps.data) out.push(`- ${p.attributes?.name} · ${p.attributes?.productId} · ${p.attributes?.inAppPurchaseType} · ${p.attributes?.state} · id ${p.id}`);
    }
    return out.join("\n");
  },
});

async function currentPrice(ctx: ToolContext, subscriptionId: string, territory: string): Promise<string | undefined> {
  const doc = await ctx.asc.get<Resource<SubscriptionPriceAttributes>[]>(`/v1/subscriptions/${subscriptionId}/prices`, {
    "filter[territory]": territory,
    include: "subscriptionPricePoint,territory",
    limit: 10,
  });
  const included = new Included(doc.included);
  const today = new Date().toISOString().slice(0, 10);
  // The current price is the latest one that has started; future scheduled prices come after it.
  const started = doc.data
    .filter((p) => !p.attributes?.startDate || p.attributes.startDate <= today)
    .sort((a, b) => (b.attributes?.startDate ?? "").localeCompare(a.attributes?.startDate ?? ""));
  const price = started[0];
  if (!price) return undefined;
  const point = included.one<SubscriptionPricePointAttributes>(price, "subscriptionPricePoint", "subscriptionPricePoints");
  const currency = included.get<{ currency?: string }>("territories", relId(price, "territory"))?.attributes?.currency;
  return point?.attributes?.customerPrice ? `${point.attributes.customerPrice}${currency ? ` ${currency}` : ""}` : undefined;
}

function bulkReport<T>(result: BulkResult<T>, label: (item: T) => string, verb: string): string[] {
  const lines: string[] = [];
  const counts = new Map<string, number>();
  for (const s of result.succeeded) counts.set(s.note ?? verb, (counts.get(s.note ?? verb) ?? 0) + 1);
  for (const [note, n] of counts) lines.push(`✓ ${note}: ${n}`);
  for (const f of result.failed.slice(0, 20)) lines.push(`✗ ${label(f.item)}: ${f.error}`);
  if (result.failed.length > 20) lines.push(`✗ …and ${result.failed.length - 20} more failures`);
  if (result.notAttempted.length) lines.push(`! Not attempted: ${result.notAttempted.length} (${result.stopReason ?? "stopped"})`);
  if (result.failed.length || result.notAttempted.length) lines.push("Run the same call again to finish; work already done is skipped.");
  return lines;
}

export const removeIntroOffers = defineTool({
  name: "remove_intro_offers",
  title: "Remove introductory offers",
  description:
    "Deletes a subscription's introductory offers (for example a free trial) in every territory or only some. Apple stores one offer per territory, so this is a bulk job: " +
    "it reports progress, keeps going past individual failures, stops early if the hourly rate limit runs low, and can be re-run to finish.",
  kind: "destructive",
  input: {
    app: appInput,
    subscription: subscriptionInput,
    territories: z.array(z.string().length(3)).optional().describe("Only these territories (ISO alpha-3, e.g. USA, GBR). Default: all."),
    offer_mode: z.enum(["FREE_TRIAL", "PAY_AS_YOU_GO", "PAY_UP_FRONT"]).optional().describe("Only offers of this kind."),
  },
  async run(args, ctx) {
    const ref = await resolveApp(ctx, args.app);
    const sub = await resolveSubscription(ctx, ref, args.subscription);
    const all = await listOffers(ctx, sub.id);
    const territories = args.territories?.map((t) => t.toUpperCase());
    const targets = all.filter(
      (o) => (!territories || territories.includes(relId(o, "territory") ?? "")) && (!args.offer_mode || o.attributes?.offerMode === args.offer_mode),
    );
    const head = `${sub.attributes?.name} (${sub.attributes?.productId}): ${plural(all.length, "introductory offer")} now; ${targets.length} match.`;
    if (!targets.length) return `${head} Nothing to delete.`;
    if (ctx.dryRun) {
      return [head, `→ Delete ${summarizeOffers(targets)}`, `  Territories: ${targets.map((o) => relId(o, "territory")).join(", ")}`].join("\n");
    }
    const result = await runBulk(
      targets,
      async (offer) => ((await ctx.asc.deleteIfExists(`/v1/subscriptionIntroductoryOffers/${offer.id}`)) === "deleted" ? "deleted" : "already gone"),
      {
        concurrency: 4,
        asc: ctx.asc,
        signal: ctx.signal,
        onProgress: (n, total) => (n % 10 === 0 || n === total ? ctx.progress(`Deleted ${n} of ${total} offers`, n, total) : undefined),
      },
    );
    const left = await listOffers(ctx, sub.id);
    return [head, ...bulkReport(result, (o) => relId(o, "territory") ?? o.id, "deleted"), `Now: ${summarizeOffers(left)}.`].join("\n");
  },
});

export const addFreeTrial = defineTool({
  name: "add_free_trial",
  title: "Add a free trial",
  description:
    "Adds a free-trial introductory offer to a subscription in every territory where it's sold (or the ones you list), skipping territories that already have an introductory offer. " +
    "Runs as a resumable bulk job with progress. Paid introductory offers need a price per territory and aren't covered; use asc_request for those.",
  kind: "write",
  input: {
    app: appInput,
    subscription: subscriptionInput,
    duration: z.enum(["THREE_DAYS", "ONE_WEEK", "TWO_WEEKS", "ONE_MONTH", "TWO_MONTHS", "THREE_MONTHS", "SIX_MONTHS", "ONE_YEAR"]),
    territories: z.array(z.string().length(3)).optional().describe("Only these territories. Default: every territory the subscription is available in."),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  },
  async run(args, ctx) {
    const ref = await resolveApp(ctx, args.app);
    const sub = await resolveSubscription(ctx, ref, args.subscription);
    let territories = args.territories?.map((t) => t.toUpperCase());
    if (!territories) {
      const availability = await ctx.asc.get<Resource | null>(`/v1/subscriptions/${sub.id}/subscriptionAvailability`).catch((error) => {
        if (error instanceof AscApiError && error.status === 404) return { data: null };
        throw error;
      });
      if (!availability.data) throw new UserError("This subscription has no availability set (no territories). Set availability in App Store Connect first, or pass territories.");
      const { data } = await ctx.asc.getAll<unknown>(`/v1/subscriptionAvailabilities/${availability.data.id}/availableTerritories`, { "fields[territories]": "currency" });
      territories = data.map((t) => t.id);
    }
    const today = new Date(ctx.now()).toISOString().slice(0, 10);
    // An offer that has ended doesn't block a new one.
    const existing = new Set(
      (await listOffers(ctx, sub.id)).filter((o) => !o.attributes?.endDate || o.attributes.endDate >= today).map((o) => relId(o, "territory")),
    );
    const todo = territories.filter((t) => !existing.has(t));
    const log = new StepLog();
    log.info(`${sub.attributes?.name} (${sub.attributes?.productId}): ${territories.length} territories, ${territories.length - todo.length} already have an introductory offer.`);
    if (!todo.length) {
      log.skip("Nothing to add");
      return log.toString();
    }
    if (ctx.dryRun) {
      log.plan(`Add FREE_TRIAL ${args.duration} in ${plural(todo.length, "territory", "territories")}: ${todo.join(", ")}`);
      return [STEP_LEGEND, log.toString()].join("\n");
    }
    const result = await runBulk(
      todo,
      async (territory) => {
        try {
          await ctx.asc.post("/v1/subscriptionIntroductoryOffers", {
            data: {
              type: "subscriptionIntroductoryOffers",
              attributes: { offerMode: "FREE_TRIAL", duration: args.duration, numberOfPeriods: 1, startDate: args.start_date, endDate: args.end_date },
              relationships: { subscription: linkage("subscriptions", sub.id), territory: linkage("territories", territory) },
            },
          });
          return "added";
        } catch (error) {
          // 409 also covers validation errors, so only call it "already there" if an offer really is.
          if (error instanceof AscApiError && error.status === 409) {
            const now = await ctx.asc.get<Offer[]>(`/v1/subscriptions/${sub.id}/introductoryOffers`, { "filter[territory]": territory, limit: 5 });
            if (now.data.some((o) => !o.attributes?.endDate || o.attributes.endDate >= today)) return "already had an offer";
          }
          throw error;
        }
      },
      {
        concurrency: 4,
        asc: ctx.asc,
        signal: ctx.signal,
        onProgress: (n, total) => (n % 10 === 0 || n === total ? ctx.progress(`Added ${n} of ${total}`, n, total) : undefined),
      },
    );
    return [log.toString(), ...bulkReport(result, (t) => t, "added")].join("\n");
  },
});
