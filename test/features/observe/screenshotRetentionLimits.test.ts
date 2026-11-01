import { expect, spyOn, test } from "bun:test";
import {
  DEFAULT_SCREENSHOT_RETENTION_LIMITS as defaults,
  effectiveScreenshotCacheBytes,
  newestScreenshotPathKeys,
  screenshotPathKey,
} from "../../../src/features/observe/screenshotCacheEviction";
import { readScreenshotRetentionLimits } from "../../../src/features/observe/screenshotRetentionLimits";
import {
  screenshotDeviceToken,
  screenshotFileName,
  screenshotFileDeviceToken,
} from "../../../src/utils/screenshot/screenshotFormats";
import { logger } from "../../../src/utils/logger";

const MiB = 1024 * 1024;
test("effective cap scales only above base and stops at ceiling", () => {
  expect(effectiveScreenshotCacheBytes(defaults, 0)).toBe(128 * MiB);
  expect(effectiveScreenshotCacheBytes(defaults, 2)).toBe(128 * MiB);
  expect(effectiveScreenshotCacheBytes(defaults, 6)).toBe(384 * MiB);
  expect(effectiveScreenshotCacheBytes(defaults, 100)).toBe(2048 * MiB);
  expect(effectiveScreenshotCacheBytes({ ...defaults, ceilingBytes: 1 }, 100)).toBe(
    defaults.baseBytes,
  );
});
test("newest sets use touched time, ignore legacy names and reserve an incoming slot", () => {
  const files = [1, 2, 3].map((mtimeMs) => ({
    path: `/frames/${screenshotFileName(mtimeMs, "a", "id", "png")}`,
    mtimeMs,
    size: 1,
  }));
  files.push({ path: "/frames/screenshot_4.png", mtimeMs: 4, size: 1 });
  files.push({ path: "/frames/crop-id.png", mtimeMs: 5, size: 1 });
  files.push({ path: "/frames/snapshot-of-app.png", mtimeMs: 6, size: 1 });
  const touched = (file: (typeof files)[number]) => (file.mtimeMs === 1 ? 10 : file.mtimeMs);
  expect([...newestScreenshotPathKeys(files, 2, touched)]).toEqual(
    [files[0].path, files[2].path].map((path) => screenshotPathKey(path)),
  );
  expect([
    ...newestScreenshotPathKeys(files, 2, touched, { incomingDevice: screenshotDeviceToken("a") }),
  ]).toEqual([screenshotPathKey(files[0].path)]);
  expect(newestScreenshotPathKeys(files, 0, touched).size).toBe(0);
  expect(screenshotFileDeviceToken(`${screenshotFileName(1, "a", "id", "png")}.temp`)).toBe(
    screenshotDeviceToken("a"),
  );
});
test("limits reader uses defaults and valid overrides, including a ceiling below base", () => {
  expect(readScreenshotRetentionLimits({})).toEqual(defaults);
  expect(
    readScreenshotRetentionLimits({
      AUTOMOBILE_SCREENSHOT_CACHE_MB: "2.5",
      AUTOMOBILE_SCREENSHOT_CACHE_PER_DEVICE_MB: "1",
      AUTOMOBILE_SCREENSHOT_CACHE_CEILING_MB: "1",
      AUTOMOBILE_SCREENSHOT_KEEP_PER_DEVICE: "0",
    }),
  ).toEqual({ baseBytes: 2.5 * MiB, perDeviceBytes: MiB, ceilingBytes: MiB, keepPerDevice: 0 });
});
test("invalid limits warn and fall back, including fractional keep counts", () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(
      readScreenshotRetentionLimits({
        AUTOMOBILE_SCREENSHOT_CACHE_MB: "0",
        AUTOMOBILE_SCREENSHOT_CACHE_PER_DEVICE_MB: "NaN",
        AUTOMOBILE_SCREENSHOT_CACHE_CEILING_MB: "-1",
        AUTOMOBILE_SCREENSHOT_KEEP_PER_DEVICE: "1.5",
      }),
    ).toEqual(defaults);
    expect(warn).toHaveBeenCalledTimes(4);
  } finally {
    warn.mockRestore();
  }
});
