import { describe, expect, spyOn, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { LONG_PRESS_MAX_MS } from "../../../src/features/action/tapAtGesture";
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
    callback({ viewHierarchy: hierarchy, screenSize: { width: 500, height: 500 } });
  return {
    adb,
    action,
    execute: (duration?: number, signal?: AbortSignal) =>
      action.execute({ text: "ListItem", action: "longPress", duration }, undefined, signal),
  };
}

describe("tapOn long press safety", () => {
  test.each([LONG_PRESS_MAX_MS + 1, LONG_PRESS_MAX_MS + 0.1, Infinity])(
    "rejects duration %s with an actionable error before any adb command",
    async (duration) => {
      const h = harness();
      await expect(h.execute(duration)).rejects.toBeInstanceOf(ActionableError);
      await expect(h.execute(duration)).rejects.toThrow(
        `maximum is ${LONG_PRESS_MAX_MS} ms; requested ${duration} ms`,
      );
      expect(h.adb.getExecutedCommands()).toEqual([]);
    },
  );

  test.each([
    [1500, 1500],
    [LONG_PRESS_MAX_MS, LONG_PRESS_MAX_MS],
    [1, 1],
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
