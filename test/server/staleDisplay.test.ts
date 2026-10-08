import { afterEach, describe, expect, test } from "bun:test";
import { staleDisplayError, withStaleDisplay } from "../../src/models/StaleDisplayError";
import { runWithSelectedDisplayPin } from "../../src/features/observe/SessionDisplayContext";
import type {
  TapAtResult,
  TapOnElementResult,
  TapAnyElementResult,
  SwipeOnResult,
  DragAndDropResult,
  PinchOnResult,
  ObserveResult,
} from "../../src/models";
import {
  tapAtHandler,
  tapOnHandler,
  setTapAtElementFactory,
  setTapOnElementFactory,
  resetTapAtElementFactory,
  resetTapOnElementFactory,
} from "../../src/server/interactionTools";
import { tapOnResultSchema } from "../../src/server/toolOutputSchemas";
import { getStructuredField, createStructuredToolResponse } from "../../src/utils/toolUtils";
import {
  finalizeToolResponse,
  type ObservationBaselineStore,
} from "../../src/server/finalizeToolResponse";
import {
  BaseVisualChange,
  sessionRenderedDisplayGeneration,
} from "../../src/features/action/BaseVisualChange";
import { sessionRenderedObservation } from "../../src/features/action/TargetDisplayAction";
import { DevicePool } from "../../src/daemon/devicePool";
import { DaemonState } from "../../src/daemon/daemonState";
import { displayTransitions } from "../../src/features/observe/DisplayTransition";
import { FakeDisplayTransitionReader } from "../fakes/FakeDisplayTransitionReader";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { serverConfig } from "../../src/utils/ServerConfig";
import { observation } from "../helpers/tapAtCoordinate";

const bounds = { left: 0, top: 0, right: 0, bottom: 0 };
const results: {
  tapAt: TapAtResult;
  tapOn: TapOnElementResult;
  tapAny: TapAnyElementResult;
  swipeOn: SwipeOnResult;
  dragAndDrop: DragAndDropResult;
  pinchOn: PinchOnResult;
} = {
  tapAt: { success: false, x: 1, y: 2 },
  tapOn: { success: false, action: "tap", element: { bounds } },
  tapAny: { success: false, action: "tap", element: { bounds } },
  swipeOn: { success: false, targetType: "screen", x1: 0, y1: 0, x2: 1, y2: 1, duration: 0 },
  dragAndDrop: { success: false, duration: 0, distance: 0 },
  pinchOn: {
    success: false,
    direction: "in",
    distanceStart: 10,
    distanceEnd: 5,
    duration: 0,
    centerX: 0,
    centerY: 0,
    targetType: "screen",
  },
};
const stale = staleDisplayError(7, 9, "cover");
const device = { deviceId: "typed-stale-wire", platform: "android" as const, name: "fake" };
afterEach(() => {
  resetTapAtElementFactory();
  resetTapOnElementFactory();
});

describe("stale-display result channel", () => {
  test("pinned stale coordinates name the actual unpin action before re-observing", () => {
    const error = runWithSelectedDisplayPin({ pin: "inner", inventory: undefined }, () =>
      staleDisplayError(7, 9, "cover"),
    );
    expect(error.message).toContain("setActiveDevice {display: null}");
    expect(error.message).toContain("deviceId and sessionUuid");
    expect(error.details).toEqual(stale.details);
    expect(withStaleDisplay(results.tapAny, error).error).toBe(error.message);
    expect(stale.message).not.toContain("setActiveDevice");
  });
  test.each(Object.keys(results) as (keyof typeof results)[])("copies details onto %s", (name) => {
    const result = withStaleDisplay({ ...results[name], error: "old wrapped error" }, stale);
    expect(result.staleDisplay).toEqual({
      observedGeneration: 7,
      currentGeneration: 9,
      currentDisplayKey: "cover",
      retry: "observe",
    });
    expect(result.error).toBe(stale.message);
    expect(results[name]).not.toHaveProperty("staleDisplay");
  });
  test("leaves unrelated typed failures alone", () => {
    const result = { ...results.tapAt, error: "invalid coordinates" };
    expect(withStaleDisplay(result, new Error("invalid coordinates"))).toBe(result);
  });
  test("tapAt handler spreads details into structuredContent", async () => {
    setTapAtElementFactory(() => ({ execute: async () => withStaleDisplay(results.tapAt, stale) }));
    const response = await tapAtHandler(device, { x: 1, y: 2 });
    expect(response.isError).toBe(true);
    expect(getStructuredField(response, "staleDisplay")).toEqual(stale.details);
    expect(getStructuredField(response, "error")).toBe(stale.message);
  });
  test("tapOn handler spreads details and its declared schema retains them", async () => {
    setTapOnElementFactory(() => ({ execute: async () => withStaleDisplay(results.tapOn, stale) }));
    const response = await tapOnHandler(device, { selector: { text: "Target" } });
    expect(response.isError).toBe(true);
    expect(getStructuredField(response, "staleDisplay")).toEqual(stale.details);
    expect(getStructuredField(response, "error")).toBe(stale.message);
    expect(tapOnResultSchema.parse(withStaleDisplay(results.tapOn, stale)).staleDisplay).toEqual(
      stale.details,
    );
    expect(
      tapOnResultSchema.safeParse({
        success: false,
        staleDisplay: { ...stale.details, retry: "tap" },
      }).success,
    ).toBe(false);
  });
});

