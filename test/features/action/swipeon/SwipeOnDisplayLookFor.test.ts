import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SwipeOnOptions } from "../../../../src/models";
import { harness } from "./displaySwipeHarness";

const search: SwipeOnOptions = {
  direction: "up",
  display: "external",
  lookFor: { text: "Found", maxTime: 3000 },
};
afterEach(() => mock.restore());
for (const route of ["ctrlproxy", "adb"] as const) {
  describe(`display search via ${route}`, () => {
    for (const n of [0, 1, 3]) {
      test(`finds after ${n} swipes using targeted observations`, async () => {
        const h = harness({ route, foundAfter: n });
        const result = await h.action.execute(search);
        expect(result).toMatchObject({
          success: true,
          found: true,
          targetType: "element",
          element: { text: "Found" },
          scrollIterations: n,
          elapsedMs: n * 300,
          x1: 0,
          y1: 0,
          x2: 0,
          y2: 0,
          duration: 0,
          observation: { display: { key: "external" } },
        });
        expect(h.legs()).toHaveLength(n);
        expect(
          h.observe.getExecuteOptions().every((options) => options.display === "external"),
        ).toBe(true);
        expect(
          h.interactions.every(
            (options) =>
              options.display === "external" &&
              options.previousObservation?.display.key === "external",
          ),
        ).toBe(true);
        expect(h.talkback).not.toHaveBeenCalled();
        expect(h.voiceover).not.toHaveBeenCalled();
        if (route === "ctrlproxy") {
          expect(h.ctrl.getSwipeHistory().every((leg) => leg.displayId === 2)).toBe(true);
          expect(h.commands()).toEqual([]);
        } else {
          expect(
            h
              .commands()
              .every((command) => command.startsWith("shell input touchscreen -d 2 swipe ")),
          ).toBe(true);
          expect(h.ctrl.getSwipeHistory()).toEqual([]);
        }
      });
    }
    test("timeout uses shared not-found failure despite default panel containing Found", async () => {
      const h = harness({ route, foundAfter: Infinity });
      const result = await h.action.execute({
        ...search,
        lookFor: { text: "Found", maxTime: 600 },
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'text "Found" not found after scrolling for 600ms (2 iterations, timeout=600ms).',
      );
      expect(h.legs()).toHaveLength(2);
    });
    test("unchanged list reverses then reports shared end-of-container failure", async () => {
      const h = harness({ route, foundAfter: Infinity, unchanged: true });
      const result = await h.action.execute(search);
      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Scroll reached end of container (no change after 1 scrolls). text "Found" not found after 2 iterations (600ms).',
      );
      expect(h.legs()).toHaveLength(2);
      expect(h.legs()[1].y1).toBeLessThan(h.legs()[1].y2);
    });
    test("dispatch failure is a failure result and stops the search", async () => {
      const h = harness({ route });
      if (route === "ctrlproxy") {
        h.ctrl.setSwipeResult({ success: false, error: "search swipe failed" });
      } else {
        h.adb.setCommandResult(
          "shell input touchscreen -d 2 swipe 100 180 100 20 300",
          "Error: search swipe failed",
        );
      }
      const result = await h.action.execute(search);
      expect(result.success).toBe(false);
      expect(result.error).toContain("search swipe failed");
      expect(h.legs()).toHaveLength(1);
    });
    test("transition after two swipes stops search with staleDisplay", async () => {
      const h = harness({ route, foundAfter: 2 });
      h.afterSwipe(() => {
        if (h.legs().length === 2) {
          h.flip();
        }
      });
      const result = await h.action.execute(search);
      expect(result.success).toBe(false);
      expect(result.staleDisplay).toEqual({
        observedGeneration: 1,
        currentGeneration: 2,
        currentDisplayKey: "internal",
        retry: "observe",
      });
      expect(result.error).not.toContain("not found");
      expect(h.legs()).toHaveLength(2);
    });
    for (const count of [2, 3, 4, 5]) {
      test(`wrong panel observation at capture ${count} cannot satisfy search`, async () => {
        const h = harness({ route, foundAfter: Infinity, unchanged: true, stale: true });
        h.onObserve((index) => {
          if (index === count) {
            h.wrongPanel();
          }
        });
        const result = await h.action.execute(search);
        expect(result.success).toBe(false);
        expect(result.staleDisplay?.retry).toBe("observe");
        expect(h.legs().length).toBeLessThanOrEqual(1);
      });
    }
    test("transition during scroll idle stops before another dispatch", async () => {
      const h = harness({ route, foundAfter: Infinity });
      h.onObserve((count) => {
        if (count === 4) {
          h.flip();
        }
      });
      const result = await h.action.execute(search);
      expect(result.success).toBe(false);
      expect(result.staleDisplay?.retry).toBe("observe");
      expect(h.legs()).toHaveLength(1);
    });
    for (const extra of [{ focusTarget: false }] satisfies Array<Partial<SwipeOnOptions>>) {
      test(`rejects ${Object.keys(extra)[0]} before observe even with search`, async () => {
        const h = harness({ route });
        const result = await h.action.execute({ ...search, ...extra });
        expect(result).toMatchObject({
          success: false,
          error: `${Object.keys(extra)[0]} is not supported with \`display\` yet`,
        });
        expect(h.observe.getExecuteCallCount()).toBe(0);
        expect(h.legs()).toEqual([]);
      });
    }
    for (const includeSystemInsets of [false, true]) {
      for (const lookFor of [undefined, search.lookFor]) {
        test(`unavailable insets reject ${includeSystemInsets}, search=${!!lookFor}`, async () => {
          const h = harness({ route });
          const result = await h.action.execute({ ...search, lookFor, includeSystemInsets });
          expect(result.success).toBe(false);
          expect(result.error).toBe(
            'includeSystemInsets is not supported with `display` for display "external": per-display system insets are unavailable',
          );
          expect(h.observe.getExecuteCallCount()).toBe(1);
          expect(h.legs()).toEqual([]);
        });
      }
      for (const lookFor of [undefined, search.lookFor]) {
        test(`available insets coordinates ${includeSystemInsets}, search=${!!lookFor}`, async () => {
          const h = harness({ route, available: true, foundAfter: 1 });
          const result = await h.action.execute({ ...search, lookFor, includeSystemInsets });
          expect(result.success).toBe(true);
          expect(h.legs()).toHaveLength(1);
          expect(h.legs()[0]).toMatchObject(
            lookFor
              ? includeSystemInsets
                ? { x1: 100, y1: 180, x2: 100, y2: 20 }
                : { x1: 110, y1: 168, x2: 110, y2: 72 }
              : includeSystemInsets
                ? { x1: 100, y1: 160, x2: 100, y2: 40 }
                : { x1: 110, y1: 156, x2: 110, y2: 84 },
          );
        });
      }
    }
    test("undefined insets preserve plain swipe and ignore unverified inset values in search", async () => {
      const h = harness({ route, foundAfter: 1 });
      expect((await h.action.execute({ direction: "up", display: "external" })).success).toBe(true);
      expect(h.legs()[0]).toMatchObject({ x1: 100, y1: 160, x2: 100, y2: 40 });
      const searching = harness({ route, foundAfter: 1 });
      const result = await searching.action.execute(search);
      expect(result.success).toBe(true);
      expect(searching.legs()[0]).toMatchObject({ x1: 100, y1: 180, x2: 100, y2: 20 });
    });
    test("display lookFor explicitly rejects boomerang before observing", async () => {
      const h = harness({ route });
      const result = await h.action.execute({
        ...search,
        boomerang: true,
        apexPause: 25,
        returnSpeed: 2,
      });
      expect(result).toMatchObject({
        success: false,
        error: "boomerang cannot be used with lookFor",
      });
      expect(h.observe.getExecuteCallCount()).toBe(0);
      expect(h.legs()).toEqual([]);
    });
  });
}
for (const route of ["ctrlproxy", "adb"] as const) {
  for (const capture of [3, 4, 5]) {
    test(`real post-action pipeline refuses wrong panel at capture ${capture} via ${route}`, async () => {
      const h = harness({ route, foundAfter: Infinity });
      h.useRealObservedInteraction();
      h.onObserve((count) => {
        h.wrongPanel(count === capture);
      });
      const result = await h.action.execute(search);
      expect(result.success).toBe(false);
      expect(result.staleDisplay?.retry).toBe("observe");
      expect(h.legs()).toHaveLength(1);
      expect(h.observe.getExecuteCallCount()).toBe(capture);
    });
  }
}
for (const extra of [
  { lookFor: { text: "Found" } },
  { includeSystemInsets: false },
  { includeSystemInsets: true },
] satisfies Array<Partial<SwipeOnOptions>>) {
  test(`iOS still rejects ${JSON.stringify(extra)}`, async () => {
    const h = harness({ platform: "ios" });
    const result = await h.action.execute({ direction: "up", display: "external", ...extra });
    expect(result).toMatchObject({
      success: false,
      error: `${Object.keys(extra)[0]} is not supported with \`display\` yet`,
    });
    expect(h.observe.getExecuteCallCount()).toBe(0);
    expect(h.legs()).toEqual([]);
  });
}
test("default lookFor stays on shared default observation path", async () => {
  const h = harness();
  const result = await h.action.execute({ direction: "up", lookFor: { text: "Found" } });
  expect(result).toMatchObject({
    success: true,
    found: true,
    scrollIterations: 0,
    observation: { display: { key: "internal" } },
  });
  expect(h.observe.getExecuteOptions().every((options) => options.display === undefined)).toBe(
    true,
  );
  expect(h.legs()).toEqual([]);
});
