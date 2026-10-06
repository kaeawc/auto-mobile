import { describe, expect, test } from "bun:test";
import {
  FocusNavigationExecutor,
  FocusNavigationStoppedError,
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
  driver.exposeHierarchy = true;
  driver.setElements(
    Array.from({ length: 12 }, (_, index) => makeElement(`e${index}`, index)),
    0,
  );
  return driver;
};

const executorFor = (driver: FakeFocusNavigationDriver, timer: FakeTimer) =>
  new FocusNavigationExecutor({ timer, driverFactory: { createDriver: () => driver } });

const requestContext = (getDeadlineMs: () => number | undefined) => ({
  getDeadlineMs,
  textState: { dispatched: () => () => {} },
});

const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

const target = { resourceId: "e10" };

describe("FocusNavigationExecutor request cancellation", () => {
  test("a cancel that lands with the focus request stops before the read-back and says the cursor moved", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const driver = longTraversal();
    const controller = new AbortController();
    driver.onFocusAction = () => controller.abort();

    const failure = await failureOf(
      executorFor(driver, timer).navigateToElement("device-1", target, {
        signal: controller.signal,
      }),
    );

    expect(failure).toBeInstanceOf(FocusNavigationStoppedError);
    expect((failure as Error).message).toBe(
      "Operation cancelled. Focus navigation partially applied: 1 accessibility-focus request " +
        "already moved the TalkBack cursor and the target was not activated. Observe before " +
        "retrying; do not retry automatically.",
    );
    expect(driver.getFocusRequestCount()).toBe(1);
  });

  test("a request already cancelled sends no focus request and does not claim the cursor moved", async () => {
    const timer = new FakeTimer();
    const driver = longTraversal();
    const controller = new AbortController();
    controller.abort();

    const failure = await failureOf(
      executorFor(driver, timer).navigateToElement("device-1", target, {
        signal: controller.signal,
      }),
    );

    expect((failure as Error).message).toBe("Operation cancelled");
    expect(driver.getFocusRequestCount()).toBe(0);
  });

  test("a cancel during the settle wait ends the wait without confirming or tapping", async () => {
    const timer = new FakeTimer();
    const driver = longTraversal();
    const controller = new AbortController();

    const settled = failureOf(
      executorFor(driver, timer).navigateToElement("device-1", target, {
        signal: controller.signal,
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(driver.getFocusRequestCount()).toBe(1);
    controller.abort();

    // The fake clock never advanced: the sleep did not have to finish for the cancel to land.
    expect((await settled) as Error).toMatchObject({
      message: expect.stringContaining("partially applied: 1 accessibility-focus request already"),
    });
    expect(driver.getFocusRequestCount()).toBe(1);
  });

  test("the ambient request signal cancels navigation without an explicit signal", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const driver = longTraversal();
    const controller = new AbortController();
    driver.onFocusAction = () => controller.abort();

    await expect(
      runWithAbortSignal(controller.signal, () =>
        executorFor(driver, timer).navigateToElement("device-1", target),
      ),
    ).rejects.toThrow("partially applied: 1 accessibility-focus request");
  });

  test("sends nothing once the request's remaining time budget is spent", async () => {
    const timer = new FakeTimer();
    const driver = longTraversal();
    timer.advanceTime(500);

    const result = runWithAbortSignal(
      undefined,
      () => executorFor(driver, timer).navigateToElement("device-1", target),
      requestContext(() => 250),
    );

    await expect(result).rejects.toThrow("Request time budget exhausted during focus navigation.");
    expect(driver.getFocusRequestCount()).toBe(0);
  });

  test("a budget that runs out after the focus request stops before the confirmation", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const driver = longTraversal();
    driver.onFocusAction = () => timer.advanceTime(300);

    const result = runWithAbortSignal(
      undefined,
      () => executorFor(driver, timer).navigateToElement("device-1", target),
      requestContext(() => 250),
    );

    await expect(result).rejects.toThrow(
      "Request time budget exhausted during focus navigation. Focus navigation partially " +
        "applied: 1 accessibility-focus request already moved",
    );
    expect(driver.getFocusRequestCount()).toBe(1);
  });

  test("a request with budget left navigates to the target", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const driver = longTraversal();

    const reached = await runWithAbortSignal(
      undefined,
      () => executorFor(driver, timer).navigateToElement("device-1", target),
      requestContext(() => 10_000),
    );

    expect(reached).toBe(true);
    expect(driver.getFocusRequestCount()).toBe(1);
  });
});
