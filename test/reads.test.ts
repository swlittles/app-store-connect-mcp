import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/tools/index.js";
import { seedApp, seedTestFlight, seedVersion } from "./helpers/fixtures.js";
import { APP_ID, makeHarness } from "./helpers/harness.js";

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
    expect(names.size).toBe(31);
  });
});
