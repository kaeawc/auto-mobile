import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  TALKBACK_ACTIVATION_WARNING,
  TalkBackTapStrategy,
} from "../../../src/features/talkback/TalkBackTapStrategy";
import { FocusNavigationExecutor } from "../../../src/features/talkback/FocusNavigationExecutor";
import type { Element } from "../../../src/models/Element";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { FakeTimer } from "../../fakes/FakeTimer";
import { HierarchyTalkBackDriver } from "./HierarchyTalkBackDriver";

const device = { name: "test-device", platform: "android" as const, deviceId: "emulator-5554" };

const row = (index: number): Element => ({
  "resource-id": `test:id/row${index}`,
  bounds: { left: 0, top: index * 100, right: 100, bottom: index * 100 + 90 },
});

describe("TalkBackTapStrategy focus-navigation activation and cancellation", () => {
  let timer: FakeTimer;
  let driver: HierarchyTalkBackDriver;
  let executor: FocusNavigationExecutor;
  let strategy: TalkBackTapStrategy;
  const rows = Array.from({ length: 12 }, (_, index) => row(index));

  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    driver = new HierarchyTalkBackDriver();
    driver.setElements(rows, 0);
    executor = new FocusNavigationExecutor({
      timer,
      deviceResolver: () => device,
      driverFactory: { createDriver: () => driver },
    });
    strategy = new TalkBackTapStrategy({ timer, executor });
  });

  describe("activation after the cursor reaches the target (#10144)", () => {
    test("is one double-tap request, never two single taps with a sleep between", async () => {
      const result = await strategy.executeTap(device.deviceId, rows[3], driver);

      expect(result).toMatchObject({
        success: true,
        method: "focus-navigation",
        screenReaderNavigation: { reachable: true },
      });
      expect(driver.doubleTapHistory).toEqual([{ x: 50, y: 345 }]);
      expect(driver.tapHistory).toEqual([]);
      expect(timer.getSleepHistory()).not.toContain(200);
    });

    test("tells the caller activation is unconfirmed, as the coordinate path does", async () => {
      const result = await strategy.executeTap(device.deviceId, rows[3], driver);

      expect(result.warnings).toEqual([TALKBACK_ACTIVATION_WARNING]);
    });

    test("reply latency cannot stretch the gap because only one request is sent", async () => {
      const doubleTap = driver.requestDoubleTapCoordinates.bind(driver);
      spyOn(driver, "requestDoubleTapCoordinates").mockImplementation(async (...args) => {
        const result = await doubleTap(...args);
        await timer.sleep(400);
        return result;
      });

      await strategy.executeTap(device.deviceId, rows[3], driver);

      expect(driver.doubleTapHistory).toHaveLength(1);
      expect(driver.tapHistory).toEqual([]);
    });

    test("a device without tap_double_v1 activates through ACTION_CLICK and does not warn", async () => {
      driver.doubleTapCapabilitySupported = false;

      const result = await strategy.executeTap(device.deviceId, rows[3], driver);

      expect(result).toMatchObject({ success: true, method: "accessibility-action" });
      expect(result.warnings).toBeUndefined();
      expect(driver.actionHistory).toEqual([{ action: "click", resourceId: "test:id/row3" }]);
      expect(driver.tapHistory).toEqual([]);
    });
  });

  describe("cancellation (#10145)", () => {
    test("a cancel with the focus request stops before the confirmation, never activates, and reports the moved cursor", async () => {
      const controller = new AbortController();
      driver.onFocusAction = () => controller.abort();

      await expect(
        strategy.executeTap(device.deviceId, rows[10], driver, undefined, controller.signal),
      ).rejects.toThrow(
        "Focus navigation partially applied: 1 accessibility-focus request already moved",
      );

      expect(driver.getFocusRequestCount()).toBe(1);
      expect(driver.tapHistory).toEqual([]);
      expect(driver.doubleTapHistory).toEqual([]);
      expect(driver.actionHistory).toEqual([]);
    });

    test("a cancel that lands after navigation but before activation never dispatches the tap", async () => {
      const controller = new AbortController();
      spyOn(executor, "navigateToElement").mockImplementation(async (_id, _sel, options) => {
        options?.onFocusRequested?.();
        controller.abort();
        return true;
      });

      await expect(
        strategy.executeTap(device.deviceId, rows[10], driver, undefined, controller.signal),
      ).rejects.toThrow(
        "partially applied: 1 accessibility-focus request already moved the TalkBack cursor",
      );

      expect(driver.doubleTapHistory).toEqual([]);
      expect(driver.tapHistory).toEqual([]);
      expect(driver.actionHistory).toEqual([]);
    });

    test("a cancel while the activation target is being read never dispatches the tap", async () => {
      const controller = new AbortController();
      const currentFocus = driver.requestCurrentFocus.bind(driver);
      spyOn(driver, "requestCurrentFocus").mockImplementation(async () => {
        const result = await currentFocus();
        controller.abort();
        return result;
      });

      await expect(
        strategy.executeTap(device.deviceId, rows[0], driver, undefined, controller.signal),
      ).rejects.toThrow("Operation cancelled");

      expect(driver.doubleTapHistory).toEqual([]);
      expect(driver.tapHistory).toEqual([]);
    });

    test("the ambient request signal stops navigation and activation without an explicit signal", async () => {
      const controller = new AbortController();
      driver.onFocusAction = () => controller.abort();

      await expect(
        runWithAbortSignal(controller.signal, () =>
          strategy.executeTap(device.deviceId, rows[10], driver),
        ),
      ).rejects.toThrow("partially applied: 1 accessibility-focus request");

      expect(driver.getFocusRequestCount()).toBe(1);
      expect(driver.doubleTapHistory).toEqual([]);
    });

    test("a request with no cancellation still navigates and activates", async () => {
      const result = await strategy.executeTap(
        device.deviceId,
        rows[10],
        driver,
        undefined,
        new AbortController().signal,
      );

      expect(result).toMatchObject({ success: true, method: "focus-navigation" });
      expect(driver.getFocusRequestCount()).toBe(1);
      expect(driver.doubleTapHistory).toHaveLength(1);
    });
  });
});
