import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { describe, expect, test, spyOn } from "bun:test";
import { TalkBackTapStrategy } from "../../../src/features/talkback/TalkBackTapStrategy";
import { FocusNavigationExecutor } from "../../../src/features/talkback/FocusNavigationExecutor";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { ActionableError } from "../../../src/models/ActionableError";
import { StaleDisplayError } from "../../../src/models/StaleDisplayError";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { HierarchyTalkBackDriver } from "./HierarchyTalkBackDriver";
import { notificationHierarchy, notificationRows } from "./capturedNotificationTargets";
import type { Element } from "../../../src/models/Element";

const device = { name: "test-device", platform: "android" as const, deviceId: "emulator-5554" };

function harness() {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const driver = new HierarchyTalkBackDriver();
  const executor = new FocusNavigationExecutor({
    timer,
    deviceResolver: () => device,
    driverFactory: { createDriver: () => driver },
  });
  const strategy = new TalkBackTapStrategy({ timer, executor });
  const detector = new FakeAccessibilityDetector();
  detector.setTalkBackEnabled(true);
  const tap = new TapOnElement(device, null, {
    timer,
    accessibilityDetector: detector,
    talkBackStrategy: strategy,
    talkBackDriverFactory: { createDriver: () => driver },
  });
  return { driver, executor, strategy, tap };
}

function navigationHarness() {
  const setup = harness();
  const start = {
    "resource-id": "app:id/start",
    text: "Start",
    bounds: { left: 0, top: 0, right: 100, bottom: 100 },
  };
  const target = {
    "resource-id": "app:id/target",
    text: "Target",
    bounds: { left: 0, top: 400, right: 100, bottom: 500 },
  };
  setup.driver.setElements([start, { text: "Middle 1" }, { text: "Middle 2" }, target], 0);
  return { ...setup, start, target };
}

function shiftedRows(): Element[] {
  return notificationRows.slice(1, 3).map((row) => ({
    ...row,
    bounds: { ...row.bounds!, top: row.bounds!.top - 20, bottom: row.bounds!.bottom - 20 },
  }));
}

