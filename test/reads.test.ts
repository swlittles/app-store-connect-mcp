import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/tools/index.js";
import { seedApp, seedTestFlight, seedVersion } from "./helpers/fixtures.js";
import { APP_ID, makeHarness, type Harness } from "./helpers/harness.js";
import { invoke, type Runtime } from "../src/tools/framework.js";
import { getRatings } from "../src/tools/reviews.js";

describe("read tools", () => {
  it("get_app_status summarizes versions, builds and submissions", async () => {
    const h = makeHarness();
    seedApp(h.fake);
    seedVersion(h.fake);
    seedTestFlight(h.fake);
    h.fake.add("buildUploads", "up-1", { cfBundleVersion: "202610011200", cfBundleShortVersionString: "1.0", platform: "IOS", state: { state: "PROCESSING" } }, { app: APP_ID });
    const { text, isError } = await h.call("get_app_status", {});
    expect(isError, text).toBe(false);
    expect(text).toContain("Example App · id 1000000001 · com.example.app");
    expect(text).toContain("- IOS 1.0 · PREPARE_FOR_SUBMISSION · no build attached");
    expect(text).toContain("build 202610010900 (v1.0)");
    expect(text).toContain("1.0 (202610011200) · PROCESSING");
  });

  it("list_beta_groups shows type, public link and tester counts", async () => {
    const h = makeHarness();
    seedApp(h.fake);
    seedTestFlight(h.fake);
    h.fake.add("betaTesters", "t1", { email: "a@example.com" }, { betaGroups: ["grp-friends"] });
    const { text } = await h.call("list_beta_groups", {});
    expect(text).toContain('- "Friends" · external · feedback on · 1 tester · id grp-friends');
    expect(text).toContain("public link https://testflight.apple.com/join/EXAMPLE1");
    expect(text).toContain('- "Internal" · internal · gets all builds');
  });

  it("resolves apps by bundle ID and name, and asks when ambiguous", async () => {
    const h = makeHarness();
    h.config.defaultAppId = undefined;
    seedApp(h.fake);
    expect((await h.call("get_app_status", { app: "com.example.other" })).text).toContain("Other App · id 1000000002");
    expect((await h.call("get_app_status", { app: "Other App" })).text).toContain("id 1000000002");
    const ambiguous = await h.call("list_builds", {});
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain("Which app?");
  });

  it("every tool has a description and only write tools take dry_run", () => {
    const names = new Set<string>();
    for (const tool of TOOLS) {
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);
      expect(tool.description.length).toBeGreaterThan(40);
      expect("dry_run" in tool.input).toBe(false);
    }
    expect(names.size).toBe(32);
  });
});

describe("get_ratings", () => {
  const lookup = (byCountry: Record<string, object | undefined>, seen: string[] = []): typeof fetch =>
    async (input) => {
      const url = new URL(String(input));
      seen.push(url.toString());
      const result = byCountry[url.searchParams.get("country") ?? ""];
      return new Response(JSON.stringify({ resultCount: result ? 1 : 0, results: result ? [result] : [] }), { status: 200 });
    };
  const call = async (h: Harness, fetchImpl: typeof fetch, args: Record<string, unknown> = {}) => {
    const runtime: Runtime = { ...h.runtime, fetch: fetchImpl };
    const result = await invoke(getRatings, { countries: ["us"], ...args }, runtime);
    return { text: result.content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: result.isError === true };
  };

  it("shows overall and current-version ratings per country", async () => {
    const h = makeHarness();
    seedApp(h.fake);
    const seen: string[] = [];
    const fetchImpl = lookup(
      {
        us: { version: "1.1", averageUserRating: 4.6667, userRatingCount: 12, averageUserRatingForCurrentVersion: 5, userRatingCountForCurrentVersion: 3 },
        gb: { version: "1.1", averageUserRating: 0, userRatingCount: 0 },
      },
      seen,
    );
    const { text, isError } = await call(h, fetchImpl, { countries: ["US", "gb", "de"] });
    expect(isError, text).toBe(false);
    expect(text).toContain("US: 4.7★ from 12 ratings; version 1.1: 5.0★ from 3 ratings");
    expect(text).toContain("GB: no ratings yet.");
    expect(text).toContain("DE: not on the App Store in this country");
    expect(seen[0]).toBe(`https://itunes.apple.com/lookup?id=${APP_ID}&country=us`);
    // The public lookup never gets the App Store Connect token.
    expect(h.fake.requests.some((r) => r.path.includes("lookup"))).toBe(false);
  });

  it("reports a failed lookup without failing the other countries", async () => {
    const h = makeHarness();
    seedApp(h.fake);
    const fetchImpl: typeof fetch = async (input) =>
      new URL(String(input)).searchParams.get("country") === "us"
        ? new Response("busy", { status: 503 })
        : new Response(JSON.stringify({ results: [{ averageUserRating: 4, userRatingCount: 1 }] }), { status: 200 });
    const { text, isError } = await call(h, fetchImpl, { countries: ["us", "ca"] });
    expect(isError).toBe(false);
    expect(text).toContain("US: couldn't reach the App Store lookup (HTTP 503)");
    expect(text).toContain("CA: 4.0★ from 1 rating");
  });
});
