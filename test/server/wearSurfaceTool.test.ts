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
import type { WatchFaceResult, WatchFaceSurface } from "../../src/features/wear/WatchFaceSurface";
import type { FormFactorRead } from "../../src/server/requireWatch";
import type { TraitFormFactor } from "../../src/utils/android-cmdline-tools/deviceTraits";
import { toolJson } from "../helpers/toolResponse";

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

const FACE = "com.google.wear.offhand";
const PROVIDER =
  "com.google.android.clockwork.sysui/com.google.android.clockwork.sysui.experiences.complications.providers.BatteryProviderService";

function recordingFaces(calls: unknown[][], applied = true): WatchFaceSurface {
  const result = (action: WatchFaceResult["action"]): WatchFaceResult => ({
    success: applied,
    action,
    requested: {},
    broadcastResult: { code: 1, data: "Favorite Id=[1]", accepted: true, favoriteId: 1 },
    applied,
    verified: applied,
    favoriteId: 1,
    readback: { activeFace: { package: FACE, className: null }, favoriteId: 1, slots: [] },
    ...(applied ? {} : { error: "not_applied" as const, reason: "not shown" }),
    message: "done",
  });
  return {
    setWatchFace: async (face) => (calls.push(["setWatchFace", face]), result("setWatchFace")),
    unsetWatchFace: async () => (calls.push(["unsetWatchFace"]), result("unsetWatchFace")),
    setComplication: async (request) => (
      calls.push(["setComplication", request]),
      result("setComplication")
    ),
    unsetComplication: async (request) => (
      calls.push(["unsetComplication", request]),
      result("unsetComplication")
    ),
  };
}

const faceHandler = (calls: unknown[][], applied = true) =>
  createWearSurfaceHandler(
    () => recordingSurface([]),
    announces("watch"),
    () => recordingFaces(calls, applied),
  );

describe("wearSurface watch face actions", () => {
  const slot = { watchFace: FACE, slot: 11, provider: PROVIDER };
  test.each<[Record<string, unknown>, unknown[]]>([
    [{ action: "setWatchFace", watchFace: FACE }, ["setWatchFace", FACE]],
    [{ action: "unsetWatchFace" }, ["unsetWatchFace"]],
    [
      { action: "setComplication", ...slot, type: 5 },
      ["setComplication", { action: "setComplication", ...slot, type: 5 }],
    ],
    [
      { action: "unsetComplication", ...slot },
      ["unsetComplication", { action: "unsetComplication", ...slot }],
    ],
  ])("%o dispatches to the watch face surface", async (args, expected) => {
    const calls: unknown[][] = [];
    const response = await faceHandler(calls)(watchDevice, wearSurfaceSchema.parse(args));
    expect(calls).toEqual([expected]);
    expect(wearSurfaceResultSchema.safeParse(toolJson(response)).success).toBe(true);
    expect(response.isError ?? false).toBe(false);
  });

  test("an accepted change that did not read back is an error", async () => {
    const response = await faceHandler([], false)(watchDevice, {
      action: "setWatchFace",
      watchFace: FACE,
    });
    expect(toolJson(response)).toMatchObject({ applied: false, error: "not_applied" });
    expect(response.isError).toBe(true);
  });

  test.each<Record<string, unknown>>([
    { action: "setWatchFace" },
    { action: "setWatchFace", watchFace: FACE, slot: 11 },
    { action: "unsetWatchFace", watchFace: FACE },
    { action: "setComplication", ...slot },
    { action: "unsetComplication", ...slot, type: 5 },
    { action: "unsetComplication", watchFace: FACE, slot: 11 },
    { action: "addTile", component: COMPONENT, watchFace: FACE },
  ])("%o is refused before any adb call", async (args) => {
    const calls: unknown[][] = [];
    await expect(
      faceHandler(calls)(watchDevice, wearSurfaceSchema.parse(args)),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(calls).toEqual([]);
  });

  test("the schema refuses a trailing-slash face and an unsafe provider", () => {
    for (const input of [
      { action: "setWatchFace", watchFace: `${FACE}/` },
      { action: "setWatchFace", watchFace: "a/b;reboot" },
      { ...slot, action: "unsetComplication", provider: "a/$(id)" },
      { ...slot, action: "setComplication", type: -1 },
    ]) {
      expect(wearSurfaceSchema.safeParse(input).success).toBe(false);
    }
  });
});

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
