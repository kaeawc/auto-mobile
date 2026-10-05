import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { harness } from "./displaySwipeHarness";
import { logger } from "../../../../src/utils/logger";

afterEach(() => mock.restore());
const search = { direction: "up", display: "external", lookFor: { text: "Found" } } as const;

for (const unavailable of ["API 24", "metadata failure", "unsupported drag"] as const) {
  test(`correction: display lookFor ${unavailable} uses one slow targeted ADB fallback`, async () => {
    const h = harness({ foundAfter: 1 });
    if (unavailable === "unsupported drag") {
      spyOn(h.ctrl, "requestDrag").mockResolvedValue({
        success: false,
        error: "unsupported command",
        totalTimeMs: 0,
      });
    } else {
      spyOn(h.ctrl, "requestDeviceInfo").mockResolvedValue(
        unavailable === "API 24"
          ? { success: true, sdkInt: 24, totalTimeMs: 0 }
          : { success: false, error: "not connected", totalTimeMs: 0 },
      );
    }
    expect(await h.action.execute(search)).toMatchObject({
      success: true,
      found: true,
      scrollIterations: 1,
    });
    expect(h.commands()).toEqual(["shell input touchscreen -d 2 swipe 100 180 100 30 600"]);
    expect(h.ctrl.getDragHistory()).toEqual([]);
    expect(h.legs()).toHaveLength(1);
  });
}

test("correction: display dispatched timeout stops without a second ADB scroll", async () => {
  const h = harness({ foundAfter: Infinity });
  h.ctrl.setDragResult({ success: false, error: "timed out", totalTimeMs: 0 });
  const result = await h.action.execute(search);
  expect(result.success).toBe(false);
  expect(result.error).toContain("indeterminate");
  expect(result.error).toContain("gesture was dispatched");
  expect(result.error).toContain("Do not retry automatically");
  expect(h.ctrl.getDragHistory()).toHaveLength(1);
  expect(h.commands()).toEqual([]);
});

test("display drag transition after dispatch retains the delivered marker and staleDisplay", async () => {
  const h = harness({ foundAfter: Infinity });
  h.useRealObservedInteraction();
  h.afterSwipe(() => h.flip());
  const result = await h.action.execute(search);
  expect(result.success).toBe(false);
  expect(result.error).toContain("gesture was dispatched");
  expect(result.error).toContain("Do not retry automatically");
  expect(result.staleDisplay?.retry).toBe("observe");
  expect(h.legs()).toHaveLength(1);
  expect(h.commands()).toEqual([]);
});

for (const scrollMode of [undefined, "a11y"] as const) {
  test(`correction: unavailable display capability probe respects explicit mode (${scrollMode})`, async () => {
    const h = harness({ foundAfter: 1 });
    spyOn(h.ctrl, "supportsCommand").mockRejectedValue(new Error("not connected"));
    const result = await h.action.execute({ ...search, scrollMode });
    if (scrollMode === "a11y") {
      expect(result.success).toBe(false);
      expect(result.error).toContain("not connected");
      expect(h.commands()).toEqual([]);
    } else {
      expect(result).toMatchObject({ success: true, found: true });
      expect(h.commands()).toEqual(["shell input touchscreen -d 2 swipe 100 180 100 30 600"]);
    }
    expect(h.ctrl.getDragHistory()).toEqual([]);
  });
}

test("correction: explicit ADB display fallback logs once across three steps", async () => {
  const h = harness({ route: "adb", foundAfter: 3 });
  const debug = spyOn(logger, "debug");
  expect(await h.action.execute(search)).toMatchObject({ found: true, scrollIterations: 3 });
  expect(h.commands()).toHaveLength(3);
  expect(
    debug.mock.calls.filter(([message]) => message.includes("slow ADB swipe fallback")),
  ).toHaveLength(1);
});

test("correction: display fallback keeps the timeout bound", async () => {
  const h = harness({ route: "adb", foundAfter: Infinity });
  const result = await h.action.execute({ ...search, lookFor: { text: "Found", maxTime: 1 } });
  expect(result.success).toBe(false);
  expect(result.error).toContain("timeout=1ms");
  expect(h.commands()).toHaveLength(1);
});

test("review: explicit-display device-info probe is cached per search", async () => {
  const h = harness({ foundAfter: 3 });
  const info = spyOn(h.ctrl, "requestDeviceInfo");
  expect(await h.action.execute(search)).toMatchObject({ found: true, scrollIterations: 3 });
  expect(info).toHaveBeenCalledTimes(1);
});
