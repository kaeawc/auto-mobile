import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { describe, expect, spyOn, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { LONG_PRESS_HARD_MAX_MS } from "../../../src/features/action/tapAtGesture";
import { ActionableError } from "../../../src/models/ActionableError";
import type { Element, ViewHierarchyResult } from "../../../src/models";
import { AdbCommandTimeoutError } from "../../../src/utils/android-cmdline-tools/AdbClient";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeScreenshotCapturer } from "../../fakes/FakeScreenshotCapturer";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";

function harness() {
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const element: Element = {
    text: "ListItem",
    clickable: true,
    "hierarchy-source": "uiautomator",
    bounds: { left: 10, top: 20, right: 110, bottom: 70 },
  };
  const hierarchy: ViewHierarchyResult = { hierarchy: { node: element } };
  const action = new TapOnElement(
    { name: "test-device", platform: "android", deviceId: "long-press-bound" },
    adb,
    {
      timer,
      screenshotCapturer: new FakeScreenshotCapturer(),
      visionConfig: {
        enabled: false,
        provider: "claude",
        confidenceThreshold: "high",
        maxCostUsd: 1,
        cacheResults: false,
        cacheTtlMinutes: 60,
      },
      hierarchyCapture: new FakeHierarchyCapture(() => hierarchy),
      accessibilityDetector: new FakeAccessibilityDetector(),
      elementSelector: new FakeElementSelector(element),
    },
  );
  action.observedInteraction = (callback) =>
    callback(
      recordObservationRead({ viewHierarchy: hierarchy, screenSize: { width: 500, height: 500 } }),
    );
  return {
    adb,
    timer,
    action,
    execute: (duration?: number, signal?: AbortSignal, remainingMs?: number) =>
      action.execute(
        { text: "ListItem", action: "longPress", duration },
        undefined,
        signal,
        undefined,
        { requestDeadlineMs: remainingMs === undefined ? undefined : timer.now() + remainingMs },
      ),
  };
}

describe("tapOn long press safety", () => {
  test.each([LONG_PRESS_HARD_MAX_MS + 1, LONG_PRESS_HARD_MAX_MS + 0.5, Infinity])(
    "rejects duration %s with an actionable error before any adb command",
    async (duration) => {
      const h = harness();
      await expect(h.execute(duration)).rejects.toBeInstanceOf(ActionableError);
      await expect(h.execute(duration)).rejects.toThrow(
        `maximum is ${LONG_PRESS_HARD_MAX_MS} ms; requested ${duration} ms`,
      );
      expect(h.adb.getExecutedCommands()).toEqual([]);
    },
  );

  test.each([
    [1500, 1500],
    [LONG_PRESS_HARD_MAX_MS, LONG_PRESS_HARD_MAX_MS],
    [1, 1],
    [200, 200],
    [0, 500],
    [undefined, 500],
  ])("duration %s retains the command and timeout", async (duration, effective) => {
    const h = harness();
    expect((await h.execute(duration)).success).toBe(true);
    expect(h.adb.getCommandCalls()).toEqual([
      expect.objectContaining({
        command: `shell input touchscreen swipe 60 45 60 45 ${effective}`,
        timeoutMs: effective! + 2000,
      }),
    ]);
  });

  test.each([
    [17000, 120000],
    [30000, undefined],
    [20000, 22000],
    [undefined, 120000],
  ])("budget admission accepts duration %s with remaining %s", async (duration, remaining) => {
    const h = harness();
    expect((await h.execute(duration, undefined, remaining)).success).toBe(true);
    expect(h.adb.getCommandCalls()).toEqual([
      expect.objectContaining({
        command: `shell input touchscreen swipe 60 45 60 45 ${duration ?? 500}`,
        timeoutMs: (duration ?? 500) + 2000,
      }),
    ]);
  });

  test.each([5000, 21999])(
    "budget admission rejects before display/observation with %s ms",
    async (remaining) => {
      const h = harness();
      const observe = spyOn(h.action, "observedInteraction");
      const call = h.action.execute(
        { text: "ListItem", action: "longPress", duration: 20000, display: 1 },
        undefined,
        undefined,
        undefined,
        { requestDeadlineMs: h.timer.now() + remaining },
      );
      await expect(call).rejects.toBeInstanceOf(ActionableError);
      await expect(call).rejects.toThrow(
        `longPress duration 20000 ms does not fit the remaining request budget (${remaining} ms; needs 22000 ms including dispatch headroom); the press was not started.`,
      );
      expect(observe).not.toHaveBeenCalled();
      expect(h.adb.getExecutedCommands()).toEqual([]);
    },
  );

  test.each(["touchscreen", "fallback"])(
    "abort during %s hold reports the remaining risk without another dispatch",
    async (path) => {
      const h = harness();
      const controller = new AbortController();
      const executeCommand = h.adb.executeCommand.bind(h.adb);
      const dispatch = spyOn(h.adb, "executeCommand").mockImplementation(async (...args) => {
        await executeCommand(...args);
        if (path === "fallback" && args[0].includes("touchscreen")) {
          throw new Error("touchscreen source unavailable");
        }
        expect(args[4]).toBe(controller.signal);
        controller.abort();
        throw new DOMException("Operation aborted", "AbortError");
      });
      try {
        const result = await h.execute(1500, controller.signal);
        expect(result.success).toBe(false);
        expect(result.error).toContain("press may still be held on the device for up to 1500 ms");
        expect(h.adb.getExecutedCommands()).toEqual(
          path === "touchscreen"
            ? ["shell input touchscreen swipe 60 45 60 45 1500"]
            : [
                "shell input touchscreen swipe 60 45 60 45 1500",
                "shell input swipe 60 45 60 45 1500",
              ],
        );
      } finally {
        dispatch.mockRestore();
      }
    },
  );

  test("an adb timeout does not retry a possibly held press", async () => {
    const h = harness();
    h.adb.setCommandError("touchscreen swipe", new AdbCommandTimeoutError("Command timed out"));
    const result = await h.execute(1500);
    expect(result.success).toBe(false);
    expect(result.error).toContain("press may still be held on the device for up to 1500 ms");
    expect(h.adb.getExecutedCommands()).toEqual(["shell input touchscreen swipe 60 45 60 45 1500"]);
  });
});
