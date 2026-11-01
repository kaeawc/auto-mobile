import { afterEach, expect, test } from "bun:test";
import {
  type InteractionToolDependencies,
  swipeOnHandler,
  swipeOnSchema,
} from "../../src/server/interactionTools";
import type { BootedDevice, SwipeOnOptions } from "../../src/models";

const interactionDeps: InteractionToolDependencies = {};
const device: BootedDevice = { deviceId: "fake", platform: "android", name: "fake" };

afterEach(() => delete interactionDeps.swipeOnFactory);

const failedPaths = (input: unknown): string[] => {
  const result = swipeOnSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => String(issue.path[0]));
};

test("fromEdge schema enforces inward direction, exclusivity and ranges (#12537)", () => {
  expect(
    swipeOnSchema.safeParse({ direction: "right", fromEdge: "left", at: 0.2, edgeInset: 8 })
      .success,
  ).toBe(true);
  expect(failedPaths({ direction: "left", fromEdge: "left" })).toContain("fromEdge");
  expect(failedPaths({ direction: "up", at: 0.5 })).toContain("fromEdge");
  expect(failedPaths({ direction: "right", fromEdge: "left", container: { text: "x" } })).toContain(
    "fromEdge",
  );
  expect(failedPaths({ direction: "right", fromEdge: "left", at: 2 })).toContain("at");
  expect(failedPaths({ direction: "right", fromEdge: "left", edgeInset: 51 })).toContain(
    "edgeInset",
  );
  // A scroll-content direction maps to the opposite finger direction.
  expect(
    swipeOnSchema.safeParse({
      direction: "left",
      gestureType: "scrollTowardsDirection",
      fromEdge: "left",
    }).success,
  ).toBe(true);
});

test("handler forwards the new options and turns autoTarget off for an edge swipe", async () => {
  let seen: SwipeOnOptions | undefined;
  interactionDeps.swipeOnFactory = () =>
    ({
      execute: async (options: SwipeOnOptions) => {
        seen = options;
        return { success: true, x1: 0, y1: 0, x2: 0, y2: 0, duration: 120 };
      },
    }) as never;
  await swipeOnHandler(
    device,
    {
      direction: "right",
      fromEdge: "left",
      at: 0.4,
      edgeInset: 6,
      durationMs: 120,
    },
    { deps: interactionDeps },
  );
  expect(seen).toMatchObject({
    fromEdge: "left",
    at: 0.4,
    edgeInset: 6,
    durationMs: 120,
    autoTarget: false,
  });
  await swipeOnHandler(device, { direction: "up" }, { deps: interactionDeps });
  expect(seen?.autoTarget).toBe(true);
  expect(seen?.durationMs).toBeUndefined();
});
