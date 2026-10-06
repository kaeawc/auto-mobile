import { describe, expect, test } from "bun:test";
import {
  FocusNavigationExecutor,
  FocusNavigationUnavailableError,
  screenFingerprint,
  type FocusNavigationDriverFactory,
} from "../../../src/features/talkback/FocusNavigationExecutor";
import { ActionableError } from "../../../src/models/ActionableError";
import type { Element } from "../../../src/models/Element";
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

const traversal = (count: number): Element[] =>
  Array.from({ length: count }, (_, index) => makeElement(`e${index}`, index));

function setup(elements: Element[], focusedIndex: number | null) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const driver = new FakeFocusNavigationDriver();
  driver.exposeHierarchy = true;
  driver.setElements(elements, focusedIndex);
  const driverFactory: FocusNavigationDriverFactory = { createDriver: () => driver };
  return { timer, driver, executor: new FocusNavigationExecutor({ timer, driverFactory }) };
}

const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error as Error,
  );

describe("FocusNavigationExecutor (accessibility-focus actions, #10209)", () => {
  test("moves the cursor onto a distant target with one focus action, never a gesture", async () => {
    const { driver, executor, timer } = setup(traversal(12), 0);

    await expect(executor.navigateToElement("device-1", { resourceId: "e10" })).resolves.toBe(true);

    expect(driver.focusHistory).toEqual([
      { action: "focus", resourceId: "e10", selector: undefined },
    ]);
    expect(driver.getFocusedElement()?.["resource-id"]).toBe("e10");
    // Exactly the settle delay, so the read-back sees the applied cursor.
    expect(timer.getSleepHistory()).toEqual([100]);
  });

  test("hands the request signal to the focus action", async () => {
    const { driver, executor } = setup(traversal(3), 0);
    const controller = new AbortController();

    await executor.navigateToElement(
      "device-1",
      { resourceId: "e2" },
      { signal: controller.signal },
    );

    expect(driver.focusSignals).toHaveLength(1);
    expect(driver.focusSignals[0]).toBeDefined();
    expect(driver.focusSignals[0]!.aborted).toBe(false);
  });

  test("sends nothing when the target already holds the cursor", async () => {
    const { driver, executor } = setup(traversal(3), 2);

    await expect(executor.navigateToElement("device-1", { resourceId: "e2" })).resolves.toBe(true);

    expect(driver.getFocusRequestCount()).toBe(0);
  });

  test("reaches a unique target after it moved from the selector bounds", async () => {
    const { driver, executor } = setup([], null);
    const movedTarget = { text: "Save", bounds: makeElement("a", 1).bounds };
    driver.setElements([movedTarget], 0);

    await expect(
      executor.navigateToElement("device-1", { text: "Save", bounds: makeElement("a", 0).bounds }),
    ).resolves.toBe(true);
    expect(driver.getFocusRequestCount()).toBe(0);
  });

  test("reports the cursor before and after the move", async () => {
    const elements = traversal(4);
    const { executor } = setup(elements, 0);
    const observed: Array<Element | null> = [];

    await executor.navigateToElement(
      "device-1",
      { resourceId: "e3" },
      { onFocusObserved: (focus) => observed.push(focus) },
    );

    expect(observed).toEqual([elements[0], elements[3]]);
  });

  test("addresses a test-tag target with a stable node selector", async () => {
    const { driver, executor } = setup([], null);
    const tagged: Element = { bounds: makeElement("a", 0).bounds, "test-tag": "pay" };
    driver.setElements([tagged], null);

    await expect(
      executor.navigateToElement("device-1", { testTag: "pay", bounds: tagged.bounds }),
    ).resolves.toBe(true);

    expect(driver.focusHistory).toEqual([
      {
        action: "focus",
        selector: { resourceId: undefined, testTag: "pay", uniqueId: undefined },
      },
    ]);
  });

  describe("failures after a focus request was sent (never a coordinate fallback)", () => {
    test("a refused action fails naming the refusal and sends no tap", async () => {
      const { driver, executor } = setup(traversal(3), 0);
      driver.focusResult = {
        success: false,
        action: "focus",
        totalTimeMs: 1,
        error: "Accessibility action is unavailable: focus",
      };

      const failure = await failureOf(executor.navigateToElement("device-1", { resourceId: "e2" }));

      expect(failure).toBeInstanceOf(ActionableError);
      expect(failure).not.toBeInstanceOf(FocusNavigationUnavailableError);
      expect(failure!.message).toContain("Accessibility action is unavailable: focus");
      expect(failure!.message).toContain("No tap was sent");
      expect(driver.getFocusRequestCount()).toBe(1);
    });

    test("an acknowledged action whose cursor never arrived is a failure, not progress", async () => {
      const { driver, executor } = setup(traversal(3), 0);
      driver.autoFocusOnAction = false;

      const failure = await failureOf(executor.navigateToElement("device-1", { resourceId: "e2" }));

      expect(failure).not.toBeInstanceOf(FocusNavigationUnavailableError);
      expect(failure!.message).toContain("did not move onto the target");
      expect(failure!.message).toContain(`focus is on "e0"`);
      expect(failure!.message).not.toContain("screen changed");
    });

    test("a screen that changed during navigation with the cursor unmoved is a failure naming it", async () => {
      const { driver, executor } = setup(traversal(3), 0);
      driver.autoFocusOnAction = false;
      // The request "scrolled" the app's pager: other nodes at other places, cursor unchanged.
      driver.onFocusAction = () => {
        driver.replaceElements(
          [
            makeElement("e0", 0),
            makeElement("e1", 5),
            makeElement("e2", 6),
            makeElement("slide-1", 7),
          ],
          true,
        );
      };

      const failure = await failureOf(executor.navigateToElement("device-1", { resourceId: "e2" }));

      expect(failure).not.toBeInstanceOf(FocusNavigationUnavailableError);
      expect(failure!.message).toContain("The screen changed while moving the TalkBack cursor");
      expect(failure!.message).toContain("No tap was sent");
    });

    test("the cursor landing on the target wins even when the screen changed around it", async () => {
      const { driver, executor } = setup(traversal(3), 0);
      driver.onFocusAction = () => {
        driver.replaceElements([...traversal(3), makeElement("badge", 9)], true);
        driver.focusedIndex = 2;
      };

      await expect(executor.navigateToElement("device-1", { resourceId: "e2" })).resolves.toBe(
        true,
      );
    });
  });

  describe("failures before anything was dispatched (a non-cursor fallback is still safe)", () => {
    test("a target without a stable selector cannot be addressed", async () => {
      const { driver, executor } = setup([], null);
      driver.setElements([{ text: "Tap", bounds: makeElement("a", 0).bounds }], null);

      const failure = await failureOf(executor.navigateToElement("device-1", { text: "Tap" }));

      expect(failure).toBeInstanceOf(FocusNavigationUnavailableError);
      expect(failure!.message).toContain("without a touch gesture");
      expect(driver.getFocusRequestCount()).toBe(0);
    });

    test("a resource-id shared by several nodes cannot be addressed", async () => {
      const { driver, executor } = setup([], null);
      driver.setElements([makeElement("dup", 0), makeElement("dup", 1), makeElement("x", 2)], 2);

      const failure = await failureOf(
        executor.navigateToElement("device-1", { resourceId: "dup" }),
      );

      expect(failure).toBeInstanceOf(FocusNavigationUnavailableError);
      expect(failure!.message).toContain("shared by 2 elements");
      expect(driver.getFocusRequestCount()).toBe(0);
    });

    test("a runner without node selectors cannot be asked to focus a test-tag target", async () => {
      const { driver, executor } = setup([], null);
      const tagged: Element = { bounds: makeElement("a", 0).bounds, "test-tag": "pay" };
      driver.setElements([tagged], null);
      driver.nodeActionSelectorsSupported = false;

      const failure = await failureOf(
        executor.navigateToElement("device-1", { testTag: "pay", bounds: tagged.bounds }),
      );

      expect(failure).toBeInstanceOf(FocusNavigationUnavailableError);
      expect(failure!.message).toContain("does not support stable node selectors");
      expect(driver.getFocusRequestCount()).toBe(0);
    });

    test("a target absent from the traversal cannot be addressed", async () => {
      const { driver, executor } = setup(traversal(2), 0);

      const failure = await failureOf(
        executor.navigateToElement("device-1", { resourceId: "does-not-exist" }),
      );

      expect(failure).toBeInstanceOf(FocusNavigationUnavailableError);
      expect(failure!.message).toBe(
        'Target not found in the accessibility traversal (resourceId="does-not-exist"). Use observe to inspect elements and the diagnostics returned by tapOn/waitFor failures.',
      );
      expect(driver.getFocusRequestCount()).toBe(0);
    });

    test("reports child-cap truncation for a missing target", async () => {
      const elements = traversal(2);
      const { driver, executor } = setup(elements, 0);
      driver.queueTraversalResult({
        elements,
        focusedIndex: 0,
        totalCount: elements.length,
        totalTimeMs: 1,
        truncationReasons: ["max_children"],
      });

      await expect(
        executor.navigateToElement("device-1", { resourceId: "missing" }),
      ).rejects.toThrow(
        "the accessibility traversal was truncated (max_children); the target may be beyond the cap",
      );
    });

    test("an unreadable traversal cannot be navigated", async () => {
      const { driver, executor } = setup(traversal(2), 0);
      driver.queueTraversalResult({
        elements: [],
        focusedIndex: null,
        totalCount: 0,
        totalTimeMs: 1,
        error: "Traversal order timeout after 5000ms",
      });

      const failure = await failureOf(executor.navigateToElement("device-1", { resourceId: "e1" }));

      expect(failure).toBeInstanceOf(FocusNavigationUnavailableError);
      expect(failure!.message).toContain("Traversal order timeout");
    });

    test("rejects focus navigation on a non-Android device", async () => {
      const driver = new FakeFocusNavigationDriver();
      driver.setElements(traversal(3), 0);
      const executor = new FocusNavigationExecutor({
        timer: new FakeTimer(),
        driverFactory: { createDriver: () => driver },
        deviceResolver: (deviceId) => ({ name: deviceId, deviceId, platform: "ios" }),
      });

      await expect(executor.navigateToElement("udid-ios", { resourceId: "e2" })).rejects.toThrow(
        /only supported on Android/,
      );
      expect(driver.getFocusRequestCount()).toBe(0);
    });
  });

  test("screenFingerprint ignores order and cursor but not what is shown or where", () => {
    const [a, b] = traversal(2);
    expect(screenFingerprint([a, b])).toBe(screenFingerprint([b, a]));
    expect(screenFingerprint([a, b])).not.toBe(screenFingerprint([a, { ...b, text: "x" }]));
    expect(screenFingerprint([a, b])).not.toBe(screenFingerprint([a, makeElement("e1", 9)]));
  });
});
