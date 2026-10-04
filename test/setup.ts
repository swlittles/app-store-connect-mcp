import { afterEach, expect } from "vitest";
import { activeFakes } from "./helpers/harness.js";

// Every request a tool makes must exist in Apple's OpenAPI spec, including ones whose errors a
// tool deliberately swallows.
afterEach(() => {
  const violations = activeFakes.flatMap((f) => f.specViolations);
  activeFakes.length = 0;
  expect(violations, "requests that aren't in the App Store Connect API spec").toEqual([]);
});
