import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TokenProvider } from "../src/asc/auth.js";
import { AscApiError, AscClient, AscNetworkError } from "../src/asc/client.js";
import { poll, runBulk } from "../src/asc/jobs.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { checkAgainstSpec } from "./helpers/fake-asc.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

function decode(token: string) {
  const [h, p, s] = token.split(".");
  return { header: JSON.parse(Buffer.from(h!, "base64url").toString()), payload: JSON.parse(Buffer.from(p!, "base64url").toString()), signingInput: `${h}.${p}`, signature: Buffer.from(s!, "base64url") };
}

describe("TokenProvider", () => {
  it("signs a valid ES256 JWT for a team key", () => {
    let now = Date.parse("2026-10-01T00:00:00Z");
    const tokens = new TokenProvider({ keyId: "KEY123", issuerId: "issuer-uuid", privateKey, now: () => now });
    const { header, payload, signingInput, signature } = decode(tokens.token());
    expect(header).toEqual({ alg: "ES256", kid: "KEY123", typ: "JWT" });
    expect(payload.iss).toBe("issuer-uuid");
    expect(payload.aud).toBe("appstoreconnect-v1");
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(20 * 60);
    expect(signature).toHaveLength(64); // raw r||s, not DER
    expect(verify("sha256", Buffer.from(signingInput), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
    void now;
  });

  it("uses sub: user for individual keys", () => {
    const { payload } = decode(new TokenProvider({ keyId: "K", privateKey }).token());
    expect(payload.sub).toBe("user");
    expect(payload.iss).toBeUndefined();
  });

  it("caches the token and refreshes it shortly before it expires", () => {
    let now = Date.parse("2026-10-01T00:00:00Z");
    const tokens = new TokenProvider({ keyId: "K", issuerId: "I", privateKey, now: () => now });
    const first = tokens.token();
    now += 10 * 60_000;
    expect(tokens.token()).toBe(first);
    now += 8.5 * 60_000; // within a minute of the 19-minute expiry
    expect(tokens.token()).not.toBe(first);
  });
});

describe("loadConfig", () => {
  it("reads a key from a file and defaults to read-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "asc-key-"));
    writeFileSync(join(dir, "AuthKey_TEST.p8"), pem);
    const config = loadConfig({ ASC_KEY_ID: "TEST", ASC_ISSUER_ID: "issuer", ASC_KEY_PATH: join(dir, "AuthKey_TEST.p8") });
    expect(config.write).toBe(false);
    expect(config.issuerId).toBe("issuer");
  });

  it("accepts the PEM inline with escaped newlines, and ASC_WRITE=1", () => {
    const config = loadConfig({ ASC_KEY_ID: "TEST", ASC_KEY: pem.replace(/\n/g, "\\n"), ASC_WRITE: "1", ASC_APP_ID: "123" });
    expect(config.write).toBe(true);
    expect(config.defaultAppId).toBe("123");
  });

  it("explains what's missing", () => {
    expect(() => loadConfig({})).toThrow(/ASC_KEY_ID and ASC_KEY_PATH/);
  });

  it("never puts key material in errors", () => {
    const secret = "-----BEGIN PRIVATE KEY-----\nTOTALLYSECRETBYTES\n-----END PRIVATE KEY-----";
    try {
      loadConfig({ ASC_KEY_ID: "TEST", ASC_KEY: secret });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain("TOTALLYSECRETBYTES");
    }
  });
});

describe("AscClient", () => {
  const tokens = new TokenProvider({ keyId: "K", issuerId: "I", privateKey });
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  function client(responses: (Response | Error)[], options: { onCall?: (url: string, init?: RequestInit) => void } = {}) {
    const calls: { url: string; method: string }[] = [];
    const delays: number[] = [];
    const asc = new AscClient({
      baseUrl: "https://api.appstoreconnect.apple.com",
      tokens,
      random: () => 0.5,
      sleep: async (ms) => void delays.push(ms),
      fetch: async (input, init) => {
        calls.push({ url: String(input), method: init?.method ?? "GET" });
        options.onCall?.(String(input), init);
        const next = responses.shift();
        if (!next) throw new Error("no more responses");
        if (next instanceof Error) throw next;
        return next;
      },
    });
    return { asc, calls, delays };
  }
  const reset = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });

  it("retries GETs on 5xx and connection resets with backoff", async () => {
    const { asc, calls, delays } = client([json(500, {}), reset(), json(200, { data: [] })]);
    await asc.get("/v1/apps");
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([750, 1500]);
  });

  it("doesn't retry a POST after a connection reset (it may have gone through)", async () => {
    const { asc, calls } = client([reset(), json(201, { data: {} })]);
    await expect(asc.post("/v1/betaGroups", {})).rejects.toBeInstanceOf(AscNetworkError);
    expect(calls).toHaveLength(1);
  });

  it("retries a POST on 429, honoring Retry-After", async () => {
    const { asc, delays } = client([json(429, { errors: [] }, { "retry-after": "7" }), json(201, { data: { id: "1" } })]);
    await asc.post("/v1/betaGroups", {});
    expect(delays).toEqual([7000]);
  });

  it("refreshes the token once on 401", async () => {
    const auths: string[] = [];
    const { asc } = client([json(401, { errors: [] }), json(200, { data: [] })], {
      onCall: (_url, init) => auths.push(new Headers(init?.headers).get("authorization")!),
    });
    await asc.get("/v1/apps");
    expect(auths).toHaveLength(2);
  });

  it("follows links.next across pages", async () => {
    const { asc, calls } = client([
      json(200, { data: [{ type: "apps", id: "1" }], links: { next: "https://api.appstoreconnect.apple.com/v1/apps?cursor=AQ&limit=1" } }),
      json(200, { data: [{ type: "apps", id: "2" }], links: {} }),
    ]);
    const { data } = await asc.getAll("/v1/apps", { limit: 1 });
    expect(data.map((d) => d.id)).toEqual(["1", "2"]);
    expect(calls[1]!.url).toContain("cursor=AQ");
  });

  it("refuses to send the token to another host", async () => {
    const { asc, calls } = client([json(200, { data: [] })]);
    await expect(asc.get("https://evil.example/v1/apps")).rejects.toThrow(/Refusing/);
    expect(calls).toHaveLength(0);
  });

  it("tracks the rate limit header", async () => {
    const { asc } = client([json(200, { data: [] }, { "x-rate-limit": "user-hour-lim:3600;user-hour-rem:3412;" })]);
    await asc.get("/v1/apps");
    expect(asc.rateLimit).toEqual({ limit: 3600, remaining: 3412 });
  });

  it("formats Apple's errors with a hint", async () => {
    const { asc } = client([json(403, { errors: [{ status: "403", code: "FORBIDDEN_ERROR", title: "Forbidden", detail: "This request is forbidden for security reasons", source: { pointer: "/data" } }] })]);
    const error = await asc.delete("/v1/appScreenshots/1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AscApiError);
    expect((error as Error).message).toContain("FORBIDDEN_ERROR: This request is forbidden for security reasons (at /data)");
    expect((error as Error).message).toContain("Never use an Admin key");
  });

  it("treats 404 on deleteIfExists as already gone", async () => {
    const { asc } = client([json(404, { errors: [{ code: "NOT_FOUND" }] })]);
    expect(await asc.deleteIfExists("/v1/appScreenshots/1")).toBe("absent");
  });
});

