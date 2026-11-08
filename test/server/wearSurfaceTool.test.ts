import { describe, expect, test } from "bun:test";
import {
  createWearSurfaceHandler,
  wearSurfaceResultSchema,
  wearSurfaceSchema,
} from "../../src/server/wearSurfaceTool";
import { ActionableError, type BootedDevice } from "../../src/models";
import type {
  TileTarget,
  WearSurface,
  WearSurfaceResult,
} from "../../src/features/wear/WearSurface";
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

describe("wearSurface tool", () => {
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
