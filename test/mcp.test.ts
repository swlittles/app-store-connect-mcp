import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { finishProcessingAt, seedApp, seedTestFlight } from "./helpers/fixtures.js";
import { makeHarness } from "./helpers/harness.js";

async function connect(write = true) {
  const h = makeHarness({ write });
  seedApp(h.fake);
  const server = createServer({ ...h.runtime, config: h.config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { h, client };
}

describe("over MCP", () => {
  it("lists every tool with annotations and dry_run only on write tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("list_apps")!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get("replace_screenshot")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get("list_apps")!.inputSchema.properties).not.toHaveProperty("dry_run");
    expect(byName.get("distribute_build")!.inputSchema.properties).toHaveProperty("dry_run");
    expect(client.getInstructions()).toContain("Writes are ENABLED");
  });

  it("validates input before calling the API", async () => {
    const { client, h } = await connect();
    const result = await client.callTool({ name: "replace_screenshot", arguments: { display_type: "APP_IPHONE_99", position: 1, file: "/x.png" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Must be one of");
    expect(h.fake.requests).toEqual([]);
  });

  it("sends progress notifications while waiting for processing", async () => {
    const { client, h } = await connect();
    seedTestFlight(h.fake, { processing: true });
    finishProcessingAt(h, h.clock.now + 2 * 60_000);
    const messages: string[] = [];
    const result = await client.callTool(
      { name: "distribute_build", arguments: { groups: ["Friends"], wait_minutes: 5, uses_non_exempt_encryption: false } },
      undefined,
      { onprogress: (p) => void messages.push(p.message ?? "") },
    );
    expect(result.isError).toBeFalsy();
    expect(messages.some((m) => m.startsWith("Waiting for Apple to process build"))).toBe(true);
  });

  it("tells the agent how to enable writes in read-only mode", async () => {
    const { client } = await connect(false);
    expect(client.getInstructions()).toContain("Read-only");
    const result = await client.callTool({ name: "create_beta_group", arguments: { name: "QA" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("ASC_WRITE=1");
  });
});
