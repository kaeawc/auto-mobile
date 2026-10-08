import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ExecuteGesture } from "../../../src/features/action/ExecuteGesture";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { ActionableError, type BootedDevice } from "../../../src/models";

describe("ExecuteGesture", () => {
  const androidDevice: BootedDevice = {
    deviceId: "test-device",
    platform: "android",
    name: "Test Device",
  };
  const iosDevice: BootedDevice = {
    deviceId: "ios-test-device",
    platform: "ios",
    name: "Test iPhone",
  };

  let getInstanceSpy: ReturnType<typeof spyOn> | null = null;

  afterEach(() => {
    getInstanceSpy?.mockRestore();
    getInstanceSpy = null;
    AndroidCtrlProxyClient.resetInstances();
  });

  test("iOS swipe forwards lockScreen through the existing context options slot", async () => {
    const fakeClient = new FakeIOSCtrlProxy();
    const requestSwipe = spyOn(fakeClient as unknown as IOSCtrlProxyClient, "requestSwipe");
    getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      fakeClient as unknown as IOSCtrlProxyClient,
    );
    const gesture = new ExecuteGesture(iosDevice, null, new FakeTimer());
    await gesture.swipe(1, 2, 3, 4, { lockScreen: true, timeoutMs: 4200 });
    expect(requestSwipe.mock.calls[0]?.[5]).toBe(4200);
    expect(requestSwipe.mock.calls[0]?.[7]).toEqual({ lockScreen: true });
    await gesture.swipe(1, 2, 3, 4);
    expect(requestSwipe.mock.calls[1]?.[7]).toBeUndefined();
  });

  describe("iOS swipe answered with the runner's deadline error (#10161)", () => {
    const completedLate =
      "Command request_swipe exceeded deadline at 5000ms (gesture completed after its deadline; outcome is indeterminate)";
    const notStarted =
      "Command request_swipe exceeded deadline at 5000ms (gesture was not started)";

    async function swipeWith(reply: { error: string; errorCode?: string }) {
      const fakeClient = new FakeIOSCtrlProxy();
      fakeClient.setSwipeResult({ success: false, totalTimeMs: 5000, ...reply });
      getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeClient as unknown as IOSCtrlProxyClient,
      );
      return new ExecuteGesture(iosDevice, null, new FakeTimer()).swipe(1, 2, 3, 4);
    }

    test("the typed code marks the acknowledged reply indeterminate", async () => {
      // The wording is deliberately not the matching text: only the code can decide this.
      const result = await swipeWith({
        error: "runner said something else",
        errorCode: "deadline_completed_late",
      });
      expect(result).toMatchObject({ success: false, outcomeIndeterminate: true });
      expect(result.error).toContain("Do not retry automatically");
    });

    test("an older runner's wording still marks it indeterminate", async () => {
      const result = await swipeWith({ error: completedLate });
      expect(result).toMatchObject({ success: false, outcomeIndeterminate: true });
    });

    test("a gesture the runner never started stays a plain failure", async () => {
      const typed = await swipeWith({ error: notStarted, errorCode: "deadline_not_started" });
      const wording = await swipeWith({ error: notStarted });
      for (const result of [typed, wording]) {
        expect(result.success).toBe(false);
        expect(result).not.toHaveProperty("outcomeIndeterminate");
        expect(result.error).toBe(notStarted);
      }
    });
  });

  describe("iOS swipe answered while the runner's gesture is still executing (#10016)", () => {
    // CommandError.gestureBoundExceeded's text, as the runner sends it (pinned by the contract test).
    const stillExecuting =
      "Command request_swipe exceeded execution bound 4497ms in phase xcuitestGesture after 4499ms; XCUITest call is still executing and the runner stays busy until it returns";
    const queryBound =
      "Command request_hierarchy exceeded execution bound 10000ms after 10000ms waiting on a live XCUITest query; XCUITest call is still executing and the runner stays busy until it returns";

    async function swipeWith(reply: { error: string; errorCode?: string }) {
      const fakeClient = new FakeIOSCtrlProxy();
      fakeClient.setSwipeResult({ success: false, totalTimeMs: 4500, ...reply });
      getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeClient as unknown as IOSCtrlProxyClient,
      );
      return new ExecuteGesture(iosDevice, null, new FakeTimer()).swipe(1, 2, 3, 4);
    }

    test("the typed code marks the acknowledged reply indeterminate", async () => {
      const result = await swipeWith({
        error: "runner said something else",
        errorCode: "gesture_bound_exceeded",
      });
      expect(result).toMatchObject({ success: false, outcomeIndeterminate: true });
      expect(result.error).toContain("The swipe may have been applied");
      expect(result.error).toContain("Do not retry automatically");
    });

    test("an older runner's wording still marks it indeterminate", async () => {
      const result = await swipeWith({ error: stillExecuting });
      expect(result).toMatchObject({ success: false, outcomeIndeterminate: true });
      expect(result.error).toContain(stillExecuting);
    });

    test("the query-bound wording, which has no gesture phase, stays a plain failure", async () => {
      const result = await swipeWith({ error: queryBound });
      expect(result.success).toBe(false);
      expect(result).not.toHaveProperty("outcomeIndeterminate");
    });
  });

  test("an already aborted gesture dispatches no device command", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const gesture = new ExecuteGesture(androidDevice, adb, timer);
    await expect(
      gesture.execute(
        [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
        300,
        AbortSignal.abort(),
      ),
    ).rejects.toThrow("Operation cancelled");
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("an abort during gesture dispatch propagates after the device command", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const controller = new AbortController();
    adb.abortAfterCommand("shell input swipe", controller);
    const gesture = new ExecuteGesture(androidDevice, adb, timer);
    await expect(
      gesture.execute(
        [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
        300,
        controller.signal,
      ),
    ).rejects.toThrow("Operation cancelled");
    expect(adb.getExecutedCommands()).toHaveLength(1);
  });

  test("an abort during swipe dispatch is not converted to a failure result", async () => {
    const adb = new FakeAdbExecutor();
    const controller = new AbortController();
    adb.abortAfterCommand("shell input swipe", controller);
    await expect(
      new ExecuteGesture(androidDevice, adb, new FakeTimer()).swipe(
        0,
        0,
        10,
        10,
        {},
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow("Operation cancelled");
    expect(adb.getExecutedCommands()).toHaveLength(1);
  });

  // Regression for https://github.com/kaeawc/auto-mobile/issues/2225.
  // executeA11ySwipe called AndroidCtrlProxyClient.getInstance(device, this.adb),
  // but getInstance expects an AdbClientFactory and immediately invokes
  // `.create(device)`. After bundler minification this surfaced as
  // `TypeError: <minified>.create is not a function` and crashed every
  // a11y-mode gesture on a fresh device.
  test("passes the AdbClientFactory (not AdbExecutor) to AndroidCtrlProxyClient.getInstance in a11y mode (regression for #2225)", async () => {
    const factory = new FakeAdbClientFactory();
    const fakeClient = {
      requestSwipe: async () => ({
        success: true,
        totalTimeMs: 1,
        gestureTimeMs: 1,
      }),
    } as unknown as AndroidCtrlProxyClient;

    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(fakeClient);

    const gesture = new ExecuteGesture(androidDevice, factory as any);
    const result = await gesture.swipe(0, 0, 100, 100, { scrollMode: "a11y" });

    expect(result.success).toBe(true);
    expect(getInstanceSpy).toHaveBeenCalled();
    const passed = getInstanceSpy!.mock.calls[0][1] as { create?: unknown };
    expect(typeof passed).toBe("object");
    expect(typeof passed.create).toBe("function");
  });

  test("returns a typed failure when the default ADB swipe command fails", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("shell input swipe", new Error("device offline"));
    const result = await new ExecuteGesture(androidDevice, adb).swipe(0, 0, 100, 100);
    expect(result.success).toBe(false);
    expect(result.error).toContain("device offline");
  });

  test("keeps the default ADB swipe successful when its command resolves", async () => {
    const result = await new ExecuteGesture(androidDevice, new FakeAdbExecutor()).swipe(
      0,
      0,
      100,
      100,
    );
    expect(result.success).toBe(true);
  });

  test("reports both a11y and ADB failures when the fallback command fails", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("shell input swipe", new Error("ADB device offline"));
    const fakeClient = {
      requestSwipe: async () => ({ success: false, error: "a11y dispatch rejected" }),
    } as unknown as AndroidCtrlProxyClient;
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(fakeClient);
    const result = await new ExecuteGesture(androidDevice, adb).swipe(0, 0, 100, 100, {
      scrollMode: "a11y",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("a11y dispatch rejected");
    expect(result.error).toContain("ADB device offline");
    expect(result.fallbackReason).toBe("a11y dispatch rejected");
  });

  test("delegates iOS multi-finger FingerPath gestures to CtrlProxy with supplied spacing", async () => {
    const fakeClient = new FakeIOSCtrlProxy();
    getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      fakeClient as unknown as IOSCtrlProxyClient,
    );

    const gesture = new ExecuteGesture(iosDevice, null);
    const result = await gesture.execute(
      [
        {
          finger: 0,
          points: [
            { x: 100, y: 600 },
            { x: 100, y: 200 },
          ],
        },
        {
          finger: 1,
          points: [
            { x: 130.5, y: 600 },
            { x: 130.5, y: 200 },
          ],
        },
      ],
      450,
    );

    expect(result).toEqual({ pathLength: 2, duration: 450, platform: "ios" });
    expect(fakeClient.getMultiFingerSwipeHistory()).toEqual([
      {
        x1: 100,
        y1: 600,
        x2: 100,
        y2: 200,
        fingerCount: 2,
        duration: 450,
        fingerSpacing: 30.5,
      },
    ]);
  });

  test("propagates failed iOS multi-finger swipe results", async () => {
    const fakeClient = new FakeIOSCtrlProxy();
    fakeClient.setMultiFingerSwipeResult({
      success: false,
      error: "XCTest private multi-touch event synthesis classes are unavailable",
      totalTimeMs: 1,
    });
    getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      fakeClient as unknown as IOSCtrlProxyClient,
    );

    const gesture = new ExecuteGesture(iosDevice, null);

    await expect(
      gesture.execute(
        [
          {
            finger: 0,
            points: [
              { x: 100, y: 600 },
              { x: 100, y: 200 },
            ],
          },
          {
            finger: 1,
            points: [
              { x: 125, y: 600 },
              { x: 125, y: 200 },
            ],
          },
        ],
        300,
      ),
    ).rejects.toThrow(
      "iOS multi-finger gesture failed: XCTest private multi-touch event synthesis classes are unavailable",
    );
  });

  describe("iOS single-finger path", () => {
    const path = [
      { x: 10, y: 600 },
      { x: 10, y: 200 },
    ];

    function iosGesture(fakeClient: FakeIOSCtrlProxy): ExecuteGesture {
      getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeClient as unknown as IOSCtrlProxyClient,
      );
      return new ExecuteGesture(iosDevice, null);
    }

    test("a confirmed swipe resolves", async () => {
      const fakeClient = new FakeIOSCtrlProxy();

      const result = await iosGesture(fakeClient).execute(path, 450);

      expect(result).toEqual({ pathLength: 2, duration: 450, platform: "ios" });
      expect(fakeClient.getSwipeHistory()).toEqual([
        { x1: 10, y1: 600, x2: 10, y2: 200, duration: 450 },
      ]);
    });

    test("a swipe sent without a reply is indeterminate, not a plain failure", async () => {
      const fakeClient = new FakeIOSCtrlProxy();
      fakeClient.setSwipeResult({
        success: false,
        error: "Swipe timed out after 5000ms",
        totalTimeMs: 5000,
        dispatched: true,
        acknowledged: false,
      });

      const error = await iosGesture(fakeClient)
        .execute(path, 300)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ActionableError);
      expect((error as Error).message).toContain("Gesture outcome is indeterminate");
      expect((error as Error).message).toContain("Swipe timed out after 5000ms");
      expect((error as Error).message).toContain("Do not retry automatically");
    });

    test("a runner refusal stays a plain failure", async () => {
      const fakeClient = new FakeIOSCtrlProxy();
      fakeClient.setSwipeResult({ success: false, error: "Runner refused", totalTimeMs: 1 });

      await expect(iosGesture(fakeClient).execute(path, 300)).rejects.toThrow(
        "iOS gesture failed: Runner refused",
      );
    });

    test("a swipe that never reached the runner stays a plain failure", async () => {
      const fakeClient = new FakeIOSCtrlProxy();
      fakeClient.setSwipeResult({
        success: false,
        error: "Not connected",
        totalTimeMs: 0,
        dispatched: false,
      });

      const error = await iosGesture(fakeClient)
        .execute(path, 300)
        .catch((e: unknown) => e);

      expect((error as Error).message).toBe("iOS gesture failed: Not connected");
    });
  });

  test("rejects iOS multi-finger paths CtrlProxy cannot preserve", async () => {
    const fakeClient = new FakeIOSCtrlProxy();
    getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      fakeClient as unknown as IOSCtrlProxyClient,
    );

    const gesture = new ExecuteGesture(iosDevice, null);

    await expect(
      gesture.execute(
        [
          {
            finger: 0,
            points: [
              { x: 100, y: 600 },
              { x: 100, y: 200 },
            ],
          },
          {
            finger: 1,
            points: [
              { x: 100, y: 630 },
              { x: 100, y: 230 },
            ],
          },
        ],
        300,
      ),
    ).rejects.toThrow("iOS multi-finger gestures only support horizontally spaced parallel swipes");
    expect(fakeClient.getMultiFingerSwipeHistory()).toHaveLength(0);
  });

  test("rejects under-specified iOS multi-finger paths", async () => {
    const fakeClient = new FakeIOSCtrlProxy();
    getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      fakeClient as unknown as IOSCtrlProxyClient,
    );

    const gesture = new ExecuteGesture(iosDevice, null);

    await expect(
      gesture.execute(
        [
          {
            finger: 0,
            points: [{ x: 100, y: 600 }],
          },
          {
            finger: 1,
            points: [
              { x: 130, y: 600 },
              { x: 130, y: 200 },
            ],
          },
        ],
        300,
      ),
    ).rejects.toThrow("iOS multi-finger gestures require at least two points per finger");
    expect(fakeClient.getMultiFingerSwipeHistory()).toHaveLength(0);
  });
});
