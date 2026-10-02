import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { logger } from "../../../src/utils/logger";
import { getScreenshotStateStore } from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import {
  SCREENSHOT_MIN_LIFETIME_MS,
  SCREENSHOT_STALE_AGE_MS,
} from "../../../src/features/observe/screenshotCacheEviction";
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

class RetentionFiles extends FakeFileSystem {
  metadata = new Map<string, { size: number; mtimeMs: number; isFile(): boolean }>();
  add(name: string, size: number, mtimeMs: number): string {
    const path = `/screenshots/${name}`;
    this.setFile(path, "frame");
    this.metadata.set(path, { size, mtimeMs, isFile: () => true });
    return path;
  }
  override async stat(path: string) {
    const metadata = this.metadata.get(path);
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
    protection,
  );
}
async function sweep() {
  await capture()["cleanupCache"]();
}
beforeEach(() => {
  timer = new FakeTimer();
  files = new RetentionFiles();
  protection = new BoundedScreenshotPathProtection(timer);
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
  await observationScreenshotEvidence(path, "cached", undefined, files, timer, protection);
  await sweep();
  expect(files.existsSync(path)).toBe(true);
});
test("previous-run stale screenshots are swept even below the size cap", async () => {
  timer.advanceTime(24 * 60 * 60 * 1000 + 1);
  const path = files.add("snapshot-of-abandoned.png", 1, 0);
  await sweep();
  expect(files.existsSync(path)).toBe(false);
});
test("stale observe crops are swept while similar unrelated filenames survive", async () => {
  timer.advanceTime(SCREENSHOT_STALE_AGE_MS + 1);
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
  await observationScreenshotEvidence(path, "cached", undefined, files, timer, protection);
  timer.advanceTime(2);
  expect(getScreenshotStateStore().getReferencedScreenshotPaths().includes(path)).toBe(false);
  for (let i = 0; i < 10; i++) {
    RealObserveScreen.clearCache("retention");
    expect(getScreenshotStateStore().getPath("retention")).toBeUndefined();
    await sweep();
    expect(files.existsSync(path)).toBe(true);
  }
  timer.advanceTime(SCREENSHOT_MIN_LIFETIME_MS - 2);
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
    timer.advanceTime(SCREENSHOT_MIN_LIFETIME_MS);
    await sweep();
    expect(files.existsSync(path)).toBe(false);
  }
});

test("stale sweep excludes unrelated files, directories, references and protected files", async () => {
  timer.advanceTime(SCREENSHOT_STALE_AGE_MS + 1);
  const referenced = files.add("screenshot_0_device_referenced.png", 1, 0);
  const protectedPath = files.add("snapshot-of-protected.png", 1, 0);
  const unrelated = files.add("unrelated.txt", 1, 0);
  const crashedPull = files.add("screenshot_0_device_crashed.png.temp", 1, 0);
  const directory = files.add("snapshot-of-directory.png", 1, 0);
  files.metadata.set(directory, { size: 1, mtimeMs: 0, isFile: () => false });
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
  timer.advanceTime(SCREENSHOT_STALE_AGE_MS + 1);
  const badStat = files.add("snapshot-of-stat.png", 1, 0);
  const badUnlink = files.add("snapshot-of-unlink.png", 1, 0);
  const good = files.add("snapshot-of-good.png", 1, 0);
  const statError = new Error("stat denied");
  const unlinkError = new Error("unlink denied");
  const realStat = files.stat.bind(files);
  const realUnlink = files.unlink.bind(files);
  const stat = spyOn(files, "stat").mockImplementation(async (path) => {
    if (path === badStat) {
      throw statError;
    }
    return realStat(path);
  });
  const unlink = spyOn(files, "unlink").mockImplementation(async (path) => {
    if (path === badUnlink) {
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
  timer.advanceTime(SCREENSHOT_STALE_AGE_MS + 1);
  const path = files.add("screenshot_0_device_previous.png", 1, 0);
  capture(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(files.existsSync(path)).toBe(false);
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
  timer.advanceTime(SCREENSHOT_STALE_AGE_MS + 1);
  const first = files.add("snapshot-of-first.png", 1, 0);
  const next = files.add("screenshot_0_device_next.png", 1, 0);
  const remove = files.unlink.bind(files);
  const unlink = spyOn(files, "unlink").mockImplementation(async (path) => {
    if (path === first) {
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
