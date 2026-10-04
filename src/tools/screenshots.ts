import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import type { Resource } from "../asc/client.js";
import { Included, linkage, linkages } from "../asc/jsonapi.js";
import { poll } from "../asc/jobs.js";
import type {
  AppScreenshotAttributes,
  AppScreenshotSetAttributes,
  AppStoreVersionAttributes,
  AppStoreVersionLocalizationAttributes,
  Platform,
  ScreenshotDisplayType,
} from "../asc/types.js";
import { SCREENSHOT_DISPLAY_TYPES } from "../asc/types.js";
import { describeFile, performUploadOperations, type LocalFile } from "../asc/upload.js";
import { STEP_LEGEND, StepLog, plural } from "./format.js";
import { defineTool, UserError, type ToolContext } from "./framework.js";
import { checkScreenshotSize } from "./image.js";
import {
  appInput,
  platformInput,
  requireLocalization,
  resolveApp,
  resolveVersion,
  versionInput,
  versionLocalizations,
  versionState,
  type AppRef,
} from "./lookup.js";

/** Apple's limit per screenshot set. */
export const MAX_SCREENSHOTS = 10;
const ASSET_POLL_MS = 5_000;

const displayTypeInput = z
  .string()
  .refine((v): v is ScreenshotDisplayType => (SCREENSHOT_DISPLAY_TYPES as readonly string[]).includes(v), {
    message: `Must be one of: ${SCREENSHOT_DISPLAY_TYPES.join(", ")}`,
  })
  .describe(
    'Screenshot display type, e.g. APP_IPHONE_67 (6.9" iPhone, 1320×2868), APP_IPHONE_65, APP_IPAD_PRO_3GEN_129 (13" iPad, 2064×2752), APP_DESKTOP, APP_APPLE_TV, APP_APPLE_VISION_PRO, APP_WATCH_ULTRA.',
  )
const localeInput = z.string().optional().describe("Localization, e.g. en-US. Defaults to the app's primary locale.");
const waitInput = z
  .number()
  .min(0)
  .max(30)
  .default(5)
  .describe("Minutes to wait for Apple to process uploaded images (usually under a minute). If time runs out, re-run the same call to continue.");

type Screenshot = Resource<AppScreenshotAttributes>;

function shotState(s: Screenshot): string {
  return s.attributes?.assetDeliveryState?.state ?? "?";
}

function describeShot(s: Screenshot, position: number): string {
  const a = s.attributes ?? {};
  const size = a.imageAsset?.width ? ` ${a.imageAsset.width}×${a.imageAsset.height}` : "";
  return `${position}. ${a.fileName ?? "?"}${size} · ${shotState(s)} · id ${s.id}`;
}

// ---------------------------------------------------------------------------------------------
// Reading

export const listScreenshots = defineTool({
  name: "list_screenshots",
  title: "List screenshots",
  description:
    "Lists App Store screenshots for a version, per localization and display type, in display order with positions (1-based), file names, sizes, states and IDs.",
  kind: "read",
  input: {
    app: appInput,
    version: versionInput,
    platform: platformInput,
    locale: z.string().optional().describe('Localization, e.g. en-US, or "all". Defaults to the primary locale.'),
    display_type: displayTypeInput.optional(),
  },
  async run({ app, version, platform, locale, display_type }, ctx) {
    const ref = await resolveApp(ctx, app);
    const v = await resolveVersionLenient(ctx, ref.id, version, platform);
    const locs = await versionLocalizations(ctx, v.id);
    const wanted = locale === "all" ? locs : locs.filter((l) => l.attributes?.locale === (locale ?? ref.primaryLocale));
    if (!wanted.length) {
      return `Version ${v.attributes?.versionString} has no ${locale ?? ref.primaryLocale} localization. It has: ${locs.map((l) => l.attributes?.locale).join(", ")}.`;
    }
    const out = [`${ref.name} ${v.attributes?.versionString} (${versionState(v)}, id ${v.id})`];
    for (const loc of wanted) {
      const doc = await ctx.asc.get<Resource<AppScreenshotSetAttributes>[]>(`/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets`, {
        include: "appScreenshots",
        "filter[screenshotDisplayType]": display_type,
        "limit[appScreenshots]": MAX_SCREENSHOTS,
      });
      const inc = new Included(doc.included);
      out.push("", `${loc.attributes?.locale} (localization ${loc.id}):`);
      if (!doc.data.length) out.push("  no screenshot sets");
      for (const set of doc.data) {
        const shots = inc.many<AppScreenshotAttributes>(set, "appScreenshots", "appScreenshots");
        out.push(`  ${set.attributes?.screenshotDisplayType} · ${plural(shots.length, "screenshot")} · set ${set.id}`);
        shots.forEach((s, i) => out.push(`    ${describeShot(s, i + 1)}`));
      }
    }
    return out.join("\n");
  },
});

