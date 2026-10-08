import { ScreenshotRetentionCapacityError } from "../../../src/features/observe/ScreenshotRetention";
import { SCREENSHOT_PATH_MIN_LIFETIME_MS } from "../../../src/features/observe/ScreenshotRetention";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { logger } from "../../../src/utils/logger";
import { getScreenshotStateStore } from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import {} from "../../../src/features/observe/screenshotCacheEviction";
import { BoundedScreenshotPathProtection } from "../../../src/features/observe/ScreenshotPathProtection";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import { observationScreenshotEvidence } from "../../../src/features/observe/screenshot/observationScreenshotEvidence";
import {
  setObserveCacheStore,
  resetObserveCacheStore,
  getObserveCacheStore,
} from "../../../src/features/observe/cache/ObserveCacheRegistry";
import {
  setScreenshotStateStore,
  resetScreenshotStateStore,
} from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { InMemoryScreenshotStateStore } from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeScreenshotFileWriter } from "../../fakes/FakeScreenshotFileWriter";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { androidDevice } from "./takeScreenshotTestHelpers";

function normalizeFakePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function samePath(a: string, b: string): boolean {
  return normalizeFakePath(a) === normalizeFakePath(b);
}

class RetentionFiles extends FakeFileSystem {
  metadata = new Map<string, { size: number; mtimeMs: number; isFile(): boolean }>();
  add(name: string, size: number, mtimeMs: number): string {
    const path = `/screenshots/${name}`;
    this.setFile(path, "frame");
    this.metadata.set(normalizeFakePath(path), { size, mtimeMs, isFile: () => true });
    return path;
  }
  override async stat(path: string) {
    const metadata = this.metadata.get(normalizeFakePath(path));
    if (!metadata || !this.existsSync(path)) {
      throw new Error("missing file");
    }
    return metadata;
  }
}
let timer: FakeTimer;
let files: RetentionFiles;
let protection: BoundedScreenshotPathProtection;
let states: InMemoryScreenshotStateStore;
function capture(cleanupOnCreate = false) {
  return new TakeScreenshot(
    androidDevice("retention"),
    new FakeAdbClientFactory(new FakeAdbExecutor()),
    timer,
    new CountingIdGenerator(),
    new FakeScreenshotFileWriter(),
    files,
    () => "/screenshots",
    undefined,
    cleanupOnCreate,
    { pathProtection: protection },
  );
}
async function sweep() {
  await protection.sweep("/screenshots", files);
}
beforeEach(() => {
  timer = new FakeTimer();
  files = new RetentionFiles();
  protection = new BoundedScreenshotPathProtection(timer, undefined);
  files.setDirectory("/screenshots");
  setObserveCacheStore(new FakeObserveCacheStore(timer));
  states = new InMemoryScreenshotStateStore(timer);
  setScreenshotStateStore(states);
});
afterEach(() => {
  resetObserveCacheStore();
  resetScreenshotStateStore();
});

test("returned old-mtime path survives the next size sweep", async () => {
  timer.advanceTime(300_000);
  const path = files.add("screenshot_0_device_old.png", 129 * 1024 * 1024, 0);
  await observationScreenshotEvidence(path, "cached", undefined, { files, timer, protection });
  await sweep();
  expect(files.existsSync(path)).toBe(true);
});

test("constructing multiple screenshot services sweeps a cache directory once", async () => {
  const sweepSpy = spyOn(protection, "sweep").mockResolvedValue(undefined);
  const cacheDir = "/screenshots";
  const create = () =>
    new TakeScreenshot(
      androidDevice("retention"),
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      timer,
      new CountingIdGenerator(),
      new FakeScreenshotFileWriter(),
      files,
      () => cacheDir,
      undefined,
      true,
      { pathProtection: protection },
    );

  create();
  create();
  await Promise.resolve();
  expect(sweepSpy).toHaveBeenCalledTimes(1);
});

