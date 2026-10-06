import { describe, expect, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FocusNavigationExecutor } from "../../../src/features/talkback/FocusNavigationExecutor";
import {
  TALKBACK_ACTIVATION_WARNING,
  TalkBackTapStrategy,
} from "../../../src/features/talkback/TalkBackTapStrategy";
import type { Element } from "../../../src/models/Element";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { HierarchyTalkBackDriver } from "./HierarchyTalkBackDriver";

const device = { name: "test-device", platform: "android" as const, deviceId: "emulator-5554" };

const rows: Element[] = Array.from({ length: 12 }, (_, index) => ({
  "resource-id": `test:id/row${index}`,
  bounds: { left: 0, top: index * 100, right: 100, bottom: index * 100 + 90 },
}));

function harness() {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const driver = new HierarchyTalkBackDriver();
  driver.setElements(rows, 0);
  const executor = new FocusNavigationExecutor({
    timer,
    deviceResolver: () => device,
    driverFactory: { createDriver: () => driver },
  });
  const detector = new FakeAccessibilityDetector();
  detector.setTalkBackEnabled(true);
  const tap = new TapOnElement(device, null, {
    timer,
    accessibilityDetector: detector,
    talkBackStrategy: new TalkBackTapStrategy({ timer, executor }),
    talkBackDriverFactory: { createDriver: () => driver },
  });
  return { driver, tap };
}

describe("tapOn screenReaderNavigation activation and cancellation", () => {
  test("reports the unconfirmed-activation warning for a successful focus-navigation tap (#10144)", async () => {
    const { driver, tap } = harness();
    const warnings: string[] = [];

    await tap.executeAndroidTap("tap", 50, 345, 500, rows[3], undefined, {
      screenReaderNavigation: true,
      onActivationWarning: (warning) => warnings.push(warning),
    });

    expect(driver.doubleTapHistory).toHaveLength(1);
    expect(driver.tapHistory).toEqual([]);
    expect(warnings).toEqual([TALKBACK_ACTIVATION_WARNING]);
  });

  test("moves the cursor with one focus action, then activates with exactly one double tap (#10209, #10144)", async () => {
    const { driver, tap } = harness();

    await tap.executeAndroidTap("tap", 50, 1045, 500, rows[10], undefined, {
      screenReaderNavigation: true,
    });

    expect(driver.focusHistory).toEqual([
      { action: "focus", resourceId: "test:id/row10", selector: undefined },
    ]);
    expect(driver.doubleTapHistory).toEqual([{ x: 50, y: 1045 }]);
    expect(driver.tapHistory).toEqual([]);
    expect(driver.actionHistory).toEqual([]);
  });

  test("rows sharing a test tag use the precise tap and never move the cursor to the first row (#10209)", async () => {
    const { driver, tap } = harness();
    const tagged: Element[] = rows.map((row, index) => ({
      bounds: row.bounds,
      text: `Row ${index}`,
      "test-tag": "row",
    }));
    driver.setElements(tagged, 0);

    await tap.executeAndroidTap("tap", 50, 345, 500, tagged[3], undefined, {
      screenReaderNavigation: true,
    });

    expect(driver.focusHistory).toEqual([]);
    expect(driver.focusedIndex).toBe(0);
    // The precise tap: a focus touch at the element, then one activation.
    expect(driver.tapHistory.length).toBeGreaterThan(0);
    expect(driver.doubleTapHistory).toHaveLength(1);
  });

  test("a refused focus action fails the call and sends no tap (#10209)", async () => {
    const { driver, tap } = harness();
    driver.focusResult = {
      success: false,
      action: "focus",
      totalTimeMs: 1,
      error: "Accessibility action is unavailable: focus",
    };

    await expect(
      tap.executeAndroidTap("tap", 50, 345, 500, rows[3], undefined, {
        screenReaderNavigation: true,
      }),
    ).rejects.toThrow("Accessibility action is unavailable: focus");

    expect(driver.doubleTapHistory).toEqual([]);
    expect(driver.tapHistory).toEqual([]);
  });

  test("a screen that changed while the cursor was being moved fails the call and sends no tap (#10209)", async () => {
    const { driver, tap } = harness();
    driver.autoFocusOnAction = false;
    driver.onFocusAction = () => driver.setElements(rows.slice(4), 0);

    await expect(
      tap.executeAndroidTap("tap", 50, 345, 500, rows[3], undefined, {
        screenReaderNavigation: true,
      }),
    ).rejects.toThrow("The screen changed while moving the TalkBack cursor");

    expect(driver.doubleTapHistory).toEqual([]);
    expect(driver.tapHistory).toEqual([]);
  });

  test("an ACTION_CLICK activation after navigation reports no warning (#10144)", async () => {
    const { driver, tap } = harness();
    driver.doubleTapCapabilitySupported = false;
    const warnings: string[] = [];

    await tap.executeAndroidTap("tap", 50, 345, 500, rows[3], undefined, {
      screenReaderNavigation: true,
      onActivationWarning: (warning) => warnings.push(warning),
    });

    expect(driver.actionHistory).toEqual([{ action: "click", resourceId: "test:id/row3" }]);
    expect(warnings).toEqual([]);
  });

  test("the request's signal stops navigation and the activation, with no coordinate fallback (#10145)", async () => {
    const { driver, tap } = harness();
    const controller = new AbortController();
    driver.onFocusAction = () => controller.abort();

    await expect(
      tap.executeAndroidTap("tap", 50, 1045, 500, rows[10], controller.signal, {
        screenReaderNavigation: true,
      }),
    ).rejects.toThrow(
      "Focus navigation partially applied: 1 accessibility-focus request already moved",
    );

    expect(driver.getFocusRequestCount()).toBe(1);
    expect(driver.doubleTapHistory).toEqual([]);
    expect(driver.tapHistory).toEqual([]);
    expect(driver.actionHistory).toEqual([]);
  });
});