describe("TalkBack selected target safety", () => {
  test.each(["strategy", "tapOn"])(
    "a target that vanishes after the focus request rejects through %s",
    async (caller) => {
      const { driver, strategy, tap, start, target } = navigationHarness();
      driver.onFocusAction = () => driver.setElements([start], 0);
      const result =
        caller === "strategy"
          ? strategy.executeTap(device.deviceId, target, driver)
          : tap.executeAndroidTap("tap", 50, 450, 500, target, undefined, {
              screenReaderNavigation: true,
            });
      await expect(result).rejects.toThrow("The screen changed while moving the TalkBack cursor");
      expect(driver.getFocusRequestCount()).toBe(1);
      expect(driver.tapHistory).toEqual([]);
      expect(driver.doubleTapHistory).toEqual([]);
    },
  );

  test("a refused focus action rejects and sends no tap", async () => {
    const { driver, strategy, target } = navigationHarness();
    driver.focusResult = {
      success: false,
      action: "focus",
      totalTimeMs: 1,
      error: "Accessibility action is unavailable: focus",
    };
    await expect(strategy.executeTap(device.deviceId, target, driver)).rejects.toThrow(
      "Could not move the TalkBack cursor onto the target: Accessibility action is unavailable: focus",
    );
    expect(driver.getFocusRequestCount()).toBe(1);
    expect(driver.tapHistory).toEqual([]);
    expect(driver.doubleTapHistory).toEqual([]);
  });

  test("a focus action the cursor never followed rejects with no fallback tap", async () => {
    const { driver, strategy, target } = navigationHarness();
    driver.autoFocusOnAction = false;
    await expect(strategy.executeTap(device.deviceId, target, driver)).rejects.toThrow(
      "did not move onto the target",
    );
    expect(driver.getFocusRequestCount()).toBe(1);
    expect(driver.tapHistory).toEqual([]);
    expect(driver.doubleTapHistory).toEqual([]);
  });

  test("an unreadable screen after the focus request rejects with no fallback tap", async () => {
    const { driver, strategy, target } = navigationHarness();
    driver.onFocusAction = () =>
      driver.queueTraversalResult({
        elements: [],
        focusedIndex: null,
        totalCount: 0,
        totalTimeMs: 1,
        error: "unavailable",
      });
    await expect(strategy.executeTap(device.deviceId, target, driver)).rejects.toThrow(
      "Failed to get traversal order: unavailable",
    );
    expect(driver.tapHistory).toEqual([]);
    expect(driver.doubleTapHistory).toEqual([]);
  });

  test("the app's pager changing under the cursor fails tapOn and never taps the old coordinates (#10209)", async () => {
    const { driver, tap, target } = navigationHarness();
    driver.autoFocusOnAction = false;
    // What the device did: the "navigation" scrolled the pager, so the next page's nodes are
    // on screen while the cursor still sits where it was.
    driver.onFocusAction = () =>
      driver.setElements(
        [
          {
            "resource-id": "app:id/start",
            text: "Slides",
            bounds: { left: 0, top: 0, right: 1, bottom: 1 },
          },
          { text: "AutoMobile", bounds: { left: 0, top: 100, right: 100, bottom: 200 } },
        ],
        0,
      );
    await expect(
      tap.executeAndroidTap("tap", 50, 450, 500, target, undefined, {
        screenReaderNavigation: true,
      }),
    ).rejects.toThrow("The screen changed while moving the TalkBack cursor");
    expect(driver.tapHistory).toEqual([]);
    expect(driver.doubleTapHistory).toEqual([]);
  });

  test("a navigation failure typed as a plain ActionableError rejects instead of falling back", async () => {
    const { driver, executor, strategy, target } = navigationHarness();
    spyOn(executor, "navigateToElement").mockRejectedValue(
      new ActionableError("Target element disappeared during navigation"),
    );
    await expect(strategy.executeTap(device.deviceId, target, driver)).rejects.toBeInstanceOf(
      ActionableError,
    );
    expect(driver.tapHistory).toEqual([]);
  });

  test.each(["Target requires 5 additional steps", "Unknown navigation failure"])(
    "typed failure after the focus request rejects: %s",
    async (message) => {
      const { driver, executor, strategy, target } = navigationHarness();
      const navigate = executor.navigateToElement.bind(executor);
      spyOn(executor, "navigateToElement").mockImplementation(async (...args) => {
        await navigate(...args);
        throw new ActionableError(message);
      });
      await expect(strategy.executeTap(device.deviceId, target, driver)).rejects.toThrow(message);
      expect(driver.getFocusRequestCount()).toBe(1);
      expect(driver.tapHistory).toEqual([]);
    },
  );

  test("a navigation that reports it did not reach the target rejects", async () => {
    const { driver, executor, strategy, target } = navigationHarness();
    spyOn(executor, "navigateToElement").mockResolvedValue(false);
    await expect(strategy.executeTap(device.deviceId, target, driver)).rejects.toThrow(
      "Focus navigation did not reach target element",
    );
    expect(driver.tapHistory).toEqual([]);
  });

  test("a target absent from the traversal before any request still permits fallback", async () => {
    const { driver, strategy, start, target } = navigationHarness();
    driver.setElements([start], 0);
    expect(await strategy.executeTap(device.deviceId, target, driver)).toMatchObject({
      success: false,
      error: expect.stringContaining("Target not found in the accessibility traversal"),
      screenReaderNavigation: { reachable: false, focusTrapDetected: false },
    });
    expect(driver.getFocusRequestCount()).toBe(0);
    expect(driver.tapHistory).toEqual([]);
  });

  test("an addressable target is activated with one double tap and no other tap or click (#10144)", async () => {
    const { driver, strategy } = harness();
    const first = {
      "resource-id": "app:id/first",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
    };
    const second = {
      "resource-id": "app:id/second",
      bounds: { left: 0, top: 200, right: 100, bottom: 300 },
    };
    driver.setElements([first, second], 0);
    expect(await strategy.executeTap(device.deviceId, second, driver)).toMatchObject({
      success: true,
      method: "focus-navigation",
      screenReaderNavigation: { reachable: true, traversalOrder: [first, second] },
    });
    expect(driver.focusHistory).toEqual([
      { action: "focus", resourceId: "app:id/second", selector: undefined },
    ]);
    expect(driver.doubleTapHistory).toEqual([{ x: 50, y: 250 }]);
    expect(driver.tapHistory).toEqual([]);
    expect(driver.actionHistory).toEqual([]);
  });

  test("shifted duplicate activation uses live bounds after navigation", async () => {
    const { driver, executor, strategy } = harness();
    const rows = notificationRows.slice(1, 3);
    const live = shiftedRows();
    driver.setElements(rows, 0);
    spyOn(executor, "navigateToElement").mockImplementation(async (_device, _selector, options) => {
      driver.setElements(live, 1);
      options?.onFocusObserved?.(live[1], live);
      return true;
    });
    expect(await strategy.executeTap(device.deviceId, rows[1], driver)).toMatchObject({
      success: true,
    });
    const bounds = live[1].bounds!;
    expect(driver.doubleTapHistory).toEqual([
      {
        x: Math.round((bounds.left + bounds.right) / 2),
        y: Math.round((bounds.top + bounds.bottom) / 2),
      },
    ]);
    expect(driver.tapHistory).toEqual([]);
  });

  test("a resource-id shared by duplicate rows cannot take a focus action, so nothing is sent", async () => {
    const { driver, strategy } = harness();
    const first = {
      "resource-id": "app:id/row",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
    };
    const second = {
      "resource-id": "app:id/row",
      bounds: { left: 0, top: 200, right: 100, bottom: 300 },
    };
    driver.setElements([first, second], 0);
    expect(await strategy.executeTap(device.deviceId, second, driver)).toMatchObject({
      success: false,
      error: expect.stringContaining("shared by 2 elements"),
    });
    expect(driver.getFocusRequestCount()).toBe(0);
    expect(driver.tapHistory).toEqual([]);
    expect(driver.doubleTapHistory).toEqual([]);
  });

  test("fresh traversal still rejects focus on the wrong same-id sibling", async () => {
    const { driver, executor, strategy } = harness();
    const rows = notificationRows.slice(1, 3);
    driver.setElements(rows, 0);
    const traversal = spyOn(driver, "requestTraversalOrder");
    spyOn(executor, "navigateToElement").mockImplementation(async () => {
      driver.setElements(shiftedRows(), 0);
      return true;
    });
    await expect(strategy.executeTap(device.deviceId, rows[1], driver)).rejects.toThrow(
      "focus no longer matches",
    );
    expect(traversal).toHaveBeenCalledTimes(1);
    expect(driver.tapHistory).toEqual([]);
  });

  test.each(["error", "empty", "throw"])(
    "ambiguous activation fails closed on fresh traversal %s",
    async (failure) => {
      const { driver, executor, strategy } = harness();
      const rows = notificationRows.slice(1, 3);
      driver.setElements(rows, 1);
      spyOn(executor, "navigateToElement").mockImplementation(
        async (_device, _selector, options) => {
          options?.onFocusObserved?.(rows[1], rows);
          if (failure === "throw") {
            spyOn(driver, "requestTraversalOrder").mockRejectedValue(new Error("unavailable"));
          } else {
            driver.queueTraversalResult({
              elements: [],
              totalTimeMs: 1,
              ...(failure === "error" ? { error: "unavailable" } : {}),
            });
          }
          return true;
        },
      );
      await expect(strategy.executeTap(device.deviceId, rows[1], driver)).rejects.toThrow(
        "Cannot verify the selected TalkBack activation target",
      );
      expect(driver.tapHistory).toEqual([]);
    },
  );

  test.each(["error", "empty", "throw"])(
    "unique activation accepts live focus on fresh traversal %s",
    async (failure) => {
      const { driver, executor, strategy } = harness();
      const rows = notificationRows.slice(2, 3);
      const live = shiftedRows()[1];
      driver.setElements(rows, 0);
      spyOn(executor, "navigateToElement").mockImplementation(
        async (_device, _selector, options) => {
          driver.setElements([live], 0);
          options?.onFocusObserved?.(live, rows);
          if (failure === "throw") {
            spyOn(driver, "requestTraversalOrder").mockRejectedValue(new Error("unavailable"));
          } else {
            driver.queueTraversalResult({
              elements: [],
              totalTimeMs: 1,
              ...(failure === "error" ? { error: "unavailable" } : {}),
            });
          }
          return true;
        },
      );
      expect(await strategy.executeTap(device.deviceId, rows[0], driver)).toMatchObject({
        success: true,
      });
      expect(driver.doubleTapHistory).toHaveLength(1);
      expect(driver.tapHistory).toEqual([]);
    },
  );
  test.each(["tap", "longPress"] as const)(
    "duplicate row %s uses its own coordinates",
    async (action) => {
      const { driver, tap } = harness();
      driver.hierarchy = notificationHierarchy;
      expect(notificationRows.length).toBeGreaterThan(1);
      const element = notificationRows[1];
      const bounds = element.bounds!;
      const x = Math.round((bounds.left + bounds.right) / 2);
      const y = Math.round((bounds.top + bounds.bottom) / 2);
      await tap.executeAndroidTap(action, x, y, 800, element);
      expect(driver.actionHistory).toEqual([]);
      expect(driver.tapHistory).toEqual([{ x, y, durationMs: action === "tap" ? 50 : 800 }]);
      expect(driver.doubleTapHistory).toEqual(action === "tap" ? [{ x, y }] : []);
    },
  );

  test("direct activation reports the shared native ID before sending", async () => {
    const { driver, strategy } = harness();
    driver.hierarchy = notificationHierarchy;
    const result = await strategy.executeDirectActivation(notificationRows[1], driver);
    expect(result.success).toBe(false);
    expect(result.error).toContain(`shared by ${notificationRows.length} elements`);
    expect(driver.actionHistory).toEqual([]);
  });

  test.each(["click", "long_click"])(
    "duplicate row with a test tag retains %s selector dispatch",
    async (action) => {
      const { driver, strategy } = harness();
      driver.hierarchy = notificationHierarchy;
      const element = { ...notificationRows[1], "test-tag": "second-notification" };
      const result =
        action === "click"
          ? await strategy.executeDirectActivation(element, driver)
          : await strategy.executeLongPress(540, 1500, 800, element, driver);
      expect(result.success).toBe(true);
      expect(driver.actionHistory).toEqual([
        {
          action,
          selector: {
            resourceId: element["resource-id"],
            testTag: "second-notification",
          },
        },
      ]);
    },
  );

  test("a target the runner cannot address by selector returns evidence and the consumer runs the precise fallback", async () => {
    const { driver, strategy, tap } = harness();
    const start = { text: "Start", bounds: { left: 0, top: 0, right: 100, bottom: 100 } };
    const target = { text: "Target", bounds: { left: 0, top: 200, right: 100, bottom: 300 } };
    driver.setElements([start, { text: "Middle 1" }, { text: "Middle 2" }, target], 0);
    const navigation = spyOn(strategy, "executeTap");
    await tap.executeAndroidTap("tap", 50, 250, 500, target, undefined, {
      screenReaderNavigation: true,
    });
    const result = await navigation.mock.results[0].value;
    expect(result).toMatchObject({
      success: false,
      method: "focus-navigation",
      screenReaderNavigation: {
        reachable: false,
        focusTrapDetected: false,
        traversalOrder: [start],
      },
    });
    // Nothing moved the cursor or the screen, so the original coordinates are still current.
    expect(driver.getFocusRequestCount()).toBe(0);
    expect(driver.tapHistory).toEqual([{ x: 50, y: 250, durationMs: 50 }]);
    expect(driver.doubleTapHistory).toEqual([{ x: 50, y: 250 }]);
  });

  test.each([
    new Error("unexpected bug"),
    new StaleDisplayError({ observedGeneration: 1, currentGeneration: 2, retry: "observe" }),
  ])("unrelated error propagates: %s", async (error) => {
    const { driver, executor, strategy } = harness();
    const element = { text: "Target" };
    driver.setElements([element], 0);
    spyOn(executor, "navigateToElement").mockRejectedValue(error);
    await expect(strategy.executeTap(device.deviceId, element, driver)).rejects.toBe(error);
    expect(driver.tapHistory).toEqual([]);
  });

  test("activation refuses a different duplicate even after navigation reports success", async () => {
    const { driver, executor, strategy } = harness();
    const first = {
      "resource-id": "app:id/row",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
    };
    const second = {
      "resource-id": "app:id/row",
      bounds: { left: 0, top: 200, right: 100, bottom: 300 },
    };
    driver.setElements([first, second], 0);
    spyOn(executor, "navigateToElement").mockResolvedValue(true);
    await expect(strategy.executeTap(device.deviceId, second, driver)).rejects.toThrow(
      "focus no longer matches the selected activation target",
    );
    expect(driver.tapHistory).toEqual([]);
    expect(driver.actionHistory).toEqual([]);
  });

  test("a target that already holds the cursor needs no focus request", async () => {
    const { driver, strategy } = harness();
    const element = { text: "Target", bounds: { left: 0, top: 0, right: 100, bottom: 100 } };
    driver.setElements([element], 0);
    // The target already holds the cursor: no request is needed, only the activation.
    expect(await strategy.executeTap(device.deviceId, element, driver)).toMatchObject({
      success: true,
      screenReaderNavigation: { reachable: true, traversalOrder: [element] },
    });
    expect(driver.getFocusRequestCount()).toBe(0);
  });
});

