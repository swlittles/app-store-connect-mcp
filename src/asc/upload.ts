import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { networkErrorCode } from "./client.js";
import type { UploadOperation } from "./types.js";

export interface LocalFile {
  path: string;
  fileName: string;
  size: number;
  md5: string;
}

export async function describeFile(path: string): Promise<LocalFile> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    throw new Error(`Can't read ${path}: ${error.code ?? error.message}`);
  });
  if (!info.isFile()) throw new Error(`${path} isn't a file.`);
  return { path, fileName: path.split("/").pop()!, size: info.size, md5: await md5File(path) };
}

export function md5File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("md5");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export interface UploadOptions {
  fetch: typeof fetch;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  concurrency?: number;
  onPart?: (done: number, total: number) => void;
}

/**
 * Sends a file's bytes to the presigned URLs App Store Connect returns in `uploadOperations`.
 * Each part is a PUT of a byte range, so retrying a part is safe. The API token is never sent
 * to these URLs.
 */
export async function performUploadOperations(
  operations: readonly UploadOperation[],
  path: string,
  options: UploadOptions,
): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = options.maxAttempts ?? 4;
  const handle = await open(path, "r");
  let done = 0;
  try {
    const queue = [...operations];
    const worker = async () => {
      for (let op = queue.shift(); op; op = queue.shift()) {
        if (!op.url || op.length === undefined || op.offset === undefined) {
          throw new Error("App Store Connect returned an incomplete upload operation (no url, offset or length).");
        }
        const bytes = Buffer.alloc(op.length);
        const { bytesRead } = await handle.read(bytes, 0, op.length, op.offset);
        if (bytesRead !== op.length) throw new Error(`${path} changed size during upload.`);
        const headers = Object.fromEntries(
          (op.requestHeaders ?? []).filter((h) => h.name).map((h) => [h.name!, h.value ?? ""]),
        );
        await putPart(op.method ?? "PUT", op.url, headers, bytes, { ...options, sleep, maxAttempts });
        options.onPart?.(++done, operations.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 3, operations.length) }, worker));
  } finally {
    await handle.close();
  }
}

async function putPart(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Buffer,
  options: UploadOptions & { sleep: (ms: number) => Promise<void>; maxAttempts: number },
): Promise<void> {
  const host = new URL(url).host;
  for (let attempt = 1; ; attempt++) {
    options.signal?.throwIfAborted();
    let reason: string;
    try {
      const res = await options.fetch(url, {
        method,
        headers,
        body,
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
      });
      await res.body?.cancel();
      if (res.ok) return;
      reason = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) {
        throw new Error(`Upload of a file part to ${host} was rejected (${reason}). The upload slot may have expired; run the tool again to get a fresh one.`);
      }
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.message.startsWith("Upload of a file part"))) throw error;
      reason = networkErrorCode(error);
    }
    if (attempt >= options.maxAttempts) throw new Error(`Upload of a file part to ${host} failed after ${attempt} attempts: ${reason}.`);
    await options.sleep(1000 * 2 ** (attempt - 1));
  }
}
