import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { PinchOn } from "../../../src/features/action/PinchOn";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { AndroidCtrlProxyManager } from "../../../src/utils/CtrlProxyManager";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";

describe("PinchOn", () => {
  const device: BootedDevice = {
    deviceId: "test-device",
    platform: "android",
    name: "Test Device",
  };

  let pinchOn: PinchOn;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeWindow: FakeWindow;
  let fakeTimer: FakeTimer;
  let fakeA11yService: FakeCtrlProxy;
  let fakeIosService: FakeIOSCtrlProxy;
  let fakeAdb: FakeAdbExecutor;
  let getInstanceSpy: ReturnType<typeof spyOn> | null = null;
  let iosGetInstanceSpy: ReturnType<typeof spyOn> | null = null;
  let managerSpy: ReturnType<typeof spyOn> | null = null;

  const createHierarchy = (): ViewHierarchyResult => ({
    hierarchy: {
      node: [
        {
          $: {
            "resource-id": "container-id",
            text: "Container",
            bounds: { left: 0, top: 0, right: 200, bottom: 200 },
            class: "android.widget.FrameLayout",
          },
        },
      ],
    },
    packageName: "com.test.app",
    updatedAt: Date.now(),
  });

  const createObserveResult = (): ObserveResult => ({
    updatedAt: Date.now(),
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    viewHierarchy: createHierarchy(),
  });

  beforeEach(() => {
    fakeObserveScreen = new FakeObserveScreen();
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeWindow = new FakeWindow();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    fakeA11yService = new FakeCtrlProxy();
    fakeIosService = new FakeIOSCtrlProxy();
    fakeAdb = new FakeAdbExecutor();

    fakeObserveScreen.setObserveResult(() => createObserveResult());
    fakeWindow.configureCachedActiveWindow(null);
    fakeWindow.configureActiveWindow({
      appId: "com.test.app",
      activityName: "MainActivity",
      layoutSeqSum: 123,
    });

    managerSpy = spyOn(AndroidCtrlProxyManager, "getInstance").mockReturnValue({
      isAvailable: async () => true,
    } as any);
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      fakeA11yService as any,
    );
    iosGetInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      fakeIosService as any,
    );

    pinchOn = new PinchOn(device, null, {
      capture: new FakeHierarchyCapture(
        async () => (await fakeObserveScreen.getMostRecentCachedObserveResult()).viewHierarchy!,
      ),
    });
    (pinchOn as any).observeScreen = fakeObserveScreen;
    (pinchOn as any).awaitIdle = fakeAwaitIdle;
    (pinchOn as any).window = fakeWindow;
    (pinchOn as any).adb = fakeAdb;
    (pinchOn as any).timer = fakeTimer;
  });

  afterEach(() => {
    getInstanceSpy?.mockRestore();
    iosGetInstanceSpy?.mockRestore();
    managerSpy?.mockRestore();
  });

  test("screen fallback uses fresh rotated dimensions and capture insets", async () => {
    fakeObserveScreen.setObserveResult({
      ...createObserveResult(),
      systemInsets: { top: 80, bottom: 100, left: 0, right: 0 },
    });
    (pinchOn as any).capture = new FakeHierarchyCapture(() => ({
      hierarchy: { node: { bounds: { left: 0, top: 0, right: 1920, bottom: 1080 } } },
      systemInsets: { top: 0, bottom: 0, left: 40, right: 60 },
    }));
    const target = await (pinchOn as any).resolveTarget({ direction: "out", autoTarget: false });
    expect(target.bounds).toEqual({ left: 40, top: 0, right: 1860, bottom: 1080 });
  });

  test("rotated capture without inset metadata never reuses old portrait insets", async () => {
    fakeObserveScreen.setObserveResult({
      ...createObserveResult(),
      systemInsets: { top: 80, bottom: 100, left: 0, right: 0 },
    });
    (pinchOn as any).capture = new FakeHierarchyCapture(() => ({
      hierarchy: { node: { bounds: { left: 0, top: 0, right: 1920, bottom: 1080 } } },
    }));
    const target = await (pinchOn as any).resolveTarget({ direction: "out", autoTarget: false });
    expect(target.bounds).toEqual({ left: 0, top: 0, right: 1920, bottom: 1080 });
  });

  test("auto-target favors the full-screen map over a top-window keyboard key", async () => {
    const mapBounds = { left: 0, top: 0, right: 1000, bottom: 1500 };
    (pinchOn as any).capture = new FakeHierarchyCapture(() => ({
      hierarchy: { node: { "resource-id": "app:id/map", bounds: mapBounds, scrollable: true } },
      windows: [
        {
          windowLayer: 10,
          hierarchy: {
            node: {
              "resource-id": "ime:id/key",
              clickable: true,
              bounds: { left: 0, top: 0, right: 50, bottom: 50 },
            },
          },
        },
      ],
    }));
    const target = await (pinchOn as any).resolveTarget({ direction: "out" });
    expect(target.bounds).toEqual(mapBounds);
  });

  test("returns error when container specifies both elementId and text", async () => {
    const result = await pinchOn.execute({
      direction: "in",
      container: { elementId: "container-id", text: "Container" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("pinchOn container must specify exactly one of elementId or text");
    expect(fakeA11yService.getPinchHistory()).toHaveLength(0);
  });

  test("returns error when container specifies neither selector", async () => {
    const result = await pinchOn.execute({
      direction: "in",
      container: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("pinchOn container must specify exactly one of elementId or text");
    expect(fakeA11yService.getPinchHistory()).toHaveLength(0);
  });

  test("container bare ID does not select a substring near miss", async () => {
    fakeObserveScreen.setObserveResult({
      ...createObserveResult(),
      viewHierarchy: {
        hierarchy: {
          node: [
            {
              "resource-id": "com.app:id/map_controls",
              bounds: { left: 0, top: 0, right: 30, bottom: 30 },
            },
            {
              "resource-id": "com.app:id/map",
              bounds: { left: 100, top: 100, right: 300, bottom: 300 },
            },
          ],
        },
      },
    });
    const result = await pinchOn.execute({ direction: "out", container: { elementId: "map" } });
    expect(result.success).toBe(true);
    expect(fakeA11yService.getPinchHistory()[0].centerX).toBe(200);
  });

  test("explicit text container keeps the matched label bounds", async () => {
    const labelBounds = { left: 100, top: 100, right: 300, bottom: 300 };
    fakeObserveScreen.setObserveResult({
      ...createObserveResult(),
      viewHierarchy: {
        hierarchy: {
          node: {
            "resource-id": "app:id/row",
            clickable: true,
            bounds: { left: 0, top: 0, right: 400, bottom: 400 },
            node: [{ text: "Map", bounds: labelBounds }],
          },
        },
      },
    });
    const result = await pinchOn.execute({ direction: "out", container: { text: "Map" } });
    expect(result.success).toBe(true);
    expect(fakeA11yService.getPinchHistory()[0].centerX).toBe(200);
    expect(fakeA11yService.getPinchHistory()[0].centerY).toBe(200);
  });

  test("ambiguous bare container ID fails before sending a pinch", async () => {
    fakeObserveScreen.setObserveResult({
      ...createObserveResult(),
      viewHierarchy: {
        hierarchy: {
          node: [
            {
              "resource-id": "com.one:id/map",
              bounds: { left: 0, top: 0, right: 100, bottom: 100 },
            },
            {
              "resource-id": "com.two:id/map",
              bounds: { left: 100, top: 100, right: 300, bottom: 300 },
            },
          ],
        },
      },
    });
    const result = await pinchOn.execute({ direction: "out", container: { elementId: "map" } });
    expect(result.success).toBe(false);
    expect(result.error).toContain("com.one:id/map");
    expect(result.error).toContain("com.two:id/map");
    expect(fakeA11yService.getPinchHistory()).toEqual([]);
  });

  test("requests fresh capture and pinches changed bounds instead of cached coordinates", async () => {
    const capture = new FakeHierarchyCapture(() => ({
      hierarchy: {
        node: {
          "resource-id": "container-id",
          bounds: { left: 400, top: 400, right: 600, bottom: 600 },
        },
      },
    }));
    (pinchOn as any).capture = capture;
    const result = await pinchOn.execute({
      direction: "out",
      container: { elementId: "container-id" },
    });
    expect(result.success).toBe(true);
    expect(capture.requests).toEqual([{ freshness: "fresh" }]);
    expect(fakeA11yService.getPinchHistory()[0].centerX).toBe(500);
    expect(fakeA11yService.getPinchHistory()[0].centerY).toBe(500);
  });

  test("does not fall back to cached bounds when fresh capture fails", async () => {
    (pinchOn as any).capture = new FakeHierarchyCapture(() => {
      throw new Error("fresh capture failed");
    });
    const result = await pinchOn.execute({
      direction: "out",
      container: { elementId: "container-id" },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("fresh capture failed");
    expect(fakeA11yService.getPinchHistory()).toEqual([]);
  });

  test("container resolution prefers the topmost window", async () => {
    const upper = {
      "resource-id": "container-id",
      bounds: { left: 300, top: 300, right: 700, bottom: 700 },
    };
    (pinchOn as any).capture = new FakeHierarchyCapture(
      () =>
        ({
          ...createHierarchy(),
          windows: [{ windowLayer: 5, hierarchy: { node: upper } }],
        }) as any,
    );
    const result = await pinchOn.execute({
      direction: "out",
      container: { elementId: "container-id" },
    });
    expect(result.success).toBe(true);
    expect(fakeA11yService.getPinchHistory()[0].centerX).toBe(500);
  });

  test("requests pinch when container elementId is valid", async () => {
    const result = await pinchOn.execute({
      direction: "out",
      container: { elementId: "container-id" },
    });

    expect(result.success).toBe(true);
    expect(result.targetType).toBe("container");

    const [pinchCall] = fakeA11yService.getPinchHistory();
    expect(pinchCall).toBeDefined();
    expect(pinchCall.centerX).toBe(100);
    expect(pinchCall.centerY).toBe(100);
  });

  test("routes iOS pinch through the iOS CtrlProxy request_pinch command", async () => {
    const iosDevice: BootedDevice = {
      deviceId: "11111111-2222-3333-4444-555555555555",
      platform: "ios",
      name: "iPhone 16 Pro",
    };
    managerSpy?.mockReturnValue({
      isAvailable: async () => false,
    } as any);
    fakeIosService.setPinchResult({ success: true, totalTimeMs: 710, gestureTimeMs: 700 });
    pinchOn = new PinchOn(iosDevice, null, {
      capture: new FakeHierarchyCapture(
        async () => (await fakeObserveScreen.getMostRecentCachedObserveResult()).viewHierarchy!,
        "ios",
      ),
    });
    (pinchOn as any).observeScreen = fakeObserveScreen;
    (pinchOn as any).awaitIdle = fakeAwaitIdle;
    (pinchOn as any).window = fakeWindow;
    (pinchOn as any).adb = fakeAdb;
    (pinchOn as any).timer = fakeTimer;

    const result = await pinchOn.execute({
      direction: "out",
      container: { elementId: "container-id" },
      duration: 700,
      rotationDegrees: 15,
    });

    expect(result.success).toBe(true);
    expect(result.targetType).toBe("container");
    expect(result.a11yTotalTimeMs).toBe(710);
    expect(fakeA11yService.getPinchHistory()).toHaveLength(0);
    expect(managerSpy).not.toHaveBeenCalled();

    const [pinchCall] = fakeIosService.getPinchHistory();
    expect(pinchCall).toEqual({
      centerX: 100,
      centerY: 100,
      distanceStart: 40,
      distanceEnd: 120,
      rotationDegrees: 15,
      duration: 700,
      timeoutMs: 5000,
    });
  });

  test("rounds fractional default iOS pinch distances before sending request_pinch", async () => {
    const iosDevice: BootedDevice = {
      deviceId: "11111111-2222-3333-4444-555555555555",
      platform: "ios",
      name: "iPhone 16 Pro",
    };
    fakeObserveScreen.setObserveResult(() => ({
      updatedAt: Date.now(),
      screenSize: { width: 393, height: 852 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: createHierarchy(),
    }));
    fakeIosService.setPinchResult({ success: true, totalTimeMs: 300, gestureTimeMs: 300 });
    pinchOn = new PinchOn(iosDevice, null, {
      capture: new FakeHierarchyCapture(
        async () => (await fakeObserveScreen.getMostRecentCachedObserveResult()).viewHierarchy!,
        "ios",
      ),
    });
    (pinchOn as any).observeScreen = fakeObserveScreen;
    (pinchOn as any).awaitIdle = fakeAwaitIdle;
    (pinchOn as any).window = fakeWindow;
    (pinchOn as any).adb = fakeAdb;
    (pinchOn as any).timer = fakeTimer;

    const result = await pinchOn.execute({
      direction: "out",
      autoTarget: false,
    });

    expect(result.success).toBe(true);
    expect(result.distanceStart).toBe(79);
    expect(result.distanceEnd).toBe(236);
    expect(result.scale).toBe(236 / 79);

    const [pinchCall] = fakeIosService.getPinchHistory();
    expect(pinchCall.distanceStart).toBe(79);
    expect(pinchCall.distanceEnd).toBe(236);
  });

  test("surfaces iOS CtrlProxy pinch failures", async () => {
    const iosDevice: BootedDevice = {
      deviceId: "11111111-2222-3333-4444-555555555555",
      platform: "ios",
      name: "iPhone 16 Pro",
    };
    fakeIosService.setPinchResult({ success: false, error: "Pinch failed on runner" });
    pinchOn = new PinchOn(iosDevice, null, {
      capture: new FakeHierarchyCapture(
        async () => (await fakeObserveScreen.getMostRecentCachedObserveResult()).viewHierarchy!,
        "ios",
      ),
    });
    (pinchOn as any).observeScreen = fakeObserveScreen;
    (pinchOn as any).awaitIdle = fakeAwaitIdle;
    (pinchOn as any).window = fakeWindow;
    (pinchOn as any).adb = fakeAdb;
    (pinchOn as any).timer = fakeTimer;

    const result = await pinchOn.execute({
      direction: "in",
      autoTarget: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Pinch failed on runner");
    expect(fakeIosService.getPinchHistory()).toHaveLength(1);
    expect(fakeA11yService.getPinchHistory()).toHaveLength(0);
  });

  test("warns when iOS pinch used the center-less element-anchored fallback (#2910)", async () => {
    const iosDevice: BootedDevice = {
      deviceId: "11111111-2222-3333-4444-555555555555",
      platform: "ios",
      name: "iPhone 16 Pro",
    };
    fakeIosService.setPinchResult({
      success: true,
      totalTimeMs: 300,
      gestureTimeMs: 300,
      pinchPath: "element-anchored",
    });
    pinchOn = new PinchOn(iosDevice, null, {
      capture: new FakeHierarchyCapture(
        async () => (await fakeObserveScreen.getMostRecentCachedObserveResult()).viewHierarchy!,
        "ios",
      ),
    });
    (pinchOn as any).observeScreen = fakeObserveScreen;
    (pinchOn as any).awaitIdle = fakeAwaitIdle;
    (pinchOn as any).window = fakeWindow;
    (pinchOn as any).adb = fakeAdb;
    (pinchOn as any).timer = fakeTimer;

    const result = await pinchOn.execute({ direction: "out", autoTarget: false });

    expect(result.success).toBe(true);
    expect(result.warning).toContain("element-anchored fallback");
  });

  test("does not warn when iOS pinch used the center-honoring event-path (#2910)", async () => {
    const iosDevice: BootedDevice = {
      deviceId: "11111111-2222-3333-4444-555555555555",
      platform: "ios",
      name: "iPhone 16 Pro",
    };
    fakeIosService.setPinchResult({
      success: true,
      totalTimeMs: 300,
      gestureTimeMs: 300,
      pinchPath: "event-path",
    });
    pinchOn = new PinchOn(iosDevice, null, {
      capture: new FakeHierarchyCapture(
        async () => (await fakeObserveScreen.getMostRecentCachedObserveResult()).viewHierarchy!,
        "ios",
      ),
    });
    (pinchOn as any).observeScreen = fakeObserveScreen;
    (pinchOn as any).awaitIdle = fakeAwaitIdle;
    (pinchOn as any).window = fakeWindow;
    (pinchOn as any).adb = fakeAdb;
    (pinchOn as any).timer = fakeTimer;

    const result = await pinchOn.execute({ direction: "out", autoTarget: false });

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
  });
});
