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
    driver.onSwipe = () => {
      if (driver.getSwipeCount() === 3) {
        controller.abort();
      }
    };

    await expect(
      tap.executeAndroidTap("tap", 50, 1045, 500, rows[10], controller.signal, {
        screenReaderNavigation: true,
      }),
    ).rejects.toThrow("Focus navigation partially applied: 3 swipes already moved");

    expect(driver.getSwipeCount()).toBe(3);
    expect(driver.doubleTapHistory).toEqual([]);
    expect(driver.tapHistory).toEqual([]);
    expect(driver.actionHistory).toEqual([]);
  });
});
