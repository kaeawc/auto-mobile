import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  BoundedScreenshotPathProtection,
  SCREENSHOT_PATH_MIN_LIFETIME_MS,
} from "../../../src/features/observe/ScreenshotRetention";
import {
  DEFAULT_SCREENSHOT_RETENTION_LIMITS,
  guaranteedScreenshotCacheBytes,
  type ScreenshotRetentionLimits,
} from "../../../src/features/observe/screenshotCacheEviction";
import {
  resetObserveCacheStore,
  setObserveCacheStore,
} from "../../../src/features/observe/cache/ObserveCacheRegistry";
import {
  InMemoryScreenshotStateStore,
  resetScreenshotStateStore,
  setScreenshotStateStore,
} from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { screenshotFileName } from "../../../src/utils/screenshot/screenshotFormats";
import { logger } from "../../../src/utils/logger";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../../fakes/FakeTimer";

/** Round 4 (#15182): about 3.2 MB PNGs, one observe with a screenshot per sim every 10 s. */
const FRAME_BYTES = 3_200_000;
const CADENCE_MS = 10_000;
const MiB = 1024 * 1024;

class SizedFiles extends FakeFileSystem {
  readonly entries = new Map<string, { size: number; mtimeMs: number; isFile(): boolean }>();
  readonly unlinked: string[] = [];
  add(path: string, size: number, mtimeMs: number): void {
    this.setFile(path, "frame");
    this.entries.set(path.replace(/\\/g, "/"), { size, mtimeMs, isFile: () => true });
  }
  async lstat(path: string) {
    const entry = this.entries.get(path.replace(/\\/g, "/"));
    if (!entry) {
      throw Object.assign(new Error("vanished"), { code: "ENOENT" });
    }
    return entry;
  }
  override async unlink(path: string) {
    const key = path.replace(/\\/g, "/");
    await super.unlink(key);
    this.entries.delete(key);
    this.unlinked.push(key);
  }
  bytes(): number {
    return [...this.entries.values()].reduce((sum, file) => sum + file.size, 0);
  }
}

interface RoundFour {
  readonly capturedAt: Map<string, number>;
  readonly bySim: string[][];
  readonly early: string[];
  readonly files: SizedFiles;
  readonly timer: FakeTimer;
  readonly warnings: string[];
  peakBytes: number;
}

/** Replays the round-4 sequence: every sim captures once per 10 s round. */
async function run(
  sims: number,
  rounds: number,
  limits?: ScreenshotRetentionLimits,
): Promise<RoundFour> {
  const timer = new FakeTimer();
  const files = new SizedFiles();
  files.setDirectory("/screenshots");
  setObserveCacheStore(new FakeObserveCacheStore(timer));
  setScreenshotStateStore(new InMemoryScreenshotStateStore(timer));
  const protection = new BoundedScreenshotPathProtection(timer, undefined, undefined, limits);
  const result: RoundFour = {
    capturedAt: new Map(),
    bySim: Array.from({ length: sims }, () => []),
    early: [],
    files,
    timer,
    warnings: [],
    peakBytes: 0,
  };
  const warn = spyOn(logger, "warn").mockImplementation((message) => {
    result.warnings.push(String(message));
  });
  try {
    for (let round = 0; round < rounds; round++) {
      for (let sim = 0; sim < sims; sim++) {
        const name = screenshotFileName(timer.now(), `sim${sim}`, String(round), "png");
        const path = `/screenshots/${name}`;
        await protection.write(path, {
          size: FRAME_BYTES,
          fileSystem: files,
          write: async () => files.add(path, FRAME_BYTES, timer.now()),
          remove: () => files.unlink(path),
        });
        await protection.protect(path);
        result.capturedAt.set(path, timer.now());
        result.bySim[sim]?.push(path);
        result.peakBytes = Math.max(result.peakBytes, files.bytes());
      }
      for (const path of files.unlinked.splice(0)) {
        if (timer.now() - (result.capturedAt.get(path) ?? 0) < SCREENSHOT_PATH_MIN_LIFETIME_MS) {
          result.early.push(path);
        }
      }
      timer.advanceTime(CADENCE_MS);
    }
  } finally {
    warn.mockRestore();
  }
  return result;
}