describe("last rendered generation persistence", () => {
  test.each([false, true])(
    "finalize persists capture-start stamp with diff=%s and clearing leaves it intact",
    async (diff) => {
      const originalDiff = serverConfig.isActionsDiffObserveEnabled();
      const originalNoObserve = serverConfig.isActionsNoObserveEnabled();
      const timer = new FakeTimer();
      const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
      const uuid = "stale-generation-store";
      await manager.createSession(uuid, device.deviceId, "android");
      const pool = new DevicePool(createDevicePoolDependencies(manager, "typed-store", { timer }));
      DaemonState.getInstance().initialize(manager, pool);
      const screen = {
        ...observation(100, 200),
        displayRevision: 43,
        display: { key: "inner", role: "inner", posture: "opened", generation: 5 },
      } as ObserveResult;
      const baselineStore: ObservationBaselineStore = {
        get: (id) => manager.getLastRenderedObservation(id),
        set: (id, result, revision) => manager.setLastRenderedObservation(id, result, revision),
        setDisplayRevision: (id, revision, key, generation) =>
          manager.setLastRenderedDisplayRevision(id, revision, key, generation),
      };
      try {
        serverConfig.setActionsDiffObserveEnabled(diff);
        serverConfig.setActionsNoObserveEnabled(false);
        finalizeToolResponse(createStructuredToolResponse(screen), {
          name: "observe",
          sessionUuid: uuid,
          baselineStore,
        });
        expect(manager.getLastRenderedDisplayRevision(uuid)).toBe(43);
        expect(manager.getLastRenderedDisplayGeneration(uuid)).toBe(screen.display.generation);
        expect(manager.getLastRenderedDisplayKey(uuid)).toBe("inner");
        expect(manager.getLastRenderedObservation(uuid)?.display.generation).toBe(
          diff ? 5 : undefined,
        );
        displayTransitions.notifyTransition(device.deviceId, "fold invalidates the diff baseline");
        expect(manager.getLastRenderedObservation(uuid)).toBeUndefined();
        expect(manager.getLastRenderedDisplayGeneration(uuid)).toBe(5);
        expect(manager.getLastRenderedDisplayRevision(uuid)).toBe(43);
        expect(sessionRenderedDisplayGeneration(device.deviceId)).toBe(5);
        expect(sessionRenderedObservation(device.deviceId)?.display.generation).toBe(5);
        const transitions = new FakeDisplayTransitionReader();
        transitions.fullRevision = 44;
        transitions.generation = 8;
        transitions.panel = { key: "cover", role: "cover" };
        const action = new BaseVisualChange(device, new FakeAdbExecutor(), timer, undefined, {
          displayTransitions: transitions,
        });
        // Caller coordinates (tapAt) are refused; a selector tapOn would re-read instead (#9847).
        await expect(
          action.observedInteraction(async () => ({ success: true }), {
            changeExpected: false,
            predictionContext: { toolName: "tapAt", toolArgs: {} },
          }),
        ).rejects.toMatchObject({
          details: {
            observedGeneration: 5,
            currentGeneration: 8,
            currentDisplayKey: "cover",
            retry: "observe",
          },
        });
        const after = {
          ...screen,
          displayRevision: 44,
          display: { ...screen.display, key: "cover", role: "cover" as const, generation: 8 },
        };
        finalizeToolResponse(createStructuredToolResponse({ success: true, observation: after }), {
          name: "tapAt",
          sessionUuid: uuid,
          baselineStore,
        });
        expect(manager.getLastRenderedDisplayGeneration(uuid)).toBe(8);
        expect(manager.getLastRenderedDisplayRevision(uuid)).toBe(44);
        expect(manager.getLastRenderedDisplayKey(uuid)).toBe("cover");
      } finally {
        serverConfig.setActionsDiffObserveEnabled(originalDiff);
        serverConfig.setActionsNoObserveEnabled(originalNoObserve);
        DaemonState.getInstance().reset();
        displayTransitions.reset(device.deviceId);
      }
    },
  );
});