async function resolveVersionLenient(ctx: ToolContext, appId: string, version: string | undefined, platform?: Platform) {
  if (version) return resolveVersion(ctx, appId, { version, platform });
  try {
    return await resolveVersion(ctx, appId, { version: "editable", platform });
  } catch {
    return resolveVersion(ctx, appId, { version: "live", platform });
  }
}

// ---------------------------------------------------------------------------------------------
// The sync engine shared by every screenshot write tool

export interface SetTarget {
  app: AppRef;
  version: Resource<AppStoreVersionAttributes>;
  localization: Resource<AppStoreVersionLocalizationAttributes>;
  displayType: ScreenshotDisplayType;
  set?: Resource<AppScreenshotSetAttributes>;
  screenshots: Screenshot[];
}

export async function loadSetTarget(
  ctx: ToolContext,
  args: { app?: string; version?: string; platform?: Platform; locale?: string; display_type: ScreenshotDisplayType },
): Promise<SetTarget> {
  const app = await resolveApp(ctx, args.app);
  const version = await resolveVersion(ctx, app.id, { version: args.version, platform: args.platform, editable: true });
  const localization = await requireLocalization(ctx, version.id, args.locale ?? app.primaryLocale);
  const sets = await ctx.asc.get<Resource<AppScreenshotSetAttributes>[]>(`/v1/appStoreVersionLocalizations/${localization.id}/appScreenshotSets`, {
    "filter[screenshotDisplayType]": args.display_type,
  });
  const set = sets.data[0];
  const screenshots = set ? await readSet(ctx, set.id) : [];
  return { app, version, localization, displayType: args.display_type, set, screenshots };
}

async function readSet(ctx: ToolContext, setId: string): Promise<Screenshot[]> {
  const { data } = await ctx.asc.getAll<AppScreenshotAttributes>(`/v1/appScreenshotSets/${setId}/appScreenshots`);
  return data;
}

export type Desired = { existing: string } | { file: LocalFile };

/**
 * Makes a screenshot set match `desired`, in order, without ever leaving a gap in the listing:
 * upload new images, wait until Apple has processed them, reorder, and only then delete what's
 * no longer wanted. Each step re-reads state, and new files are matched to screenshots already
 * in the set by MD5, so re-running after a failure or timeout continues instead of duplicating.
 */
