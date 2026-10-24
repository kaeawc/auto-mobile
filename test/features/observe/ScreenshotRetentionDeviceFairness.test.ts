import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  BoundedScreenshotPathProtection,
  SCREENSHOT_PATH_MIN_LIFETIME_MS,
} from "../../../src/features/observe/ScreenshotRetention";
import {
  DEFAULT_SCREENSHOT_RETENTION_LIMITS,
  type ScreenshotRetentionLimits,
} from "../../../src/features/observe/screenshotCacheEviction";
import { BASE_CAP_SCREENSHOT_LIMITS } from "../../helpers/screenshotRetentionLimits";
import {
  resetObserveCacheStore,
  setObserveCacheStore,
} from "../../../src/features/observe/cache/ObserveCacheRegistry";
import {
  resetScreenshotStateStore,
  setScreenshotStateStore,
  InMemoryScreenshotStateStore,
} from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { screenshotFileName } from "../../../src/utils/screenshot/screenshotFormats";
import { logger } from "../../../src/utils/logger";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../../fakes/FakeTimer";

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
let timer: FakeTimer;
let files: SizedFiles;
let protection: BoundedScreenshotPathProtection;
const tiny: ScreenshotRetentionLimits = {
  baseBytes: 6_000,
  perDeviceBytes: 1_000,
  ceilingBytes: 6_000,
  keepPerDevice: 3,
};

function setup(): void {
  timer = new FakeTimer();
  files = new SizedFiles();
  files.setDirectory("/screenshots");
  setObserveCacheStore(new FakeObserveCacheStore(timer));
  setScreenshotStateStore(new InMemoryScreenshotStateStore(timer));
  protection = new BoundedScreenshotPathProtection(timer, undefined, undefined, tiny);
}
function reset(): void {
  resetObserveCacheStore();
  resetScreenshotStateStore();
}
async function capture(
  device: string,
  index: number,
  size = 1_000,
  advance = 10_000,
): Promise<string> {
  const path = `/screenshots/${screenshotFileName(timer.now(), device, String(index), "png")}`;
  await protection.write(path, {
    size,
    fileSystem: files,
    write: async () => files.add(path, size, timer.now()),
    remove: () => files.unlink(path),
  });
  await protection.protect(path);
  timer.advanceTime(advance);
  return path;
}

describe("twelve-device screenshot retention", () => {
  const recent = new Map<string, string[]>();
  const missingNewest = new Set<string>();
  let overBudget = false;
  beforeAll(async () => {
    setup();
    protection = new BoundedScreenshotPathProtection(timer);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      // Build the long-running fixture once; individual assertions stay below 100 ms.
      for (let index = 0; index < 60; index++) {
        for (let device = 0; device < 12; device++) {
          const id = String(device);
          const path = await capture(id, index, 3_300_000, 0);
          recent.set(id, [...(recent.get(id) ?? []), path].slice(-3));
          for (const paths of recent.values()) {
            for (const kept of paths) {
              if (!files.existsSync(kept)) {
                missingNewest.add(kept);
              }
            }
          }
          // Guaranteed frames lift the device scale, but never past the ceiling.
          overBudget ||= files.bytes() > DEFAULT_SCREENSHOT_RETENTION_LIMITS.ceilingBytes;
        }
        timer.advanceTime(10_000);
      }
    } finally {
      warn.mockRestore();
    }
  });
  afterAll(reset);
  test("no device loses a newest-three frame during sixty capture rounds", () => {
    expect([...missingNewest]).toEqual([]);
    expect(overBudget).toBe(false);
    expect(files.bytes()).toBeLessThanOrEqual(DEFAULT_SCREENSHOT_RETENTION_LIMITS.ceilingBytes);
  });
  test.each(Array.from({ length: 12 }, (_, device) => String(device)))(
    "device %s retains its latest three at the end",
    (id) => {
      const paths = recent.get(id) ?? [];
      expect(paths).toHaveLength(3);
      expect(paths.every((path) => files.existsSync(path))).toBe(true);
    },
  );
});

