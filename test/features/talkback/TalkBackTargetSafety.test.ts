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
  const start = { text: "Start", bounds: { left: 0, top: 0, right: 100, bottom: 100 } };
  const target = { text: "Target", bounds: { left: 0, top: 400, right: 100, bottom: 500 } };
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
    "disappeared target after a swipe rejects through %s",
    async (caller) => {
      const { driver, strategy, tap, start, target } = navigationHarness();
      driver.onSwipe = () => driver.setElements([start], 0);
      const result =
        caller === "strategy"
          ? strategy.executeTap(device.deviceId, target, driver)
          : tap.executeAndroidTap("tap", 50, 450, 500, target, undefined, {
              screenReaderNavigation: true,
            });
      await expect(result).rejects.toThrow("Target element disappeared during navigation");
      expect(driver.getSwipeCount()).toBe(1);
      expect(driver.tapHistory).toEqual([]);
      expect(driver.doubleTapHistory).toEqual([]);
    },
  );

  test("swipe failure after an earlier successful swipe rejects", async () => {
    const { driver, strategy, target } = navigationHarness();
    driver.onSwipe = () => {
      if (driver.getSwipeCount() === 2) {
        driver.setSwipeResult({ success: false, totalTimeMs: 1, error: "second swipe failed" });
      }
    };
    await expect(strategy.executeTap(device.deviceId, target, driver)).rejects.toThrow(
      "second swipe failed",
    );
    expect(driver.getSwipeCount()).toBe(2);
    expect(driver.tapHistory).toEqual([]);
  });

  test("disappeared-target error always rejects even before a swipe", async () => {
    const { driver, executor, strategy, target } = navigationHarness();
    spyOn(executor, "navigateToElement").mockRejectedValue(
      new ActionableError("Target element disappeared during navigation"),
    );
    await expect(strategy.executeTap(device.deviceId, target, driver)).rejects.toBeInstanceOf(
      ActionableError,
    );
    expect(driver.getSwipeCount()).toBe(0);
  });

  test.each(["Target requires 5 additional swipes", "Unknown navigation failure"])(
    "typed failure after swipes rejects: %s",
    async (message) => {
      const { driver, executor, strategy, target } = navigationHarness();
      const navigate = executor.navigateToElement.bind(executor);
      spyOn(executor, "navigateToElement").mockImplementation(async (...args) => {
        await navigate(...args);
        throw new ActionableError(message);
      });
      await expect(strategy.executeTap(device.deviceId, target, driver)).rejects.toThrow(message);
      expect(driver.getSwipeCount()).toBe(3);
      expect(driver.tapHistory).toEqual([]);
    },
  );

  test.each([false, true])(
    "false return after swipes rechecks original bounds (moved=%s)",
    async (moved) => {
      const { driver, executor, strategy, target } = navigationHarness();
      const navigate = executor.navigateToElement.bind(executor);
      spyOn(executor, "navigateToElement").mockImplementation(async (...args) => {
        await navigate(...args);
        if (moved) {
          driver.setElements(
            [{ ...target, bounds: { ...target.bounds, top: 380, bottom: 480 } }],
            0,
          );
        }
        return false;
      });
      const result = strategy.executeTap(device.deviceId, target, driver);
      if (moved) {
        await expect(result).rejects.toThrow("focusTrapDetected=true");
      } else {
        expect(await result).toMatchObject({
          success: false,
          screenReaderNavigation: { focusTrapDetected: true },
        });
      }
      expect(driver.getSwipeCount()).toBe(3);
      expect(driver.tapHistory).toEqual([]);
    },
  );

  test("no-movement trap permits fallback only after a fresh unchanged target read", async () => {
    const { driver, strategy, target } = navigationHarness();
    driver.autoAdvanceOnSwipe = false;
    const traversal = spyOn(driver, "requestTraversalOrder");
    expect(await strategy.executeTap(device.deviceId, target, driver)).toMatchObject({
      success: false,
      screenReaderNavigation: { focusTrapDetected: true },
    });
    expect(driver.getSwipeCount()).toBe(3);
    // Initial snapshot, three executor verifications, then fallback safety proof.
    expect(traversal).toHaveBeenCalledTimes(5);
  });

  test("trap after swipes rejects when the target moved and retains trap evidence", async () => {
    const { driver, strategy, target } = navigationHarness();
    driver.autoAdvanceOnSwipe = false;
    driver.onSwipe = () => {
      driver.elements = driver.elements.map((node) =>
        node.text === "Target"
          ? { ...target, bounds: { ...target.bounds, top: 380, bottom: 480 } }
          : node,
      );
    };
    await expect(strategy.executeTap(device.deviceId, target, driver)).rejects.toThrow(
      "focusTrapDetected=true",
    );
    expect(driver.getSwipeCount()).toBe(3);
    expect(driver.tapHistory).toEqual([]);
  });

  test.each(["error", "empty", "throw"])("trap safety read fails closed on %s", async (failure) => {
    const { driver, strategy, target } = navigationHarness();
    driver.autoAdvanceOnSwipe = false;
    const read = driver.requestTraversalOrder.bind(driver);
    let reads = 0;
    spyOn(driver, "requestTraversalOrder").mockImplementation(async () => {
      if (++reads === 5) {
        if (failure === "throw") {
          throw new Error("traversal unavailable");
        }
        return {
          elements: [],
          totalTimeMs: 1,
          ...(failure === "error" ? { error: "unavailable" } : {}),
        };
      }
      return read();
    });
    await expect(strategy.executeTap(device.deviceId, target, driver)).rejects.toThrow(
      "focusTrapDetected=true",
    );
    expect(driver.tapHistory).toEqual([]);
  });

  test("no navigation path before the first swipe still permits fallback", async () => {
    const { driver, strategy, start, target } = navigationHarness();
    driver.setElements([start], 0);
    expect(await strategy.executeTap(device.deviceId, target, driver)).toMatchObject({
      success: false,
      error: "Could not calculate navigation path to target element",
    });
    expect(driver.getSwipeCount()).toBe(0);
  });

  test("shifted duplicate activation uses live bounds after real navigation", async () => {
    const { driver, strategy } = harness();
    const rows = notificationRows.slice(1, 3);
    const live = shiftedRows();
    driver.setElements(rows, 0);
    driver.onSwipe = () => driver.setElements(live, 1);
    expect(await strategy.executeTap(device.deviceId, rows[1], driver)).toMatchObject({
      success: true,
    });
    const bounds = live[1].bounds!;
    expect(driver.tapHistory).toEqual(
      Array.from({ length: 2 }, () => ({
        x: Math.round((bounds.left + bounds.right) / 2),
        y: Math.round((bounds.top + bounds.bottom) / 2),
        durationMs: 50,
      })),
    );
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
    expect(traversal).toHaveBeenCalledTimes(2);
    expect(driver.tapHistory).toEqual([]);
  });

  test.each(["error", "empty", "throw"])(
    "ambiguous activation fails closed on fresh traversal %s",
    async (failure) => {
      const { driver, executor, strategy } = harness();
      const rows = notificationRows.slice(1, 3);
      driver.setElements(rows, 1);
      spyOn(executor, "navigateToElement").mockImplementation(async () => {
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
      });
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
      spyOn(executor, "navigateToElement").mockImplementation(async () => {
        driver.setElements([live], 0);
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
      });
      expect(await strategy.executeTap(device.deviceId, rows[0], driver)).toMatchObject({
        success: true,
      });
      expect(driver.tapHistory).toHaveLength(2);
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

  test("real executor focus trap returns evidence and the consumer runs precise fallback", async () => {
    const { driver, strategy, tap } = harness();
    const start = { text: "Start", bounds: { left: 0, top: 0, right: 100, bottom: 100 } };
    const target = { text: "Target", bounds: { left: 0, top: 200, right: 100, bottom: 300 } };
    driver.setElements([start, { text: "Middle 1" }, { text: "Middle 2" }, target], 0);
    driver.autoAdvanceOnSwipe = false;
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
        focusTrapDetected: true,
        traversalOrder: [start],
      },
    });
    expect(driver.getSwipeCount()).toBeGreaterThan(0);
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

  test("real executor reaches the intended duplicate by bounds and activates it", async () => {
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
      success: true,
      screenReaderNavigation: { reachable: true, traversalOrder: [first, second] },
    });
    expect(driver.tapHistory).toEqual([
      { x: 50, y: 250, durationMs: 50 },
      { x: 50, y: 250, durationMs: 50 },
    ]);
    expect(driver.actionHistory).toEqual([]);
  });

  test("typed caller failure before navigation remains readable", async () => {
    const { driver, executor, strategy } = harness();
    const element = { text: "Target" };
    driver.setElements([element], 0);
    spyOn(executor, "navigateToElement").mockRejectedValue(
      new ActionableError("TalkBack focus navigation is only supported on Android devices."),
    );
    expect(await strategy.executeTap(device.deviceId, element, driver)).toMatchObject({
      success: false,
      error: "TalkBack focus navigation is only supported on Android devices.",
      screenReaderNavigation: {
        reachable: false,
        focusTrapDetected: false,
        traversalOrder: [element],
      },
    });
  });
});
