/**
 * Opt-in tests against the real App Store Connect API. They never run by default.
 *
 *   ASC_LIVE_TEST=1 ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_PATH=… ASC_LIVE_APP_ID=… npm run test:live
 *
 * Without ASC_WRITE=1 everything here is read-only or a dry run. With ASC_WRITE=1 and
 * ASC_LIVE_WRITE=1, it also round-trips the promotional text of the app's live version (setting
 * it, then restoring the original). Use a sandbox app you don't mind touching.
 * Set ASC_LIVE_SCREENSHOT to an image path to also exercise replace_screenshot as a dry run.
 */
import { describe, expect, it } from "vitest";
import { invoke, inputShape } from "../../src/tools/framework.js";
import { TOOLS } from "../../src/tools/index.js";
import { runtimeFromEnv } from "../../src/server.js";
import { z } from "zod";

const live = process.env.ASC_LIVE_TEST === "1";
const app = process.env.ASC_LIVE_APP_ID;
const runtime = live ? runtimeFromEnv() : undefined;

async function call(name: string, args: Record<string, unknown> = {}) {
  const tool = TOOLS.find((t) => t.name === name)!;
  const result = await invoke(tool, z.object(inputShape(tool)).parse(args), runtime!);
  const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  if (process.env.ASC_LIVE_VERBOSE) console.log(`\n## ${name} ${JSON.stringify(args)}\n${text}`);
  return { text, isError: result.isError === true };
}

describe.skipIf(!live)("live App Store Connect (read-only)", () => {
  it("authenticates and lists apps", async () => {
    const { text, isError } = await call("list_apps");
    expect(isError, text).toBe(false);
    expect(text).toMatch(/app/);
  });

  it.skipIf(!app).each([
    ["get_app_status", {}],
    ["list_builds", { limit: 3 }],
    ["get_build", {}],
    ["list_beta_groups", {}],
    ["list_testers", {}],
    ["get_listing", {}],
    ["list_screenshots", { locale: "all" }],
    ["list_subscriptions", {}],
    ["get_reviews", { limit: 3 }],
  ] as const)("%s", async (name, args) => {
    const { text, isError } = await call(name, { app, ...args });
    expect(isError, text).toBe(false);
  });

  it.skipIf(!app)("distribute_build dry run plans without changing anything", async () => {
    const { text } = await call("distribute_build", { app, dry_run: true });
    expect(text).toContain("DRY RUN");
  });

  it.skipIf(!app || !process.env.ASC_LIVE_SCREENSHOT)("replace_screenshot dry run", async () => {
    const { text } = await call("replace_screenshot", { app, display_type: process.env.ASC_LIVE_DISPLAY_TYPE ?? "APP_IPHONE_67", position: 1, file: process.env.ASC_LIVE_SCREENSHOT });
    expect(text).toContain("DRY RUN");
  });
});

describe.skipIf(!live || !app || process.env.ASC_LIVE_WRITE !== "1" || !runtime?.config?.write)("live App Store Connect (writes)", () => {
  it("round-trips promotional text on the live version", async () => {
    const before = await call("get_listing", { app, version: "live" });
    const original = /promotional text \(\d+\/170\): (.*)/.exec(before.text)?.[1];
    const marker = `Live test ${new Date().toISOString().slice(0, 16)}`;
    const set = await call("update_listing", { app, version: "live", promotional_text: marker });
    expect(set.isError, set.text).toBe(false);
    const restore = await call("update_listing", { app, version: "live", promotional_text: original === "empty" ? "" : (original ?? "") });
    expect(restore.isError, restore.text).toBe(false);
  });
});