describe("TalkBack newer full hierarchy contradicts selected target", () => {
  test.each(["tap", "longPress"] as const)(
    "%s refuses stale duplicate-ID coordinates",
    async (action) => {
      const { driver, tap } = harness();
      const selected = {
        text: "Photos",
        "resource-id": "android:id/title",
        bounds: { left: 0, top: 1500, right: 300, bottom: 1600 },
      };
      driver.setElements([
        { ...selected, text: "Apps", bounds: { left: 0, top: 300, right: 300, bottom: 400 } },
        {
          ...selected,
          text: "Notifications",
          bounds: { left: 0, top: 500, right: 300, bottom: 600 },
        },
      ]);
      await expect(
        tap.executeAndroidTap(action, 150, 1550, 500, selected, undefined, { action }),
      ).rejects.toThrow("Selected element moved or is gone");
      expect(driver.tapHistory).toEqual([]);
      expect(driver.doubleTapHistory).toEqual([]);
      expect(driver.actionHistory).toEqual([]);
    },
  );
});

describe("TalkBack selected node identity and bounds", () => {
  test.each(["moved", "relabelled", "absent-id"])(
    "refuses %s target before semantic action",
    async (change) => {
      const { driver, strategy } = harness();
      const selected: Element = {
        text: "Apps",
        "resource-id": "android:id/title",
        bounds: { left: 0, top: 300, right: 300, bottom: 400 },
      };
      driver.setElements([
        {
          ...selected,
          ...(change === "moved" ? { bounds: { left: 0, top: 500, right: 300, bottom: 600 } } : {}),
          ...(change === "relabelled" ? { text: "Photos" } : {}),
          ...(change === "absent-id" ? { "resource-id": "other:id/title" } : {}),
        },
      ]);
      await expect(strategy.executeDirectActivation(selected, driver)).rejects.toThrow(
        "Selected element moved or is gone",
      );
      expect(driver.actionHistory).toEqual([]);
      expect(driver.tapHistory).toEqual([]);
    },
  );
});

