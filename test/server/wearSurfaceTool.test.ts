import { describe, expect, test } from "bun:test";
import {
  createWearSurfaceHandler,
  surfaceSnapshot,
  wearSurfaceResultSchema,
  wearSurfaceSchema,
} from "../../src/server/wearSurfaceTool";
import { ActionableError, type BootedDevice } from "../../src/models";
import { AdbWearSurface, WEAR_SYSUI_PACKAGE } from "../../src/features/wear/WearSurface";
import { FakeTimer } from "../fakes/FakeTimer";
import { capturedBroadcast, capturedFace, capturedTile } from "../helpers/wearSurfaceCaptures";
import type {
  TileTarget,
  WearSurface,
  WearSurfaceResult,
} from "../../src/features/wear/WearSurface";
import type { FormFactorRead } from "../../src/server/requireWatch";
import type { TraitFormFactor } from "../../src/utils/android-cmdline-tools/deviceTraits";
import { toolJson } from "../helpers/toolResponse";
import type { WatchFaceReader, WatchFaceResult } from "../../src/features/wear/WatchFace";

const watchDevice: BootedDevice = { name: "Wear", deviceId: "emulator-5554", platform: "android" };
const COMPONENT = "com.google.android.contacts/com.google.android.wearable.contacts.tiles.X";
const announces =
  (formFactor: TraitFormFactor | null | undefined): FormFactorRead =>
  async () =>
    formFactor;

type Call = ["addTile" | "removeTile", string] | ["showTile", TileTarget];

function recordingSurface(calls: Call[], success = true): WearSurface {
  const result = (action: WearSurfaceResult["action"]): WearSurfaceResult => ({
    success,
    action,
    requested: {},
    broadcastResult: { code: 1, outcome: "showRequested" },
    verified: success,
    message: "done",
    ...(success ? {} : { reason: "not confirmed" }),
  });
  return {
    addTile: async (component) => (calls.push(["addTile", component]), result("addTile")),
    removeTile: async (component) => (calls.push(["removeTile", component]), result("removeTile")),
    showTile: async (target) => (calls.push(["showTile", target]), result("showTile")),
  };
}

