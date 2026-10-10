import { afterEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import {
  pinchOnHandler,
  pinchOnSchema,
  resetPinchOnFactory,
  resetSelectAllTextFactory,
  resetSwipeOnFactory,
  resetTapAtElementFactory,
  selectAllTextHandler,
  selectAllTextSchema,
  setPinchOnFactory,
  setSelectAllTextFactory,
  setSwipeOnFactory,
  setTapAtElementFactory,
  swipeOnHandler,
  swipeOnSchema,
  tapAtHandler,
  tapAtSchema,
  type PinchOnLike,
  type SelectAllTextLike,
  type SwipeOnLike,
  type TapAtElementLike,
} from "../../src/server/interactionTools";

const device: BootedDevice = { name: "Android", platform: "android", deviceId: "emulator-5600" };

afterEach(() => {
  resetPinchOnFactory();
  resetSelectAllTextFactory();
  resetSwipeOnFactory();
  resetTapAtElementFactory();
});

describe("coordinate and focus tool layer argument (#9305)", () => {
  test.each([
    ["tapAt", tapAtSchema, { x: 1, y: 2 }],
    ["swipeOn", swipeOnSchema, { direction: "up" }],
    ["pinchOn", pinchOnSchema, { direction: "in" }],
    ["selectAllText", selectAllTextSchema, {}],
  ] as const)("%s accepts app and prototype and rejects anything else", (_name, schema, base) => {
    expect(schema.safeParse({ ...base, layer: "app" }).success).toBe(true);
    expect(schema.safeParse({ ...base, layer: "prototype" }).success).toBe(true);
    expect(schema.safeParse({ ...base, layer: "target" }).success).toBe(false);
  });

  test("handlers pass layer through to the action", async () => {
    const seen: unknown[] = [];
    setTapAtElementFactory(
      () =>
        ({
          execute: async (options: { layer?: string }) => {
            seen.push(["tapAt", options.layer]);
            return { success: true, x: 1, y: 2, action: "tap" };
          },
        }) as unknown as TapAtElementLike,
    );
    setSwipeOnFactory(
      () =>
        ({
          execute: async (options: { layer?: string }) => {
            seen.push(["swipeOn", options.layer]);
            return { success: true, targetType: "screen", x1: 0, y1: 0, x2: 0, y2: 0, duration: 0 };
          },
        }) as unknown as SwipeOnLike,
    );
    setPinchOnFactory(
      () =>
        ({
          execute: async (options: { layer?: string }) => {
            seen.push(["pinchOn", options.layer]);
            return { success: true };
          },
        }) as unknown as PinchOnLike,
    );
    setSelectAllTextFactory(
      () =>
        ({
          execute: async (_progress: unknown, _signal: unknown, options: { layer?: string }) => {
            seen.push(["selectAllText", options.layer]);
            return { success: true };
          },
        }) as unknown as SelectAllTextLike,
    );

    await tapAtHandler(device, { x: 1, y: 2, layer: "app" });
    await swipeOnHandler(device, { direction: "up", layer: "prototype" });
    await pinchOnHandler(device, { direction: "in", layer: "app" });
    await selectAllTextHandler(device, { layer: "prototype" });

    expect(seen).toEqual([
      ["tapAt", "app"],
      ["swipeOn", "prototype"],
      ["pinchOn", "app"],
      ["selectAllText", "prototype"],
    ]);
  });
});
