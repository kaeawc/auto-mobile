import { afterEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { createSwipeAtHandler, swipeAtSchema } from "../../src/server/swipeAtTools";
import {
  type InteractionToolDependencies,
  tapAtHandler,
  tapAtSchema,
} from "../../src/server/interactionTools";

const interactionDeps: InteractionToolDependencies = {};
const device: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };

afterEach(() => delete interactionDeps.tapAtElementFactory);

const swipe = { from: { x: 1, y: 2 }, to: { x: 3, y: 4 } };
const tap = { x: 1, y: 2 };

describe("pointer option schema (#13081)", () => {
  test("tapAt and swipeAt accept a stylus pointer", () => {
    expect(tapAtSchema.safeParse({ ...tap, pointer: { toolType: "stylus" } }).success).toBe(true);
    expect(
      swipeAtSchema.safeParse({ ...swipe, pointer: { toolType: "stylus", pressure: 1 } }).success,
    ).toBe(true);
  });

  test.each([
    ["an unknown tool type", { toolType: "finger" }],
    ["a missing tool type", { pressure: 1 }],
    ["an unknown key", { toolType: "stylus", tilt: 10 }],
    ["pressure above 1", { toolType: "stylus", pressure: 1.5 }],
    ["negative pressure", { toolType: "stylus", pressure: -0.1 }],
  ])("%s is rejected as a malformed pointer", (_name, pointer) => {
    // The issue must sit under `pointer`; a bare unrecognized-key error on the root would mean
    // the option is not in the schema at all.
    for (const result of [
      tapAtSchema.safeParse({ ...tap, pointer }),
      swipeAtSchema.safeParse({ ...swipe, pointer }),
    ]) {
      expect(result.success).toBe(false);
      expect(result.error?.issues.some((issue) => issue.path[0] === "pointer")).toBe(true);
    }
  });

  test("the pointer stays optional", () => {
    expect(tapAtSchema.safeParse(tap).success).toBe(true);
    expect(swipeAtSchema.safeParse(swipe).success).toBe(true);
  });
});

describe("handlers forward the pointer to the action (#13081)", () => {
  test("tapAt hands a stylus pointer to the executor, so it can never run as a finger", async () => {
    const seen: unknown[] = [];
    interactionDeps.tapAtElementFactory = () =>
      ({
        execute: async (options: { pointer?: unknown }) => {
          seen.push(options.pointer);
          return { success: true, x: 1, y: 2, action: "tap" };
        },
      }) as never;

    await tapAtHandler(
      device,
      { x: 1, y: 2, pointer: { toolType: "stylus" } },
      { deps: interactionDeps },
    );
    expect(seen).toEqual([{ toolType: "stylus" }]);
  });

  test("swipeAt hands a stylus pointer to the executor", async () => {
    const seen: unknown[] = [];
    const handler = createSwipeAtHandler({
      swipeAtFactory: () => ({
        execute: async (options) => {
          seen.push(options.pointer);
          return { success: true, x1: 1, y1: 2, x2: 3, y2: 4, duration: 300 };
        },
      }),
    });

    await handler(device, {
      from: { x: 1, y: 2 },
      to: { x: 3, y: 4 },
      pointer: { toolType: "stylus" },
    });
    expect(seen).toEqual([{ toolType: "stylus" }]);
  });
});