test("a fresh protection sweeps the same cache directory once again", async () => {
  const firstSweep = spyOn(protection, "sweep").mockResolvedValue(undefined);
  const create = (pathProtection: BoundedScreenshotPathProtection) =>
    new TakeScreenshot(
      androidDevice("retention"),
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      timer,
      new CountingIdGenerator(),
      new FakeScreenshotFileWriter(),
      files,
      () => "/screenshots",
      undefined,
      true,
      { pathProtection },
    );

  create(protection);
  const freshProtection = new BoundedScreenshotPathProtection(timer, undefined);
  const freshSweep = spyOn(freshProtection, "sweep").mockResolvedValue(undefined);
  create(freshProtection);
  await Promise.resolve();
  expect(firstSweep).toHaveBeenCalledTimes(1);
  expect(freshSweep).toHaveBeenCalledTimes(1);
});
test("an equivalent protected spelling survives an over-budget sweep", async () => {
  timer.advanceTime(60_000);
  const path = files.add("screenshot_0_device_equivalent.png", 129 * 1024 * 1024, 0);
  await protection.protect("/screenshots/./screenshot_0_device_equivalent.png");
  await sweep();
  expect(files.existsSync(path)).toBe(true);
});

test("equivalent reference spellings in both stores survive a stale sweep", async () => {
  timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS + 1);
  const statePath = files.add("snapshot-of-state.png", 1, 0);
  const observePath = files.add("snapshot-of-observe.png", 1, 0);
  states.update("retention", "/screenshots/./snapshot-of-state.png");
  await getObserveCacheStore().put("retention", {
    updatedAt: timer.now(),
    screenSize: { width: 1, height: 1 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    screenshotPath: "/screenshots/./snapshot-of-observe.png",
  });
  await sweep();
  expect(files.existsSync(statePath)).toBe(true);
  expect(files.existsSync(observePath)).toBe(true);
});
test("previous-run stale screenshots are swept even below the size cap", async () => {
  timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS + 1);
  const path = files.add("snapshot-of-abandoned.png", 1, 0);
  await sweep();
  expect(files.existsSync(path)).toBe(false);
});
test("stale observe crops are swept while similar unrelated filenames survive", async () => {
  timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS + 1);
  const stale = [
    files.add("crop-8a4edfd3-272f-4d47-9288-1e73aacd1b97.png", 1, 0),
    files.add("crop-test_1-A.png", 1, 0),
  ];
  const unrelated = [
    files.add("crop-.png", 1, 0),
    files.add("crop-other.backup.png", 1, 0),
    files.add("crop-test.png.temp", 1, 0),
    files.add("other-crop-test.png", 1, 0),
  ];
  await sweep();
  for (const path of stale) {
    expect(files.existsSync(path)).toBe(false);
  }
  for (const path of unrelated) {
    expect(files.existsSync(path)).toBe(true);
  }
});

test("size sweep uses the injected clock for the cross-process mtime floor", async () => {
  timer.advanceTime(1_000);
  const path = files.add("screenshot_0_device_recent.png", 129 * 1024 * 1024, 0);
  await sweep();
  expect(files.existsSync(path)).toBe(true);
});

test("repeated publication near cache expiry survives clear and the next ten captures, then expires", async () => {
  const path = files.add("screenshot_0_device_cached.png", 129 * 1024 * 1024, 0);
  getScreenshotStateStore().update("retention", path);
  timer.advanceTime(299_999);
  await observationScreenshotEvidence(path, "cached", undefined, { files, timer, protection });
  timer.advanceTime(2);
  expect(getScreenshotStateStore().getReferencedScreenshotPaths().includes(path)).toBe(false);
  for (let i = 0; i < 10; i++) {
    RealObserveScreen.clearCache("retention");
    expect(getScreenshotStateStore().getPath("retention")).toBeUndefined();
    await sweep();
    expect(files.existsSync(path)).toBe(true);
  }
  timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS - 2);
  await sweep();
  expect(files.existsSync(path)).toBe(false);
});

test("fresh and crop publications use the same return-time window even with an old mtime", async () => {
  timer.advanceTime(60_000);
  for (const name of [
    "screenshot_0_device_fresh.png",
    "snapshot-of-crop.png",
    "crop-test_1-A.png",
  ]) {
    const path = files.add(name, 129 * 1024 * 1024, 0);
    await protection.protect(path);
    await sweep();
    expect(files.existsSync(path)).toBe(true);
    timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS);
    await sweep();
    expect(files.existsSync(path)).toBe(false);
  }
});

