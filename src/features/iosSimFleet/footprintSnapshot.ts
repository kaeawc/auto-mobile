import type { HostCommandExecutor } from "../../utils/HostCommandExecutor";
import type { HostProcessRow } from "../../models/HostProcessRow";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";

/**
 * Read-only argv for one `top` sample of every process's memory. On macOS the `MEM` column is the
 * process's `phys_footprint` (what `footprint` and Activity Monitor report): dirty and compressed
 * pages it owns, with the shared dyld cache and frameworks not charged to every process. `ps`
 * `rss` has no such notion and counts those shared pages once per process (#15288).
 */
export const TOP_FOOTPRINT_ARGS = ["-l", "1", "-stats", "pid,mem"];
export const TOP_FOOTPRINT_MAX_BUFFER_BYTES = 16 * 1024 ** 2;

const UNIT_BYTES: Readonly<Record<string, number>> = {
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};
// `top` prints whole numbers with a K/M/G unit; a trailing +/- marks a changed value in some modes.
const TOP_ROW = /^\s*(\d+)\s+(\d+(?:[.,]\d+)?)([BKMGT])?[+-]?\s*$/;

/**
 * Parses `top -l 1 -stats pid,mem` into pid -> footprint bytes. The summary header and any
 * malformed row are skipped; the count of skipped data rows is returned so a wholesale format
 * change is visible to the caller instead of silently yielding an empty map.
 */
export function parseTopFootprints(stdout: string): {
  footprints: Map<number, number>;
  skipped: number;
} {
  const footprints = new Map<number, number>();
  let skipped = 0;
  let inTable = false;
  for (const line of stdout.split("\n")) {
    if (!inTable) {
      inTable = /^\s*PID\s+MEM\b/.test(line);
      continue;
    }
    if (line.trim() === "") {
      continue;
    }
    const match = TOP_ROW.exec(line);
    if (match) {
      footprints.set(
        Number(match[1]),
        Math.round(Number(match[2].replace(",", ".")) * UNIT_BYTES[match[3] ?? "B"]),
      );
    } else {
      skipped += 1;
    }
  }
  return { footprints, skipped };
}

/** One read-only `top` sample of every process's footprint, keyed by pid. */
export async function readHostFootprints(
  executor: HostCommandExecutor,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Map<number, number>> {
  const top = await executor.executeCommand("top", TOP_FOOTPRINT_ARGS, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxBuffer: TOP_FOOTPRINT_MAX_BUFFER_BYTES,
  });
  const { footprints, skipped } = parseTopFootprints(top.stdout);
  if (footprints.size === 0) {
    throw new Error(`top returned no parseable footprints (${skipped} unparseable rows)`);
  }
  return footprints;
}

/** A sample younger than this is reused: footprints are only a sizing input, not a boot decision. */
export const FOOTPRINT_CACHE_TTL_MS = 20_000;
/** The one shared `top` child's own bound, independent of any caller's budget. */
export const FOOTPRINT_RUN_TIMEOUT_MS = 60_000;
/**
 * The longest a caller waits on a footprint sample. Beyond it the caller proceeds with the last
 * (stale) sample or without footprints, so a slow `top` never consumes a whole capacity sample
 * budget (#15307).
 */
export const FOOTPRINT_MAX_WAIT_MS = 5_000;
/** A stale sample is still better sizing than none, but not forever. */
export const FOOTPRINT_STALE_MAX_AGE_MS = 5 * 60_000;

/** Narrow seam the host source reads footprints through. */
export interface FootprintReader {
  read(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Map<number, number>>;
}

/**
 * Footprints through a single shared `top` child with a short-lived cache. Concurrent `top`
 * runs serialize in the kernel (4 take 12.5 s at 28 simulators), and a run abandoned by a
 * caller's timeout is not cancelled, so every caller joins the one in-flight run instead of
 * starting its own, and a caller that stops waiting never kills it (#15307).
 */
export class CachedFootprintReader implements FootprintReader {
  private cached: { takenAtMs: number; footprints: Map<number, number> } | undefined;
  private inFlight: Promise<Map<number, number>> | undefined;

  constructor(
    private readonly executor: HostCommandExecutor,
    private readonly timer: Timer,
    private readonly limits: {
      ttlMs?: number;
      runTimeoutMs?: number;
      maxWaitMs?: number;
      staleMaxAgeMs?: number;
    } = {},
  ) {}

  async read(
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Map<number, number>> {
    options.signal?.throwIfAborted();
    const fresh = this.cachedWithin(this.limits.ttlMs ?? FOOTPRINT_CACHE_TTL_MS);
    if (fresh) {
      return fresh;
    }
    const waitMs = Math.min(
      options.timeoutMs ?? Number.POSITIVE_INFINITY,
      this.limits.maxWaitMs ?? FOOTPRINT_MAX_WAIT_MS,
    );
    try {
      return await raceWithDeadline(() => this.run(), {
        timer: this.timer,
        timeoutMs: waitMs,
        signal: options.signal,
        label: "Reading host memory footprints",
      });
    } catch (error) {
      options.signal?.throwIfAborted();
      const stale = this.cachedWithin(this.limits.staleMaxAgeMs ?? FOOTPRINT_STALE_MAX_AGE_MS);
      if (stale) {
        logger.warn(`using stale host footprints: ${errorMessage(error)}`);
        return stale;
      }
      throw error;
    }
  }

  private cachedWithin(maxAgeMs: number): Map<number, number> | undefined {
    return this.cached && this.timer.now() - this.cached.takenAtMs < maxAgeMs
      ? this.cached.footprints
      : undefined;
  }

  private run(): Promise<Map<number, number>> {
    if (!this.inFlight) {
      const run = readHostFootprints(this.executor, {
        timeoutMs: this.limits.runTimeoutMs ?? FOOTPRINT_RUN_TIMEOUT_MS,
      })
        .then((footprints) => {
          this.cached = { takenAtMs: this.timer.now(), footprints };
          return footprints;
        })
        .finally(() => {
          if (this.inFlight === run) {
            this.inFlight = undefined;
          }
        });
      this.inFlight = run;
      // A run no caller is still waiting on must not become an unhandled rejection.
      run.catch((error: unknown) => {
        // Every waiter reports its own failure; this branch only prevents an unhandled rejection.
        logger.debug(`host footprint run failed: ${errorMessage(error)}`);
      });
    }
    return this.inFlight;
  }
}

/** Rows with their footprint attached; a process `top` did not list keeps no footprint. */
export function withFootprints(
  rows: readonly HostProcessRow[],
  footprints: ReadonlyMap<number, number>,
): HostProcessRow[] {
  return rows.map((row) => {
    const footprintBytes = footprints.get(row.pid);
    return footprintBytes === undefined ? row : { ...row, footprintBytes };
  });
}
