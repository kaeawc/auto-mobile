import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { DragAndDrop } from "../../../src/features/action/DragAndDrop";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { AndroidCtrlProxyManager } from "../../../src/utils/CtrlProxyManager";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeTimer } from "../../fakes/FakeTimer";

// Simulator-shaped UDID so isIosSimulatorUdid would pass (not that dragAndDrop branches on it,
// but keeps the device realistic).
const IOS_DEVICE: BootedDevice = {
  deviceId: "11111111-2222-3333-4444-555555555555",
  platform: "ios",
  name: "iPhone 16 Pro",
};

describe("DragAndDrop - iOS", () => {
  let dragAndDrop: DragAndDrop;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeWindow: FakeWindow;
  let fakeIosClient: FakeCtrlProxy;
  let fakeAndroidClient: FakeCtrlProxy;
  let fakeTimer: FakeTimer;
  let iosSpy: ReturnType<typeof spyOn> | null = null;
  let androidSpy: ReturnType<typeof spyOn> | null = null;
  let managerSpy: ReturnType<typeof spyOn> | null = null;

  const createHierarchy = (): ViewHierarchyResult => ({
    hierarchy: {
      node: [
        {
          $: {
            "resource-id": "source-id",
            text: "Source",
            bounds: { left: 0, top: 0, right: 100, bottom: 100 },
            class: "XCUIElementTypeCell",
          },
        },
        {
          $: {
            "resource-id": "target-id",
            text: "Target",
            bounds: { left: 200, top: 200, right: 300, bottom: 300 },
            class: "XCUIElementTypeCell",
          },
        },
      ],
    },
    packageName: "com.test.app",
    updatedAt: Date.now(),
  });

  const createObserveResult = (): ObserveResult => ({
    updatedAt: Date.now(),
    screenSize: { width: 1170, height: 2532 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    viewHierarchy: createHierarchy(),
  });

  beforeEach(() => {
    fakeObserveScreen = new FakeObserveScreen();
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeWindow = new FakeWindow();
    fakeIosClient = new FakeCtrlProxy();
    fakeAndroidClient = new FakeCtrlProxy();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    fakeObserveScreen.setObserveResult(() => createObserveResult());
    fakeWindow.configureCachedActiveWindow(null);
    fakeWindow.configureActiveWindow({
      appId: "com.test.app",
      activityName: "Main",
      layoutSeqSum: 1,
    });

    // If the Android availability guard ran on iOS, this would force failure — it must NOT run.
    managerSpy = spyOn(AndroidCtrlProxyManager, "getInstance").mockReturnValue({
      isAvailable: async () => false,
    } as any);
    androidSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      fakeAndroidClient as any,
    );
    iosSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(fakeIosClient as any);

    dragAndDrop = new DragAndDrop(IOS_DEVICE, null, fakeTimer);
    (dragAndDrop as any).observeScreen = fakeObserveScreen;
    (dragAndDrop as any).awaitIdle = fakeAwaitIdle;
    (dragAndDrop as any).window = fakeWindow;
  });

  afterEach(() => {
    iosSpy?.mockRestore();
    androidSpy?.mockRestore();
    managerSpy?.mockRestore();
  });

  test("routes drag through the iOS CtrlProxy client (not the Android a11y service)", async () => {
    fakeIosClient.setDragResult({ success: true, totalTimeMs: 410, gestureTimeMs: 300 });

    const result = await dragAndDrop.execute({
      source: { elementId: "source-id" },
      target: { elementId: "target-id" },
      pressDurationMs: 600,
      dragDurationMs: 500,
      holdDurationMs: 200,
    });

    expect(result.success).toBe(true);
    expect(result.distance).toBeCloseTo(Math.hypot(200, 200));
    expect(result.a11yTotalTimeMs).toBe(410);

    // iOS client received the drag with resolved element centers; Android client did not.
    const [iosDrag] = fakeIosClient.getDragHistory();
    expect(iosDrag).toBeDefined();
    expect(iosDrag.x1).toBe(50);
    expect(iosDrag.y1).toBe(50);
    expect(iosDrag.x2).toBe(250);
    expect(iosDrag.y2).toBe(250);
    expect(fakeAndroidClient.getDragHistory()).toHaveLength(0);
  });

  test("does not require the Android accessibility service on iOS", async () => {
    // AndroidCtrlProxyManager.isAvailable() returns false above; the iOS path must ignore it.
    fakeIosClient.setDragResult({ success: true, totalTimeMs: 1, gestureTimeMs: 1 });

    const result = await dragAndDrop.execute({
      source: { elementId: "source-id" },
      target: { elementId: "target-id" },
    });

    expect(result.success).toBe(true);
    expect(fakeIosClient.getDragHistory()).toHaveLength(1);
  });

  test("surfaces iOS runner failure", async () => {
    fakeIosClient.setDragResult({ success: false, error: "Drag failed on runner" });

    const result = await dragAndDrop.execute({
      source: { elementId: "source-id" },
      target: { elementId: "target-id" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Drag failed on runner");
  });

  test("refreshes the iOS hierarchy before resolving drag targets", async () => {
    fakeIosClient.setDragResult({ success: true, totalTimeMs: 1, gestureTimeMs: 1 });

    await dragAndDrop.execute({
      source: { elementId: "source-id" },
      target: { elementId: "target-id" },
    });

    // iOS forces a fresh runner snapshot; the Android service is never asked.
    expect(fakeIosClient.getHierarchyRequestCount()).toBeGreaterThan(0);
    expect(fakeAndroidClient.getHierarchyRequestCount()).toBe(0);
  });

  test("bypasses the client hierarchy cache via requestHierarchySync", async () => {
    // requestHierarchySync always does a fresh runner round-trip; the cache-aware
    // getAccessibilityHierarchy / getLatestHierarchy fast-paths must NOT be used,
    // otherwise a snapshot younger than the client TTL could resolve stale coordinates.
    const syncSpy = spyOn(fakeIosClient, "requestHierarchySync");
    const cachedSpy = spyOn(fakeIosClient, "getAccessibilityHierarchy");
    const latestSpy = spyOn(fakeIosClient, "getLatestHierarchy");
    fakeIosClient.setDragResult({ success: true, totalTimeMs: 1, gestureTimeMs: 1 });

    await dragAndDrop.execute({
      source: { elementId: "source-id" },
      target: { elementId: "target-id" },
    });

    expect(syncSpy).toHaveBeenCalled();
    expect(cachedSpy).not.toHaveBeenCalled();
    expect(latestSpy).not.toHaveBeenCalled();
    // Uses the 15s iOS budget (XCUITest extraction can take 5-15s), not the 5s Android value.
    expect(syncSpy).toHaveBeenCalledWith(undefined, false, undefined, 15000);
  });

  test("drags against the freshly-refreshed hierarchy, not the stale observe cache", async () => {
    // The cached observe places the elements at (50,50)/(250,250); the fresh runner
    // snapshot reports new coordinates after the UI scrolled. The drag must use the fresh ones.
    fakeIosClient.setHierarchyData({ packageName: "com.test.app", updatedAt: Date.now() });
    fakeIosClient.setViewHierarchyResult({
      hierarchy: {
        node: [
          {
            $: {
              "resource-id": "source-id",
              text: "Source",
              bounds: { left: 450, top: 450, right: 550, bottom: 550 },
              class: "XCUIElementTypeCell",
            },
          },
          {
            $: {
              "resource-id": "target-id",
              text: "Target",
              bounds: { left: 650, top: 650, right: 750, bottom: 750 },
              class: "XCUIElementTypeCell",
            },
          },
        ],
      },
      packageName: "com.test.app",
      updatedAt: Date.now(),
    });
    fakeIosClient.setDragResult({ success: true, totalTimeMs: 1, gestureTimeMs: 1 });

    const result = await dragAndDrop.execute({
      source: { elementId: "source-id" },
      target: { elementId: "target-id" },
    });

    expect(result.success).toBe(true);
    const [iosDrag] = fakeIosClient.getDragHistory();
    expect(iosDrag.x1).toBe(500);
    expect(iosDrag.y1).toBe(500);
    expect(iosDrag.x2).toBe(700);
    expect(iosDrag.y2).toBe(700);
    expect(result.distance).toBeCloseTo(Math.hypot(200, 200));
  });

  test("falls back to the observe cache when the iOS refresh returns nothing", async () => {
    // No hierarchyData configured → the runner snapshot is null; the cached observe
    // (source/target at (50,50)/(250,250)) must still resolve the drag endpoints.
    fakeIosClient.setDragResult({ success: true, totalTimeMs: 1, gestureTimeMs: 1 });

    const result = await dragAndDrop.execute({
      source: { elementId: "source-id" },
      target: { elementId: "target-id" },
    });

    expect(result.success).toBe(true);
    const [iosDrag] = fakeIosClient.getDragHistory();
    expect(iosDrag.x1).toBe(50);
    expect(iosDrag.y1).toBe(50);
    expect(iosDrag.x2).toBe(250);
    expect(iosDrag.y2).toBe(250);
  });

  test("forwards a caller-supplied dragDurationMs to the iOS runner", async () => {
    fakeIosClient.setDragResult({ success: true, totalTimeMs: 1, gestureTimeMs: 1 });

    const result = await dragAndDrop.execute({
      source: { elementId: "source-id" },
      target: { elementId: "target-id" },
      dragDurationMs: 800,
    });

    expect(result.success).toBe(true);
    expect(result.duration).toBe(800);
    const [iosDrag] = fakeIosClient.getDragHistory();
    expect(iosDrag.dragDurationMs).toBe(800);
  });
});
