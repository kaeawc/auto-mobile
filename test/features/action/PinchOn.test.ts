import { StaleDisplayError } from "../../../src/models/StaleDisplayError";
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";
import { ActionableError } from "../../../src/models/ActionableError";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type {
  BootedDevice,
  Element,
  ObserveResult,
  ViewHierarchyResult,
} from "../../../src/models";
import {
  isLikelyBottomSheet,
  PinchOn,
  scorePinchElement,
} from "../../../src/features/action/PinchOn";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { serverConfig } from "../../../src/utils/ServerConfig";
import containerFixture from "../../fixtures/observe/android-container-scope.json";

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
    serverConfig.setRawElementSearchEnabled(false);
    getInstanceSpy?.mockRestore();
    iosGetInstanceSpy?.mockRestore();
    managerSpy?.mockRestore();
  });

  test.each(["settle-throws", "throws", "dispatch-transition", "settle-transition"] as const)(
    "confirmed display pinch preserves delivery after %s",
    async (outcome) => {
      const display = {
        key: "inner",
        role: "inner" as const,
        posture: "unknown" as const,
        generation: 0,
      };
      const before = { ...createObserveResult(), display, displayRevision: 0 };
      before.viewHierarchy!.displayId = 0;
      const destination = {
        ...before,
        viewHierarchy: { hierarchy: { node: { text: "Destination" } }, displayId: 0 },
      };
      fakeAdb.setCommandResponse("cmd display get-displays", {
        stdout: 'Display id 0: DisplayInfo{uniqueId "local:inner" type INTERNAL, real 1080 x 1920}',
        stderr: "",
      });
      fakeA11yService.setSupportedCommands(["gesture_display_id_v1"]);
      const transitions = new FakeDisplayTransitionReader();
      transitions.generation = 0;
      transitions.fullRevision = 0;
      transitions.panel = { key: "inner", role: "inner" };
      const requestPinch = fakeA11yService.requestPinch.bind(fakeA11yService);
      if (outcome === "dispatch-transition") {
        spyOn(fakeA11yService, "requestPinch").mockImplementation(async (...args) => {
          const result = await requestPinch(...args);
          transitions.transition();
          return result;
        });
      }
      const action = new PinchOn(
        {
          ...device,
          displays: {
            panels: [{ key: "inner", role: "inner", sizePx: before.screenSize }],
            postures: [],
          },
        },
        fakeAdb,
        {
          timer: fakeTimer,
          displayTransitions: transitions,
          capture: new FakeHierarchyCapture(() => before.viewHierarchy!),
          lastRenderedObservation: () => before,
        },
      );
      action.observeScreen = fakeObserveScreen;
      action.awaitIdle = fakeAwaitIdle;
      let postReads = 0;
      fakeObserveScreen.setObserveResult(() => {
        if (!fakeA11yService.getPinchHistory().length) {
          return before;
        }
        postReads++;
        if (outcome === "throws" || postReads > 1) {
          if (outcome === "settle-transition") {
            transitions.transition();
            throw new StaleDisplayError({
              observedGeneration: 0,
              currentGeneration: 1,
              retry: "observe",
            });
          }
          throw new Error("display post-read unavailable");
        }
        return destination;
      });
      const result = await action.execute({ direction: "in", display: "inner", autoTarget: false });
      expect(fakeA11yService.getPinchHistory()).toHaveLength(1);
      if (outcome === "throws" || outcome === "dispatch-transition") {
        expect(result.success).toBe(false);
        expect(result.error).toContain("Do not retry automatically");
        expect(result.observation).toBeUndefined();
        if (outcome === "dispatch-transition") {
          expect(result.staleDisplay?.retry).toBe("observe");
        }
      } else {
        expect(result.success).toBe(true);
        expect(result.observation?.viewHierarchy).toEqual(destination.viewHierarchy);
        expect(result.observation?.freshness?.warning).toContain("display settle");
        if (outcome === "settle-transition") {
          expect(result.staleDisplay?.retry).toBe("observe");
        }
      }
    },
  );

  test.each([0, -1, 1.5, 10001])(
    "rejects invalid duration %s before dispatch",
    async (duration) => {
      await expect(pinchOn.execute({ direction: "in", duration })).rejects.toThrow(ActionableError);
      expect(fakeA11yService.getPinchHistory()).toEqual([]);
      expect(fakeIosService.getPinchHistory()).toEqual([]);
    },
  );

  test.each([1, 10000, undefined])("preserves accepted/default duration %s", async (duration) => {
    const result = await pinchOn.execute({ direction: "in", autoTarget: false, duration });
    expect(result.success).toBe(true);
    expect(result.duration).toBe(duration ?? 300);
    expect(fakeA11yService.getPinchHistory()[0]?.duration).toBe(duration ?? 300);
  });

  test("already aborted pinch dispatches no device command", async () => {
    await expect(
      pinchOn.execute({ direction: "in" }, undefined, AbortSignal.abort()),
    ).rejects.toThrow("Operation cancelled");
    expect(fakeA11yService.getPinchHistory()).toEqual([]);
  });

  test("abort during target capture stops before pinch dispatch", async () => {
    const controller = new AbortController();
    Object.defineProperty(pinchOn, "capture", {
      value: new FakeHierarchyCapture(() => {
        controller.abort();
        return createHierarchy();
      }),
    });
    await expect(
      pinchOn.execute({ direction: "in", autoTarget: false }, undefined, controller.signal),
    ).rejects.toThrow("Operation cancelled");
    expect(fakeA11yService.getPinchHistory()).toEqual([]);
  });
  test("fresh pinch selector capture requests raw hierarchy when enabled", async () => {
    serverConfig.setRawElementSearchEnabled(true);
    const capture = new FakeHierarchyCapture(createHierarchy);
    (pinchOn as any).capture = capture;
    await (pinchOn as any).resolveTarget({
      direction: "in",
      container: { elementId: "container-id" },
    });
    expect(capture.requests[0]?.searchRaw).toBe(true);
  });

  test("a missing cached hierarchy is re-read without a screenshot or audit before the pinch", async () => {
    fakeObserveScreen.setObserveResult(() => ({
      ...createObserveResult(),
      viewHierarchy: fakeObserveScreen.getExecuteCallCount() === 0 ? undefined : createHierarchy(),
    }));
    await pinchOn.execute({ direction: "out", autoTarget: false });
    const reads = fakeObserveScreen.getExecuteOptions();
    expect(reads[0]).toMatchObject({
      freshness: "cached-ok",
      skipScreenshot: true,
      skipAccessibilityAudit: true,
    });
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

  test("string true scrollable flags receive the scrollable score", () => {
    const element: Element = {
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      scrollable: "true",
    };
    expect(scorePinchElement(element, 20_000)).toBe(10_800);
  });

  test("bottom-sheet detection handles string and boolean scrollable flags", () => {
    const bounds = { left: 0, top: 700, right: 300, bottom: 1000 };
    const screenBounds = { left: 0, top: 0, right: 500, bottom: 1000 };
    const stringTrue: Element = { bounds, scrollable: "true" };
    const stringFalse: Element = { bounds, scrollable: "false" };
    const booleanTrue: Element = { bounds, scrollable: true };

    expect(isLikelyBottomSheet(stringTrue, screenBounds)).toBe(true);
    expect(isLikelyBottomSheet(stringFalse, screenBounds)).toBe(false);
    expect(isLikelyBottomSheet(booleanTrue, screenBounds)).toBe(true);
    expect(scorePinchElement(stringFalse, 20_000)).toBe(108_000);
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
        // Keep screen geometry distinct from the freshly moved content control.
        bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
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
    expect(capture.requests).toEqual([{ freshness: "fresh", searchRaw: false }]);
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

  test("pinches the selected nested descendant and never a peer", async () => {
    fakeObserveScreen.setObserveResult({
      ...createObserveResult(),
      viewHierarchy: {
        hierarchy: {
          node: { "resource-id": "cart_A", node: containerFixture.viewHierarchy.hierarchy.node },
        },
      },
    });
    const container = {
      elementId: "action",
      selectionStrategy: "unique" as const,
      container: {
        elementId: "left",
        selectionStrategy: "unique" as const,
        container: { elementId: "cart_A", selectionStrategy: "unique" as const },
      },
    };
    const result = await pinchOn.execute({ direction: "out", container });
    expect(result.success).toBe(true);
    expect(fakeA11yService.getPinchHistory()[0]).toMatchObject({ centerX: 120, centerY: 70 });

    const missing = await pinchOn.execute({
      direction: "out",
      container: { ...container, container: { ...container.container, elementId: "missing" } },
    });
    expect(missing.success).toBe(false);
    expect(missing.error).toContain("Container level 2 not found");
    expect(fakeA11yService.getPinchHistory()).toHaveLength(1);
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