export async function syncSet(ctx: ToolContext, target: SetTarget, desired: Desired[], log: StepLog, waitMinutes: number): Promise<string[]> {
  if (desired.length > MAX_SCREENSHOTS) throw new UserError(`A set holds at most ${MAX_SCREENSHOTS} screenshots; this would leave ${desired.length}.`);
  const current = target.screenshots;
  const byId = new Map(current.map((s) => [s.id, s]));
  const claimed = new Set<string>();

  // Resolve every desired entry to an existing screenshot or a file to upload.
  type Slot = { id?: string; file?: LocalFile };
  const slots: Slot[] = desired.map((d) => {
    if ("existing" in d) {
      if (!byId.has(d.existing)) throw new UserError(`Screenshot ${d.existing} isn't in this set.`);
      if (claimed.has(d.existing)) throw new UserError(`Screenshot ${d.existing} is listed twice.`);
      claimed.add(d.existing);
      return { id: d.existing };
    }
    return { file: d.file };
  });
  for (const slot of slots) {
    if (!slot.file) continue;
    // An earlier run may already have uploaded this exact file.
    const match = current.find((s) => !claimed.has(s.id) && s.attributes?.sourceFileChecksum === slot.file!.md5 && ["COMPLETE", "UPLOAD_COMPLETE"].includes(shotState(s)));
    if (match) {
      claimed.add(match.id);
      slot.id = match.id;
      log.skip(`${slot.file.fileName} is already uploaded (${match.id})`);
    }
  }
  const toUpload = slots.filter((s) => !s.id);
  const toDelete = current.filter((s) => !claimed.has(s.id));

  // A set can't exceed 10, even briefly, so some deletes may have to come first.
  const overflow = current.length + toUpload.length - MAX_SCREENSHOTS;
  const broken = (s: Screenshot) => ["FAILED", "AWAITING_UPLOAD"].includes(shotState(s));
  const early = overflow > 0 ? [...toDelete].sort((a, b) => Number(broken(b)) - Number(broken(a))).slice(0, overflow) : [];
  const positionOf = (s: Screenshot) => current.indexOf(s) + 1;

  if (early.length) {
    log.warn(`The set is full, so ${plural(early.length, "screenshot")} must be deleted before uploading; the listing will be briefly shorter.`);
  }

  if (ctx.dryRun) {
    if (!target.set) log.plan(`Create the ${target.displayType} set`);
    for (const s of early) log.plan(`Delete #${positionOf(s)} ${s.attributes?.fileName ?? s.id} first (set is full)`);
    for (const s of toUpload) log.plan(`Upload ${s.file!.fileName}`);
    if (slots.length) log.plan(`Order: ${slots.map((s, i) => `${i + 1}. ${s.file?.fileName ?? byId.get(s.id!)?.attributes?.fileName ?? s.id}`).join(", ")}`);
    for (const s of toDelete.filter((d) => !early.includes(d))) log.plan(`Delete #${positionOf(s)} ${s.attributes?.fileName ?? s.id} (after the new order is in place)`);
    if (!toUpload.length && !toDelete.length && sameOrder(current.map((s) => s.id), slots.map((s) => s.id!))) log.skip("Set already matches; nothing to do");
    return [];
  }

  const state: SyncState = { pendingDeletes: [] };
  try {
    return await applySync(ctx, target, slots, byId, early, log, waitMinutes, state);
  } catch (error) {
    // Show what already happened, so the agent can tell the user and knows how to finish.
    if (error instanceof UserError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const next = state.pendingDeletes.length
      ? `The new order is in place; only the cleanup is left. To finish, call delete_screenshots with screenshots ${JSON.stringify(state.pendingDeletes)} and dry_run: false.`
      : "Run the same call again to continue; uploads already done are matched by checksum and not repeated.";
    throw new UserError(`${STEP_LEGEND}\n${log.toString()}\n✗ ${message}\nThe steps above are done. ${next}`);
  }
}

interface SyncState {
  /** Screenshots that are out of the requested order and only need deleting. */
  pendingDeletes: string[];
}

async function applySync(
  ctx: ToolContext,
  target: SetTarget,
  slots: { id?: string; file?: LocalFile }[],
  byId: Map<string, Screenshot>,
  early: Screenshot[],
  log: StepLog,
  waitMinutes: number,
  state: SyncState,
): Promise<string[]> {
  const toUpload = slots.filter((s) => !s.id);
  const positionOf = (s: Screenshot) => target.screenshots.indexOf(s) + 1;

  // 1. Make sure the set exists.
  let setId = target.set?.id;
  if (!setId) {
    const created = await ctx.asc.post<Resource<AppScreenshotSetAttributes>>("/v1/appScreenshotSets", {
      data: {
        type: "appScreenshotSets",
        attributes: { screenshotDisplayType: target.displayType },
        relationships: { appStoreVersionLocalization: linkage("appStoreVersionLocalizations", target.localization.id) },
      },
    });
    setId = created!.data.id;
    log.done(`Created the ${target.displayType} set (${setId})`);
  }

  // 2. Deletes that must happen first.
  for (const s of early) {
    await ctx.asc.deleteIfExists(`/v1/appScreenshots/${s.id}`);
    log.done(`Deleted #${positionOf(s)} ${s.attributes?.fileName ?? s.id} to make room`);
  }

  // 3. Upload.
  for (const [i, slot] of toUpload.entries()) {
    const file = slot.file!;
    await ctx.progress(`Uploading ${file.fileName} (${i + 1} of ${toUpload.length})`, i, toUpload.length);
    const reserved = await ctx.asc.post<Screenshot>("/v1/appScreenshots", {
      data: {
        type: "appScreenshots",
        attributes: { fileName: file.fileName, fileSize: file.size },
        relationships: { appScreenshotSet: linkage("appScreenshotSets", setId) },
      },
    });
    const id = reserved!.data.id;
    await performUploadOperations(reserved!.data.attributes?.uploadOperations ?? [], file.path, {
      fetch: ctx.asc.fetcher,
      signal: ctx.signal,
      sleep: ctx.sleep,
    });
    await ctx.asc.patch(`/v1/appScreenshots/${id}`, {
      data: { type: "appScreenshots", id, attributes: { uploaded: true, sourceFileChecksum: file.md5 } },
    });
    slot.id = id;
    log.done(`Uploaded ${file.fileName} (${id})`);
  }

  // 4. Wait until Apple has processed every screenshot we're keeping.
  const finalIds = slots.map((s) => s.id!);
  const pendingIds = new Set(finalIds.filter((id) => !byId.has(id) || shotState(byId.get(id)!) !== "COMPLETE"));
  if (pendingIds.size) {
    const { value, done } = await poll(
      async () => Promise.all([...pendingIds].map((id) => ctx.asc.get<Screenshot>(`/v1/appScreenshots/${id}`).then((d) => d.data))),
      (shots) => shots.every((s) => ["COMPLETE", "FAILED"].includes(shotState(s))),
      { timeoutMs: waitMinutes * 60_000, intervalMs: ASSET_POLL_MS, sleep: ctx.sleep, now: ctx.now, signal: ctx.signal },
    );
    const failed = value.filter((s) => shotState(s) === "FAILED");
    if (failed.length) {
      for (const s of failed) {
        const why = (s.attributes?.assetDeliveryState?.errors ?? []).map((e) => `${e.code}: ${e.description}`).join("; ");
        log.fail(`Apple couldn't process ${s.attributes?.fileName} (${s.id}): ${why || "no detail"}`);
      }
      log.info("Stopped before reordering or deleting anything, so the live listing is unchanged. Fix the image (usually its size), then run the same call again.");
      return finalIds;
    }
    if (!done) {
      log.warn(`Apple is still processing ${plural(value.filter((s) => shotState(s) !== "COMPLETE").length, "image")}. Run the same call again to finish (uploads won't repeat).`);
      return finalIds;
    }
    log.done(`Apple finished processing ${plural(pendingIds.size, "image")}`);
  }

  // 5. Reorder. Screenshots still to be deleted go last so the visible order is right immediately.
  const now = await readSet(ctx, setId);
  const leftovers = now.map((s) => s.id).filter((id) => !finalIds.includes(id));
  const order = [...finalIds, ...leftovers];
  if (!sameOrder(now.map((s) => s.id), order)) {
    await ctx.asc.patch(`/v1/appScreenshotSets/${setId}/relationships/appScreenshots`, linkages("appScreenshots", order));
    log.done("Reordered");
  } else {
    log.skip("Order already correct");
  }

  // 6. Delete what's no longer wanted, one call each so a dropped connection loses nothing.
  state.pendingDeletes = [...leftovers];
  for (const id of leftovers) {
    const s = now.find((x) => x.id === id);
    const result = await ctx.asc.deleteIfExists(`/v1/appScreenshots/${id}`);
    state.pendingDeletes = state.pendingDeletes.filter((x) => x !== id);
    log[result === "deleted" ? "done" : "skip"](`${result === "deleted" ? "Deleted" : "Already deleted:"} ${s?.attributes?.fileName ?? id}`);
  }

  // 7. Verify.
  const final = await readSet(ctx, setId);
  if (!sameOrder(final.map((s) => s.id), finalIds)) {
    log.warn("The set doesn't match the requested order yet. Re-run the same call; it will fix whatever is left.");
  }
  log.info(`Set ${setId} now:`);
  final.forEach((s, i) => log.info(`  ${describeShot(s, i + 1)}`));
  return finalIds;
}

/**
 * The current screenshots minus any that are copies of `files`: those come from an earlier,
 * interrupted run of the same call and are matched to the files by checksum instead.
 */
function keptExcept(current: Screenshot[], files: LocalFile[]): Screenshot[] {
  const checksums = new Set(files.map((f) => f.md5));
  return current.filter((s) => !s.attributes?.sourceFileChecksum || !checksums.has(s.attributes.sourceFileChecksum));
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function header(t: SetTarget): string {
  return `${t.app.name} ${t.version.attributes?.versionString} · ${t.localization.attributes?.locale} · ${t.displayType}`;
}

async function loadFiles(paths: readonly string[], displayType: ScreenshotDisplayType, log: StepLog): Promise<LocalFile[]> {
  const files: LocalFile[] = [];
  for (const path of paths) {
    const file = await describeFile(path).catch((error: Error) => {
      throw new UserError(error.message);
    });
    const warning = await checkScreenshotSize(path, displayType);
    if (warning) log.warn(warning);
    files.push(file);
  }
  return files;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

async function filesInFolder(folder: string): Promise<string[]> {
  const entries = await readdir(folder).catch((error: NodeJS.ErrnoException) => {
    throw new UserError(`Can't read folder ${folder}: ${error.code ?? error.message}`);
  });
  const images = entries.filter((e) => IMAGE_EXTENSIONS.has(extname(e).toLowerCase()) && !e.startsWith("."));
  // Natural order, so 2.png comes before 10.png.
  images.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  return images.map((e) => join(folder, e));
}

const targetInputs = {
  app: appInput,
  display_type: displayTypeInput,
  locale: localeInput,
  version: versionInput,
  platform: platformInput,
};

// ---------------------------------------------------------------------------------------------
// Tools

export const uploadScreenshots = defineTool({
  name: "upload_screenshots",
  title: "Upload screenshots",
  description:
    'Uploads images to one screenshot set of the version being prepared. mode "replace" makes the set exactly these files in this order (the old ones are deleted only after the new ones are processed); ' +
    'mode "append" adds them at the end. Files already in the set (same MD5) aren\'t uploaded again, so re-running is safe.',
  kind: "destructive",
  input: {
    ...targetInputs,
    files: z.array(z.string()).optional().describe("Absolute image paths, in display order."),
    folder: z.string().optional().describe("Folder of .png/.jpg files, used in natural filename order (1, 2, …, 10). Use instead of files."),
    mode: z.enum(["replace", "append"]).default("replace"),
    wait_minutes: waitInput,
  },
  async run(args, ctx) {
    if (!args.files?.length === !args.folder) throw new UserError("Pass either files or folder.");
    const paths = args.files?.length ? args.files : await filesInFolder(args.folder!);
    if (!paths.length) throw new UserError(`No .png or .jpg files in ${args.folder}.`);
    const log = new StepLog();
    const files = await loadFiles(paths, args.display_type, log);
    const target = await loadSetTarget(ctx, args);
    const desired: Desired[] =
      args.mode === "append"
        ? [...keptExcept(target.screenshots, files).map((s) => ({ existing: s.id })), ...files.map((file) => ({ file }))]
        : files.map((file) => ({ file }));
    await syncSet(ctx, target, desired, log, args.wait_minutes);
    return [header(target), STEP_LEGEND, log.toString()].join("\n");
  },
});

export const replaceScreenshot = defineTool({
  name: "replace_screenshot",
  title: "Replace one screenshot",
  description:
    "Replaces the screenshot at one position (1-based) with a new image, keeping its place. The new image is uploaded and processed before the old one is removed, so the listing never has a gap.",
  kind: "destructive",
  input: {
    ...targetInputs,
    position: z.number().int().min(1).max(MAX_SCREENSHOTS).describe("Position to replace, 1-based, as shown by list_screenshots."),
    file: z.string().describe("Absolute path of the new image."),
    wait_minutes: waitInput,
  },
  async run(args, ctx) {
    const log = new StepLog();
    const [file] = await loadFiles([args.file], args.display_type, log);
    const target = await loadSetTarget(ctx, args);
    const current = target.screenshots;
    const old = current[args.position - 1];
    if (!old) {
      // A re-run after the old one was already deleted lands here only if the set shrank; say so plainly.
      if (current.some((s) => s.attributes?.sourceFileChecksum === file!.md5)) {
        return [header(target), `${file!.fileName} is already in the set and there's no screenshot at position ${args.position}; nothing to do. Check with list_screenshots.`].join("\n");
      }
      throw new UserError(`There's no screenshot at position ${args.position}; the set has ${current.length}. Use upload_screenshots with mode "append" to add one.`);
    }
    if (old.attributes?.sourceFileChecksum === file!.md5) {
      log.skip(`Position ${args.position} already has this image (${old.id})`);
      return [header(target), STEP_LEGEND, log.toString()].join("\n");
    }
    log.info(`Replacing #${args.position} ${old.attributes?.fileName ?? old.id} with ${file!.fileName}`);
    const desired: Desired[] = keptExcept(current, [file!]).map((s) => (s.id === old.id ? { file: file! } : { existing: s.id }));
    await syncSet(ctx, target, desired, log, args.wait_minutes);
    return [header(target), STEP_LEGEND, log.toString()].join("\n");
  },
});

export const reorderScreenshots = defineTool({
  name: "reorder_screenshots",
  title: "Reorder screenshots",
  description:
    "Changes the order of a screenshot set. order lists current positions (1-based) or screenshot IDs in the new order; any not listed keep their relative order after them. " +
    "Example: [4] moves screenshot 4 to the front.",
  kind: "write",
  input: {
    ...targetInputs,
    order: z.array(z.union([z.number().int().min(1), z.string()])).min(1),
  },
  async run(args, ctx) {
    const target = await loadSetTarget(ctx, args);
    const current = target.screenshots;
    const picked = args.order.map((o) => {
      const s = typeof o === "number" ? current[o - 1] : current.find((x) => x.id === o);
      if (!s) throw new UserError(`${o} doesn't match a screenshot in this set (it has ${current.length}).`);
      return s.id;
    });
    if (new Set(picked).size !== picked.length) throw new UserError("order lists the same screenshot twice.");
    const order = [...picked, ...current.map((s) => s.id).filter((id) => !picked.includes(id))];
    const log = new StepLog();
    await syncSet(ctx, target, order.map((existing) => ({ existing })), log, 0);
    return [header(target), STEP_LEGEND, log.toString()].join("\n");
  },
});

export const deleteScreenshots = defineTool({
  name: "delete_screenshots",
  title: "Delete screenshots",
  description: "Deletes screenshots from a set by position (1-based) or ID. The rest keep their order.",
  kind: "destructive",
  input: {
    ...targetInputs,
    screenshots: z.array(z.union([z.number().int().min(1), z.string()])).min(1).describe("Positions or IDs to delete."),
  },
  async run(args, ctx) {
    const target = await loadSetTarget(ctx, args);
    const current = target.screenshots;
    const remove = new Set(
      args.screenshots.map((o) => {
        const s = typeof o === "number" ? current[o - 1] : current.find((x) => x.id === o);
        if (!s) throw new UserError(`${o} doesn't match a screenshot in this set (it has ${current.length}).`);
        return s.id;
      }),
    );
    const log = new StepLog();
    await syncSet(ctx, target, current.filter((s) => !remove.has(s.id)).map((s) => ({ existing: s.id })), log, 0);
    return [header(target), STEP_LEGEND, log.toString()].join("\n");
  },
});