describe("TalkBack re-resolution before native dispatch", () => {
  test.each(["tap", "longPress"])(
    "%s follows the original indexed selector at current bounds",
    async (action) => {
      const { tap, driver } = harness();
      const old = notificationRows[2];
      const live = {
        ...old,
        bounds: { ...old.bounds!, top: old.bounds!.top + 1, bottom: old.bounds!.bottom + 1 },
      };
      driver.setElements([notificationRows[1], live]);
      const result = await tap.executeAndroidTap(action, 1, 1, 500, old, undefined, {
        elementId: old["resource-id"],
        index: 1,
        action,
      });
      expect(result).toBeUndefined();
      expect(driver.actionHistory).toEqual([]);
      const bounds = live.bounds!;
      expect(driver.tapHistory[0]).toMatchObject({
        x: Math.round((bounds.left + bounds.right) / 2),
        y: Math.round((bounds.top + bounds.bottom) / 2),
      });
    },
  );

  test("index resolving to another labelled row refuses every fallback", async () => {
    const { tap, driver } = harness();
    const old = { ...notificationRows[2], text: "Selected notification" };
    driver.setElements([old, { ...notificationRows[1], text: "Another notification" }]);
    await expect(
      tap.executeAndroidTap("longPress", 1, 1, 500, old, undefined, {
        elementId: old["resource-id"],
        index: 1,
        action: "longPress",
      }),
    ).rejects.toThrow("selector now resolves to a different element");
    expect(driver.actionHistory).toEqual([]);
    expect(driver.tapHistory).toEqual([]);
  });
});

