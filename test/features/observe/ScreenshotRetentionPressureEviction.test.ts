import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BoundedScreenshotPathProtection,
  SCREENSHOT_PRESSURE_EVICTION_MIN_AGE_MS,
  ScreenshotRetentionCapacityError,
} from "../../../src/features/observe/ScreenshotRetention";
import { SCREENSHOT_CACHE_MAX_SIZE_BYTES } from "../../../src/features/observe/screenshotCacheEviction";
import {
  resetObserveCacheStore,
  setObserveCacheStore,
} from "../../../src/features/observe/cache/ObserveCacheRegistry";
import {
  InMemoryScreenshotStateStore,
  resetScreenshotStateStore,
  setScreenshotStateStore,
} from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../../fakes/FakeTimer";

/** iPhone Pro settled frames are ~3.3 MB, so the 128 MiB cap holds about 40 (#8758). */
const LARGE_FRAME_BYTES = 3_300_000;

class SizedFiles extends FakeFileSystem {
  readonly entries = new Map<string, { size: number; mtimeMs: number; isFile(): boolean }>();
  readonly unlinked: string[] = [];
  add(path: string, size: number, mtimeMs: number): void {
    this.setFile(path, "frame");
    this.entries.set(path, { size, mtimeMs, isFile: () => true });
  }
  async lstat(path: string) {
    const entry = this.entries.get(path);
    if (!entry) {
      throw Object.assign(new Error("vanished"), { code: "ENOENT" });
    }
    return entry;
  }
  override async unlink(path: string) {
    await super.unlink(path);
    this.entries.delete(path);
    this.unlinked.push(path);
  }
  bytes(): number {
    return [...this.entries.values()].reduce((total, entry) => total + entry.size, 0);
  }
}

class ReferencingStateStore extends InMemoryScreenshotStateStore {
  referenced: string[] = [];
  override getReferencedScreenshotPaths(): readonly string[] {
    return this.referenced;
  }
}

let timer: FakeTimer;
let files: SizedFiles;
let state: ReferencingStateStore;
let protection: BoundedScreenshotPathProtection;

beforeEach(() => {
  timer = new FakeTimer();
  files = new SizedFiles();
  files.setDirectory("/screenshots");
  state = new ReferencingStateStore(timer);
  setObserveCacheStore(new FakeObserveCacheStore(timer));
  setScreenshotStateStore(state);
  protection = new BoundedScreenshotPathProtection(timer);
});

afterEach(() => {
  resetObserveCacheStore();
  resetScreenshotStateStore();
});

function frame(index: number): string {
  return `/screenshots/screenshot_${index}.png`;
}

/** Write a frame and return its path to the client, as a settled observe does. */
async function capture(index: number, size = LARGE_FRAME_BYTES): Promise<void> {
  const path = frame(index);
  await protection.write(path, {
    size,
    fileSystem: files,
    write: async () => files.add(path, size, timer.now()),
    remove: () => files.unlink(path),
  });
  await protection.protect(path);
}

describe("screenshot retention under capacity pressure (#8758)", () => {
  test("a 60-frame large-screen run evicts the oldest frames instead of failing", async () => {
    for (let index = 0; index < 60; index++) {
      await capture(index);
      timer.advanceTime(1_000);
    }
    expect(files.existsSync(frame(59))).toBe(true);
    expect(files.bytes()).toBeLessThanOrEqual(SCREENSHOT_CACHE_MAX_SIZE_BYTES);
    // Oldest first: exactly the earliest frames were evicted, in capture order.
    expect(files.unlinked.length).toBe(60 - files.entries.size);
    expect(files.unlinked).toEqual(files.unlinked.map((_, index) => frame(index)));
  });

  test("referenced frames are kept and the next oldest is evicted", async () => {
    const capacityFrames = Math.floor(SCREENSHOT_CACHE_MAX_SIZE_BYTES / LARGE_FRAME_BYTES);
    for (let index = 0; index < capacityFrames; index++) {
      await capture(index);
      timer.advanceTime(1_000);
    }
    state.referenced = [frame(0)];
    await capture(capacityFrames);
    expect(files.existsSync(frame(0))).toBe(true);
    expect(files.unlinked).toEqual([frame(1)]);
  });

  test("a re-returned frame counts as recently used", async () => {
    const capacityFrames = Math.floor(SCREENSHOT_CACHE_MAX_SIZE_BYTES / LARGE_FRAME_BYTES);
    for (let index = 0; index < capacityFrames; index++) {
      await capture(index);
      timer.advanceTime(1_000);
    }
    await protection.protect(frame(0));
    timer.advanceTime(SCREENSHOT_PRESSURE_EVICTION_MIN_AGE_MS);
    await capture(capacityFrames);
    expect(files.unlinked).toEqual([frame(1)]);
  });

  test("the cap still refuses a capture when only referenced or very recent frames remain", async () => {
    const half = SCREENSHOT_CACHE_MAX_SIZE_BYTES / 2;
    await capture(0, half);
    timer.advanceTime(60_000);
    state.referenced = [frame(0)];
    await capture(1, half);
    timer.advanceTime(SCREENSHOT_PRESSURE_EVICTION_MIN_AGE_MS - 1);
    await expect(capture(2, LARGE_FRAME_BYTES)).rejects.toBeInstanceOf(
      ScreenshotRetentionCapacityError,
    );
    expect(files.unlinked).toEqual([]);
    expect(files.existsSync(frame(2))).toBe(false);
  });

  test("the file-count cap also evicts the oldest frame", async () => {
    protection = new BoundedScreenshotPathProtection(timer, undefined, 3);
    for (let index = 0; index < 5; index++) {
      await capture(index, 1);
      timer.advanceTime(SCREENSHOT_PRESSURE_EVICTION_MIN_AGE_MS);
    }
    expect(files.unlinked).toEqual([frame(0), frame(1)]);
    expect(files.entries.size).toBe(3);
  });
});
