#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, runtimeFromEnv, VERSION } from "./server.js";
import { checkForUpdate, describeResult, installRoot, lastUpdateResult, updateSettings } from "./update.js";

const args = process.argv.slice(2);
const update = updateSettings(process.env);

if (args.includes("--version") || args.includes("-v")) {
  console.log(VERSION);
} else if (args.includes("--help") || args.includes("-h")) {
  console.log(`app-store-connect-mcp ${VERSION}: an MCP server for App Store Connect (stdio).

Environment:
  ASC_KEY_ID          API key ID (required)
  ASC_ISSUER_ID       Issuer ID (team keys; leave unset for an individual key)
  ASC_KEY_PATH        Path to the AuthKey_XXXX.p8 file (or ASC_KEY with the PEM contents)
  ASC_WRITE=1         Allow changes. Without it the server is read-only.
  ASC_APP_ID          Default app (ID, bundle ID or name)
  ASC_VENDOR_NUMBER   Vendor number for sales and finance reports
  ASC_TOOLS           Only these tools or groups (default: all), e.g. "read,testflight"
  ASC_DISABLED_TOOLS  Turn off these tools or groups, e.g. "destructive,raw"
  ASC_AUTO_UPDATE=0   Turn off automatic updates from GitHub (on by default)
  ASC_UPDATE_CHANNEL  "release" (default: the latest GitHub release) or "main"

Optional Apple Ads keyword research (docs/apple-ads-key.md):
  ADS_CLIENT_ID, ADS_TEAM_ID, ADS_KEY_ID, ADS_KEY_PATH (or ADS_KEY), ADS_AD_ACCOUNT_ID
                      Groups: all, read, destructive, testflight, listing, screenshots,
                      release, subscriptions, reviews, raw

Flags:
  --check             Verify the credentials by listing the apps the key can see, then exit
  --update            Update to the latest version now, then exit
  --version, --help`);
} else if (args.includes("--update")) {
  const result = await checkForUpdate({ root: installRoot(), channel: update.channel, force: true, log: (m) => console.log(m) });
  console.log(describeResult(result, { ...update, enabled: true }));
  process.exit(result.status === "failed" ? 1 : 0);
} else if (args.includes("--check")) {
  const runtime = runtimeFromEnv();
  if (runtime.configError) {
    console.error(runtime.configError.message);
    process.exit(1);
  }
  const { asc, config } = runtime.services();
  try {
    const { data } = await asc.getAll<{ name?: string; bundleId?: string }>("/v1/apps", { "fields[apps]": "name,bundleId" }, { max: 50 });
    console.log(`OK: key ${config.keyId} can see ${data.length} app(s). Writes ${config.write ? "enabled" : "disabled (read-only)"}.`);
    const enabled = runtime.tools?.length ?? 0;
    const off = runtime.disabledTools ?? [];
    console.log(`Tools: ${enabled} enabled${off.length ? `; turned off: ${off.join(", ")}` : " (all)"}.`);
    for (const app of data) console.log(`  ${app.attributes?.name} (${app.attributes?.bundleId}) id ${app.id}`);
    if (asc.rateLimit.remaining !== undefined) console.log(`Rate limit: ${asc.rateLimit.remaining} of ${asc.rateLimit.limit} requests left this hour.`);
    console.log(`Version ${VERSION}. ${describeResult(await lastUpdateResult(installRoot()), update)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
} else {
  const runtime = runtimeFromEnv();
  const last = update.enabled ? await lastUpdateResult(installRoot()).catch(() => undefined) : undefined;
  // Tell the agent about an update that just happened, or one that failed and needs attention.
  if (last && (last.status === "failed" || (last.status === "updated" && Date.now() - Date.parse(last.at) < 24 * 3600_000))) {
    runtime.notices = [describeResult(last, update)];
  }
  const server = createServer(runtime);
  await server.connect(new StdioServerTransport());
  if (update.enabled) {
    // Update in the background after startup; the new version is used from the next start.
    setTimeout(() => {
      checkForUpdate({ root: installRoot(), channel: update.channel, log: (m) => console.error(m) }).catch(() => {});
    }, 2_000).unref();
  }
}
