#!/usr/bin/env node
// Calls one tool on the built server over stdio, the way an MCP client does. For trying tools
// against a real account during development:
//
//   npm run build && node scripts/call-tool.mjs list_apps '{}'
//   node scripts/call-tool.mjs --list            # tool names and annotations
//
// Reads the same ASC_* environment variables as the server.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [name, json = "{}"] = process.argv.slice(2);
if (!name) {
  console.error("Usage: node scripts/call-tool.mjs <tool> '<json arguments>' | --list");
  process.exit(2);
}
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: process.env, stderr: "inherit" });
const client = new Client({ name: "call-tool", version: "1" });
await client.connect(transport);
try {
  if (name === "--list") {
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`${t.name}${t.annotations?.readOnlyHint ? "" : t.annotations?.destructiveHint ? " (destructive)" : " (write)"}`);
  } else {
    const started = Date.now();
    const result = await client.callTool({ name, arguments: JSON.parse(json) }, undefined, {
      timeout: 40 * 60_000,
      resetTimeoutOnProgress: true,
      onprogress: (p) => console.error(`  … ${p.message ?? p.progress}`),
    });
    for (const c of result.content) if (c.type === "text") console.log(c.text);
    console.error(`[${name}: ${result.isError ? "ERROR" : "ok"} in ${((Date.now() - started) / 1000).toFixed(1)}s]`);
    process.exitCode = result.isError ? 1 : 0;
  }
} finally {
  await client.close();
}
