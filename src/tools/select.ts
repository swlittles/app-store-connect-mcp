import { ConfigError } from "../config.js";
import type { AnyTool } from "./framework.js";

/**
 * Named groups for ASC_TOOLS and ASC_DISABLED_TOOLS. The area groups cover the tools that change
 * things; "read" and "destructive" are worked out from each tool's kind.
 */
export const AREA_GROUPS: Record<string, readonly string[]> = {
  testflight: ["upload_build", "distribute_build", "create_beta_group", "invite_testers", "remove_testers"],
  listing: ["update_listing", "set_whats_new", "update_age_rating"],
  screenshots: ["upload_screenshots", "replace_screenshot", "reorder_screenshots", "delete_screenshots"],
  release: ["prepare_version", "set_review_details", "submit_for_review", "cancel_review_submission"],
  subscriptions: ["remove_intro_offers", "add_free_trial"],
  reviews: ["reply_to_review"],
  raw: ["asc_request"],
  ads: ["ads_status", "keyword_popularity", "search_term_trends", "keyword_suggestions"],
};

export function toolGroups(tools: readonly AnyTool[]): Record<string, string[]> {
  return {
    all: tools.map((t) => t.name),
    read: tools.filter((t) => t.kind === "read" && !t.gatesOwnWrites).map((t) => t.name),
    destructive: tools.filter((t) => t.kind === "destructive" || t.gatesOwnWrites).map((t) => t.name),
    ...Object.fromEntries(Object.entries(AREA_GROUPS).map(([k, v]) => [k, [...v]])),
  };
}

export interface ToolSelection {
  tools: AnyTool[];
  /** Names of tools turned off, for --check and the server instructions. */
  disabled: string[];
  /** Set when ASC_TOOLS or ASC_DISABLED_TOOLS has an entry that isn't a tool or group. */
  error?: ConfigError;
}

/**
 * Applies ASC_TOOLS (an allowlist, default everything) and then ASC_DISABLED_TOOLS (a denylist).
 * Entries are tool names or group names, separated by commas or spaces.
 */
export function selectTools(env: NodeJS.ProcessEnv, tools: readonly AnyTool[]): ToolSelection {
  const groups = toolGroups(tools);
  const names = new Set(tools.map((t) => t.name));
  const unknown: string[] = [];
  const expand = (variable: string, value: string): Set<string> => {
    const out = new Set<string>();
    for (const entry of value.split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)) {
      if (groups[entry]) groups[entry].forEach((n) => out.add(n));
      else if (names.has(entry)) out.add(entry);
      else unknown.push(`${variable}: ${entry}`);
    }
    return out;
  };

  const allowed = env.ASC_TOOLS?.trim() ? expand("ASC_TOOLS", env.ASC_TOOLS) : new Set(names);
  const denied = env.ASC_DISABLED_TOOLS?.trim() ? expand("ASC_DISABLED_TOOLS", env.ASC_DISABLED_TOOLS) : new Set<string>();
  const enabled = tools.filter((t) => allowed.has(t.name) && !denied.has(t.name));
  const disabled = tools.filter((t) => !enabled.includes(t)).map((t) => t.name);

  if (unknown.length) {
    // Fail closed: a typo in a denylist must not leave a tool switched on.
    return {
      tools: [...tools],
      disabled,
      error: new ConfigError(
        `Unknown tool or group in ${unknown.join(", ")}. Groups: ${Object.keys(groups).join(", ")}. ` +
          "Tool names are listed in the README. Every tool is refusing to run until this is fixed.",
      ),
    };
  }
  return { tools: enabled, disabled };
}
