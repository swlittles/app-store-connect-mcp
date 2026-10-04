/**
 * Opt-in tests against the real Apple Ads Platform API. Skipped unless ASC_LIVE_TEST=1 and the
 * ADS_* variables are set:
 *
 *   ASC_LIVE_TEST=1 ADS_CLIENT_ID=… ADS_TEAM_ID=… ADS_KEY_ID=… ADS_KEY_PATH=… npm run test:live
 *
 * Everything here only reads. Besides checking the tools work, it prints answers to open
 * questions about the API (set ADS_LIVE_VERBOSE=1 to see the tool output too):
 * - Does phrase SEARCH work without live apps, campaigns or a payment method?
 * - Does it score single words, and how many values does one IN filter accept?
 * - Is the API Account Read Only role enough for suggestions and insights?
 * - How do phrase scores compare with the US search-term insights (a hint at their storefront)?
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AdsApiError } from "../../src/ads/client.js";
import { runtimeFromEnv } from "../../src/server.js";
import { inputShape, invoke } from "../../src/tools/framework.js";
import { ALL_TOOLS } from "../../src/tools/index.js";

const live = process.env.ASC_LIVE_TEST === "1" && Boolean(process.env.ADS_CLIENT_ID);
const runtime = live ? runtimeFromEnv() : undefined;

async function call(name: string, args: Record<string, unknown> = {}) {
  const tool = ALL_TOOLS.find((t) => t.name === name)!;
  const result = await invoke(tool, z.object(inputShape(tool)).parse(args), runtime!);
  const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  if (process.env.ADS_LIVE_VERBOSE) console.log(`\n## ${name} ${JSON.stringify(args)}\n${text}`);
  return { text, isError: result.isError === true };
}

const finding = (question: string, answer: string) => console.log(`[Apple Ads finding] ${question}: ${answer}`);

describe.skipIf(!live)("live Apple Ads (read-only)", () => {
  it("connects and reports the account", async () => {
    const { text, isError } = await call("ads_status");
    expect(isError, text).toBe(false);
    finding("Account", text.split("\n").filter((l) => /Keyword tools use|roles:|product features/.test(l)).join(" | "));
  });

  it("scores phrases and single words", async () => {
    const { text, isError } = await call("keyword_popularity", { phrases: ["chess", "puzzle", "chess puzzle", "daily puzzle", "photo editor"] });
    expect(isError, text).toBe(false);
    finding("Phrase SEARCH with this account", isError ? "refused" : "works");
    finding("Scores for single words vs phrases", text.replace(/\n/g, " | "));
  });

  it("finds the largest IN list Apple accepts", async () => {
    const ads = runtime!.ads!();
    let largest = 0;
    for (const size of [50, 100, 200, 500, 1000]) {
      try {
        await ads.query("/suggestions/phrases/query", {
          filters: [
            { field: "queryType", operator: "EQUALS", value: ["SEARCH"] },
            { field: "phrase", operator: "IN", value: Array.from({ length: size }, (_, i) => `term ${i}`) },
          ],
          pagination: { offset: 0, pageSize: size },
        });
        largest = size;
      } catch (error) {
        finding(`IN with ${size} values`, error instanceof AdsApiError ? `HTTP ${error.status} ${error.code ?? ""}` : String(error));
        break;
      }
    }
    finding("Largest IN list accepted", String(largest));
    expect(largest).toBeGreaterThan(0);
  });

  it("reads search term insights (role check)", async () => {
    const { text, isError } = await call("search_term_trends", { genre: "GAMES", limit: 5 });
    finding("search_term_trends with this role", isError ? `refused: ${text.split("\n")[0]}` : "works");
    if (!isError) {
      const top = /\n\s+\d+\s+(\d+)\s+\d+\s+\d+\s+(.+?)(\s+\(|$)/m.exec(text);
      if (top) {
        const phrase = await call("keyword_popularity", { phrases: [top[2]!.trim()] });
        finding("US insights score vs phrase score for the same term", `"${top[2]!.trim()}": insights ${top[1]}/100, phrase search ${phrase.text.split("\n")[1]?.trim() ?? "?"}`);
      }
    }
  });

  it("tries keyword suggestions (needs a live app)", async () => {
    const app = process.env.ADS_LIVE_APP_ID;
    if (!app) return finding("keyword_suggestions", "skipped (set ADS_LIVE_APP_ID to a live App Store app ID)");
    const { text, isError } = await call("keyword_suggestions", { app, limit: 5 });
    finding("keyword_suggestions", isError ? `refused: ${text.split("\n")[0]}` : "works");
  });
});
