import { describe, expect, test } from "bun:test";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import {
  screenshotDeviceToken,
  screenshotFileName,
} from "../../../src/utils/screenshot/screenshotFormats";
import { mockDevice } from "./takeScreenshotTestHelpers";

describe("TakeScreenshot path generation", function () {
  test("should generate correct screenshot path with png format", function () {
    const screenshot = new TakeScreenshot(
      mockDevice,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
    );
    const result = screenshot.generateScreenshotPath(1234567890123, { format: "png" });
    expect(result).toContain("screenshot_1234567890123");
    expect(result).toMatch(/screenshot_1234567890123_[^.]+\.png$/);
  });

  test("should generate correct screenshot path with webp format", function () {
    const screenshot = new TakeScreenshot(
      mockDevice,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
    );
    const result = screenshot.generateScreenshotPath(1234567890456, { format: "webp" });
    expect(result).toContain("screenshot_1234567890456");
    expect(result).toMatch(/screenshot_1234567890456_[^.]+\.webp$/);
  });

  test("should generate different timestamps for consecutive calls", function () {
    const fakeTimer = new FakeTimer();
    const screenshot = new TakeScreenshot(
      mockDevice,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
    );
    const first = screenshot.generateScreenshotPath(fakeTimer.now(), { format: "png" });
    fakeTimer.advanceTime(1);
    const second = screenshot.generateScreenshotPath(fakeTimer.now(), { format: "png" });
    expect(first).not.toBe(second);
  });

  test("uses an injected unique suffix when captures share a timestamp", function () {
    const fakeAdb = new FakeAdbExecutor();
    const screenshot = new TakeScreenshot(
      mockDevice,
      new FakeAdbClientFactory(fakeAdb),
      new FakeTimer(),
      new CountingIdGenerator("capture"),
    );
    const first = screenshot.generateScreenshotPath(1234567890123, { format: "png" });
    const second = screenshot.generateScreenshotPath(1234567890123, { format: "png" });
    const deviceToken = screenshotDeviceToken("test-device-id");
    expect(first.endsWith(`screenshot_1234567890123_${deviceToken}_capture-1.png`)).toBe(true);
    expect(second.endsWith(`screenshot_1234567890123_${deviceToken}_capture-2.png`)).toBe(true);
    expect(first).not.toBe(second);
  });

  test("names captures after the device so a shared cache dir stays attributable", function () {
    const fakeAdb = new FakeAdbExecutor();
    const screenshot = new TakeScreenshot(
      { name: "remote", platform: "android", deviceId: "127.0.0.1:5555", source: "local" },
      new FakeAdbClientFactory(fakeAdb),
      new FakeTimer(),
      new CountingIdGenerator("capture"),
    );
    const generated = screenshot.generateScreenshotPath(1234567890123, { format: "png" });
    expect(
      generated.endsWith(screenshotFileName(1234567890123, "127.0.0.1:5555", "capture-1", "png")),
    ).toBe(true);
    expect(pathBasename(generated)).toMatch(
      /^screenshot_1234567890123_127-0-0-1-5555-[0-9a-f]+_capture-1\.png$/,
    );
  });
});

function pathBasename(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1);
}
