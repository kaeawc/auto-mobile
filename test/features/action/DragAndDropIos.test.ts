import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import {
  DragAndDrop,
  getIosDragTimeoutMs,
  IOS_DRAG_TIMEOUT_OVERHEAD_MS,
  IOS_DRAG_TIMEOUT_DURATION_RATIO,
} from "../../../src/features/action/DragAndDrop";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { IOSCtrlProxy } from "../../../src/features/observe/ios/IOSCtrlProxyClient";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeTimer } from "../../fakes/FakeTimer";
import { iosProjectionFixture } from "../../fixtures/iosProjectionFixture";
import { raceWithDeadline } from "../../../src/utils/raceWithDeadline";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { identifyObservedHierarchy } from "../../../src/features/observe/HierarchyCapture";
import { awaitWhileRequestIsLive } from "../../../src/utils/toolUtils";
import { DeviceLostError } from "../../../src/models/DeviceLostError";
import { FakeScreenshotCapturer } from "../../fakes/FakeScreenshotCapturer";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { createSuccessWebSocketFactory } from "../../fakes/FakeWebSocket";

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
  let iosDragClient: Pick<IOSCtrlProxy, "requestDrag">;
  let fakeTimer: FakeTimer;
  let iosSpy: ReturnType<typeof spyOn> | null = null;
  let androidSpy: ReturnType<typeof spyOn> | null = null;
  let managerSpy: ReturnType<typeof spyOn> | null = null;
  let runnerFinishedAt = 0;

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
    // The shared fake retains Android positional arguments; view its iOS request contract.
    iosDragClient = fakeIosClient as Pick<IOSCtrlProxy, "requestDrag">;
    fakeAndroidClient = new FakeCtrlProxy();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    runnerFinishedAt = 0;
    fakeIosClient.setHierarchyData(createHierarchy());
    fakeIosClient.setViewHierarchyResult(createHierarchy());

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
    expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    iosSpy?.mockRestore();
    androidSpy?.mockRestore();
    managerSpy?.mockRestore();
  });

  // Model the client's transport deadline and a synchronous XCUITest call that
  // can finish after the host has stopped waiting, using only fake time.
  const fakeRunnerReply = (replyDelayMs?: number, controller?: AbortController) => {
    return spyOn(iosDragClient, "requestDrag").mockImplementation(
      async (_x1, _y1, _x2, _y2, _press, _drag, _hold, timeoutMs, _context, signal, onDispatch) => {
        onDispatch?.();
        const timeout = new Error(`Drag timed out after ${timeoutMs}ms`);
        if (controller) {
          fakeTimer.setTimeout(() => controller.abort(), 25);
        }
        const reply = new Promise<{ success: boolean; totalTimeMs: number }>((resolve) => {
          if (replyDelayMs !== undefined) {
            fakeTimer.setTimeout(
              () => resolve({ success: true, totalTimeMs: replyDelayMs }),
              replyDelayMs,
            );
          }
        });
        try {
          return await raceWithDeadline(reply, {
            timer: fakeTimer,
            timeoutMs,
            signal,
            label: "Drag",
            timeoutError: () => timeout,
          });
        } catch (error) {
          if (error !== timeout) {
            throw error;
          }
          return { success: false, totalTimeMs: timeoutMs, error: timeout.message };
        } finally {
          runnerFinishedAt = fakeTimer.now();
        }
      },
    );
  };

  test("accepts a runner reply 850ms after the planned drag duration", async () => {
    const runner = fakeRunnerReply(1850);
    const result = await dragAndDrop.execute({
      source: { elementId: "source-id" },
      target: { elementId: "target-id" },
      pressDurationMs: 600,
      dragDurationMs: 300,
      holdDurationMs: 100,
    });
    expect(result.success).toBe(true);
    expect(result.a11yTotalTimeMs).toBe(1850);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test("budgets short and long plans with sibling gesture headroom and scaling", () => {
    expect(IOS_DRAG_TIMEOUT_OVERHEAD_MS).toBe(2000);
    expect(IOS_DRAG_TIMEOUT_DURATION_RATIO).toBe(0.5);
    expect(getIosDragTimeoutMs(600, 300, 100)).toBe(5000);
    expect(getIosDragTimeoutMs(1000, 800, 300)).toBe(5150);
    expect(getIosDragTimeoutMs(3000, 2000, 3000)).toBe(14000);
  });

  test.each([600, 1000.25])(
    "an unanswered drag is indeterminate at the iOS budget (press %sms)",
    async (pressDurationMs) => {
      const runner = fakeRunnerReply();
      const budget = getIosDragTimeoutMs(pressDurationMs, 800, 300);
      const result = await dragAndDrop.execute({
        source: { elementId: "source-id" },
        target: { elementId: "target-id" },
        pressDurationMs,
        dragDurationMs: 800,
        holdDurationMs: 300,
      });
      expect(runnerFinishedAt).toBe(budget);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Drag outcome is indeterminate");
      expect(result.error).toContain(`Drag timed out after ${budget}ms`);
      expect(result.error).toContain("gesture may have run");
      expect(result.error).toContain("Do not retry automatically");
      expect(result.error).toContain("observe");
      expect(runner).toHaveBeenCalledTimes(1);
    },
  );

  test("iOS client forwards drag cancellation and dispatch to the shared gesture delegate", async () => {
    const controller = new AbortController();
    const client = IOSCtrlProxyClient.createForTesting(
      IOS_DEVICE,
      8765,
      createSuccessWebSocketFactory(fakeTimer),
      fakeTimer,
    );
    const delegate = spyOn(client["gestures"], "requestDrag").mockResolvedValue({
      success: true,
      totalTimeMs: 1850,
    });
    try {
      const onDispatch = () => {};
      await client.requestDrag(
        50,
        50,
        250,
        250,
        600,
        300,
        100,
        5000,
        undefined,
        controller.signal,
        onDispatch,
      );
      expect(delegate).toHaveBeenCalledWith(
        50,
        50,
        250,
        250,
        600,
        300,
        100,
        5000,
        undefined,
        controller.signal,
        undefined,
        undefined,
        onDispatch,
      );
    } finally {
      delegate.mockRestore();
    }
  });

  test("abort stops waiting even while the client is still connecting", async () => {
    const controller = new AbortController();
    const runner = spyOn(iosDragClient, "requestDrag").mockImplementation(() => {
      fakeTimer.setTimeout(() => controller.abort(), 25);
      return new Promise(() => {});
    });
    await expect(
      dragAndDrop.execute(
        {
          source: { elementId: "source-id" },
          target: { elementId: "target-id" },
        },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow("Operation cancelled");
    expect(fakeTimer.now()).toBe(25);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test("abort clears the pending iOS drag deadline", async () => {
    const timer = new FakeTimer();
    const action = new DragAndDrop(IOS_DEVICE, null, timer);
    Object.assign(action, {
      observeScreen: fakeObserveScreen,
      awaitIdle: fakeAwaitIdle,
      window: fakeWindow,
    });
    const controller = new AbortController();
    const ready = Promise.withResolvers<void>();
    const runner = spyOn(iosDragClient, "requestDrag").mockImplementation((...args) => {
      args[10]?.();
      const pending = raceWithDeadline(new Promise<never>(() => {}), {
        timer,
        timeoutMs: args[7],
        signal: args[9],
        label: "Drag",
      });
      ready.resolve();
      return pending;
    });
    const pending = action.execute(
      { source: { elementId: "source-id" }, target: { elementId: "target-id" } },
      undefined,
      controller.signal,
    );
    await ready.promise;
    expect(timer.getPendingTimeoutCount()).toBe(1);
    controller.abort();
    await expect(pending).rejects.toThrow("Operation cancelled");
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test.each(["explicit", "ambient"])(
    "honours the %s abort before the drag budget",
    async (kind) => {
      const controller = new AbortController();
      const runner = fakeRunnerReply(undefined, controller);
      const execute = () =>
        dragAndDrop.execute(
          {
            source: { elementId: "source-id" },
            target: { elementId: "target-id" },
          },
          undefined,
          kind === "explicit" ? controller.signal : undefined,
        );
      const pending =
        kind === "ambient" ? runWithAbortSignal(controller.signal, execute) : execute();
      await expect(pending).rejects.toThrow("Operation cancelled");
      expect(fakeTimer.now()).toBe(25);
      expect(runner.mock.calls[0][9]).toBe(controller.signal);
      expect(runner).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["explicit", "ambient"])(
    "rethrows %s cancellation during explicit-display preflight",
    async (kind) => {
      const controller = new AbortController();
      const device: BootedDevice = {
        ...IOS_DEVICE,
        displays: {
          panels: [
            { key: "internal", role: "inner", sizePx: { width: 100, height: 100 } },
            { key: "external", role: "external", sizePx: { width: 200, height: 200 } },
          ],
          postures: [],
        },
      };
      const action = new DragAndDrop(device, null, fakeTimer, {
        lastRenderedObservation: () => ({ display: { key: "external" } }),
      });
      action.observeScreen = fakeObserveScreen;
      const observe = spyOn(fakeObserveScreen, "execute").mockImplementation((options) => {
        const pending = awaitWhileRequestIsLive(
          new Promise<ObserveResult>(() => {}),
          options?.signal,
        );
        controller.abort();
        return pending;
      });
      const runner = spyOn(iosDragClient, "requestDrag");
      try {
        const execute = () =>
          action.execute(
            {
              source: { elementId: "source-id" },
              target: { elementId: "target-id" },
              display: "external",
            },
            undefined,
            kind === "explicit" ? controller.signal : undefined,
          );
        const pending =
          kind === "ambient" ? runWithAbortSignal(controller.signal, execute) : execute();
        await expect(pending).rejects.toThrow("Operation cancelled");
        expect(observe.mock.calls[0][0]).toMatchObject({
          display: "external",
          signal: controller.signal,
        });
        expect(runner).not.toHaveBeenCalled();
      } finally {
        observe.mockRestore();
        runner.mockRestore();
      }
    },
  );

  test.each(["cancel", "device loss"])(
    "rethrows %s during connect before failure mapping",
    async (kind) => {
      const controller = new AbortController();
      const loss = new DeviceLostError(IOS_DEVICE.deviceId, "Device connection lost");
      const runner = spyOn(iosDragClient, "requestDrag").mockImplementation(async () => {
        controller.abort(kind === "device loss" ? loss : undefined);
        return { success: false, totalTimeMs: 0, error: "Request aborted before dispatch" };
      });
      const pending = dragAndDrop.execute(
        {
          source: { elementId: "source-id" },
          target: { elementId: "target-id" },
        },
        undefined,
        controller.signal,
      );
      if (kind === "device loss") {
        await expect(pending).rejects.toBe(loss);
      } else {
        await expect(pending).rejects.toThrow("Operation cancelled");
      }
      expect(runner).toHaveBeenCalledTimes(1);
    },
  );

  test("rethrows abort when element resolution returns a null hierarchy", async () => {
    const controller = new AbortController();
    spyOn(dragAndDrop["hierarchyCapture"], "capture").mockImplementation(async (request) => {
      expect(request.signal).toBe(controller.signal);
      const snapshot = identifyObservedHierarchy("ios", createHierarchy(), "fresh", fakeTimer);
      // Model the legacy null-on-abort boundary despite the capture's non-null type contract.
      Object.defineProperty(snapshot, "hierarchy", { value: null });
      controller.abort();
      return snapshot;
    });
    const runner = spyOn(iosDragClient, "requestDrag");
    await expect(
      dragAndDrop.execute(
        {
          source: { elementId: "source-id" },
          target: { elementId: "target-id" },
        },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow("Operation cancelled");
    expect(runner).not.toHaveBeenCalled();
  });

  test("rethrows abort swallowed by vision enrichment", async () => {
    const controller = new AbortController();
    const capturer = new FakeScreenshotCapturer();
    const capture = spyOn(capturer, "capture").mockImplementation(async () => {
      controller.abort();
      throw new Error("screenshot cancelled");
    });
    Object.assign(dragAndDrop, {
      visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: true },
      screenshotCapturer: capturer,
    });
    const runner = spyOn(iosDragClient, "requestDrag");
    await expect(
      dragAndDrop.execute(
        {
          source: { elementId: "missing-source" },
          target: { elementId: "target-id" },
        },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow("Operation cancelled");
    expect(capture).toHaveBeenCalledTimes(1);
    expect(runner).not.toHaveBeenCalled();
  });

  test("rethrows abort when post-action observation returns normally", async () => {
    const controller = new AbortController();
    const observe = spyOn(fakeObserveScreen, "execute").mockImplementation(async () => {
      controller.abort();
      return createObserveResult();
    });
    await expect(
      dragAndDrop.execute(
        {
          source: { elementId: "source-id" },
          target: { elementId: "target-id" },
        },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow("Operation cancelled");
    expect(observe).toHaveBeenCalledTimes(1);
  });

  test("direct iOS sync cannot resolve an offscreen source excluded by observe", async () => {
    const freshHierarchy = {
      packageName: "com.test.app",
      updatedAt: 1,
      screenWidth: 100,
      screenHeight: 100,
      hierarchy: {
        bounds: [0, 0, 100, 100],
        node: [
          { "resource-id": "source-id", text: "Source", bounds: [0, 500, 50, 550] },
          { "resource-id": "target-id", text: "Target", bounds: [0, 0, 50, 50] },
        ],
      },
    } as any;
    fakeIosClient.setHierarchyData(freshHierarchy);
    fakeIosClient.setViewHierarchyResult(freshHierarchy);
    const result = await dragAndDrop.execute({
      source: { elementId: "source-id" },
      target: { elementId: "target-id" },
    });
    expect(result.success).toBe(false);
    expect(fakeIosClient.getDragHistory()).toHaveLength(0);
  });

  test("drag uses cleaned visible children and excludes filtered iOS nodes", async () => {
    const freshHierarchy = iosProjectionFixture();
    fakeIosClient.setHierarchyData(freshHierarchy);
    fakeIosClient.setViewHierarchyResult(freshHierarchy);
    fakeIosClient.setDragResult({ success: true, totalTimeMs: 1, gestureTimeMs: 1 });

    const visible = await dragAndDrop.execute({
      source: { elementId: "source-id" },
      target: { elementId: "target-id" },
    });
    expect(visible.success).toBe(true);
    expect(fakeIosClient.getDragHistory()[0]).toMatchObject({ x1: 20, y1: 20, x2: 70, y2: 70 });

    const hidden = await dragAndDrop.execute({
      source: { elementId: "hidden-id" },
      target: { elementId: "target-id" },
    });
    expect(hidden.success).toBe(false);
    expect(fakeIosClient.getDragHistory()).toHaveLength(1);
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

  test.each([false, true])("maps a runner failure with dispatched=%s", async (dispatched) => {
    spyOn(iosDragClient, "requestDrag").mockImplementation(async (...args) => {
      if (dispatched) {
        args[10]?.();
      }
      return { success: false, totalTimeMs: 0, error: "Drag failed on runner" };
    });
    const result = await dragAndDrop.execute({
      source: { elementId: "source-id" },
      target: { elementId: "target-id" },
    });
    expect(result.success).toBe(false);
    if (dispatched) {
      expect(result.error).toContain("Drag outcome is indeterminate");
      expect(result.error).toContain("Drag failed on runner");
    } else {
      expect(result.error).toBe("Drag failed on runner");
    }
  });

  test("keeps iOS dispatched failure rules for Android no-op text", async () => {
    spyOn(iosDragClient, "requestDrag").mockImplementation(async (...args) => {
      args[10]?.();
      return { success: false, totalTimeMs: 0, error: "Failed to dispatch gesture" };
    });
    const result = await dragAndDrop.execute({
      source: { elementId: "source-id" },
      target: { elementId: "target-id" },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Drag outcome is indeterminate");
    expect(result.error).toContain("Failed to dispatch gesture");
  });

  test.each([false, true])("maps a transport throw with dispatched=%s", async (dispatched) => {
    spyOn(iosDragClient, "requestDrag").mockImplementation(async (...args) => {
      if (dispatched) {
        args[10]?.();
      }
      throw new Error("transport disconnected");
    });
    const result = await dragAndDrop.execute({
      source: { elementId: "source-id" },
      target: { elementId: "target-id" },
    });
    expect(result.success).toBe(false);
    if (dispatched) {
      expect(result.error).toContain("Drag outcome is indeterminate");
      expect(result.error).toContain("transport disconnected");
    } else {
      expect(result.error).toBe("Failed to perform drag and drop: transport disconnected");
    }
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
    expect(syncSpy).toHaveBeenCalledWith(
      expect.anything(),
      false,
      undefined,
      15000,
      expect.any(Object),
      undefined,
    );
  });

  test("drags against the freshly-refreshed hierarchy, not the stale observe cache", async () => {
    // The cached observe places the elements at (50,50)/(250,250); the fresh runner
    // snapshot reports new coordinates after the UI scrolled. The drag must use the fresh ones.
    const freshHierarchy = {
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
    } as any;
    fakeIosClient.setHierarchyData(freshHierarchy);
    fakeIosClient.setViewHierarchyResult(freshHierarchy);
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

  test("rejects a failed fresh capture without dragging cached coordinates", async () => {
    spyOn(fakeIosClient, "requestHierarchySync").mockResolvedValue(null);
    fakeIosClient.setDragResult({ success: true, totalTimeMs: 1, gestureTimeMs: 1 });
    const result = await dragAndDrop.execute({
      source: { elementId: "source-id" },
      target: { elementId: "target-id" },
    });
    expect(result.success).toBe(false);
    expect(fakeIosClient.getDragHistory()).toHaveLength(0);
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