test("stale sweep excludes unrelated files, directories, references and protected files", async () => {
  timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS + 1);
  const referenced = files.add("screenshot_0_device_referenced.png", 1, 0);
  const protectedPath = files.add("snapshot-of-protected.png", 1, 0);
  const unrelated = files.add("unrelated.txt", 1, 0);
  const crashedPull = files.add("screenshot_0_device_crashed.png.temp", 1, 0);
  const directory = files.add("snapshot-of-directory.png", 1, 0);
  files.metadata.set(normalizeFakePath(directory), { size: 1, mtimeMs: 0, isFile: () => false });
  getScreenshotStateStore().update("retention", referenced);
  await protection.protect(protectedPath);
  await sweep();
  expect(files.existsSync(crashedPull)).toBe(false);
  for (const path of [referenced, protectedPath, unrelated, directory]) {
    expect(files.existsSync(path)).toBe(true);
  }
});

test("readdir failure logs its error and never rejects cleanup", async () => {
  const error = new Error("readdir denied");
  const read = spyOn(files, "readdir").mockRejectedValue(error);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    await sweep();
    expect(warn.mock.calls.some((call) => call[1] === error)).toBe(true);
  } finally {
    read.mockRestore();
    warn.mockRestore();
  }
});

test("stat and unlink failures log their errors and do not stop other stale deletions", async () => {
  timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS + 1);
  const badStat = files.add("snapshot-of-stat.png", 1, 0);
  const badUnlink = files.add("snapshot-of-unlink.png", 1, 0);
  const good = files.add("snapshot-of-good.png", 1, 0);
  const statError = new Error("stat denied");
  const unlinkError = new Error("unlink denied");
  const realStat = files.stat.bind(files);
  const realUnlink = files.unlink.bind(files);
  const stat = spyOn(files, "stat").mockImplementation(async (path) => {
    if (samePath(path, badStat)) {
      throw statError;
    }
    return realStat(path);
  });
  const unlink = spyOn(files, "unlink").mockImplementation(async (path) => {
    if (samePath(path, badUnlink)) {
      throw unlinkError;
    }
    await realUnlink(path);
  });
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    await sweep();
    expect(files.existsSync(good)).toBe(false);
    expect(files.existsSync(badUnlink)).toBe(true);
    expect(warn.mock.calls.some((call) => call[1] === statError)).toBe(true);
    expect(warn.mock.calls.some((call) => call[1] === unlinkError)).toBe(true);
  } finally {
    stat.mockRestore();
    unlink.mockRestore();
    warn.mockRestore();
  }
});

test("first capture construction sweeps files left by an earlier process", async () => {
  timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS + 1);
  const path = files.add("screenshot_0_device_previous.png", 1, 0);
  let deleted!: () => void;
  const deletion = new Promise<void>((resolve) => {
    deleted = resolve;
  });
  const remove = files.unlink.bind(files);
  const unlink = spyOn(files, "unlink").mockImplementation(async (target) => {
    await remove(target);
    deleted();
  });
  try {
    capture(true);
    await deletion;
    expect(files.existsSync(path)).toBe(false);
  } finally {
    unlink.mockRestore();
  }
});

test("over-budget cleanup logs protected count without deleting the live lease", async () => {
  timer.advanceTime(60_000);
  const path = files.add("snapshot-of-budget.png", 129 * 1024 * 1024, 0);
  await protection.protect(path);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    await sweep();
    expect(
      warn.mock.calls.some((call) => String(call[0]).includes("1 protected screenshots")),
    ).toBe(true);
    expect(files.existsSync(path)).toBe(true);
  } finally {
    warn.mockRestore();
  }
});

