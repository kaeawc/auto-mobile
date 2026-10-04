import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ExecuteGesture } from "../../../src/features/action/ExecuteGesture";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import type { BootedDevice } from "../../../src/models";
import { ActionableError } from "../../../src/models/ActionableError";

describe("ExecuteGesture Android swipe", () => {
  const androidDevice: BootedDevice = {
    deviceId: "test-device",
    platform: "android",
    name: "Test Device",
  };

  let fakeAdb: FakeAdbExecutor;
  let fakeA11yService: FakeCtrlProxy;
  let getInstanceSpy: ReturnType<typeof spyOn> | null = null;

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    fakeA11yService = new FakeCtrlProxy();
  });

  afterEach(() => {
    getInstanceSpy?.mockRestore();
    getInstanceSpy = null;
    AndroidCtrlProxyClient.resetInstances();
  });

  const createGesture = () => new ExecuteGesture({ ...androidDevice }, fakeAdb);

  test.each([
    [250.5, 251],
    [250, 250],
    [0.1, 1],
    [0, 0],
  ] as const)(
    "formats ADB duration %s as %s without changing coordinates",
    async (duration, expected) => {
      await createGesture().swipe(10.5, 20.5, 30.5, 40.5, { duration });
      expect(fakeAdb.getExecutedCommands()).toEqual([
        `shell input swipe 10.5 20.5 30.5 40.5 ${expected}`,
      ]);
    },
  );

  test("dispatches an ADB input swipe with the given coordinates and duration in adb mode", async () => {
    const result = await createGesture().swipe(10, 20, 30, 40, { duration: 250 });

    expect(result).toEqual({ success: true, x1: 10, y1: 20, x2: 30, y2: 40, duration: 250 });
    expect(fakeAdb.getExecutedCommands()).toEqual(["shell input swipe 10 20 30 40 250"]);
  });

  test("defaults the ADB swipe duration to 300ms when none is supplied", async () => {
    const result = await createGesture().swipe(0, 0, 100, 100);

    expect(result.duration).toBe(300);
    expect(fakeAdb.getExecutedCommands()).toEqual(["shell input swipe 0 0 100 100 300"]);
  });

  test("uses the accessibility service and skips ADB when a11y swipe succeeds", async () => {
    fakeA11yService.setSwipeResult({ success: true, totalTimeMs: 42, gestureTimeMs: 30 });
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      fakeA11yService as unknown as AndroidCtrlProxyClient,
    );

    const result = await createGesture().swipe(5, 6, 7, 8, { scrollMode: "a11y", duration: 120 });

    expect(result.success).toBe(true);
    expect(result.a11yTotalTimeMs).toBe(42);
    expect(result.a11yGestureTimeMs).toBe(30);
    expect(result.fallbackReason).toBeUndefined();
    // Success path must not touch ADB.
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
    // The a11y service received the exact coordinates.
    expect(fakeA11yService.getSwipeHistory()).toEqual([
      { x1: 5, y1: 6, x2: 7, y2: 8, duration: 120 },
    ]);
  });

  test("falls back to an ADB swipe when the a11y service reports failure", async () => {
    fakeA11yService.setSwipeResult({
      success: false,
      totalTimeMs: 0,
      error: "service unavailable",
    });
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      fakeA11yService as unknown as AndroidCtrlProxyClient,
    );

    const result = await createGesture().swipe(5, 6, 7, 8, { scrollMode: "a11y", duration: 120 });

    // Still reports success, but records why it fell back and issues the ADB swipe.
    expect(result.success).toBe(true);
    expect(result.fallbackReason).toBe("service unavailable");
    expect(fakeAdb.getExecutedCommands()).toEqual(["shell input swipe 5 6 7 8 120"]);
  });

  test("does not replay a dispatched a11y swipe when its response is lost", async () => {
    fakeA11yService.setSwipeResult({
      success: false,
      totalTimeMs: 0,
      error: "Swipe timed out after 5000ms",
    });
    fakeA11yService.setSwipeDispatchesBeforeResult(true);
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      fakeA11yService as unknown as AndroidCtrlProxyClient,
    );

    const result = await createGesture().swipe(5, 6, 7, 8, { scrollMode: "a11y", duration: 120 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outcome is indeterminate.*Do not retry automatically/i);
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test("does not replay a dispatched a11y swipe if its request throws", async () => {
    fakeA11yService.setFailureMode("swipe", new Error("response lost"));
    fakeA11yService.setSwipeDispatchesBeforeResult(true);
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      fakeA11yService as unknown as AndroidCtrlProxyClient,
    );

    const result = await createGesture().swipe(5, 6, 7, 8, { scrollMode: "a11y", duration: 120 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outcome is indeterminate.*Do not retry automatically/i);
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test("falls back to an ADB swipe when the a11y service throws", async () => {
    fakeA11yService.setFailureMode("swipe", new Error("socket closed"));
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      fakeA11yService as unknown as AndroidCtrlProxyClient,
    );

    const result = await createGesture().swipe(5, 6, 7, 8, { scrollMode: "a11y", duration: 90 });

    expect(result.success).toBe(true);
    expect(result.fallbackReason).toContain("socket closed");
    expect(fakeAdb.getExecutedCommands()).toEqual(["shell input swipe 5 6 7 8 90"]);
  });

  test("rejects a platform it has no swipe transport for", async () => {
    const gesture = createGesture();
    // The constructor validates the platform in BaseVisualChange, so mutate the
    // resolved device after construction to reach the swipe() default branch.
    (gesture as any).device.platform = "web";

    const error = await gesture.swipe(0, 0, 1, 1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActionableError);
    expect((error as Error).message).toContain("web");
  });
});
