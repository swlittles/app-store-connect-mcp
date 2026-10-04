import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer, runtimeFromEnv } from "../src/server.js";
import { TOOLS } from "../src/tools/index.js";
import { AREA_GROUPS, selectTools, toolGroups } from "../src/tools/select.js";
import { seedApp } from "./helpers/fixtures.js";
import { makeHarness } from "./helpers/harness.js";

const names = (env: NodeJS.ProcessEnv) => selectTools(env, TOOLS).tools.map((t) => t.name);

describe("tool groups", () => {
  it("put every tool in exactly one of read or an area group", () => {
    const groups = toolGroups(TOOLS);
    const placed = [...groups.read!, ...Object.values(AREA_GROUPS).flat()];
    expect(placed.sort()).toEqual(TOOLS.map((t) => t.name).sort());
    expect(new Set(placed).size).toBe(placed.length);
  });
});

describe("selectTools", () => {
  it("enables everything by default", () => {
    expect(names({})).toHaveLength(TOOLS.length);
  });

  it("ASC_TOOLS=read leaves only tools that can't change anything", () => {
    const tools = selectTools({ ASC_TOOLS: "read" }, TOOLS).tools;
    expect(tools.length).toBe(11);
    expect(tools.every((t) => t.kind === "read" && !t.gatesOwnWrites)).toBe(true);
  });

  it("combines groups and tool names, separated by commas or spaces", () => {
    expect(names({ ASC_TOOLS: "read, testflight replace_screenshot" })).toEqual(
      expect.arrayContaining(["list_apps", "distribute_build", "invite_testers", "replace_screenshot"]),
    );
    expect(names({ ASC_TOOLS: "read, testflight replace_screenshot" })).not.toContain("upload_screenshots");
  });

  it("ASC_DISABLED_TOOLS removes tools after the allowlist", () => {
    const tools = names({ ASC_DISABLED_TOOLS: "destructive" });
    expect(tools).not.toContain("submit_for_review");
    expect(tools).not.toContain("asc_request");
    expect(tools).toContain("distribute_build");
    expect(names({ ASC_TOOLS: "read", ASC_DISABLED_TOOLS: "Download_Report" })).not.toContain("download_report");
  });

  it("fails closed on a typo", () => {
    const selection = selectTools({ ASC_DISABLED_TOOLS: "submit_for_reveiw" }, TOOLS);
    expect(selection.error?.message).toContain("Unknown tool or group in ASC_DISABLED_TOOLS: submit_for_reveiw");
    const runtime = runtimeFromEnv({ ASC_DISABLED_TOOLS: "submit_for_reveiw" });
    expect(() => runtime.services()).toThrow(/Unknown tool or group/);
  });
});

describe("over MCP", () => {
  it("hides disabled tools from the agent and refuses calls to them", async () => {
    const h = makeHarness();
    seedApp(h.fake);
    const { tools, disabled } = selectTools({ ASC_TOOLS: "read", ASC_DISABLED_TOOLS: "get_reviews" }, TOOLS);
    const server = createServer({ ...h.runtime, config: h.config, tools, disabledTools: disabled });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);

    const listed = (await client.listTools()).tools.map((t) => t.name);
    expect(listed).toHaveLength(10);
    expect(listed).not.toContain("distribute_build");
    expect(client.getInstructions()).toContain("turned off these tools");
    const call = await client.callTool({ name: "distribute_build", arguments: {} }).catch((error: Error) => ({ isError: true, content: [{ type: "text", text: error.message }] }));
    expect(call.isError).toBe(true);
    expect(JSON.stringify(call.content)).toMatch(/not found/i);
    expect(h.fake.requests).toEqual([]);
  });
});
