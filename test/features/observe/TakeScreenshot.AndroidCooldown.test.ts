import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAndroidPhysicalDisplayIdResolver } from "../../fakes/FakeAndroidPhysicalDisplayIdResolver";
import { FakeScreenshotFileWriter } from "../../fakes/FakeScreenshotFileWriter";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { FakeTimer } from "../../fakes/FakeTimer";
import { BoundedScreenshotPathProtection } from "../../../src/features/observe/ScreenshotPathProtection";
import { createExecResult } from "../../../src/utils/execResult";
import {
  InMemoryCtrlProxyCaptureCooldown,
  type CtrlProxyCaptureCooldown,
} from "../../../src/features/observe/android/CtrlProxyCaptureCooldown";
import { FakeCtrlProxyCaptureCooldown } from "../../fakes/FakeCtrlProxyCaptureCooldown";
import { androidDevice } from "./takeScreenshotTestHelpers";

// Shared across distinct TakeScreenshot instances; tests use distinct device ids.
function harness(
  deviceId: string,
  injectedCooldown?: CtrlProxyCaptureCooldown,
  useDefault = false,
) {
  const timer = new FakeTimer();
  const adb = new FakeAdbExecutor();
  const png = readFileSync("test/fixtures/screenshots/black-on-white.png").toString("base64");
  adb.setDefaultResponse(createExecResult(png, ""));
  const executeAdb = spyOn(adb, "executeCommand");
  executeAdb.mockImplementation(async () => {
    timer.advanceTime(200);
    return createExecResult(png, "");
  });
  const client = new FakeCtrlProxy();
  const request = spyOn(client, "requestScreenshot").mockImplementation(async () => {
    timer.advanceTime(25);
    return { success: true, data: png, format: "png" };
  });
  spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
  const files = new FakeFileSystem();
  files.setDirectory("/screenshots");
  const protection = new BoundedScreenshotPathProtection(timer);
  const cooldown = injectedCooldown ?? new InMemoryCtrlProxyCaptureCooldown(timer);
  const make = () =>
    new TakeScreenshot(androidDevice(deviceId), {
      timer,
      ...(useDefault ? {} : { ctrlProxyCaptureCooldown: cooldown }),
      adbFactory: new FakeAdbClientFactory(adb),
      fileWriter: new FakeScreenshotFileWriter(),
      fileSystem: files,
      cacheDirResolver: () => "/screenshots",
      cleanupOnCreate: false,
      pathProtection: protection,
      physicalDisplayIdResolver: new FakeAndroidPhysicalDisplayIdResolver(),
    });
  return { timer, adb, executeAdb, request, make };
}

afterEach(() => mock.restore());

