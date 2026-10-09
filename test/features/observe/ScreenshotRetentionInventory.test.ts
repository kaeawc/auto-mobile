import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  BoundedScreenshotPathProtection,
  SCREENSHOT_PATH_MIN_LIFETIME_MS,
} from "../../../src/features/observe/ScreenshotRetention";
import { SCREENSHOT_CACHE_MAX_SIZE_BYTES } from "../../../src/features/observe/screenshotCacheEviction";
import {
  resetObserveCacheStore,
  setObserveCacheStore,
} from "../../../src/features/observe/cache/ObserveCacheRegistry";
import {
  resetScreenshotStateStore,
  setScreenshotStateStore,
  InMemoryScreenshotStateStore,
} from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../../fakes/FakeTimer";

class RecordingRetentionFiles extends FakeFileSystem {
  readonly entries = new Map<string, { size: number; mtimeMs: number; isFile(): boolean }>();
  readonly calls = { readdir: 0, lstat: 0, unlink: 0 };
  missingOnUnlink?: string;
  writeError?: string;
  private key(path: string): string {
    return path.replace(/\\/g, "/");
  }
  add(name: string, size: number, mtimeMs: number): string {
    const path = `/screenshots/${name}`;
    this.setFile(path, "frame");
    this.entries.set(path, { size, mtimeMs, isFile: () => true });
    return path;
  }
  override async readdir(path: string) {
    this.calls.readdir++;
    return super.readdir(path);
  }
  async lstat(path: string) {
    this.calls.lstat++;
    const entry = this.entries.get(this.key(path));
    if (!entry) {
      throw Object.assign(new Error("vanished"), { code: "ENOENT" });
    }
    return entry;
  }
  override async unlink(path: string) {
    this.calls.unlink++;
    await super.unlink(path);
    this.entries.delete(this.key(path));
    if (this.key(path) === this.missingOnUnlink) {
      throw Object.assign(new Error("vanished during unlink"), { code: "ENOENT" });
    }
  }
}
let timer: FakeTimer;
let files: RecordingRetentionFiles;
let protection: BoundedScreenshotPathProtection;
beforeEach(() => {
  timer = new FakeTimer();
  files = new RecordingRetentionFiles();
  files.setDirectory("/screenshots");
  protection = new BoundedScreenshotPathProtection(timer);
  setObserveCacheStore(new FakeObserveCacheStore(timer));
  setScreenshotStateStore(new InMemoryScreenshotStateStore(timer));
});
afterEach(() => {
  resetObserveCacheStore();
  resetScreenshotStateStore();
});
function write(name: string, size = 1, authority = protection, clock = timer) {
  const path = `/screenshots/${name}`;
  return authority.write(path, {
    size,
    fileSystem: files,
    write: async () => {
      if (files.writeError) {
        throw Object.assign(new Error("write failed"), { code: files.writeError });
      }
      files.add(name, size, clock.now());
    },
    remove: () => files.unlink(path),
  });
}

test("50 captures inventory once; one explicit sweep reconciles and removes expired files", async () => {
  for (let i = 0; i < 50; i++) {
    await write(`crop-${i}.png`);
  }
  console.log("50 captures FS calls:", JSON.stringify(files.calls));
  expect(files.calls).toEqual({ readdir: 1, lstat: 0, unlink: 0 });
  Object.assign(files.calls, { readdir: 0, lstat: 0, unlink: 0 });
  timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS);
  await protection.sweep("/screenshots", files);
  console.log("one explicit sweep FS calls:", JSON.stringify(files.calls));
  expect(files.calls).toEqual({ readdir: 1, lstat: 50, unlink: 50 });
});

test("independent authorities capture concurrently and preserve each other's mtime floor under cap pressure", async () => {
  protection = new BoundedScreenshotPathProtection(timer);
  const otherTimer = new FakeTimer();
  const other = new BoundedScreenshotPathProtection(otherTimer);
  let finish!: () => void;
  let started!: () => void;
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const first = protection.write("/screenshots/crop-processA.png", {
    size: 70 * 1024 * 1024,
    fileSystem: files,
    write: async () => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      files.add("crop-processA.png", 70 * 1024 * 1024, timer.now());
    },
    remove: () => files.unlink("/screenshots/crop-processA.png"),
  });
  await writing;
  try {
    await write("snapshot-of-processB.png", 70 * 1024 * 1024, other, otherTimer);
  } finally {
    finish();
    await first;
  }
  timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS - 1);
  otherTimer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS - 1);
  await protection.sweep("/screenshots", files);
  await other.sweep("/screenshots", files);
  expect(files.calls.unlink).toBe(0);
  expect(files.entries.size).toBe(2);
});

