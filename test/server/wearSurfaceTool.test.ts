import { describe, expect, spyOn, test } from "bun:test";
import {
  createWearSurfaceHandler,
  createDeviceObserver,
  surfaceSnapshot,
  wearSurfaceResultSchema,
  wearSurfaceSchema,
} from "../../src/server/wearSurfaceTool";
import { ActionableError, type BootedDevice } from "../../src/models";
import { AdbWearSurface, WEAR_SYSUI_PACKAGE } from "../../src/features/wear/WearSurface";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  capturedBroadcast,
  capturedFace,
  capturedTile,
  capturedSurfaceObservation,
} from "../helpers/wearSurfaceCaptures";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import type {
  TileTarget,
  WearSurface,
  WearSurfaceResult,
} from "../../src/features/wear/WearSurface";
import type {
  WatchFaceChangeResult,
  WatchFaceSurface,
} from "../../src/features/wear/WatchFaceSurface";
import type { FormFactorRead } from "../../src/server/requireWatch";
import type { TraitFormFactor } from "../../src/utils/android-cmdline-tools/deviceTraits";
import { toolJson } from "../helpers/toolResponse";
import type { WatchFaceReader, WatchFaceResult } from "../../src/features/wear/WatchFace";

import { ViewHierarchy } from "../../src/features/observe/ViewHierarchy";
import * as observeDefaults from "../../src/features/observe/ObserveScreenDefaults";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeViewHierarchy } from "../fakes/FakeViewHierarchy";

const watchDevice: BootedDevice = { name: "Wear", deviceId: "emulator-5554", platform: "android" };
const COMPONENT = "com.google.android.contacts/com.google.android.wearable.contacts.tiles.X";
const announces =
  (formFactor: TraitFormFactor | null | undefined): FormFactorRead =>
  async () =>
    formFactor;

type Call = ["addTile" | "removeTile", string] | ["showTile", TileTarget] | ["listTileProviders"];

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
    listTileProviders: async () => (
      calls.push(["listTileProviders"]),
      {
        success: true,
        action: "listTileProviders",
        requested: {},
        providers: [{ component: COMPONENT, packageName: "p", className: "c" }],
        verified: false,
        message: "1 tile provider(s)",
      }
    ),
    addTile: async (component) => (calls.push(["addTile", component]), result("addTile")),
    removeTile: async (component) => (calls.push(["removeTile", component]), result("removeTile")),
    showTile: async (target) => (calls.push(["showTile", target]), result("showTile")),
  };
}

const FACE = "com.google.wear.offhand";
const PROVIDER =
  "com.google.android.clockwork.sysui/com.google.android.clockwork.sysui.experiences.complications.providers.BatteryProviderService";

