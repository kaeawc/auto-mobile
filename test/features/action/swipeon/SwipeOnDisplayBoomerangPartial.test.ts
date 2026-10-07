import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { SwipeOnOptions } from "../../../../src/models";
import { harness } from "./displaySwipeHarness";

const boomerang: SwipeOnOptions = {
  direction: "up",
  display: "external",
  boomerang: true,
  apexPause: 25,
};

afterEach(() => mock.restore());

test("display boomerang whose return leg fails reports a partial application (#9973)", async () => {
  const h = harness();
  h.afterSwipe(() => {
    if (h.legs().length === 1) {
      h.ctrl.setSwipeResult({ success: false, error: "Swipe timed out after 5000ms" });
    }
  });
  const result = await h.action.execute(boomerang);

  expect(h.legs()).toHaveLength(2);
  expect(result.success).toBe(false);
  expect(result.error).toContain("Boomerang partially applied");
  expect(result.error).toContain("forward swipe was delivered");
  expect(result.error).toContain("Swipe timed out after 5000ms");
  expect(result.error).toContain("Observe before retrying");
  expect(result).toMatchObject({ retryable: false, partialApplication: true });
  expect(result.duration).toBeGreaterThan(0);
});

test("display boomerang return leg failing on the adb route is also partial", async () => {
  const h = harness({ route: "adb" });
  h.afterSwipe(() =>
    h.adb.setPreDispatchError(
      "shell input touchscreen -d 2 swipe 100 40 100 160 300",
      new Error("input swipe rejected"),
    ),
  );
  const result = await h.action.execute(boomerang);

  expect(h.commands()).toHaveLength(1);
  expect(result.success).toBe(false);
  expect(result.error).toContain("Boomerang partially applied");
  expect(result.error).toContain("input swipe rejected");
  expect(result).toMatchObject({ retryable: false, partialApplication: true });
});

test("a failed FORWARD display swipe is not reported as partially applied", async () => {
  const h = harness();
  h.ctrl.setSwipeResult({ success: false, error: "forward dispatch failed" });
  const result = await h.action.execute(boomerang);

  expect(h.legs()).toHaveLength(1);
  expect(result.success).toBe(false);
  expect(result.error).toContain("forward dispatch failed");
  expect(result.error).not.toContain("partially applied");
  expect(result).not.toHaveProperty("partialApplication");
});

test("a successful display boomerang is unchanged", async () => {
  const h = harness();
  const result = await h.action.execute(boomerang);

  expect(result.success).toBe(true);
  expect(h.legs()).toHaveLength(2);
  expect(h.timer.getSleepHistory()).toEqual([25]);
  expect(result).not.toHaveProperty("partialApplication");
});

test("cancelling during the display apex pause stops before the return leg", async () => {
  const h = harness();
  const controller = new AbortController();
  // A pause that never completes: only the abort signal can end it, and it fires once the
  // pause has started (after the forward leg has fully returned).
  spyOn(h.timer, "sleep").mockImplementation(() => {
    queueMicrotask(() => controller.abort());
    return new Promise<void>(() => {});
  });

  const error = await h.action.execute(boomerang, undefined, controller.signal).then(
    () => undefined,
    (caught: unknown) => caught,
  );

  expect(h.legs()).toHaveLength(1);
  expect(error).toBeInstanceOf(Error);
  // The caller sees a cancellation that still says the forward swipe landed.
  expect((error as Error).message).toContain("Operation cancelled");
  expect((error as Error).message).toContain("forward swipe was delivered");
  expect((error as Error).message).toContain("do not retry automatically");
});
