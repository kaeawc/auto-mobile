import { expect, describe, test, beforeEach, afterEach } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ScreenshotCache } from "../../src/utils/screenshot/ScreenshotCache";
import { FakeTimer } from "../fakes/FakeTimer";

const CACHE_TTL_MS = 10 * 60 * 1000;
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==",
  "base64",
);
const BLUE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNgYPj/HwADAgH/FAeIXAAAAABJRU5ErkJggg==",
  "base64",
);
const WHITE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=",
  "base64",
);
const GREEN_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNg+M/wHwAEAQH/g5vEFwAAAABJRU5ErkJggg==",
  "base64",
);

describe("ScreenshotCache", function () {
  let tempDir: string;
  let fakeTimer: FakeTimer;

  beforeEach(async function () {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "screenshot-cache-"));
    fakeTimer = new FakeTimer();
    ScreenshotCache.clearCache();
  });

  afterEach(async function () {
    ScreenshotCache.clearCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("returns cached buffer within TTL", async function () {
    const filePath = path.join(tempDir, "screenshot.png");
    const buffer1 = RED_PNG;
    await fs.writeFile(filePath, buffer1);

    const first = await ScreenshotCache.getCachedScreenshot(filePath, fakeTimer);

    const buffer2 = BLUE_PNG;
    await fs.writeFile(filePath, buffer2);

    const second = await ScreenshotCache.getCachedScreenshot(filePath, fakeTimer);

    expect(first.buffer.equals(buffer1)).toBe(true);
    expect(second.buffer.equals(buffer1)).toBe(true);
    expect(second.buffer.equals(buffer2)).toBe(false);
  });

  test("reloads cache after TTL expires", async function () {
    const filePath = path.join(tempDir, "screenshot.png");
    const buffer1 = WHITE_PNG;
    await fs.writeFile(filePath, buffer1);

    await ScreenshotCache.getCachedScreenshot(filePath, fakeTimer);

    const buffer2 = GREEN_PNG;
    await fs.writeFile(filePath, buffer2);

    fakeTimer.advanceTime(CACHE_TTL_MS + 1);

    const refreshed = await ScreenshotCache.getCachedScreenshot(filePath, fakeTimer);

    expect(refreshed.buffer.equals(buffer2)).toBe(true);
  });
});
