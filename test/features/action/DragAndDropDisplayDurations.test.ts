import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DragAndDrop } from "../../../src/features/action/DragAndDrop";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { StaleDisplayError } from "../../../src/models/StaleDisplayError";
import { throwIfAborted } from "../../../src/utils/toolUtils";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import type { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";

const device = {
  deviceId: "drag-display-durations",
  platform: "android",
  name: "Android",
  displays: {
    panels: [
      { key: "internal", role: "inner", sizePx: { width: 100, height: 100 } },
      { key: "external", role: "external", sizePx: { width: 200, height: 200 } },
    ],
    postures: [],
  },
} as BootedDevice;

function fixture(options: { supportsDisplay: boolean; display?: string }) {
  displayTransitions.reset(device.deviceId);
  const adb = new FakeAdbClient();
  adb.setCommandResult(
    "shell cmd display get-displays",
    'Display id 0: DisplayInfo{uniqueId "local:internal" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
  );
  const hierarchy: ViewHierarchyResult = {
    displayId: options.display === "external" ? 2 : 0,
    screenWidth: 200,
    screenHeight: 200,
    hierarchy: {
      node: [
        { $: { text: "Source", bounds: { left: 20, top: 30, right: 80, bottom: 50 } } },
        { $: { text: "Target", bounds: { left: 120, top: 130, right: 180, bottom: 150 } } },
      ],
    },
  };
  const observation: ObserveResult = {
    observationId: "drag-display-observation",
    timestamp: 1,
    displayRevision: 0,
    display: {
      key: options.display ?? "internal",
      role: options.display === "external" ? "external" : "inner",
      posture: "unknown",
      generation: 1,
    },
    screenSize: { width: 200, height: 200 },
    rotation: 0,
    systemInsets: { left: 0, top: 0, right: 0, bottom: 0 },
    viewHierarchy: hierarchy,
  };
  const observe = new FakeObserveScreen();
  observe.setObserveResult(observation);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const action = new DragAndDrop(device, adb as unknown as AdbClient, timer, {
    lastRenderedObservation: () => observation,
    hierarchyCapture: new FakeHierarchyCapture(() => hierarchy),
  });
  action.observeScreen = observe;
  const client = AndroidCtrlProxyClient.getExistingInstance(device.deviceId)!;
  const capability = spyOn(client, "supportsCommand").mockResolvedValue(options.supportsDisplay);
  const drag = spyOn(client, "requestDrag").mockResolvedValue({ success: true, totalTimeMs: 0 });
  const invalidate = spyOn(client, "invalidateCache").mockImplementation(() => {});
  const available = spyOn(AndroidCtrlProxyManager.prototype, "isAvailable").mockResolvedValue(true);
  restorers.push(() => {
    capability.mockRestore();
    drag.mockRestore();
    invalidate.mockRestore();
    available.mockRestore();
    AndroidCtrlProxyClient.removeInstance(device.deviceId);
    displayTransitions.reset(device.deviceId);
  });
  return { action, adb, drag, capability, observe, observation, invalidate };
}

const restorers: Array<() => void> = [];
afterEach(() => {
  for (const restore of restorers.splice(0).reverse()) {
    restore();
  }
});

const endpoints = { source: { text: "Source" }, target: { text: "Target" } };

describe("dragAndDrop Android explicit-display cancellation", () => {
  test("rethrows abort during display preflight without checking capabilities or dragging", async () => {
    const { action, adb, drag, capability, observe, observation } = fixture({
      supportsDisplay: true,
      display: "external",
    });
    const controller = new AbortController();
    const preflight = spyOn(observe, "execute").mockImplementation(async (options) => {
      expect(options).toMatchObject({ display: "external", signal: controller.signal });
      controller.abort();
      throwIfAborted(options?.signal);
      return observation;
    });
    restorers.push(() => preflight.mockRestore());

    await expect(
      action.execute({ ...endpoints, display: "external" }, undefined, controller.signal),
    ).rejects.toThrow("Operation cancelled");
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(capability).not.toHaveBeenCalled();
    expect(drag).not.toHaveBeenCalled();
    expect(adb.getAllCommands()).toEqual([]);
  });

  test("rethrows abort during the capability check without dispatching a drag", async () => {
    const { action, adb, drag, capability, observe, invalidate } = fixture({
      supportsDisplay: true,
      display: "external",
    });
    const controller = new AbortController();
    capability.mockImplementation(async () => {
      controller.abort();
      return true;
    });

    await expect(
      action.execute({ ...endpoints, display: "external" }, undefined, controller.signal),
    ).rejects.toThrow("Operation cancelled");
    expect(capability).toHaveBeenCalledWith("gesture_display_id_v1");
    expect(drag).not.toHaveBeenCalled();
    expect(adb.wasCommandExecuted("touchscreen")).toBe(false);
    expect(observe.getExecuteCallCount()).toBe(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  test.each(["returns failure", "rejects"] as const)(
    "rethrows abort when the drag request %s without observing afterward",
    async (reply) => {
      const { action, adb, drag, observe, invalidate } = fixture({
        supportsDisplay: true,
        display: "external",
      });
      const controller = new AbortController();
      drag.mockImplementation(async (...args) => {
        expect(args[9]).toBe(controller.signal);
        expect(args[10]).toBe(2);
        controller.abort();
        if (reply === "rejects") {
          throw new Error("Drag request cancelled");
        }
        return { success: false, totalTimeMs: 0, error: "Drag request cancelled" };
      });

      await expect(
        action.execute({ ...endpoints, display: "external" }, undefined, controller.signal),
      ).rejects.toThrow("Operation cancelled");
      expect(drag).toHaveBeenCalledTimes(1);
      expect(adb.wasCommandExecuted("touchscreen")).toBe(false);
      expect(observe.getExecuteCallCount()).toBe(1);
      expect(invalidate).not.toHaveBeenCalled();
    },
  );

  test("rethrows abort forwarded to the adb fallback without observing afterward", async () => {
    const { action, adb, drag, observe, invalidate } = fixture({
      supportsDisplay: false,
      display: "external",
    });
    const controller = new AbortController();
    const input = spyOn(adb, "execute").mockImplementation(async (args, options) => {
      expect(args).toEqual(["shell", "input touchscreen -d 2 draganddrop 50 40 150 140 300"]);
      expect(options?.signal).toBe(controller.signal);
      await options?.beforeDispatch?.(options.timeoutMs);
      controller.abort();
      throw new Error("adb request cancelled");
    });
    restorers.push(() => input.mockRestore());

    await expect(
      action.execute({ ...endpoints, display: "external" }, undefined, controller.signal),
    ).rejects.toThrow("Operation cancelled");
    expect(input).toHaveBeenCalledTimes(1);
    expect(drag).not.toHaveBeenCalled();
    expect(observe.getExecuteCallCount()).toBe(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  test("preserves a non-aborted drag failure", async () => {
    const { action, drag, observe, invalidate } = fixture({
      supportsDisplay: true,
      display: "external",
    });
    const controller = new AbortController();
    drag.mockResolvedValue({ success: false, totalTimeMs: 0, error: "boom" });

    const result = await action.execute(
      { ...endpoints, display: "external" },
      undefined,
      controller.signal,
    );
    expect(controller.signal.aborted).toBe(false);
    expect(result).toEqual({ success: false, duration: 0, distance: 0, error: "boom" });
    expect(drag).toHaveBeenCalledTimes(1);
    expect(observe.getExecuteCallCount()).toBe(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  test("preserves stale-display details for a non-aborted failure", async () => {
    const { action, adb, drag, capability } = fixture({
      supportsDisplay: true,
      display: "external",
    });
    const controller = new AbortController();
    const stale = new StaleDisplayError({
      observedGeneration: 1,
      currentGeneration: 2,
      currentDisplayKey: "internal",
      retry: "observe",
    });
    capability.mockRejectedValue(stale);

    const result = await action.execute(
      { ...endpoints, display: "external" },
      undefined,
      controller.signal,
    );
    expect(controller.signal.aborted).toBe(false);
    expect(result).toEqual({
      success: false,
      duration: 0,
      distance: 0,
      error: stale.message,
      staleDisplay: stale.details,
    });
    expect(drag).not.toHaveBeenCalled();
    expect(adb.wasCommandExecuted("touchscreen")).toBe(false);
  });
});

describe("dragAndDrop display durations", () => {
  test("adb external display rounds a fractional drag duration", async () => {
    const { action, adb } = fixture({ supportsDisplay: false, display: "external" });
    const result = await action.execute({
      ...endpoints,
      display: "external",
      dragDurationMs: 500.5,
    });
    expect(result.success).toBe(true);
    expect(adb.getAllCommands()).toContain(
      "shell input touchscreen -d 2 draganddrop 50 40 150 140 501",
    );
  });
  for (const display of [undefined, "external"]) {
    test(`CtrlProxy ${display ?? "default"} display uses the documented default durations`, async () => {
      const { action, adb, drag } = fixture({ supportsDisplay: true, display });
      const result = await action.execute({ ...endpoints, display });
      expect(result.success).toBe(true);
      expect(result.duration).toBe(300);
      expect(drag).toHaveBeenCalledTimes(1);
      expect(drag.mock.calls[0]?.slice(4, 7)).toEqual([600, 300, 100]);
      expect(adb.wasCommandExecuted("touchscreen")).toBe(false);
    });
  }

  for (const durations of [
    { pressDurationMs: 700 },
    { holdDurationMs: 200 },
    { pressDurationMs: 800, holdDurationMs: 250, dragDurationMs: 500 },
  ]) {
    test(`CtrlProxy external display forwards ${JSON.stringify(durations)}`, async () => {
      const { action, adb, drag, capability } = fixture({
        supportsDisplay: true,
        display: "external",
      });
      const result = await action.execute({ ...endpoints, display: "external", ...durations });
      expect(result.success).toBe(true);
      expect(capability).toHaveBeenCalledWith("gesture_display_id_v1");
      expect(drag).toHaveBeenCalledTimes(1);
      expect(drag.mock.calls[0]).toEqual([
        50,
        40,
        150,
        140,
        durations.pressDurationMs ?? 600,
        durations.dragDurationMs ?? 300,
        durations.holdDurationMs ?? 100,
        expect.any(Number),
        undefined,
        undefined,
        2,
        expect.any(Function),
      ]);
      expect(adb.wasCommandExecuted("touchscreen")).toBe(false);
    });
  }

  for (const durations of [{ pressDurationMs: 700 }, { holdDurationMs: 200 }]) {
    test(`adb external display refuses ${JSON.stringify(durations)}`, async () => {
      const { action, adb, drag } = fixture({ supportsDisplay: false, display: "external" });
      const result = await action.execute({ ...endpoints, display: "external", ...durations });
      expect(result.success).toBe(false);
      expect(result.error).toContain("gesture_display_id_v1");
      expect(result.error).toContain("display 2");
      expect(result.error).toContain("CtrlProxy");
      expect(drag).not.toHaveBeenCalled();
      expect(adb.wasCommandExecuted("touchscreen")).toBe(false);
    });
  }

  test("adb external display keeps the default drag duration", async () => {
    const { action, adb, drag } = fixture({ supportsDisplay: false, display: "external" });
    const result = await action.execute({ ...endpoints, display: "external" });
    expect(result.success).toBe(true);
    expect(drag).not.toHaveBeenCalled();
    expect(adb.getAllCommands()).toContain(
      "shell input touchscreen -d 2 draganddrop 50 40 150 140 300",
    );
  });

  test("adb external display forwards an explicit drag duration", async () => {
    const { action, adb, drag } = fixture({ supportsDisplay: false, display: "external" });
    const result = await action.execute({ ...endpoints, display: "external", dragDurationMs: 500 });
    expect(result.success).toBe(true);
    expect(result.duration).toBe(500);
    expect(drag).not.toHaveBeenCalled();
    expect(adb.getAllCommands()).toContain(
      "shell input touchscreen -d 2 draganddrop 50 40 150 140 500",
    );
  });

  test("ordinary default display forwards explicit durations without a display id", async () => {
    const { action, adb, drag } = fixture({ supportsDisplay: false });
    const result = await action.execute({
      ...endpoints,
      pressDurationMs: 700,
      dragDurationMs: 500,
      holdDurationMs: 200,
    });
    expect(result.success).toBe(true);
    expect(drag).toHaveBeenCalledTimes(1);
    const args = drag.mock.calls[0];
    expect(args?.slice(0, 7)).toEqual([50, 40, 150, 140, 700, 500, 200]);
    expect(args?.[10]).toBeUndefined();
    expect(adb.wasCommandExecuted("touchscreen")).toBe(false);
  });
});