describe("device fairness under pressure", () => {
  beforeEach(setup);
  afterEach(reset);
  test("a noisy device cannot evict a quiet device's newest K", async () => {
    const quiet = [];
    for (let index = 0; index < 3; index++) {
      quiet.push(await capture("quiet", index));
    }
    for (let index = 0; index < 12; index++) {
      await capture("noisy", index);
    }
    expect(quiet.every((path) => files.existsSync(path))).toBe(true);
    expect(files.unlinked.length).toBe(9);
  });

  test("newest K outlast even referenced non-latest frames", async () => {
    const quiet = await capture("quiet", 0);
    const older = await capture("noisy", 0);
    for (let index = 1; index < 4; index++) {
      await capture("noisy", index);
    }
    const cache = new FakeObserveCacheStore(timer);
    cache.getReferencedScreenshotPaths = async () => [older];
    setObserveCacheStore(cache);
    await capture("other", 0, 2_000);
    expect(files.existsSync(quiet)).toBe(true);
    expect(files.unlinked).toEqual([older]);
  });

  test("last resort evicts oldest of K and oversized captures are admitted with warning", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const oldest = await capture("quiet", 0, 2_000);
      const latest = await capture("quiet", 1, 2_000);
      await capture("other", 0, 3_000);
      expect(files.unlinked).toEqual([oldest]);
      expect(files.existsSync(latest)).toBe(true);
      expect(
        warn.mock.calls.some(([message]) => String(message).includes("1 were a device's newest")),
      ).toBe(true);
      const oversized = await capture("other", 1, 7_000);
      expect(files.existsSync(oversized)).toBe(true);
      expect(
        warn.mock.calls.some(([message]) => String(message).includes("admitting it anyway")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("incoming frame counts toward its device's K", async () => {
    protection = new BoundedScreenshotPathProtection(timer, undefined, undefined, {
      ...tiny,
      baseBytes: 3_000,
      ceilingBytes: 3_000,
      keepPerDevice: 2,
    });
    const quiet = await capture("quiet", 0);
    const oldNoisy = await capture("noisy", 0);
    await capture("noisy", 1);
    await capture("noisy", 2);
    expect(files.unlinked).toEqual([oldNoisy]);
    expect(files.existsSync(quiet)).toBe(true);
  });

  test("expired devices cease to scale capacity even with referenced files", async () => {
    protection = new BoundedScreenshotPathProtection(timer, undefined, undefined, {
      ...tiny,
      baseBytes: 2_000,
      perDeviceBytes: 2_000,
    });
    const cache = new FakeObserveCacheStore(timer);
    cache.getReferencedScreenshotPaths = async () => [...files.entries.keys()];
    setObserveCacheStore(cache);
    await capture("expired", 0, 2_000);
    timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS);
    await capture("active", 0, 2_000);
    expect(files.entries.size).toBe(1);
    expect(files.bytes()).toBe(2_000);
  });

  test("zero keepPerDevice restores LRU ordering", async () => {
    protection = new BoundedScreenshotPathProtection(timer, undefined, undefined, {
      ...tiny,
      keepPerDevice: 0,
    });
    const quiet = await capture("quiet", 0);
    for (let index = 0; index < 6; index++) {
      await capture("noisy", index);
    }
    expect(files.unlinked).toEqual([quiet]);
  });

  test("guaranteed frames lift capacity above the device scale and its drop reclaims them", async () => {
    protection = new BoundedScreenshotPathProtection(timer, undefined, undefined, {
      baseBytes: 3_000,
      perDeviceBytes: 2_000,
      ceilingBytes: 10_000,
      keepPerDevice: 0,
    });
    await capture("a", 0, 1_000);
    await capture("b", 0, 3_000);
    await capture("c", 0, 2_000);
    await capture("c", 1, 3_000);
    expect(files.unlinked).toEqual([]);
    expect(files.bytes()).toBe(9_000);
    timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS);
    const next = await capture("c", 2, 1_000);
    expect(files.bytes()).toBe(1_000);
    expect([...files.entries.keys()]).toEqual([next]);
  });

  test("past the ceiling the cap holds for the whole pass and evicts the least recently touched", async () => {
    protection = new BoundedScreenshotPathProtection(timer, undefined, undefined, {
      baseBytes: 3_000,
      perDeviceBytes: 2_000,
      ceilingBytes: 6_000,
      keepPerDevice: 0,
    });
    const a = await capture("a", 0, 1_000);
    const b = await capture("b", 0, 3_000);
    const c = await capture("c", 0, 2_000);
    const incoming = await capture("c", 1, 3_000);
    expect(files.unlinked).toEqual([a, b]);
    expect([...files.entries.keys()]).toEqual([c, incoming]);
    expect(files.bytes()).toBe(5_000);
  });

  test("a newest frame mid-removal leaves K slots for the device's remaining frames", async () => {
    protection = new BoundedScreenshotPathProtection(timer, undefined, undefined, {
      ...tiny,
      keepPerDevice: 2,
    });
    const quiet = [await capture("quiet", 0), await capture("quiet", 1)];
    const noisy = await capture("noisy", 0);
    await capture("noisy", 1);
    const newest = `/screenshots/${screenshotFileName(timer.now(), "quiet", "2", "png")}`;
    await protection.write(newest, {
      size: 1_000,
      fileSystem: files,
      write: async () => files.add(newest, 1_000, timer.now()),
      remove: () => files.unlink(newest),
    });
    timer.advanceTime(10_000);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const unlink = files.unlink.bind(files);
    const blocked = spyOn(files, "unlink").mockImplementation(async (path) => {
      if (path === newest) {
        await gate;
      }
      await unlink(path);
    });
    const removal = protection.removeIfUnprotected(newest, async () => {
      await files.unlink(newest);
      return true;
    });
    try {
      await capture("noisy", 2, 2_000);
      expect(files.unlinked).toEqual([noisy]);
      expect(quiet.every((path) => files.existsSync(path))).toBe(true);
    } finally {
      finish();
      await removal;
      blocked.mockRestore();
    }
  });

  test("two devices retain the base byte cap when the ceiling is the base", async () => {
    protection = new BoundedScreenshotPathProtection(
      timer,
      undefined,
      undefined,
      BASE_CAP_SCREENSHOT_LIMITS,
    );
    const half = DEFAULT_SCREENSHOT_RETENTION_LIMITS.baseBytes / 2;
    await capture("a", 0, half);
    await capture("b", 0, half);
    await capture("a", 1, half);
    expect(files.entries.size).toBe(2);
    expect(files.bytes()).toBe(DEFAULT_SCREENSHOT_RETENTION_LIMITS.baseBytes);
  });

  test("six active devices grow capacity and growth stops at the ceiling", async () => {
    protection = new BoundedScreenshotPathProtection(timer);
    const perDevice = DEFAULT_SCREENSHOT_RETENTION_LIMITS.perDeviceBytes;
    for (let index = 0; index < 6; index++) {
      await capture(String(index), 0, perDevice);
    }
    expect(files.bytes()).toBe(384 * 1024 * 1024);
    expect(files.unlinked).toEqual([]);
    const { ceilingBytes } = DEFAULT_SCREENSHOT_RETENTION_LIMITS;
    for (let index = 6; index < 40; index++) {
      await capture(String(index), 0, perDevice);
    }
    expect(files.bytes()).toBe(ceilingBytes);
    expect(files.entries.size).toBe(ceilingBytes / perDevice);
  });
});
