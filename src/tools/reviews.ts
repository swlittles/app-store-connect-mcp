import { writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { AscApiError, type Resource } from "../asc/client.js";
import { Included, linkage } from "../asc/jsonapi.js";
import type { CustomerReviewAttributes, CustomerReviewResponseAttributes } from "../asc/types.js";
import { plural, truncate, when } from "./format.js";
import { defineTool, UserError } from "./framework.js";
import { appInput, resolveApp } from "./lookup.js";

export const getReviews = defineTool({
  name: "get_reviews",
  title: "Get customer reviews",
  description: "Lists App Store customer reviews, newest first by default, with your published replies and review IDs (for reply_to_review).",
  kind: "read",
  input: {
    app: appInput,
    rating: z.number().int().min(1).max(5).optional(),
    territory: z.string().length(3).optional().describe("ISO alpha-3, e.g. USA."),
    unanswered: z.boolean().optional().describe("Only reviews without a published reply."),
    sort: z.enum(["-createdDate", "createdDate", "-rating", "rating"]).default("-createdDate"),
    limit: z.number().int().min(1).max(200).default(20),
  },
  async run(args, ctx) {
    const ref = await resolveApp(ctx, args.app);
    const doc = await ctx.asc.get<Resource<CustomerReviewAttributes>[]>(`/v1/apps/${ref.id}/customerReviews`, {
      "filter[rating]": args.rating,
      "filter[territory]": args.territory?.toUpperCase(),
      "exists[publishedResponse]": args.unanswered ? "false" : undefined,
      sort: args.sort,
      include: "response",
      limit: args.limit,
    });
    if (!doc.data.length) return `No reviews for ${ref.name} match.`;
    const included = new Included(doc.included);
    const out = [`${ref.name}: ${plural(doc.data.length, "review")}${doc.meta?.paging?.total ? ` of ${doc.meta.paging.total}` : ""}`];
    for (const r of doc.data) {
      const a = r.attributes ?? {};
      out.push(`- ${"★".repeat(a.rating ?? 0)}${"☆".repeat(5 - (a.rating ?? 0))} "${a.title ?? ""}" · ${a.reviewerNickname ?? "?"} · ${a.territory ?? "?"} · ${when(a.createdDate)} · id ${r.id}`);
      out.push(`    ${truncate(a.body, 600)}`);
      const response = included.one<CustomerReviewResponseAttributes>(r, "response", "customerReviewResponses");
      if (response) out.push(`    ↳ your reply (${response.attributes?.state}): ${truncate(response.attributes?.responseBody, 300)}`);
    }
    return out.join("\n");
  },
});

export const replyToReview = defineTool({
  name: "reply_to_review",
  title: "Reply to a customer review",
  description:
    "Publishes a developer reply to a customer review. Replies are public, so this is a dry run until confirmed. A review has at most one reply; to change an existing one pass replace: true, which overwrites it.",
  kind: "destructive",
  input: {
    review_id: z.string().describe("Review ID from get_reviews."),
    text: z.string().min(1).max(5970),
    replace: z.boolean().default(false),
  },
  async run(args, ctx) {
    const review = await ctx.asc.get<Resource<CustomerReviewAttributes>>(`/v1/customerReviews/${args.review_id}`, { include: "response" }).catch((error) => {
      if (error instanceof AscApiError && error.status === 404) throw new UserError(`No review ${args.review_id}.`);
      throw error;
    });
    const existing = new Included(review.included).one<CustomerReviewResponseAttributes>(review.data, "response", "customerReviewResponses");
    const label = `"${truncate(review.data.attributes?.title, 60)}" (${review.data.attributes?.rating}★, ${review.data.attributes?.reviewerNickname})`;
    if (existing?.attributes?.responseBody === args.text) return `The reply to ${label} already says this. Nothing to do.`;
    if (existing && !args.replace) {
      return `${label} already has a reply (${existing.attributes?.state}): "${truncate(existing.attributes?.responseBody, 300)}"\nPass replace: true to replace it.`;
    }
    if (ctx.dryRun) return `Would ${existing ? "replace the reply to" : "reply to"} ${label} with: "${truncate(args.text, 300)}"`;
    // Apple overwrites an existing reply on POST. Deleting first would leave no reply if the POST failed.
    const created = await ctx.asc.post<Resource<CustomerReviewResponseAttributes>>("/v1/customerReviewResponses", {
      data: { type: "customerReviewResponses", attributes: { responseBody: args.text }, relationships: { review: linkage("customerReviews", args.review_id) } },
    });
    return `${existing ? "Replaced the reply to" : "Replied to"} ${label}. State: ${created?.data.attributes?.state ?? "PENDING_PUBLISH"} (Apple publishes replies after a short check).`;
  },
});

// ---------------------------------------------------------------------------------------------

export const downloadReport = defineTool({
  name: "download_report",
  title: "Download a sales or finance report",
  description:
    "Downloads a sales or finance report (Apple returns gzipped TSV), optionally saves it, and returns the row count, columns, simple totals and the first rows. " +
    "Needs the vendor number (App Store Connect > Payments and Financial Reports) as vendor_number or ASC_VENDOR_NUMBER, and a key with the Finance or Sales role.",
  kind: "read",
  input: {
    kind: z.enum(["sales", "finance"]).default("sales"),
    report_date: z.string().describe("Sales: YYYY-MM-DD (daily/weekly), YYYY-MM (monthly) or YYYY (yearly). Finance: fiscal month YYYY-MM."),
    report_type: z
      .enum(["SALES", "PRE_ORDER", "NEWSSTAND", "SUBSCRIPTION", "SUBSCRIPTION_EVENT", "SUBSCRIBER", "SUBSCRIPTION_OFFER_CODE_REDEMPTION", "INSTALLS", "FIRST_ANNUAL", "WIN_BACK_ELIGIBILITY", "FINANCIAL", "FINANCE_DETAIL"])
      .optional()
      .describe("Default SALES for sales, FINANCIAL for finance."),
    report_sub_type: z.enum(["SUMMARY", "DETAILED", "SUMMARY_INSTALL_TYPE", "SUMMARY_TERRITORY", "SUMMARY_CHANNEL"]).default("SUMMARY"),
    frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]).default("DAILY"),
    version: z.string().optional().describe("Report format version, e.g. 1_0 or 1_4. Apple's error says which version it wants if this is wrong."),
    region_code: z.string().optional().describe("Finance only: region, e.g. US, EU. Default: ZZ (all regions) for FINANCIAL, Z1 for FINANCE_DETAIL, which only accepts Z1."),
    vendor_number: z.string().optional(),
    save_to: z.string().optional().describe("Absolute path to save the uncompressed TSV."),
    rows: z.number().int().min(0).max(200).default(20).describe("How many rows to show."),
  },
  async run(args, ctx) {
    const vendor = args.vendor_number ?? ctx.config.vendorNumber;
    if (!vendor) throw new UserError("Pass vendor_number or set ASC_VENDOR_NUMBER (App Store Connect > Payments and Financial Reports, top left).");
    const finance = args.kind === "finance";
    const financeType = args.report_type ?? "FINANCIAL";
    const query = finance
      ? {
          "filter[vendorNumber]": vendor,
          "filter[reportType]": financeType,
          "filter[regionCode]": args.region_code ?? (financeType === "FINANCE_DETAIL" ? "Z1" : "ZZ"),
          "filter[reportDate]": args.report_date,
        }
      : {
          "filter[vendorNumber]": vendor,
          "filter[reportType]": args.report_type ?? "SALES",
          "filter[reportSubType]": args.report_sub_type,
          "filter[frequency]": args.frequency,
          "filter[reportDate]": args.report_date,
          "filter[version]": args.version,
        };
    let gz: Buffer;
    try {
      gz = await ctx.asc.getBinary(finance ? "/v1/financeReports" : "/v1/salesReports", query, "application/a-gzip", ctx.signal);
    } catch (error) {
      if (error instanceof AscApiError && error.status === 404) {
        throw new UserError(`No ${args.kind} report for ${args.report_date}. Apple publishes daily reports the next day (Pacific time), and nothing exists for days without activity.\n${error.message}`);
      }
      throw error;
    }
    const tsv = (gz[0] === 0x1f && gz[1] === 0x8b ? gunzipSync(gz) : gz).toString("utf8");
    if (args.save_to) await writeFile(args.save_to, tsv);
    return summarizeTsv(tsv, args.rows, args.save_to);
  },
});

