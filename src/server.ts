import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TokenProvider } from "./asc/auth.js";
import { AscClient } from "./asc/client.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { registerTools, type Runtime, type Services } from "./tools/framework.js";
import type { AnyTool } from "./tools/framework.js";
import { TOOLS } from "./tools/index.js";
import { selectTools } from "./tools/select.js";

export type ServerRuntime = Runtime & {
  config?: Config;
  configError?: ConfigError;
  /** The tools to expose, after ASC_TOOLS and ASC_DISABLED_TOOLS. Defaults to every tool. */
  tools?: readonly AnyTool[];
  disabledTools?: readonly string[];
  /** Extra lines for the agent, e.g. that the server was just updated. */
  notices?: string[];
};

export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

/** Builds the runtime from environment variables. A bad config doesn't stop the server; tools report it. */
export function runtimeFromEnv(env: NodeJS.ProcessEnv = process.env): ServerRuntime {
  let services: Services | undefined;
  let configError: ConfigError | undefined;
  let config: Config | undefined;
  try {
    config = loadConfig(env);
    const tokens = new TokenProvider({ keyId: config.keyId, issuerId: config.issuerId, privateKey: config.privateKey });
    services = { config, asc: new AscClient({ baseUrl: config.baseUrl, tokens }) };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    configError = error;
  }
  const selection = selectTools(env, TOOLS);
  if (selection.error) {
    // An invalid tool selection fails closed: every tool refuses until it's fixed.
    configError = selection.error;
    services = undefined;
  }
  return {
    config,
    configError,
    tools: selection.tools,
    disabledTools: selection.disabled,
    services() {
      if (!services) throw configError!;
      return services;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

export function createServer(runtime: ServerRuntime): McpServer {
  const tools = runtime.tools ?? TOOLS;
  const disabled = runtime.disabledTools ?? [];
  const mode = runtime.configError
    ? `NOT CONFIGURED: ${runtime.configError.message}`
    : runtime.config?.write
      ? "Writes are ENABLED (ASC_WRITE=1)."
      : "Read-only: write tools only return plans (dry runs) until the user restarts the server with ASC_WRITE=1.";
  const server = new McpServer(
    { name: "app-store-connect", version: VERSION },
    {
      instructions: [
        "Manage apps in Apple's App Store Connect: TestFlight builds and testers, store listing, screenshots, subscriptions, App Review submission, customer reviews and reports.",
        mode,
        ...(runtime.notices ?? []),
        ...(disabled.length ? [`The user turned off these tools (ASC_TOOLS / ASC_DISABLED_TOOLS): ${disabled.join(", ")}. Don't work around them with asc_request.`] : []),
        "Start with list_apps or get_app_status. Tools take an app ID, bundle ID or name; ASC_APP_ID sets a default.",
        "Prefer the workflow tools (distribute_build, replace_screenshot, upload_screenshots, update_listing, submit_for_review…) over asc_request: they check state first and are safe to re-run.",
        "Destructive tools (deleting screenshots, offers or testers, submitting for review) default to dry_run: true. Show the user the plan, then call again with dry_run: false.",
        "Apple processes builds and images asynchronously. When a tool says something is still processing, call it again with the same arguments later; finished steps are skipped.",
      ].join("\n"),
    },
  );
  registerTools(server, tools, runtime);
  return server;
}
