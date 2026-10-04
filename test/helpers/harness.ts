import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { TokenProvider } from "../../src/asc/auth.js";
import { AscClient } from "../../src/asc/client.js";
import type { Config } from "../../src/config.js";
import { inputShape, invoke, type Runtime } from "../../src/tools/framework.js";
import { TOOLS } from "../../src/tools/index.js";
import { clearLookupCache } from "../../src/tools/lookup.js";
import { FakeAsc } from "./fake-asc.js";

export const APP_ID = "1000000001";

/** Every fake created in the current test; test/setup.ts fails the test if any saw an off-spec request. */
export const activeFakes: FakeAsc[] = [];

export interface Harness {
  fake: FakeAsc;
  asc: AscClient;
  config: Config;
  clock: { now: number; onTick: ((now: number) => void)[] };
  runtime: Runtime;
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

export function makeHarness(options: { write?: boolean } = {}): Harness {
  clearLookupCache();
  const fake = new FakeAsc();
  activeFakes.push(fake);
  // A throwaway key generated per test run; no key material is ever committed.
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const config: Config = {
    keyId: "TESTKEY123",
    issuerId: "00000000-0000-0000-0000-000000000000",
    privateKey,
    write: options.write ?? true,
    defaultAppId: APP_ID,
    baseUrl: "https://api.appstoreconnect.apple.com",
  };
  const clock = { now: Date.parse("2026-10-01T12:00:00Z"), onTick: [] as ((now: number) => void)[] };
  const sleep = async (ms: number) => {
    clock.now += ms;
    for (const tick of clock.onTick) tick(clock.now);
  };
  const asc = new AscClient({
    baseUrl: config.baseUrl,
    tokens: new TokenProvider({ keyId: config.keyId, issuerId: config.issuerId, privateKey, now: () => clock.now }),
    fetch: fake.fetch,
    sleep,
    random: () => 0.5,
  });
  const runtime: Runtime = { services: () => ({ asc, config }), sleep, now: () => clock.now };
  return {
    fake,
    asc,
    config,
    clock,
    runtime,
    async call(name, args = {}) {
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) throw new Error(`No tool ${name}`);
      // Validate and apply defaults the way the MCP SDK does.
      const parsed = z.object(inputShape(tool)).strict().parse(args);
      const result = await invoke(tool, parsed, runtime);
      const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      return { text, isError: result.isError === true };
    },
  };
}

/** A minimal PNG header with the given size; `seed` changes the bytes (and so the MD5). */
export function makePng(width: number, height: number, seed: string): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(0x89504e47, 0);
  header.writeUInt32BE(0x0d0a1a0a, 4);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.from(`fake image ${seed}`.repeat(50))]);
}

export function tempImages(names: string[], width = 1320, height = 2868): string[] {
  const dir = mkdtempSync(join(tmpdir(), "asc-test-"));
  return names.map((name) => {
    const path = join(dir, name);
    writeFileSync(path, makePng(width, height, name));
    return path;
  });
}