export function summarizeTsv(tsv: string, rows: number, savedTo?: string): string {
  const lines = tsv.split(/\r?\n/).filter((l) => l.trim());
  const [header, ...data] = lines;
  if (!header) return "The report is empty.";
  const columns = header.split("\t");
  const out = [`${plural(data.length, "row")}${savedTo ? `, saved to ${savedTo}` : ""}`, `Columns: ${columns.join(", ")}`];

  const col = (name: string) => columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());
  const units = col("Units");
  if (units >= 0) out.push(`Total units: ${data.reduce((sum, l) => sum + (Number(l.split("\t")[units]) || 0), 0)}`);
  const proceeds = col("Developer Proceeds");
  const currency = col("Currency of Proceeds");
  if (proceeds >= 0 && units >= 0) {
    const byCurrency = new Map<string, number>();
    for (const l of data) {
      const cells = l.split("\t");
      const amount = (Number(cells[proceeds]) || 0) * (Number(cells[units]) || 0);
      const cur = currency >= 0 ? (cells[currency] ?? "?") : "?";
      byCurrency.set(cur, (byCurrency.get(cur) ?? 0) + amount);
    }
    out.push(`Developer proceeds: ${[...byCurrency].filter(([, v]) => v).map(([c, v]) => `${v.toFixed(2)} ${c}`).join(", ") || "0"}`);
  }
  if (rows > 0) {
    out.push("", header, ...data.slice(0, rows));
    if (data.length > rows) out.push(`… ${data.length - rows} more rows${savedTo ? "" : " (pass save_to to keep the whole file)"}`);
  }
  return out.join("\n");
}
