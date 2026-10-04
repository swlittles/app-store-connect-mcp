// Auto-update for installs cloned from GitHub. The server starts on the code it has and updates in
// the background; the new version is used from the next start. It only ever fast-forwards a clean
// checkout, so a development clone with local changes or commits is never touched, and a failed
// install or build is rolled back.

import { execFile } from "node:child_process";
import { chmodSync, closeSync, existsSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type UpdateChannel = "release" | "main";

export interface UpdateResult {
  status: "updated" | "current" | "skipped" | "failed";
  /** When this result was produced (ISO). */
  at: string;
  from?: string;
  to?: string;
  reason?: string;
}

export interface UpdateOptions {
  root: string;
  channel: UpdateChannel;
  /** Ignore the minimum interval between checks (the --update flag). */
  force?: boolean;
  minIntervalMs?: number;
  now?: () => number;
  log?: (message: string) => void;
  /** Runs a command; injectable for tests. Rejects on a non-zero exit. */
  run?: (command: string, args: string[], cwd: string) => Promise<string>;
  /** Installs dependencies and builds. `lockChanged` says whether npm ci is needed. Injectable for tests. */
  install?: (root: string, lockChanged: boolean) => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 30 * 60_000;
const STALE_LOCK_MS = 10 * 60_000;
const STATUS_FILE = "asc-mcp-update.json";
const LOCK_FILE = "asc-mcp-update.lock";

/** The directory this copy of the server runs from (the repository root). */
export function installRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function updateSettings(env: NodeJS.ProcessEnv): { enabled: boolean; channel: UpdateChannel } {
  const flag = env.ASC_AUTO_UPDATE?.trim().toLowerCase();
  const channel = env.ASC_UPDATE_CHANNEL?.trim().toLowerCase() === "main" ? "main" : "release";
  return { enabled: !["0", "false", "no", "off"].includes(flag ?? ""), channel };
}

/** The last result, if this checkout has ever checked for updates. */
export async function lastUpdateResult(root: string, run = defaultRun): Promise<UpdateResult | undefined> {
  const gitDir = await gitDirOf(root, run);
  if (!gitDir) return undefined;
  try {
    return JSON.parse(readFileSync(join(gitDir, STATUS_FILE), "utf8")) as UpdateResult;
  } catch {
    return undefined;
  }
}

export async function checkForUpdate(options: UpdateOptions): Promise<UpdateResult> {
  const run = options.run ?? defaultRun;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const result = (status: UpdateResult["status"], extra: Partial<UpdateResult> = {}): UpdateResult => ({
    status,
    at: new Date(now()).toISOString(),
    ...extra,
  });

  const gitDir = await gitDirOf(options.root, run);
  if (!gitDir) return result("skipped", { reason: "not a git clone, so there's nothing to update from" });

  const statusPath = join(gitDir, STATUS_FILE);
  const previous = readJson<UpdateResult>(statusPath);
  if (!options.force && previous && now() - Date.parse(previous.at) < (options.minIntervalMs ?? DEFAULT_INTERVAL_MS)) {
    return previous;
  }

  const lockPath = join(gitDir, LOCK_FILE);
  if (!takeLock(lockPath, now())) return result("skipped", { reason: "another update is already running" });
  const save = (r: UpdateResult) => {
    writeFileSync(statusPath, JSON.stringify(r, null, 2));
    return r;
  };
  try {
    const git = (...args: string[]) => run("git", args, options.root);
    if ((await git("status", "--porcelain", "--untracked-files=no")).trim()) {
      return save(result("skipped", { reason: "this copy has local changes" }));
    }

    if (options.channel === "release") await git("fetch", "--quiet", "--tags", "--force", "origin");
    else await git("fetch", "--quiet", "origin", "main");

    const head = (await git("rev-parse", "HEAD")).trim();
    const from = await describe(git, head);
    let targetRef: string;
    if (options.channel === "release") {
      const tags = (await git("tag", "--list", "v*", "--sort=-v:refname")).split("\n").map((t) => t.trim()).filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
      if (!tags.length) return save(result("current", { from, reason: "no releases published yet" }));
      targetRef = tags[0]!;
    } else {
      targetRef = "origin/main";
    }
    const target = (await git("rev-parse", `${targetRef}^{commit}`)).trim();
    if (target === head) return save(result("current", { from }));
    const to = options.channel === "release" ? targetRef : await describe(git, target);
    if (!options.force && previous?.status === "failed" && previous.to === to) {
      // Don't retry a version that already failed to install; wait for a newer one (or --update).
      return save({ ...previous, at: new Date(now()).toISOString() });
    }
    try {
      await git("merge-base", "--is-ancestor", head, target);
    } catch {
      // HEAD has commits the target doesn't: a development copy, or already newer. Leave it alone.
      return save(result("skipped", { from, reason: `this copy has commits that aren't in ${targetRef}` }));
    }

    const lockChanged = await git("diff", "--quiet", head, target, "--", "package-lock.json").then(
      () => false,
      () => true,
    );
    log(`Updating app-store-connect-mcp from ${from} to ${to}…`);
    await git("checkout", "--quiet", "--detach", target);
    const install = options.install ?? defaultInstall(run);
    try {
      await install(options.root, lockChanged);
    } catch (error) {
      // Put the previous version back so the next start still works.
      await git("checkout", "--quiet", "--detach", head);
      await install(options.root, lockChanged).catch(() => {});
      return save(result("failed", { from, to, reason: `install failed, rolled back to ${from}: ${firstLine(error)}` }));
    }
    log(`Updated to ${to}. Restart your agent to use it.`);
    return save(result("updated", { from, to }));
  } catch (error) {
    return save(result("failed", { reason: firstLine(error) }));
  } finally {
    rmSync(lockPath, { force: true });
  }
}

export function describeResult(r: UpdateResult | undefined, settings: { enabled: boolean; channel: UpdateChannel }): string {
  if (!settings.enabled) return "Auto-update: off (ASC_AUTO_UPDATE=0).";
  const head = `Auto-update: on, following ${settings.channel === "release" ? "GitHub releases" : "the main branch"}.`;
  if (!r) return `${head} No check yet.`;
  const when = r.at.slice(0, 16).replace("T", " ") + "Z";
  switch (r.status) {
    case "updated":
      return `${head} Updated ${r.from} → ${r.to} at ${when}; restart your agent if it's still running the old version.`;
    case "current":
      return `${head} Up to date (${r.from ?? "?"}) as of ${when}.`;
    case "skipped":
      return `${head} Skipped at ${when}: ${r.reason}.`;
    case "failed":
      return `${head} Failed at ${when}: ${r.reason}.`;
  }
}

// ---------------------------------------------------------------------------------------------

async function gitDirOf(root: string, run: NonNullable<UpdateOptions["run"]>): Promise<string | undefined> {
  try {
    const top = (await run("git", ["rev-parse", "--show-toplevel"], root)).trim();
    // Only the server's own repository, never a parent repository it happens to sit inside.
    // Compare real paths: on macOS, /var and /tmp are symlinks into /private.
    if (realpathSync(top) !== realpathSync(root)) return undefined;
    return resolve(root, (await run("git", ["rev-parse", "--git-dir"], root)).trim());
  } catch {
    return undefined;
  }
}

async function describe(git: (...args: string[]) => Promise<string>, commit: string): Promise<string> {
  const tag = await git("describe", "--tags", "--exact-match", commit).catch(() => "");
  return tag.trim() || commit.slice(0, 7);
}

function takeLock(path: string, now: number): boolean {
  try {
    closeSync(openSync(path, "wx"));
    return true;
  } catch {
    try {
      if (now - statSync(path).mtimeMs > STALE_LOCK_MS) {
        rmSync(path, { force: true });
        closeSync(openSync(path, "wx"));
        return true;
      }
    } catch {
      // Lost the race to another process.
    }
    return false;
  }
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n").find((l) => l.trim()) ?? "unknown error";
}

function defaultRun(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 }, (error, stdout, stderr) => {
      if (error) {
        // tsc reports compile errors on stdout; keep the end of whichever stream has them.
        const output = (stderr.trim() || stdout.trim() || error.message).split("\n").slice(-5).join(" ").trim();
        reject(new Error(`${args[0]?.endsWith("tsc") ? "build" : `${command.split("/").pop()} ${args[0] ?? ""}`.trim()} failed: ${output}`));
      } else resolvePromise(stdout);
    });
  });
}

function defaultInstall(run: NonNullable<UpdateOptions["run"]>) {
  return async (root: string, lockChanged: boolean): Promise<void> => {
    if (lockChanged || !existsSync(join(root, "node_modules", "typescript"))) {
      // npm sits next to node in standard installs; fall back to PATH.
      const npm = join(dirname(process.execPath), "npm");
      await run(existsSync(npm) ? npm : "npm", ["ci", "--no-audit", "--no-fund"], root); // also builds (prepare)
      return;
    }
    // Dependencies unchanged: just rebuild, which works offline and takes seconds.
    await run(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"], root);
    chmodSync(join(root, "dist", "index.js"), 0o755);
  };
}