describe("TalkBack resolved result and fallback coordinates", () => {
  test.each([false, true])(
    "click rejection keeps the re-resolved bounds for fallback (ADB=%s)",
    async (adbFallback) => {
      const { tap, driver, strategy } = harness();
      const selected: Element = {
        text: "Apps",
        "resource-id": "android:id/title",
        clickable: true,
        bounds: { left: 0, top: 300, right: 300, bottom: 400 },
      };
      const moved = { ...selected, bounds: { left: 0, top: 301, right: 300, bottom: 401 } };
      driver.setElements([moved]);
      driver.setActionResult({ success: false, action: "click", error: "unsupported" });
      if (adbFallback) {
        driver.setTapResult({ success: false, error: "unavailable" });
      }
      const fallbackPoints: { x: number; y: number }[] = [];
      tap["executeAndroidTapWithCoordinates"] = async (_action, x, y) => {
        fallbackPoints.push({ x, y });
      };
      const direct = spyOn(strategy, "executeDirectActivation");
      let reported: Element | undefined;
      let reportedMatches: number | undefined;
      await tap.executeAndroidTap("tap", 150, 350, 500, selected, undefined, {
        action: "tap",
        text: "Apps",
        onResolvedElement: (current, selection) => {
          reported = current;
          reportedMatches = selection?.totalMatches;
        },
      });
      expect(reported?.bounds).toEqual(moved.bounds);
      expect(reportedMatches).toBe(1);
      expect((await direct.mock.results[0].value).element?.bounds).toEqual(moved.bounds);
      expect(driver.tapHistory[0]).toMatchObject({ x: 150, y: 351 });
      expect(fallbackPoints).toEqual(adbFallback ? [{ x: 150, y: 351 }] : []);
    },
  );

  test("an ambiguous original unique selector refuses with a recovery step", async () => {
    const { driver } = harness();
    const selected: Element = {
      text: "Apps",
      "resource-id": "android:id/title",
      clickable: true,
      bounds: { left: 0, top: 300, right: 300, bottom: 400 },
    };
    driver.setElements([
      { ...selected, bounds: { left: 0, top: 301, right: 300, bottom: 401 } },
      { ...selected, bounds: { left: 0, top: 501, right: 300, bottom: 601 } },
    ]);
    // Exercise the same unique resolver at the strategy seam: scoped tool
    // dispatch itself deliberately bypasses global native-ID activation.
    const selector = new ResolverElementSelector();
    await expect(
      new TalkBackTapStrategy().executeDirectActivation(selected, driver, {
        reResolve: (hierarchy) =>
          selector.selectByText(hierarchy, "Apps", { strategy: "unique", intentAction: "tap" })
            .element,
      }),
    ).rejects.toThrow("original selector cannot resolve unambiguously");
    expect(driver.actionHistory).toEqual([]);
    expect(driver.tapHistory).toEqual([]);
  });
});