test("cache invalidation drops both reference stores without unlinking a returned file", async () => {
  timer.advanceTime(60_000);
  const path = files.add("screenshot_0_device_clear.png", 129 * 1024 * 1024, 0);
  await getObserveCacheStore().put("retention", {
    updatedAt: timer.now(),
    screenSize: { width: 1, height: 1 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    screenshotPath: path,
  });
  states.update("retention", path);
  await protection.protect(path);
  const unlink = spyOn(files, "unlink");
  try {
    expect(await getObserveCacheStore().getReferencedScreenshotPaths()).toContain(path);
    expect(states.getReferencedScreenshotPaths()).toContain(path);
    RealObserveScreen.defaultObserveScreenCache.clearForDevice("retention");
    expect(await getObserveCacheStore().getReferencedScreenshotPaths()).not.toContain(path);
    expect(states.getReferencedScreenshotPaths()).not.toContain(path);
    expect(unlink).not.toHaveBeenCalled();
    await sweep();
    expect(files.existsSync(path)).toBe(true);
  } finally {
    unlink.mockRestore();
  }
});

test("a reference added while another unlink is pending prevents deleting the next file", async () => {
  timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS + 1);
  const first = files.add("screenshot_0_device_a-first.png", 1, 0);
  const next = files.add("screenshot_0_device_next.png", 1, 0);
  const remove = files.unlink.bind(files);
  const unlink = spyOn(files, "unlink").mockImplementation(async (path) => {
    if (samePath(path, first)) {
      states.update("retention", next);
    }
    await remove(path);
  });
  try {
    await sweep();
    expect(files.existsSync(first)).toBe(false);
    expect(files.existsSync(next)).toBe(true);
  } finally {
    unlink.mockRestore();
  }
});

test("a newly added equivalent reference prevents deleting the next stale file", async () => {
  timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS + 1);
  const first = files.add("screenshot_0_device_a-first.png", 1, 0);
  const next = files.add("screenshot_0_device_next.png", 1, 0);
  const remove = files.unlink.bind(files);
  const unlink = spyOn(files, "unlink").mockImplementation(async (path) => {
    if (samePath(path, first)) {
      states.update("retention", "/screenshots/./screenshot_0_device_next.png");
    }
    await remove(path);
  });
  try {
    await sweep();
    expect(files.existsSync(first)).toBe(false);
    expect(files.existsSync(next)).toBe(true);
  } finally {
    unlink.mockRestore();
  }
});

test("restart gives old files a full process-start grace, then age sweeps them", async () => {
  timer.advanceTime(2_000_000);
  protection = new BoundedScreenshotPathProtection(timer, undefined);
  const old = files.add("snapshot-of-restart.png", 1, 0);
  await sweep();
  timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS - 1);
  await sweep();
  expect(files.existsSync(old)).toBe(true);
  timer.advanceTime(1);
  await sweep();
  expect(files.existsSync(old)).toBe(false);
});

test("restart grace never shortens a newer file's mtime floor", async () => {
  timer.advanceTime(2_000_000);
  protection = new BoundedScreenshotPathProtection(timer, undefined);
  const recent = files.add("snapshot-of-newer.png", 1, timer.now() + 100);
  await sweep();
  timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS);
  await sweep();
  expect(files.existsSync(recent)).toBe(true);
  timer.advanceTime(100);
  await sweep();
  expect(files.existsSync(recent)).toBe(false);
});

test("one opted-in timer per directory sweeps expired files while idle", async () => {
  const old = files.add("crop-timer.png", 1, 0);
  const interval = spyOn(timer, "setInterval");
  protection.start("/screenshots", { fileSystem: files, scheduled: true });
  protection.start("/screenshots", { fileSystem: files, scheduled: true });
  await sweep();
  await protection.protect(old);
  expect(interval).toHaveBeenCalledTimes(1);
  await timer.advanceTimeAsync(SCREENSHOT_PATH_MIN_LIFETIME_MS - 1);
  expect(files.existsSync(old)).toBe(true);
  await timer.advanceTimeAsync(1);
  expect(files.existsSync(old)).toBe(false);
  interval.mockRestore();
});

function writeFrame(name: string, size: number) {
  const path = `/screenshots/${name}`;
  return protection.write(path, {
    size,
    fileSystem: files,
    write: async () => {
      files.add(name, size, timer.now());
    },
    remove: () => files.unlink(path),
  });
}

