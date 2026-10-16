import { expect, test } from "bun:test";
import { createMultiTouchHandler, multiTouchSchema } from "../../src/server/multiTouchTools";
import type { BootedDevice, MultiTouchOptions, MultiTouchResult } from "../../src/models";

const device: BootedDevice = { deviceId: "mt", platform: "android", name: "fake" };

const failedPaths = (input: unknown): string[] => {
  const result = multiTouchSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => String(issue.path[0]));
};

test("the schema accepts each action and 2-5 fingers", () => {
  for (const fingers of [2, 3, 4, 5]) {
    expect(multiTouchSchema.safeParse({ action: "tap", x: 5, y: 5, fingers }).success).toBe(true);
  }
  expect(
    multiTouchSchema.safeParse({ action: "swipe", x: 5, y: 5, fingers: 3, direction: "up" })
      .success,
  ).toBe(true);
  expect(
    multiTouchSchema.safeParse({ action: "longPress", x: 5, y: 5, durationMs: 800 }).success,
  ).toBe(true);
});

test("the schema refuses unsupported counts, missing direction and bad normalized points", () => {
  expect(failedPaths({ action: "tap", x: 5, y: 5, fingers: 1 })).toContain("fingers");
  expect(failedPaths({ action: "tap", x: 5, y: 5, fingers: 6 })).toContain("fingers");
  expect(failedPaths({ action: "swipe", x: 5, y: 5 })).toContain("direction");
  expect(failedPaths({ action: "tap", x: 5, y: 5, direction: "up" })).toContain("direction");
  expect(failedPaths({ action: "longPress", x: 5, y: 5, durationMs: 100 })).toContain("durationMs");
  expect(failedPaths({ action: "tap", x: 2, y: 0.5, coordinateSpace: "normalized" })).toContain(
    "x",
  );
  expect(failedPaths({ action: "tap", x: 5, y: 5, bogus: 1 }).length).toBeGreaterThan(0);
});

test("the handler forwards options and marks a failed gesture as an error", async () => {
  let seen: MultiTouchOptions | undefined;
  const result = (success: boolean): MultiTouchResult => ({
    success,
    error: success ? undefined : "refused",
    x1: 1,
    y1: 2,
    x2: 1,
    y2: 2,
    duration: 50,
    action: "tap",
    fingers: 3,
    fingerSpacing: 100,
    points: [],
  });
  let ok = true;
  const handler = createMultiTouchHandler({
    multiTouchFactory: () => ({
      execute: async (options) => {
        seen = options;
        return result(ok);
      },
    }),
  });
  const success = await handler(device, { action: "tap", x: 1, y: 2, fingers: 3, layer: "app" });
  expect(seen).toMatchObject({ action: "tap", x: 1, y: 2, fingers: 3, layer: "app" });
  expect(success.isError).toBeUndefined();
  ok = false;
  const failure = await handler(device, { action: "tap", x: 1, y: 2 });
  expect(failure.isError).toBe(true);
});
