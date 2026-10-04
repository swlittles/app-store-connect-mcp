#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, runtimeFromEnv, VERSION } from "./server.js";

const args = process.argv.slice(2);

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

Flags:
  --check             Verify the credentials by listing the apps the key can see, then exit
  --version, --help`);
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
    for (const app of data) console.log(`  ${app.attributes?.name} (${app.attributes?.bundleId}) id ${app.id}`);
    if (asc.rateLimit.remaining !== undefined) console.log(`Rate limit: ${asc.rateLimit.remaining} of ${asc.rateLimit.limit} requests left this hour.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
} else {
  const server = createServer(runtimeFromEnv());
  await server.connect(new StdioServerTransport());
}
