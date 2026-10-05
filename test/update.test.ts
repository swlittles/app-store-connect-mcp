import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { checkForUpdate, describeResult, lastUpdateResult, newestFirst, updateSettings } from "../src/update.js";

// Real git repositories in a temp folder: "origin" plays GitHub, "install" is a user's clone.
beforeAll(() => {
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();

function publish(work: string, file: string, content: string, tag?: string) {
  writeFileSync(join(work, file), content);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", `change ${file}`);
  if (tag) git(work, "tag", tag);
  git(work, "push", "-q", "origin", "main", "--tags");
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "asc-update-"));
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  git(dir, "init", "-q", "--bare", origin);
  git(dir, "clone", "-q", origin, work);
  publish(work, "package-lock.json", "{}", undefined);
  publish(work, "code.txt", "v1", "v0.1.0");
  const install = join(dir, "install");
  git(dir, "clone", "-q", origin, install);
  git(install, "checkout", "-q", "--detach", "v0.1.0");
  publish(work, "code.txt", "v2", "v0.2.0");
  const installs: boolean[] = [];
  const opts = {
    root: install,
    channel: "release" as const,
    install: async (_root: string, lockChanged: boolean) => void installs.push(lockChanged),
  };
  return { dir, origin, work, install, installs, opts };
}

