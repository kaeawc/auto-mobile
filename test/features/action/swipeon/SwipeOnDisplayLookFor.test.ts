import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SwipeOnOptions } from "../../../../src/models";
import { harness } from "./displaySwipeHarness";
import type { BootedDevice } from "../../../../src/models";
import { runSessionDisplayPin } from "../../../../src/server/sessionDisplayPin";
import { createStructuredToolResponse } from "../../../../src/utils/toolUtils";
import { encodeIosDollar } from "../../../fixtures/hierarchyArbitraries";

const search: SwipeOnOptions = {
  direction: "up",
  display: "external",
  lookFor: { text: "Found", maxTime: 3000 },
};
afterEach(() => mock.restore());
for (const route of ["sole pin", "other panel pin", "explicit display", "no pin"] as const) {
  test(`session pin options: iOS swipeOn lookFor with ${route}`, async () => {
    const target: BootedDevice = {
      name: "Search fake",
      deviceId: "swipe-display-search",
      platform: "ios",
      displays: {
        panels: [
          ...(route === "sole pin"
            ? []
            : [{ key: "internal", role: "inner" as const, sizePx: { width: 100, height: 100 } }]),
          { key: "external", role: "external", sizePx: { width: 200, height: 200 } },
        ],
        postures: [],
      },
    };
    const h = harness({
      platform: "ios",
      observationFor: ({ observation }) => ({
        ...observation,
        display: { ...observation.display, key: "external" },
        screenSize: { width: 400, height: 800 },
        systemInsets: { left: 0, top: 0, right: 0, bottom: 0 },
        viewHierarchy: {
          screenWidth: 400,
          screenHeight: 800,
          hierarchy: {
            node: encodeIosDollar({
              attrs: { class: "XCUIElementTypeApplication" },
              bounds: { left: 0, top: 0, right: 400, bottom: 800 },
              children: [
                {
                  attrs: { text: "Found", "resource-id": "found", visible: true },
                  bounds: { left: 80, top: 80, right: 120, bottom: 120 },
                  children: [],
                },
              ],
            }),
          },
        },
      }),
    });
    const response = await runSessionDisplayPin({
      name: "swipeOn",
      acceptsDisplay: true,
      device: target,
      sessionUuid: "s1",
      store: {
        getDeviceForSession: () => target.deviceId,
        getDisplayPin: () => (route === "no pin" ? undefined : "external"),
      },
      args: route === "explicit display" ? { display: "external" } : {},
      invoke: async (args) =>
        createStructuredToolResponse(
          await h.action.execute({
            direction: "up",
            lookFor: { text: "Found" },
            display: typeof args.display === "string" ? args.display : undefined,
          }),
        ),
    });
    if (route === "sole pin" || route === "no pin") {
      expect(response).toMatchObject({ structuredContent: { success: true, found: true } });
      expect(h.observe.getExecuteCallCount()).toBeGreaterThan(0);
      expect(h.observe.getExecuteOptions().every((options) => options.display === undefined)).toBe(
        true,
      );
      expect(response).toMatchObject({
        structuredContent: {
          observation: {
            display: {
              key: "external",
              ...(route === "sole pin" ? { pinned: true } : {}),
            },
          },
        },
      });
    } else {
      expect(response).toMatchObject({
        structuredContent: {
          success: false,
          error:
            route === "explicit display"
              ? "lookFor is not supported with `display` yet"
              : 'lookFor is not supported while the session is pinned to display "external". Clear the pin with setActiveDevice {display: null} (include deviceId and sessionUuid), then retry.',
        },
      });
      expect(h.observe.getExecuteCallCount()).toBe(0);
    }
  });
}

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
        expect(h.legs().every((leg) => leg.duration === 600)).toBe(true);
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
          expect(
            h.ctrl
              .getDragHistory()
              .every((leg) => leg.displayId === 2 && leg.holdDurationMs === 100),
          ).toBe(true);
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
        h.ctrl.setDragResult({ success: false, error: "search swipe failed", totalTimeMs: 0 });
      } else {
        h.adb.setCommandResult(
          "shell input touchscreen -d 2 swipe 100 180 100 30 600",
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
                ? { x1: 100, y1: 180, x2: 100, y2: 30 }
                : { x1: 110, y1: 168, x2: 110, y2: 78 }
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
      expect(searching.legs()[0]).toMatchObject({ x1: 100, y1: 180, x2: 100, y2: 30 });
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
