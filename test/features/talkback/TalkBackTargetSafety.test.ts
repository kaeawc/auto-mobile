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

describe("TalkBack selected target safety", () => {
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