describe("one-shot Android CtrlProxy failure cooldown", () => {
  test("the default cooldown is shared across instances", async () => {
    const h = harness("cooldown-default-shared", undefined, true);
    h.request.mockResolvedValue({ success: false, error: "capture failed" });
    await h.make().execute({});
    expect((await h.make().execute({})).screenshotFallbackReason).toBe("ctrlproxy_recent_failure");
    expect(h.request).toHaveBeenCalledTimes(1);
  });
  test("bounds the request at 3000 ms and reports CtrlProxy stage timing", async () => {
    const h = harness("cooldown-bound");
    const result = await h.make().execute({});
    expect(h.request.mock.calls[0]?.[0]).toBe(3000);
    expect(result).toMatchObject({
      success: true,
      screenshotCaptureSource: "android_ctrlproxy_a11y",
      screenshotFallback: false,
      screenshotStageDurationsMs: { ctrlProxyMs: 25, totalMs: 25 },
    });
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("timeout falls back, subsequent instances skip, and a successful probe clears the cooldown", async () => {
    const h = harness("cooldown-timeout");
    h.request.mockImplementationOnce(async () => {
      h.timer.advanceTime(3000);
      return { success: false, error: "Screenshot timeout after 3000ms" };
    });
    const first = await h.make().execute({});
    expect(first).toMatchObject({
      success: true,
      screenshotCaptureSource: "android_adb_screencap",
      screenshotFallback: true,
      screenshotFallbackReason: "ctrlproxy_timeout",
      screenshotStageDurationsMs: { ctrlProxyMs: 3000, adbMs: 200, totalMs: 3200 },
    });
    const second = await h.make().execute({});
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({
      screenshotFallbackReason: "ctrlproxy_recent_failure",
      screenshotStageDurationsMs: { adbMs: 200, totalMs: 200 },
    });
    h.timer.advanceTime(60_000);
    expect((await h.make().execute({})).screenshotFallback).toBe(false);
    expect((await h.make().execute({})).screenshotFallback).toBe(false);
    expect(h.request).toHaveBeenCalledTimes(3);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("caller cancellation does not arm the cooldown or run ADB", async () => {
    const cooldown = new FakeCtrlProxyCaptureCooldown();
    const h = harness("cooldown-cancel", cooldown);
    const controller = new AbortController();
    h.request.mockImplementationOnce(async () => {
      controller.abort();
      return { success: false, error: "cancelled" };
    });
    expect((await h.make().execute({}, controller.signal)).success).toBe(false);
    expect(h.executeAdb).not.toHaveBeenCalled();
    expect(cooldown.failures).toEqual([]);
    expect((await h.make().execute({})).success).toBe(true);
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  test("a thrown CtrlProxy failure records device health and falls back", async () => {
    const cooldown = new FakeCtrlProxyCaptureCooldown();
    const h = harness("cooldown-exception", cooldown);
    h.request.mockRejectedValueOnce(new Error("socket stalled"));
    const result = await h.make().execute({});
    expect(result).toMatchObject({ success: true, screenshotFallback: true });
    expect(cooldown.failures).toEqual(["cooldown-exception"]);
    expect((await h.make().execute({})).screenshotFallbackReason).toBe("ctrlproxy_recent_failure");
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  test("rate limiting does not arm the cooldown", async () => {
    const h = harness("cooldown-rate-limit");
    h.request.mockResolvedValueOnce({ success: false, error: "Screenshot rate limited" });
    expect((await h.make().execute({})).screenshotFallbackReason).toBe("ctrlproxy_rate_limited");
    expect((await h.make().execute({})).screenshotFallback).toBe(false);
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  test("a failed probe re-arms the cooldown and does not affect another device", async () => {
    const h = harness("cooldown-probe");
    h.request.mockResolvedValue({ success: false, error: "capture failed" });
    await h.make().execute({});
    h.timer.advanceTime(60_000);
    await h.make().execute({});
    expect((await h.make().execute({})).screenshotFallbackReason).toBe("ctrlproxy_recent_failure");
    expect(h.request).toHaveBeenCalledTimes(2);
    const other = harness("cooldown-other");
    expect((await other.make().execute({})).screenshotFallback).toBe(false);
    expect(other.request).toHaveBeenCalledTimes(1);
  });

  test("explicit displays still fail rather than using an ADB fallback", async () => {
    const h = harness("cooldown-display");
    h.request.mockResolvedValue({ success: false, error: "capture failed" });
    await h.make().execute({});
    const commandsBefore = h.executeAdb.mock.calls.length;
    expect((await h.make().execute({ displayId: 2 })).success).toBe(false);
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.executeAdb).toHaveBeenCalledTimes(commandsBefore);
  });

  test("hidePrototypes keeps 10000 ms, bypasses the cooldown, and never falls back", async () => {
    const h = harness("cooldown-hidden");
    h.request.mockResolvedValue({ success: false, error: "capture failed" });
    await h.make().execute({});
    const commandsBefore = h.executeAdb.mock.calls.length;
    const result = await h.make().execute({ hidePrototypes: true });
    expect(h.executeAdb).toHaveBeenCalledTimes(commandsBefore);
    expect(h.request.mock.calls[1]?.[0]).toBe(10000);
    expect(result.success).toBe(false);
    expect(h.request).toHaveBeenCalledTimes(2);
  });
});