function recordingFaces(calls: unknown[][], applied = true): WatchFaceSurface {
  const result = (action: WatchFaceChangeResult["action"]): WatchFaceChangeResult => ({
    success: applied,
    action,
    requested: {},
    broadcastResult: { code: 1, data: "Favorite Id=[1]", accepted: true, favoriteId: 1 },
    applied,
    verified: applied,
    favoriteId: 1,
    readback: {
      activeFace: { package: FACE, favoriteId: 1, fallback: false },
      favorites: [{ favoriteId: 1, package: FACE, slots: [] }],
    },
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
    () => {
      throw new Error("must not construct the watch face reader");
    },
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
  test.each([
    {
      name: "tile-showing",
      observationId: "7ab8f636-6fe4-47b5-be2f-cfa2e043fec2",
      appId: WEAR_SYSUI_PACKAGE,
    },
    {
      name: "app-in-front",
      observationId: "5c7c1bd7-3cac-4464-9624-d9a4524cf1ec",
      appId: "dev.jasonpearson.automobile.wearfixture",
    },
  ] as const)(
    "$name observation keeps the full capture's identity and its 384px round screen",
    ({ name, observationId, appId }) => {
      const observation = capturedSurfaceObservation(name);
      expect(observation).toMatchObject({
        observationId,
        deviceId: "emulator-5578",
        screenSize: { width: 384, height: 384, units: "physical-pixels" },
        isScreenRound: true,
        activeWindow: { appId },
        viewHierarchy: { packageName: appId, screenWidth: 384, screenHeight: 384, density: 320 },
      });
    },
  );

  test("the default device observer constructs a screen that reads the session hierarchy", async () => {
    const capture = capturedSurfaceObservation("tile-showing");
    const hierarchy = new FakeViewHierarchy();
    expect(capture.viewHierarchy).toBeDefined();
    hierarchy.configureHierarchySequence([capture.viewHierarchy!]);
    const adb = spyOn(defaultAdbClientFactory, "create").mockReturnValue(new FakeAdbExecutor());
    const read = spyOn(ViewHierarchy.prototype, "getViewHierarchy").mockImplementation((...args) =>
      hierarchy.getViewHierarchy(...args),
    );
    const resolveSources = observeDefaults.resolveObserveDataSources;
    // Keep the real hierarchy selection; only suppress unrelated screenshot-cache I/O.
    const sources = spyOn(observeDefaults, "resolveObserveDataSources").mockImplementation(
      (context) =>
        resolveSources({
          ...context,
          dependencies: {
            ...context.dependencies,
            screenshot: {
              execute: async () => {
                throw new Error("unexpected screenshot");
              },
              generateScreenshotPath: () => {
                throw new Error("unexpected screenshot path");
              },
              getActivityHash: async () => {
                throw new Error("unexpected activity hash");
              },
            },
          },
        }),
    );
    // Record the hierarchy source the constructor resolves for its default dependencies.
    const resolveHierarchy = observeDefaults.resolveObserveViewHierarchy;
    const constructed: ReturnType<typeof resolveHierarchy>[] = [];
    const resolved = spyOn(observeDefaults, "resolveObserveViewHierarchy").mockImplementation(
      (context) => {
        const source = resolveHierarchy(context);
        constructed.push(source);
        return source;
      },
    );
    // Exercise the constructor's hierarchy without running the unrelated observe pipeline.
    const execute = spyOn(RealObserveScreen.prototype, "execute").mockImplementation(async () => {
      const [source] = constructed;
      if (!source) {
        throw new Error("ObserveScreen did not resolve a hierarchy source");
      }
      return { ...capture, viewHierarchy: await source.getViewHierarchy() };
    });
    try {
      expect(await createDeviceObserver(watchDevice)()).toEqual({
        appId: WEAR_SYSUI_PACKAGE,
        tileShowing: true,
      });
      expect(constructed).toHaveLength(1);
      expect(constructed[0]).toBeInstanceOf(ViewHierarchy);
      expect(read).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      execute.mockRestore();
      resolved.mockRestore();
      sources.mockRestore();
      read.mockRestore();
      adb.mockRestore();
    }
  });

  test("the device observer constructs a session screen and forwards fresh extraction options", async () => {
    const screen = new FakeObserveScreen();
    screen.setObserveResult(capturedSurfaceObservation("tile-showing"));
    const constructions: ConstructorParameters<typeof RealObserveScreen>[] = [];
    const observe = createDeviceObserver(watchDevice, (...args) => {
      constructions.push(args);
      return screen;
    });
    const { signal } = new AbortController();
    expect(await observe(signal)).toEqual({ appId: WEAR_SYSUI_PACKAGE, tileShowing: true });
    expect(constructions).toEqual([[watchDevice]]);
    expect(screen.getExecuteOptions()).toEqual([
      { skipScreenshot: true, skipBackStack: true, requireFreshExtraction: true, signal },
    ]);
  });

  test.each(["tile-showing", "app-in-front"] as const)(
    "surfaceSnapshot reads the full %s capture",
    (name) => {
      expect(surfaceSnapshot(capturedSurfaceObservation(name))).toEqual({
        appId:
          name === "tile-showing" ? WEAR_SYSUI_PACKAGE : "dev.jasonpearson.automobile.wearfixture",
        tileShowing: name === "tile-showing",
      });
    },
  );

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
          tileProviders: { list: async () => [] },
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

  test("strict schema accepts the four actions and refuses unsafe components", () => {
    for (const input of [
      { action: "listTileProviders" },
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
    ["listTileProviders", { action: "listTileProviders" }, ["listTileProviders"]],
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
    ["listTileProviders with a component", { action: "listTileProviders", component: COMPONENT }],
    ["listTileProviders with an index", { action: "listTileProviders", index: 0 }],
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