const evictionWarnings = (result: RoundFour) =>
  result.warnings.filter((message) => message.includes("before their guarantee expired"));

afterAll(() => {
  resetObserveCacheStore();
  resetScreenshotStateStore();
});

describe.each([3, 6])("round 4 scale run with %d simulators", (sims) => {
  let result: RoundFour;
  beforeAll(async () => {
    // 12 minutes at one frame per sim per 10 s: well past the first frames' 10-minute guarantee.
    result = await run(sims, 72);
  });

  test("never evicts a frame inside its 10-minute guarantee", () => {
    expect(result.early).toEqual([]);
    expect(evictionWarnings(result)).toEqual([]);
  });

  test("keeps every frame from the last ten minutes readable", () => {
    const now = result.timer.now();
    const live = [...result.capturedAt].filter(
      ([, at]) => now - at < SCREENSHOT_PATH_MIN_LIFETIME_MS,
    );
    expect(live.length).toBeGreaterThanOrEqual(sims * 59);
    expect(live.filter(([path]) => !result.files.entries.has(path))).toEqual([]);
  });

  test("reclaims frames once their guarantee has expired", () => {
    const now = result.timer.now();
    const expiredStillThere = [...result.capturedAt].filter(
      ([path, at]) =>
        now - at >= SCREENSHOT_PATH_MIN_LIFETIME_MS + CADENCE_MS && result.files.entries.has(path),
    );
    expect(expiredStillThere).toEqual([]);
  });

  test("stays inside the ceiling", () => {
    expect(result.peakBytes).toBeLessThanOrEqual(DEFAULT_SCREENSHOT_RETENTION_LIMITS.ceilingBytes);
  });
});

describe("overload past the ceiling", () => {
  const limits: ScreenshotRetentionLimits = {
    ...DEFAULT_SCREENSHOT_RETENTION_LIMITS,
    ceilingBytes: 256 * MiB,
  };
  let result: RoundFour;
  beforeAll(async () => {
    // 180 captures under eviction pressure: replay once outside the per-test budget, like the
    // scale runs above, and assert on the outcome.
    result = await run(6, 30, limits);
  });

  test("evicts under pressure instead of failing the capture and keeps each newest three", () => {
    expect(result.peakBytes).toBeLessThanOrEqual(limits.ceilingBytes);
    expect(evictionWarnings(result).length).toBeGreaterThan(0);
    for (let sim = 0; sim < 6; sim++) {
      const newest = (result.bySim[sim] ?? []).slice(-3);
      expect(newest.every((path) => result.files.entries.has(path))).toBe(true);
    }
  });
});

describe("guaranteedScreenshotCacheBytes", () => {
  const limits = { ...DEFAULT_SCREENSHOT_RETENTION_LIMITS, ceilingBytes: 1000 * MiB };
  test("never drops below the device-scaled capacity", () => {
    expect(guaranteedScreenshotCacheBytes(limits, 3, 0)).toBe(192 * MiB);
  });
  test("grows to cover bytes still inside their guarantee", () => {
    expect(guaranteedScreenshotCacheBytes(limits, 3, 500 * MiB)).toBe(500 * MiB);
  });
  test("is bounded by the ceiling", () => {
    expect(guaranteedScreenshotCacheBytes(limits, 3, 5000 * MiB)).toBe(1000 * MiB);
  });
  test("never lowers the base when the ceiling is smaller", () => {
    expect(guaranteedScreenshotCacheBytes({ ...limits, ceilingBytes: MiB }, 1, 500 * MiB)).toBe(
      limits.baseBytes,
    );
  });
});
