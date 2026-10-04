import type { AscClient } from "./client.js";

export interface PollOptions {
  timeoutMs: number;
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  signal?: AbortSignal;
  onTick?: (elapsedMs: number) => void | Promise<void>;
}

/**
 * Re-reads state until `isDone` says so or the time budget runs out. A timeout isn't an error:
 * the caller gets the last value and `done: false`, and tells the agent how to resume.
 */
export async function poll<T>(
  read: () => Promise<T>,
  isDone: (value: T) => boolean,
  options: PollOptions,
): Promise<{ value: T; done: boolean }> {
  const start = options.now();
  for (;;) {
    const value = await read();
    if (isDone(value)) return { value, done: true };
    const elapsed = options.now() - start;
    if (elapsed + options.intervalMs > options.timeoutMs) return { value, done: false };
    await options.onTick?.(elapsed);
    options.signal?.throwIfAborted();
    await options.sleep(options.intervalMs);
  }
}

export interface BulkResult<T> {
  succeeded: { item: T; note?: string }[];
  failed: { item: T; error: string }[];
  /** Items not attempted because the job stopped early (rate limit or cancellation). */
  notAttempted: T[];
  stopReason?: string;
}

export interface BulkOptions {
  concurrency: number;
  asc?: AscClient;
  /** Stop starting new items when fewer than this many requests are left in the hour. */
  rateLimitReserve?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void | Promise<void>;
}

/**
 * Runs `work` over many items with bounded concurrency. One item failing doesn't stop the rest;
 * the result lists exactly what succeeded, failed and wasn't tried, so a re-run can finish the job.
 */
export async function runBulk<T>(
  items: readonly T[],
  work: (item: T) => Promise<string | void>,
  options: BulkOptions,
): Promise<BulkResult<T>> {
  const result: BulkResult<T> = { succeeded: [], failed: [], notAttempted: [] };
  const queue = [...items];
  let done = 0;
  const reserve = options.rateLimitReserve ?? 50;

  const worker = async () => {
    while (queue.length) {
      if (options.signal?.aborted) result.stopReason ??= "cancelled";
      const remaining = options.asc?.rateLimit.remaining;
      if (remaining !== undefined && remaining < reserve) {
        result.stopReason ??= `only ${remaining} API requests left this hour; stopped to leave headroom`;
      }
      if (result.stopReason) return;
      const item = queue.shift()!;
      try {
        const note = await work(item);
        result.succeeded.push({ item, note: note ?? undefined });
      } catch (error) {
        result.failed.push({ item, error: error instanceof Error ? error.message.split("\n").slice(0, 2).join(" ") : String(error) });
      }
      done++;
      await options.onProgress?.(done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, items.length)) }, worker));
  result.notAttempted.push(...queue);
  return result;
}
