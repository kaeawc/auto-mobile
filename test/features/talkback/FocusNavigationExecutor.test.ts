import { describe, expect, test } from "bun:test";
import {
  FocusNavigationExecutor,
  type FocusNavigationDriverFactory,
  type FocusNavigationPath,
} from "../../../src/features/talkback/FocusNavigationExecutor";
import { FocusPathCalculator } from "../../../src/features/talkback/FocusPathCalculator";
import type { Element } from "../../../src/models/Element";
import type { ElementSelector as FocusElementSelector } from "../../../src/features/talkback/ElementSelector";
import { FakeFocusNavigationDriver } from "../../fakes/FakeFocusNavigationDriver";
import { FakeTimer } from "../../fakes/FakeTimer";

const makeElement = (resourceId: string, index: number): Element => ({
  bounds: {
    left: index * 10,
    top: index * 10,
    right: index * 10 + 5,
    bottom: index * 10 + 5,
  },
  "resource-id": resourceId,
});

describe("FocusNavigationExecutor", () => {
  test("uses injected driver and FakeTimer to stop early", async () => {
    const timer = new FakeTimer();
    const driver = new FakeFocusNavigationDriver();
    const elements = [makeElement("a", 0), makeElement("b", 1), makeElement("c", 2)];
    driver.setElements(elements, 0);

    const targetSelector: FocusElementSelector = { resourceId: "c" };
    const path: FocusNavigationPath = {
      currentFocusIndex: 0,
      targetFocusIndex: 2,
      swipeCount: 5,
      direction: "forward",
    };

    const driverFactory: FocusNavigationDriverFactory = {
      createDriver: () => driver,
    };
    const executor = new FocusNavigationExecutor({ timer, driverFactory });

    // Start navigation (non-blocking)
    const resultPromise = executor.navigateToElement("device-1", targetSelector, path, {
      verificationInterval: 1,
      swipeDelay: 123,
    });

    // Interleave time advancement with async execution
    // Each iteration: advance time, then let async code run
    for (let i = 0; i < 10; i++) {
      timer.advanceTime(200);
      await new Promise((r) => setImmediate(r));
    }

    const result = await resultPromise;

    expect(result).toBe(true);
    expect(driver.getSwipeCount()).toBe(2);
    expect(timer.getSleepHistory()).toEqual([123, 123]);
  });

  test("throws when focus does not move across swipes", async () => {
    const timer = new FakeTimer();
    const driver = new FakeFocusNavigationDriver();
    const elements = [makeElement("a", 0), makeElement("b", 1), makeElement("c", 2)];
    driver.setElements(elements, 0);
    driver.autoAdvanceOnSwipe = false;

    const targetSelector: FocusElementSelector = { resourceId: "c" };
    const path: FocusNavigationPath = {
      currentFocusIndex: 0,
      targetFocusIndex: 2,
      swipeCount: 3,
      direction: "forward",
    };

    const driverFactory: FocusNavigationDriverFactory = {
      createDriver: () => driver,
    };
    const executor = new FocusNavigationExecutor({ timer, driverFactory });

    let thrownError: Error | null = null;
    const resultPromise = executor
      .navigateToElement("device-1", targetSelector, path, {
        verificationInterval: 1,
        swipeDelay: 0,
      })
      .catch((e) => {
        thrownError = e as Error;
      });

    // Interleave time advancement with async execution
    for (let i = 0; i < 10; i++) {
      timer.advanceTime(100);
      await new Promise((r) => setImmediate(r));
    }

    await resultPromise;

    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toContain("Focus did not move after multiple swipes");
  });

  test("recalculates when traversal order moves target farther away", async () => {
    const timer = new FakeTimer();
    const driver = new FakeFocusNavigationDriver();
    const a = makeElement("a", 0);
    const b = makeElement("b", 1);
    const c = makeElement("c", 2);
    const d = makeElement("d", 3);
    const e = makeElement("e", 4);
    driver.setElements([a, b, c, d, e], 0);

    const targetSelector: FocusElementSelector = { resourceId: "c" };
    const calculator = new FocusPathCalculator();
    const path = calculator.calculatePath(a, targetSelector, [a, b, c, d, e])!;

    driver.onSwipe = () => {
      if (driver.getSwipeCount() === 1) {
        driver.replaceElements([a, b, d, e, c], true);
      }
    };

    const driverFactory: FocusNavigationDriverFactory = {
      createDriver: () => driver,
    };
    const executor = new FocusNavigationExecutor({ timer, driverFactory });

    const resultPromise = executor.navigateToElement("device-1", targetSelector, path, {
      verificationInterval: 1,
      swipeDelay: 0,
    });

    // Interleave time advancement with async execution
    for (let i = 0; i < 10; i++) {
      timer.advanceTime(100);
      await new Promise((r) => setImmediate(r));
    }

    const result = await resultPromise;

    expect(result).toBe(true);
    expect(driver.getSwipeCount()).toBe(4);
  });

  test("returns true without swiping when target is already focused (zero-swipe path)", async () => {
    const timer = new FakeTimer();
    const driver = new FakeFocusNavigationDriver();
    const elements = [makeElement("a", 0), makeElement("b", 1), makeElement("c", 2)];
    // Focus is already on the target element "c" (index 2).
    driver.setElements(elements, 2);

    const targetSelector: FocusElementSelector = { resourceId: "c" };
    const path: FocusNavigationPath = {
      currentFocusIndex: 2,
      targetFocusIndex: 2,
      swipeCount: 0,
      direction: "forward",
    };

    const driverFactory: FocusNavigationDriverFactory = {
      createDriver: () => driver,
    };
    const executor = new FocusNavigationExecutor({ timer, driverFactory });

    const result = await executor.navigateToElement("device-1", targetSelector, path, {
      verificationInterval: 1,
      swipeDelay: 0,
    });

    expect(result).toBe(true);
    expect(driver.getSwipeCount()).toBe(0);
  });

  test("recalculates and navigates when zero-swipe path but target is not yet focused", async () => {
    const timer = new FakeTimer();
    const driver = new FakeFocusNavigationDriver();
    const elements = [makeElement("a", 0), makeElement("b", 1), makeElement("c", 2)];
    // Focus is on "a" (index 0) but the caller supplied a stale zero-swipe path.
    driver.setElements(elements, 0);

    const targetSelector: FocusElementSelector = { resourceId: "c" };
    const path: FocusNavigationPath = {
      currentFocusIndex: 0,
      targetFocusIndex: 2,
      swipeCount: 0,
      direction: "forward",
    };

    const driverFactory: FocusNavigationDriverFactory = {
      createDriver: () => driver,
    };
    const executor = new FocusNavigationExecutor({ timer, driverFactory });

    const resultPromise = executor.navigateToElement("device-1", targetSelector, path, {
      verificationInterval: 1,
      swipeDelay: 0,
    });

    for (let i = 0; i < 10; i++) {
      timer.advanceTime(100);
      await new Promise((r) => setImmediate(r));
    }

    const result = await resultPromise;

    expect(result).toBe(true);
    expect(driver.getSwipeCount()).toBe(2);
  });

  test("throws an actionable error (not a ReferenceError) when zero-swipe path but target is not found", async () => {
    const timer = new FakeTimer();
    const driver = new FakeFocusNavigationDriver();
    const elements = [makeElement("a", 0), makeElement("b", 1)];
    driver.setElements(elements, 0);

    const targetSelector: FocusElementSelector = { resourceId: "does-not-exist" };
    const path: FocusNavigationPath = {
      currentFocusIndex: 0,
      targetFocusIndex: 0,
      swipeCount: 0,
      direction: "forward",
    };

    const driverFactory: FocusNavigationDriverFactory = {
      createDriver: () => driver,
    };
    const executor = new FocusNavigationExecutor({ timer, driverFactory });

    let thrownError: Error | null = null;
    await executor
      .navigateToElement("device-1", targetSelector, path, {
        verificationInterval: 1,
        swipeDelay: 0,
      })
      .catch((e) => {
        thrownError = e as Error;
      });

    expect(thrownError).not.toBeNull();
    expect(thrownError).not.toBeInstanceOf(ReferenceError);
    expect(thrownError!.message).toContain("Target not found");
    expect(driver.getSwipeCount()).toBe(0);
  });

  test("self-corrects when the supplied path points the wrong direction (#3917)", async () => {
    const timer = new FakeTimer();
    const driver = new FakeFocusNavigationDriver();
    const elements = [
      makeElement("a", 0),
      makeElement("b", 1),
      makeElement("c", 2),
      makeElement("d", 3),
      makeElement("e", 4),
    ];
    // Cursor is really on "c" (index 2); the target "a" is behind it (index 0).
    driver.setElements(elements, 2);

    const targetSelector: FocusElementSelector = { resourceId: "a" };
    // A path built while the cursor was unresolved: forward-from-0, which points
    // AWAY from the target.
    const path: FocusNavigationPath = {
      currentFocusIndex: null,
      targetFocusIndex: 0,
      swipeCount: 2,
      direction: "forward",
    };

    const driverFactory: FocusNavigationDriverFactory = {
      createDriver: () => driver,
    };
    const executor = new FocusNavigationExecutor({ timer, driverFactory });

    const resultPromise = executor.navigateToElement("device-1", targetSelector, path, {
      verificationInterval: 1,
      swipeDelay: 0,
    });
    for (let i = 0; i < 15; i++) {
      timer.advanceTime(100);
      await new Promise((r) => setImmediate(r));
    }
    const result = await resultPromise;

    expect(result).toBe(true);
    // Once the cursor is observed, navigation reverses and converges on "a" —
    // the final swipe is backward (endX < startX).
    const lastSwipe = driver.swipeHistory[driver.swipeHistory.length - 1];
    expect(lastSwipe.x2).toBeLessThan(lastSwipe.x1);
  });

  test("bails when the TalkBack cursor can't be tracked instead of marching to maxSwipes (#3917)", async () => {
    const timer = new FakeTimer();
    const driver = new FakeFocusNavigationDriver();
    const elements = [makeElement("a", 0), makeElement("b", 1), makeElement("c", 2)];
    // No cursor is ever reported (focusedIndex null, autoAdvance off), so the
    // cursor position can never be resolved in the traversal order.
    driver.setElements(elements, null);
    driver.autoAdvanceOnSwipe = false;

    const targetSelector: FocusElementSelector = { resourceId: "c" };
    // A large swipe count that, without the progress guard, would march blindly.
    const path: FocusNavigationPath = {
      currentFocusIndex: null,
      targetFocusIndex: 2,
      swipeCount: 50,
      direction: "forward",
    };

    const driverFactory: FocusNavigationDriverFactory = {
      createDriver: () => driver,
    };
    const executor = new FocusNavigationExecutor({ timer, driverFactory });

    let thrownError: Error | null = null;
    const resultPromise = executor
      .navigateToElement("device-1", targetSelector, path, {
        verificationInterval: 1,
        swipeDelay: 0,
      })
      .catch((e) => {
        thrownError = e as Error;
      });
    for (let i = 0; i < 20; i++) {
      timer.advanceTime(100);
      await new Promise((r) => setImmediate(r));
    }
    await resultPromise;

    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toContain("could not track the TalkBack cursor position");
    // Bailed after a couple of no-progress checks, nowhere near the 50 swipes.
    expect(driver.getSwipeCount()).toBeLessThan(10);
  });

  test("reports every swipe without treating delayed focus updates as a trap", async () => {
    const timer = new FakeTimer();
    const driver = new FakeFocusNavigationDriver();
    const elements = [
      makeElement("a", 0),
      makeElement("b", 1),
      makeElement("c", 2),
      makeElement("d", 3),
      makeElement("e", 4),
    ];
    driver.setElements(elements, 0);
    driver.autoAdvanceOnSwipe = false;
    driver.onSwipe = () => {
      if (driver.getSwipeCount() === 4) {
        driver.focusedIndex = 4;
      }
    };
    const observed: Element[] = [];
    const executor = new FocusNavigationExecutor({
      timer,
      driverFactory: { createDriver: () => driver },
    });

    const result = await executor.navigateToElement(
      "device-1",
      { resourceId: "e" },
      { currentFocusIndex: 0, targetFocusIndex: 4, swipeCount: 5, direction: "forward" },
      {
        verificationInterval: 5,
        swipeDelay: 0,
        onFocusObserved: (element) => {
          if (element) {
            observed.push(element);
          }
        },
      },
    );

    expect(result).toBe(true);
    expect(driver.getSwipeCount()).toBe(4);
    expect(observed).toEqual([elements[0], elements[0], elements[0], elements[4]]);
  });

  describe("navigation guards", () => {
    const makeDriverFactory = (
      driver: FakeFocusNavigationDriver,
    ): FocusNavigationDriverFactory => ({
      createDriver: () => driver,
    });

    test("rejects a path that needs more swipes than the maxSwipes cap", async () => {
      const driver = new FakeFocusNavigationDriver();
      driver.setElements([makeElement("a", 0), makeElement("c", 2)], 0);
      const executor = new FocusNavigationExecutor({
        timer: new FakeTimer(),
        driverFactory: makeDriverFactory(driver),
      });

      await expect(
        executor.navigateToElement(
          "device-1",
          { resourceId: "c" },
          { currentFocusIndex: 0, targetFocusIndex: 2, swipeCount: 5, direction: "forward" },
          { maxSwipes: 2, swipeDelay: 0 },
        ),
      ).rejects.toThrow(/max: 2/);
      // Bailed before touching the device — no swipes issued.
      expect(driver.getSwipeCount()).toBe(0);
    });

    test("rejects focus navigation on a non-Android device", async () => {
      const driver = new FakeFocusNavigationDriver();
      driver.setElements([makeElement("a", 0), makeElement("c", 2)], 0);
      const executor = new FocusNavigationExecutor({
        timer: new FakeTimer(),
        driverFactory: makeDriverFactory(driver),
        deviceResolver: (deviceId) => ({ name: deviceId, deviceId, platform: "ios" }),
      });

      await expect(
        executor.navigateToElement(
          "udid-ios",
          { resourceId: "c" },
          { currentFocusIndex: 0, targetFocusIndex: 2, swipeCount: 2, direction: "forward" },
          { swipeDelay: 0 },
        ),
      ).rejects.toThrow(/only supported on Android/);
      expect(driver.getSwipeCount()).toBe(0);
    });

    test("rejects a zero-sized screen instead of hanging", async () => {
      const driver = new FakeFocusNavigationDriver();
      driver.setElements([makeElement("a", 0), makeElement("c", 2)], 0);
      // A finite-but-non-positive screen size must be rejected, not marched into
      // the swipe loop (which would wedge to the test timeout).
      driver.setScreenSize({ width: 0, height: 0 });
      const executor = new FocusNavigationExecutor({
        timer: new FakeTimer(),
        driverFactory: makeDriverFactory(driver),
      });

      await expect(
        executor.navigateToElement(
          "device-1",
          { resourceId: "c" },
          { currentFocusIndex: 0, targetFocusIndex: 2, swipeCount: 3, direction: "forward" },
          { swipeDelay: 0 },
        ),
      ).rejects.toThrow(/screen size/);
      expect(driver.getSwipeCount()).toBe(0);
    });

    test("surfaces a failed swipe as a navigation failure rather than success", async () => {
      const driver = new FakeFocusNavigationDriver();
      driver.setElements([makeElement("a", 0), makeElement("c", 2)], 0);
      driver.setSwipeResult({ success: false, totalTimeMs: 1, error: "proxy swipe rejected" });
      const executor = new FocusNavigationExecutor({
        timer: new FakeTimer(),
        driverFactory: makeDriverFactory(driver),
      });

      await expect(
        executor.navigateToElement(
          "device-1",
          { resourceId: "c" },
          { currentFocusIndex: 0, targetFocusIndex: 2, swipeCount: 1, direction: "forward" },
          { swipeDelay: 0 },
        ),
      ).rejects.toThrow(/proxy swipe rejected/);
    });
  });
});