describe("checkForUpdate", { timeout: 30_000 }, () => {
  it("fast-forwards to the latest release and only rebuilds when the lockfile is unchanged", async () => {
    const t = setup();
    const result = await checkForUpdate(t.opts);
    expect(result).toMatchObject({ status: "updated", from: "v0.1.0", to: "v0.2.0" });
    expect(git(t.install, "describe", "--tags")).toBe("v0.2.0");
    expect(t.installs).toEqual([false]);
    expect((await lastUpdateResult(t.install))?.status).toBe("updated");
  });

  it("runs a full install when dependencies changed", async () => {
    const t = setup();
    publish(t.work, "package-lock.json", '{"changed":true}', "v0.3.0");
    await checkForUpdate(t.opts);
    expect(t.installs).toEqual([true]);
  });

  it("checks at most once per interval unless forced", async () => {
    const t = setup();
    await checkForUpdate(t.opts);
    publish(t.work, "code.txt", "v3", "v0.3.0");
    expect((await checkForUpdate(t.opts)).to).toBe("v0.2.0"); // cached result, no fetch
    expect((await checkForUpdate({ ...t.opts, force: true })).to).toBe("v0.3.0");
  });

  it("reports up to date", async () => {
    const t = setup();
    await checkForUpdate(t.opts);
    expect((await checkForUpdate({ ...t.opts, force: true })).status).toBe("current");
  });

  it("never touches a copy with local changes", async () => {
    const t = setup();
    writeFileSync(join(t.install, "code.txt"), "my edit");
    const result = await checkForUpdate(t.opts);
    expect(result).toMatchObject({ status: "skipped", reason: "this copy has local changes" });
    expect(git(t.install, "describe", "--tags")).toBe("v0.1.0");
  });

  it("never touches a development copy with its own commits", async () => {
    const t = setup();
    writeFileSync(join(t.work, "code.txt"), "work in progress");
    git(t.work, "commit", "-q", "-am", "unreleased local work");
    const result = await checkForUpdate({ ...t.opts, root: t.work });
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("commits that aren't in v0.2.0");
  });

  it("rolls back when the install fails", async () => {
    const t = setup();
    let calls = 0;
    const result = await checkForUpdate({
      ...t.opts,
      install: async () => {
        if (calls++ === 0) throw new Error("npm ci failed: network down");
      },
    });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("rolled back to v0.1.0");
    expect(git(t.install, "describe", "--tags")).toBe("v0.1.0");
    expect(calls).toBe(2); // the failed install, then reinstalling the previous version
  });

  it("doesn't retry a release that already failed, until forced or a newer one appears", async () => {
    const t = setup();
    let installs = 0;
    const broken = {
      ...t.opts,
      minIntervalMs: 0,
      install: async () => {
        installs++;
        throw new Error("boom");
      },
    };
    await checkForUpdate(broken);
    const before = installs;
    expect((await checkForUpdate(broken)).status).toBe("failed");
    expect(installs).toBe(before); // not retried
    publish(t.work, "code.txt", "v3", "v0.3.0");
    const fixed = await checkForUpdate({ ...t.opts, minIntervalMs: 0 });
    expect(fixed).toMatchObject({ status: "updated", to: "v0.3.0" });
  });

  it("follows the main branch on the main channel", async () => {
    const t = setup();
    publish(t.work, "code.txt", "unreleased");
    const result = await checkForUpdate({ ...t.opts, channel: "main" });
    expect(result.status).toBe("updated");
    expect(git(t.install, "rev-parse", "HEAD")).toBe(git(t.work, "rev-parse", "HEAD"));
  });

  it("skips while another update holds the lock", async () => {
    const t = setup();
    closeSync(openSync(join(t.install, ".git", "asc-mcp-update.lock"), "w"));
    expect((await checkForUpdate(t.opts)).reason).toContain("another update is already running");
    expect(git(t.install, "describe", "--tags")).toBe("v0.1.0");
  });

  it("takes over a lock left by an update that was killed", async () => {
    const t = setup();
    writeFileSync(join(t.install, ".git", "asc-mcp-update.lock"), "99999999"); // no such process
    expect((await checkForUpdate(t.opts)).status).toBe("updated");
  });

  it("finishes an update that was interrupted after the checkout", async () => {
    const t = setup();
    const v1 = git(t.install, "rev-parse", "HEAD");
    git(t.install, "fetch", "-q", "--tags");
    git(t.install, "checkout", "-q", "--detach", "v0.2.0");
    const status = { status: "installing", at: new Date().toISOString(), from: "v0.1.0", to: "v0.2.0", fromCommit: v1 };
    writeFileSync(join(t.install, ".git", "asc-mcp-update.json"), JSON.stringify(status));
    const result = await checkForUpdate(t.opts); // within the interval, but not cached
    expect(result).toMatchObject({ status: "updated", from: "v0.1.0", to: "v0.2.0" });
    expect(t.installs).toEqual([true]); // node_modules may be half-installed, so a full install
  });

  it("rolls an interrupted update back to the version that worked", async () => {
    const t = setup();
    const v1 = git(t.install, "rev-parse", "HEAD");
    git(t.install, "fetch", "-q", "--tags");
    git(t.install, "checkout", "-q", "--detach", "v0.2.0");
    writeFileSync(join(t.install, ".git", "asc-mcp-update.json"), JSON.stringify({ status: "installing", at: new Date().toISOString(), fromCommit: v1 }));
    const result = await checkForUpdate({ ...t.opts, install: async (_root, full) => { if (full) throw new Error("offline"); } });
    expect(result.reason).toContain("rolled back to v0.1.0");
    expect(git(t.install, "rev-parse", "HEAD")).toBe(v1);
  });

  it("ignores tags that are no longer on GitHub", async () => {
    const t = setup();
    git(t.install, "tag", "v9.0.0", "v0.1.0"); // e.g. pushed by mistake, fetched, then deleted upstream
    expect(await checkForUpdate(t.opts)).toMatchObject({ status: "updated", to: "v0.2.0" });
  });

  it("keeps the working node_modules when npm ci fails, and rebuilds the old version offline", async () => {
    const t = setup();
    publish(t.work, "package-lock.json", '{"changed":true}', "v0.3.0");
    mkdirSync(join(t.install, "node_modules", "typescript"), { recursive: true });
    writeFileSync(join(t.install, "node_modules", "marker"), "working");
    mkdirSync(join(t.install, "dist"));
    writeFileSync(join(t.install, "dist", "index.js"), "");
    const commands: string[] = [];
    const result = await checkForUpdate({
      root: t.install,
      channel: "release",
      run: async (command, args, cwd) => {
        if (command === "git") return execFileSync("git", args, { cwd, encoding: "utf8" });
        commands.push(args.includes("ci") ? "npm ci" : "tsc");
        if (args.includes("ci")) {
          rmSync(join(cwd, "node_modules"), { recursive: true, force: true }); // what npm ci does first
          throw new Error("npm ci failed: ENOTFOUND registry.npmjs.org");
        }
        return "";
      },
    });
    expect(result.reason).toContain("rolled back to v0.1.0");
    expect(commands).toEqual(["npm ci", "tsc"]);
    expect(readFileSync(join(t.install, "node_modules", "marker"), "utf8")).toBe("working");
    expect(existsSync(join(t.install, "node_modules.prev"))).toBe(false);
  });

  it("does nothing outside a git clone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "asc-plain-"));
    expect((await checkForUpdate({ root: dir, channel: "release" })).status).toBe("skipped");
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });
});

describe("newestFirst", () => {
  it("sorts release tags by version and drops anything else", () => {
    expect(newestFirst(["v0.9.0", "v0.10.0", "v0.10.0-beta", "v1.0", "latest", "v0.10.1"])).toEqual(["v0.10.1", "v0.10.0", "v0.9.0"]);
  });
});

describe("settings", () => {
  it("is on by default, follows releases, and can be turned off", () => {
    expect(updateSettings({})).toEqual({ enabled: true, channel: "release" });
    expect(updateSettings({ ASC_AUTO_UPDATE: "0", ASC_UPDATE_CHANNEL: "main" })).toEqual({ enabled: false, channel: "main" });
    expect(describeResult(undefined, { enabled: false, channel: "release" })).toContain("off");
  });
});
