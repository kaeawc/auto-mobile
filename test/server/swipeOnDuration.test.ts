import { afterEach, expect, test } from "bun:test";
import {
  type InteractionToolDependencies,
  swipeOnHandler,
  swipeOnSchema,
} from "../../src/server/interactionTools";
import type { BootedDevice, SwipeOnOptions } from "../../src/models";
import {
  SWIPE_DURATION_MAX_MS,
  SWIPE_DURATION_MIN_MS,
  validateSwipeTimingOptions,
} from "../../src/features/action/swipeon/swipeTiming";

const interactionDeps: InteractionToolDependencies = {};
const device: BootedDevice = { deviceId: "fake", platform: "android", name: "fake" };

afterEach(() => delete interactionDeps.swipeOnFactory);

const failedPaths = (input: unknown): string[] => {
  const result = swipeOnSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => String(issue.path[0]));
};

test("durationMs bounds are integer 1..max and rejected before dispatch (#12538)", () => {
  expect(
    swipeOnSchema.safeParse({ direction: "up", durationMs: SWIPE_DURATION_MIN_MS }).success,
  ).toBe(true);
  expect(
    swipeOnSchema.safeParse({ direction: "up", durationMs: SWIPE_DURATION_MAX_MS }).success,
  ).toBe(true);
  for (const durationMs of [0, SWIPE_DURATION_MAX_MS + 1, 1.5, -5]) {
    expect(failedPaths({ direction: "up", durationMs })).toContain("durationMs");
  }
});

test("durationMs excludes speed and lookFor, and must fit the boomerang budget", () => {
  expect(failedPaths({ direction: "up", durationMs: 100, speed: "fast" })).toContain("durationMs");
  expect(failedPaths({ direction: "up", durationMs: 100, lookFor: { text: "x" } })).toContain(
    "durationMs",
  );
  expect(
    validateSwipeTimingOptions({ boomerang: true, durationMs: 3000, apexPause: 1500 }),
  ).toContain("boomerang duration");
  expect(validateSwipeTimingOptions({ boomerang: true, durationMs: 1000 })).toBeNull();
});

test("handler forwards durationMs", async () => {
  let seen: SwipeOnOptions | undefined;
  interactionDeps.swipeOnFactory = () =>
    ({
      execute: async (options: SwipeOnOptions) => {
        seen = options;
        return { success: true, x1: 0, y1: 0, x2: 0, y2: 0, duration: 120 };
      },
    }) as never;
  await swipeOnHandler(device, { direction: "up", durationMs: 120 }, { deps: interactionDeps });
  expect(seen?.durationMs).toBe(120);
  await swipeOnHandler(device, { direction: "up" }, { deps: interactionDeps });
  expect(seen?.durationMs).toBeUndefined();
});