test("external live files appear at the next sweep and are evicted to admit a capture", async () => {
  await write("crop-local.png");
  const external = files.add(
    "snapshot-of-external.png",
    SCREENSHOT_CACHE_MAX_SIZE_BYTES,
    timer.now(),
  );
  await write("crop-before-sweep.png");
  expect(files.calls.readdir).toBe(1);
  await protection.sweep("/screenshots", files);
  await write("crop-after-sweep.png");
  expect(files.existsSync(external)).toBe(false);
  expect(files.entries.has("/screenshots/crop-after-sweep.png")).toBe(true);
});

test("projected bytes at the 90 percent margin trigger exactly one reconcile", async () => {
  await write("crop-small.png");
  await write("crop-below-margin.png");
  expect(files.calls.readdir).toBe(1);
  files.add("snapshot-of-external.png", 1, timer.now());
  const before = files.calls.readdir;
  await write("crop-near-cap.png", Math.ceil(SCREENSHOT_CACHE_MAX_SIZE_BYTES * 0.9));
  expect(files.calls.readdir - before).toBe(1);
  expect(files.calls.lstat).toBe(3);
});

test("projected count at the 90 percent margin triggers exactly one reconcile", async () => {
  for (let i = 0; i < 3685; i++) {
    files.add(`crop-count-${i}.png`, 1, timer.now());
  }
  await protection.sweep("/screenshots", files);
  const before = files.calls.readdir;
  await write("crop-below-count-margin.png");
  expect(files.calls.readdir).toBe(before);
  await write("crop-near-count.png");
  expect(files.calls.readdir - before).toBe(1);
});

test("unexpected ENOENT on unlink drops the entry and triggers another reconcile", async () => {
  await write("crop-vanished.png", SCREENSHOT_CACHE_MAX_SIZE_BYTES / 2);
  files.missingOnUnlink = "/screenshots/crop-vanished.png";
  timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS);
  const before = files.calls.readdir;
  await protection.sweep("/screenshots", files);
  expect(files.calls.readdir - before).toBe(2);
  await write("crop-replacement.png", SCREENSHOT_CACHE_MAX_SIZE_BYTES / 2);
  expect(files.calls.readdir - before).toBe(2);
});

test.each(["ENOENT", "EEXIST"])(
  "unexpected %s on write reconciles before surfacing the failure",
  async (code) => {
    await write("crop-local.png");
    files.add("snapshot-of-external.png", SCREENSHOT_CACHE_MAX_SIZE_BYTES, timer.now());
    files.writeError = code;
    const before = files.calls.readdir;
    await expect(write("crop-failed.png")).rejects.toThrow("write failed");
    expect(files.calls.readdir - before).toBe(1);
    files.writeError = undefined;
    await write("crop-after-failure.png");
    expect(files.entries.has("/screenshots/snapshot-of-external.png")).toBe(false);
    expect(files.entries.has("/screenshots/crop-after-failure.png")).toBe(true);
  },
);

test("reconcile drops externally deleted files from capacity", async () => {
  await write("crop-external-removal.png", SCREENSHOT_CACHE_MAX_SIZE_BYTES / 2);
  await files.unlink("/screenshots/crop-external-removal.png");
  await protection.sweep("/screenshots", files);
  await write("crop-new.png", SCREENSHOT_CACHE_MAX_SIZE_BYTES / 2);
  expect(files.entries.size).toBe(1);
});

test("a temporary screenshot vanishing before lstat does not block admission", async () => {
  files.setFile("/screenshots/screenshot_x.png.temp", "temporary frame");
  await expect(write("crop-a.png")).resolves.toBeUndefined();
  expect(files.calls.lstat).toBe(1);
  expect(files.entries.has("/screenshots/crop-a.png")).toBe(true);
});

test.each(["readdir", "lstat"])(
  "a failed %s inventory refuses admission until reconciliation succeeds",
  async (method) => {
    await write("crop-local.png");
    const failure = spyOn(files, method).mockRejectedValue(
      Object.assign(new Error("inventory denied"), { code: "EACCES" }),
    );
    try {
      await protection.sweep("/screenshots", files);
      await expect(write("crop-refused.png")).rejects.toThrow(
        method === "lstat" ? "Cannot verify screenshot retention capacity" : "inventory denied",
      );
      expect(files.entries.size).toBe(1);
    } finally {
      failure.mockRestore();
    }
    await write("crop-after-recovery.png");
    expect(files.entries.size).toBe(2);
  },
);

test("a failed eviction unlink still admits the capture and the file is swept later", async () => {
  await write("crop-live.png", SCREENSHOT_CACHE_MAX_SIZE_BYTES - 1);
  const failure = spyOn(files, "unlink").mockRejectedValue(new Error("unlink denied"));
  try {
    await expect(write("crop-over.png", 2)).resolves.toBeUndefined();
    expect(files.entries.size).toBe(2);
  } finally {
    failure.mockRestore();
  }
  timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS);
  await protection.sweep("/screenshots", files);
  expect(files.entries.size).toBe(0);
});
