import { describe, expect, test } from "bun:test";
import {
  FocusNavigationExecutor,
  FocusNavigationStoppedError,
  type FocusNavigationPath,
} from "../../../src/features/talkback/FocusNavigationExecutor";
import type { Element } from "../../../src/models/Element";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { FakeFocusNavigationDriver } from "../../fakes/FakeFocusNavigationDriver";
import { FakeTimer } from "../../fakes/FakeTimer";

const makeElement = (resourceId: string, index: number): Element => ({
  bounds: { left: index * 10, top: index * 10, right: index * 10 + 5, bottom: index * 10 + 5 },
  "resource-id": resourceId,
});

const longTraversal = () => {
  const driver = new FakeFocusNavigationDriver();
  driver.setElements(
    Array.from({ length: 12 }, (_, index) => makeElement(`e${index}`, index)),
    0,
  );
  const path: FocusNavigationPath = {
    currentFocusIndex: 0,
    targetFocusIndex: 10,
    swipeCount: 10,
    direction: "forward",
  };
  return { driver, path };
};

const executorFor = (driver: FakeFocusNavigationDriver, timer: FakeTimer) =>
  new FocusNavigationExecutor({ timer, driverFactory: { createDriver: () => driver } });

const requestContext = (getDeadlineMs: () => number | undefined) => ({
  getDeadlineMs,
  textState: { dispatched: () => () => {} },
});

describe("FocusNavigationExecutor request cancellation", () => {
  test("a cancel after the third swipe stops before the fourth and says how far the cursor moved", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { driver, path } = longTraversal();
    const controller = new AbortController();
    driver.onSwipe = () => {
      if (driver.getSwipeCount() === 3) {
        controller.abort();
      }
    };

    const failure = await executorFor(driver, timer)
      .navigateToElement("device-1", { resourceId: "e10" }, path, {
        verificationInterval: 1,
        swipeDelay: 100,
        signal: controller.signal,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(FocusNavigationStoppedError);
    expect((failure as Error).message).toBe(
      "Operation cancelled. Focus navigation partially applied: 3 swipes already moved the " +
        "TalkBack cursor and the target was not activated. Observe before retrying; do not " +
        "retry automatically.",
    );
    expect(driver.getSwipeCount()).toBe(3);
  });

  test("hands the request signal to every swipe request", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { driver, path } = longTraversal();
    const controller = new AbortController();

    await executorFor(driver, timer).navigateToElement("device-1", { resourceId: "e10" }, path, {
      verificationInterval: 1,
      swipeDelay: 0,
      signal: controller.signal,
    });

    expect(driver.swipeSignals).toHaveLength(10);
    expect(driver.swipeSignals.every((signal) => signal === controller.signal)).toBe(true);
  });

  test("a request already cancelled sends no swipe and does not claim the cursor moved", async () => {
    const timer = new FakeTimer();
    const { driver, path } = longTraversal();
    const controller = new AbortController();
    controller.abort();

    const failure = await executorFor(driver, timer)
      .navigateToElement("device-1", { resourceId: "e10" }, path, {
        verificationInterval: 1,
        swipeDelay: 0,
        signal: controller.signal,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect((failure as Error).message).toBe("Operation cancelled");
    expect(driver.getSwipeCount()).toBe(0);
  });

  test("a cancel during the post-swipe wait ends the wait without a further swipe", async () => {
    const timer = new FakeTimer();
    const { driver, path } = longTraversal();
    const controller = new AbortController();

    const settled = executorFor(driver, timer)
      .navigateToElement("device-1", { resourceId: "e10" }, path, {
        verificationInterval: 1,
        swipeDelay: 100,
        signal: controller.signal,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await new Promise((resolve) => setImmediate(resolve));
    expect(driver.getSwipeCount()).toBe(1);
    controller.abort();

    // The fake clock never advanced: the sleep did not have to finish for the cancel to land.
    expect((await settled) as Error).toMatchObject({
      message: expect.stringContaining("partially applied: 1 swipe already moved"),
    });
    expect(driver.getSwipeCount()).toBe(1);
  });

  test("the ambient request signal cancels navigation without an explicit signal", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { driver, path } = longTraversal();
    const controller = new AbortController();
    driver.onSwipe = () => {
      if (driver.getSwipeCount() === 2) {
        controller.abort();
      }
    };

    await expect(
      runWithAbortSignal(controller.signal, () =>
        executorFor(driver, timer).navigateToElement("device-1", { resourceId: "e10" }, path, {
          verificationInterval: 1,
          swipeDelay: 0,
        }),
      ),
    ).rejects.toThrow("partially applied: 2 swipes");
    expect(driver.getSwipeCount()).toBe(2);
  });

  test("stops swiping once the request's remaining time budget is spent", async () => {
    const timer = new FakeTimer();
    const { driver, path } = longTraversal();
    driver.onSwipe = () => timer.advanceTime(100);

    const result = runWithAbortSignal(
      undefined,
      () =>
        executorFor(driver, timer).navigateToElement("device-1", { resourceId: "e10" }, path, {
          verificationInterval: 1,
          swipeDelay: 0,
        }),
      requestContext(() => 250),
    );

    await expect(result).rejects.toThrow(
      "Request time budget exhausted during focus navigation. Focus navigation partially " +
        "applied: 3 swipes already moved",
    );
    expect(driver.getSwipeCount()).toBe(3);
  });

  test("a request with budget left navigates to the target", async () => {
    const timer = new FakeTimer();
    const { driver, path } = longTraversal();
    driver.onSwipe = () => timer.advanceTime(10);

    const reached = await runWithAbortSignal(
      undefined,
      () =>
        executorFor(driver, timer).navigateToElement("device-1", { resourceId: "e10" }, path, {
          verificationInterval: 1,
          swipeDelay: 0,
        }),
      requestContext(() => 10_000),
    );

    expect(reached).toBe(true);
    expect(driver.getSwipeCount()).toBe(10);
  });
});