describe("jobs", () => {
  it("runBulk keeps going past failures and reports them", async () => {
    const result = await runBulk([1, 2, 3, 4], async (n) => {
      if (n === 2) throw new Error("boom");
      return n % 2 ? "odd" : "even";
    }, { concurrency: 2 });
    expect(result.succeeded.map((s) => s.item).sort()).toEqual([1, 3, 4]);
    expect(result.failed).toEqual([{ item: 2, error: "boom" }]);
    expect(result.notAttempted).toEqual([]);
  });

  it("poll returns the last value without throwing on timeout", async () => {
    let now = 0;
    let reads = 0;
    const result = await poll(async () => ++reads, () => false, { timeoutMs: 60_000, intervalMs: 20_000, now: () => now, sleep: async (ms) => void (now += ms) });
    expect(result.done).toBe(false);
    expect(reads).toBe(4); // t = 0, 20, 40, 60s
  });
});

describe("spec checker", () => {
  it("catches unknown paths, methods and query parameters", () => {
    expect(checkAgainstSpec("GET", "/v1/apps", { "filter[bundleId]": "x" })).toBeUndefined();
    expect(checkAgainstSpec("GET", "/v1/apps", { "filter[nope]": "x" })).toMatch(/no query parameter filter\[nope\]/);
    expect(checkAgainstSpec("PUT", "/v1/apps/1", {})).toMatch(/isn't allowed/);
    expect(checkAgainstSpec("GET", "/v1/nothing", {})).toMatch(/isn't in the App Store Connect API spec/);
  });
});
