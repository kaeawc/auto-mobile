import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { DragAndDrop } from "../../../src/features/action/DragAndDrop";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { AndroidCtrlProxyManager } from "../../../src/utils/CtrlProxyManager";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("DragAndDrop", () => {
  const device: BootedDevice = {
    deviceId: "test-device",
    platform: "android",
    name: "Test Device",
  };

  let dragAndDrop: DragAndDrop;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeWindow: FakeWindow;
  let fakeA11yService: FakeCtrlProxy;
  let fakeAdb: FakeAdbExecutor;
  let fakeTimer: FakeTimer;
  let getInstanceSpy: ReturnType<typeof spyOn> | null = null;
  let managerSpy: ReturnType<typeof spyOn> | null = null;

  const createHierarchy = (): ViewHierarchyResult => ({
    hierarchy: {
      node: [
        {
          $: {
            "resource-id": "source-id",
            text: "Source",
            bounds: { left: 0, top: 0, right: 100, bottom: 100 },
            class: "android.widget.TextView",
          },
        },
        {
          $: {
            "resource-id": "target-id",
            text: "Target",
            bounds: { left: 200, top: 200, right: 300, bottom: 300 },
            class: "android.widget.TextView",
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
    fakeA11yService = new FakeCtrlProxy();
    fakeAdb = new FakeAdbExecutor();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

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

    dragAndDrop = new DragAndDrop(device, null, fakeTimer);
    (dragAndDrop as any).observeScreen = fakeObserveScreen;
    (dragAndDrop as any).awaitIdle = fakeAwaitIdle;
    (dragAndDrop as any).window = fakeWindow;
    (dragAndDrop as any).adb = fakeAdb;
  });

  afterEach(() => {
    getInstanceSpy?.mockRestore();
    managerSpy?.mockRestore();
  });

  test("uses accessibility service drag between resolved elements", async () => {
    fakeA11yService.setDragResult({
      success: true,
      totalTimeMs: 750,
      gestureTimeMs: 500,
    });

    const result = await dragAndDrop.execute({
      source: { elementId: "source-id" },
      target: { elementId: "target-id" },
      pressDurationMs: 600,
      dragDurationMs: 500,
      holdDurationMs: 200,
    });

    expect(result.success).toBe(true);
    expect(result.duration).toBe(500);
    expect(result.distance).toBeCloseTo(Math.hypot(200, 200));
    expect(result.a11yTotalTimeMs).toBe(750);
    expect(result.a11yGestureTimeMs).toBe(500);

    const [dragCall] = fakeA11yService.getDragHistory();
    expect(dragCall).toBeDefined();
    expect(dragCall.x1).toBe(50);
    expect(dragCall.y1).toBe(50);
    expect(dragCall.x2).toBe(250);
    expect(dragCall.y2).toBe(250);
  });

  test("returns error when accessibility service reports failure", async () => {
    fakeA11yService.setDragResult({
      success: false,
      totalTimeMs: 300,
      error: "Drag gesture rejected",
    });

    const result = await dragAndDrop.execute({
      source: { elementId: "source-id" },
      target: { elementId: "target-id" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Drag gesture rejected");
  });

  test("surfaces thrown errors from accessibility service", async () => {
    fakeA11yService.setFailureMode("drag", new Error("Accessibility service failure"));

    const result = await dragAndDrop.execute({
      source: { elementId: "source-id" },
      target: { elementId: "target-id" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Failed to perform drag and drop: Accessibility service failure");
  });

  test("uses default gesture durations and a 1600ms drag timeout when none are supplied", async () => {
    await dragAndDrop.execute({
      source: { elementId: "source-id" },
      target: { elementId: "target-id" },
    });

    const [dragCall] = fakeA11yService.getDragHistory();
    expect(dragCall.pressDurationMs).toBe(600);
    expect(dragCall.dragDurationMs).toBe(300);
    expect(dragCall.holdDurationMs).toBe(100);
    // 600 + 300 + 100 + DROP(100) + BUFFER(500) = 1600
    expect(dragCall.timeoutMs).toBe(1600);
  });

  test("derives the drag timeout from the supplied gesture durations", async () => {
    await dragAndDrop.execute({
      source: { elementId: "source-id" },
      target: { elementId: "target-id" },
      pressDurationMs: 600,
      dragDurationMs: 500,
      holdDurationMs: 200,
    });

    const [dragCall] = fakeA11yService.getDragHistory();
    // 600 + 500 + 200 + DROP(100) + BUFFER(500) = 1900
    expect(dragCall.timeoutMs).toBe(1900);
  });

  describe("validateOptions", () => {
    test.each<[string, any, string]>([
      ["missing target", { source: { elementId: "source-id" } }, "requires source and target"],
      [
        "source with both selectors",
        { source: { elementId: "source-id", text: "Source" }, target: { elementId: "target-id" } },
        "source must specify exactly one of text or elementId",
      ],
      [
        "target with both selectors",
        { source: { elementId: "source-id" }, target: { elementId: "target-id", text: "Target" } },
        "target must specify exactly one of text or elementId",
      ],
      [
        "pressDurationMs above the maximum",
        {
          source: { elementId: "source-id" },
          target: { elementId: "target-id" },
          pressDurationMs: 5000,
        },
        "pressDurationMs must be between 600ms and 3000ms",
      ],
      [
        "dragDurationMs above the maximum",
        {
          source: { elementId: "source-id" },
          target: { elementId: "target-id" },
          dragDurationMs: 5000,
        },
        "dragDurationMs must be between 300ms and 2000ms",
      ],
      [
        "holdDurationMs below the minimum",
        {
          source: { elementId: "source-id" },
          target: { elementId: "target-id" },
          holdDurationMs: 5,
        },
        "holdDurationMs must be between 100ms and 3000ms",
      ],
    ])("rejects %s without dispatching a drag", async (_name, options, expected) => {
      const result = await dragAndDrop.execute(options);

      expect(result.success).toBe(false);
      expect(result.error).toContain(expected);
      // A rejected request must never reach the accessibility service.
      expect(fakeA11yService.getDragHistory()).toHaveLength(0);
    });
  });
});
