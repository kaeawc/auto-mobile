import { afterEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import {
  type InteractionToolDependencies,
  pinchOnHandler,
  pinchOnSchema,
  selectAllTextHandler,
  selectAllTextSchema,
  swipeOnHandler,
  swipeOnSchema,
  tapAtHandler,
  tapAtSchema,
} from "../../src/server/interactionTools";

const interactionDeps: InteractionToolDependencies = {};
const device: BootedDevice = { name: "Android", platform: "android", deviceId: "emulator-5600" };

afterEach(() => {
  delete interactionDeps.pinchOnFactory;
  delete interactionDeps.selectAllTextFactory;
  delete interactionDeps.swipeOnFactory;
  delete interactionDeps.tapAtElementFactory;
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
    interactionDeps.tapAtElementFactory = () => ({
      execute: async (options: { layer?: string }) => {
        seen.push(["tapAt", options.layer]);
        return { success: true, x: 1, y: 2, action: "tap" };
      },
    });
    interactionDeps.swipeOnFactory = () => ({
      execute: async (options: { layer?: string }) => {
        seen.push(["swipeOn", options.layer]);
        return { success: true, targetType: "screen", x1: 0, y1: 0, x2: 0, y2: 0, duration: 0 };
      },
    });
    interactionDeps.pinchOnFactory = () => ({
      execute: async (options: { layer?: string }) => {
        seen.push(["pinchOn", options.layer]);
        return {
          success: true,
          direction: "in" as const,
          distanceStart: 100,
          distanceEnd: 50,
          duration: 0,
          centerX: 0,
          centerY: 0,
          targetType: "screen" as const,
        };
      },
    });
    interactionDeps.selectAllTextFactory = () => ({
      execute: async (_progress: unknown, _signal: unknown, options: { layer?: string } = {}) => {
        seen.push(["selectAllText", options.layer]);
        return { success: true };
      },
    });

    await tapAtHandler(device, { x: 1, y: 2, layer: "app" }, undefined, undefined, interactionDeps);
    await swipeOnHandler(
      device,
      { direction: "up", layer: "prototype" },
      undefined,
      undefined,
      interactionDeps,
    );
    await pinchOnHandler(
      device,
      { direction: "in", layer: "app" },
      undefined,
      undefined,
      interactionDeps,
    );
    await selectAllTextHandler(
      device,
      { layer: "prototype" },
      undefined,
      undefined,
      interactionDeps,
    );

    expect(seen).toEqual([
      ["tapAt", "app"],
      ["swipeOn", "prototype"],
      ["pinchOn", "app"],
      ["selectAllText", "prototype"],
    ]);
  });
});