test("two devices and sessions share the byte cap without evicting live paths", async () => {
  const paths = [
    files.add("screenshot_0_deviceA_sessionA.png", 64 * 1024 * 1024, 0),
    files.add("screenshot_0_deviceB_sessionB.png", 64 * 1024 * 1024, 0),
  ];
  timer.advanceTime(100);
  await protection.protect(paths[0]);
  await protection.protect(paths[1]);
  let failure: unknown;
  try {
    await writeFrame("crop-capacity.png", 1);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ScreenshotRetentionCapacityError);
  expect(failure).toMatchObject({
    cap: 128 * 1024 * 1024,
    liveCount: 2,
    earliestExpiresAt: 600_100,
  });
  expect((failure as Error).message).toContain(new Date(600_100).toISOString());
  for (const path of paths) {
    expect(files.existsSync(path)).toBe(true);
  }
  expect(files.existsSync("/screenshots/crop-capacity.png")).toBe(false);
});

test("count capacity refuses a new file and never drops a live file", async () => {
  // A small injected cap exercises the same admission path as the production 4096 without
  // building and sweeping 4096 fake files (~10 ms, the slowest test in this file).
  const countCap = 16;
  protection = new BoundedScreenshotPathProtection(timer, undefined, countCap);
  for (let i = 0; i < countCap; i++) {
    files.add(`crop-count-${i}.png`, 1, 0);
  }
  await expect(writeFrame("crop-count-overflow.png", 1)).rejects.toMatchObject({
    countCap,
    liveCount: countCap,
    earliestExpiresAt: 600_000,
  });
  expect(files.existsSync("/screenshots/crop-count-0.png")).toBe(true);
  expect(files.existsSync(`/screenshots/crop-count-${countCap - 1}.png`)).toBe(true);
});

test("post-write overshoot rolls back only the new unpublished frame", async () => {
  const live = files.add("screenshot_0_device_live.png", 127 * 1024 * 1024, 0);
  await protection.protect(live);
  const unlink = spyOn(files, "unlink");
  await expect(writeFrame("crop-overshoot.png", 2 * 1024 * 1024)).rejects.toBeInstanceOf(
    ScreenshotRetentionCapacityError,
  );
  expect(unlink.mock.calls).toEqual([["/screenshots/crop-overshoot.png"]]);
  expect(files.existsSync(live)).toBe(true);
  expect(files.existsSync("/screenshots/crop-overshoot.png")).toBe(false);
  unlink.mockRestore();
});

test("unlink failure logs and retries next sweep without rejecting capture cleanup", async () => {
  const old = files.add("crop-retry.png", 1, 0);
  timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS);
  const error = new Error("unlink denied");
  const unlink = spyOn(files, "unlink").mockRejectedValueOnce(error);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    await sweep();
    expect(files.existsSync(old)).toBe(true);
    expect(warn.mock.calls.some((call) => call[1] === error)).toBe(true);
    await sweep();
    expect(files.existsSync(old)).toBe(false);
  } finally {
    unlink.mockRestore();
    warn.mockRestore();
  }
});

test("cleanup failures still consume capacity and cannot permit unlimited new captures", async () => {
  files.add("crop-unremovable.png", 128 * 1024 * 1024, 0);
  timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS);
  const unlink = spyOn(files, "unlink").mockRejectedValue(new Error("denied"));
  try {
    await expect(writeFrame("crop-not-admitted.png", 1)).rejects.toBeInstanceOf(
      ScreenshotRetentionCapacityError,
    );
    expect(files.existsSync("/screenshots/crop-not-admitted.png")).toBe(false);
  } finally {
    unlink.mockRestore();
  }
});

test("publication waits for post-write admission and cannot lease an oversized frame", async () => {
  files.add("screenshot_0_device_live.png", 127 * 1024 * 1024, 0);
  let publication!: Promise<number>;
  const path = "/screenshots/crop-in-flight.png";
  const write = protection.write(path, {
    size: 2 * 1024 * 1024,
    fileSystem: files,
    write: async () => {
      files.add("crop-in-flight.png", 2 * 1024 * 1024, timer.now());
      publication = protection.protect(path);
      // Attach the rejection reader before the write's admission settles.
      void publication.catch(() => {});
    },
    remove: () => files.unlink(path),
  });
  await expect(write).rejects.toBeInstanceOf(ScreenshotRetentionCapacityError);
  await expect(publication).rejects.toBeInstanceOf(ScreenshotRetentionCapacityError);
  expect(files.existsSync(path)).toBe(false);
});