describe("wearSurface tool", () => {
  test("captured tile and face hierarchies distinguish tile evidence", async () => {
    expect(surfaceSnapshot({ viewHierarchy: await capturedTile() }).tileShowing).toBe(true);
    expect(surfaceSnapshot(capturedFace).tileShowing).toBe(false);
    expect(surfaceSnapshot({}).tileShowing).toBe(false);
  });

  test.each([0, 99])("captured show index %i verifies only a tile hierarchy", async (index) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const snapshot = surfaceSnapshot(
      index === 0 ? { viewHierarchy: await capturedTile() } : capturedFace,
    );
    const stdout = capturedBroadcast("ops3.txt", `--es operation show-tile --ei index ${index}`);
    const response = await createWearSurfaceHandler(
      () =>
        new AdbWearSurface({
          timer,
          observe: async () => ({ ...snapshot, appId: WEAR_SYSUI_PACKAGE }),
          adb: {
            executeCommand: async () => ({
              stdout,
              stderr: "",
              toString: () => stdout,
              trim: () => stdout.trim(),
              includes: (s) => stdout.includes(s),
            }),
          },
        }),
      announces("watch"),
    )(watchDevice, { action: "showTile", index });
    expect(toolJson(response)).toMatchObject({
      success: index === 0,
      verified: index === 0,
      broadcastResult: { code: 1 },
    });
    expect(response.isError ?? false).toBe(index !== 0);
  });

  test("strict schema accepts the three actions and refuses unsafe components", () => {
    for (const input of [
      { action: "addTile", component: COMPONENT },
      { action: "removeTile", component: COMPONENT },
      { action: "showTile", index: 0 },
      { action: "showTile", component: COMPONENT },
      { action: "watchFace" },
    ]) {
      expect(wearSurfaceSchema.safeParse(input).success).toBe(true);
    }
    for (const input of [
      { action: "listTiles" },
      { action: "addTile", component: "a/b;reboot" },
      { action: "showTile", index: -1 },
      { action: "showTile", index: 1.5 },
      { action: "addTile", component: COMPONENT, extra: true },
    ]) {
      expect(wearSurfaceSchema.safeParse(input).success).toBe(false);
    }
  });

  test.each<[string, Record<string, unknown>, Call]>([
    ["addTile", { action: "addTile", component: COMPONENT }, ["addTile", COMPONENT]],
    ["removeTile", { action: "removeTile", component: COMPONENT }, ["removeTile", COMPONENT]],
    ["showTile by index", { action: "showTile", index: 2 }, ["showTile", { index: 2 }]],
    [
      "showTile by component",
      { action: "showTile", component: COMPONENT },
      ["showTile", { component: COMPONENT }],
    ],
  ])("%s dispatches to the surface", async (_label, args, expected) => {
    const calls: Call[] = [];
    const response = await createWearSurfaceHandler(
      () => recordingSurface(calls),
      announces("watch"),
    )(watchDevice, wearSurfaceSchema.parse(args));
    expect(calls).toEqual([expected]);
    expect(wearSurfaceResultSchema.safeParse(toolJson(response)).success).toBe(true);
    expect(response.isError ?? false).toBe(false);
  });

  test.each<[string, WatchFaceResult]>([
    [
      "available",
      {
        success: true,
        action: "watchFace",
        available: true,
        activeFace: { package: "com.google.wear.offhand", favoriteId: 1, fallback: false },
        favorites: [
          {
            favoriteId: 1,
            package: "com.google.wear.offhand",
            slots: [{ slot: 11, type: 1, provider: null }],
          },
        ],
        ambient: false,
        message: "read",
      },
    ],
    [
      "unavailable",
      {
        success: false,
        action: "watchFace",
        available: false,
        message: "unreadable",
        reason: "no section",
      },
    ],
  ])("watchFace %s reads without constructing the tile surface", async (_label, result) => {
    const reads: string[] = [];
    const reader: WatchFaceReader = {
      observe: async () => (reads.push("observe"), result),
    };
    const response = await createWearSurfaceHandler(
      () => {
        throw new Error("must not construct");
      },
      announces("watch"),
      () => reader,
    )(watchDevice, wearSurfaceSchema.parse({ action: "watchFace" }));
    expect(reads).toEqual(["observe"]);
    expect(toolJson(response)).toEqual({ ...result });
    expect(wearSurfaceResultSchema.safeParse(toolJson(response)).success).toBe(true);
    expect(response.isError ?? false).toBe(!result.success);
  });

  test("an unconfirmed result is marked as an error", async () => {
    const response = await createWearSurfaceHandler(
      () => recordingSurface([], false),
      announces("watch"),
    )(watchDevice, { action: "showTile", index: 99 });
    expect(toolJson(response).verified).toBe(false);
    expect(response.isError).toBe(true);
  });

  test.each<[string, Record<string, unknown>]>([
    ["addTile without component", { action: "addTile" }],
    ["removeTile with an index", { action: "removeTile", component: COMPONENT, index: 0 }],
    ["showTile with neither", { action: "showTile" }],
    ["showTile with both", { action: "showTile", component: COMPONENT, index: 0 }],
    ["watchFace with a component", { action: "watchFace", component: COMPONENT }],
  ])("%s is refused before any adb call", async (_label, args) => {
    const calls: Call[] = [];
    const call = createWearSurfaceHandler(() => recordingSurface(calls), announces("watch"))(
      watchDevice,
      wearSurfaceSchema.parse(args),
    );
    await expect(call).rejects.toBeInstanceOf(ActionableError);
    expect(calls).toEqual([]);
  });

  test("a phone is refused without a change", async () => {
    const calls: Call[] = [];
    const call = createWearSurfaceHandler(() => recordingSurface(calls), announces(null))(
      { ...watchDevice, formFactor: "phone" },
      { action: "addTile", component: COMPONENT },
    );
    await expect(call).rejects.toThrow(/wearSurface requires a Wear OS watch.*nothing was changed/);
    expect(calls).toEqual([]);
  });

  test("iOS is refused before constructing the surface", async () => {
    const handler = createWearSurfaceHandler(() => {
      throw new Error("must not construct");
    }, announces("watch"));
    await expect(
      handler({ ...watchDevice, platform: "ios" }, { action: "showTile", index: 0 }),
    ).rejects.toThrow(/Android-only/);
  });
});
