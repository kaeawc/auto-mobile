import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import { refreshStaleIosPanelGeometry } from "../../../src/features/action/panelGeometryRefresh";
import { TapAtCoordinate } from "../../../src/features/action/TapAtCoordinate";
import { COORDINATE_ACTIONS } from "../../../src/features/action/visualChangeDisplayFence";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { buildObserveResult } from "../../helpers/observeFixture";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { setFakeTapAtWindow } from "../../helpers/tapAtCoordinate";

const panels = {
  panels: [
    { key: "inner", role: "inner" as const, sizePx: { width: 1600, height: 1200 } },
    { key: "cover", role: "cover" as const, sizePx: { width: 800, height: 1200 } },
  ],
  postures: [],
};
const duo: BootedDevice = {
  name: "Duo",
  platform: "ios",
  deviceId: "duo-panel-geometry",
  displays: panels,
};
const singlePanel: BootedDevice = { ...duo, deviceId: "single-panel", displays: undefined };
const tapAt = { predictionContext: { toolName: "tapAt", toolArgs: {} } };
const androidFoldable: BootedDevice = { ...duo, deviceId: "android-fold", platform: "android" };

function observation(displayRevision: number | undefined, id: string): ObserveResult {
  return buildObserveResult({
    updatedAt: 1000,
    observationId: id,
    display: { key: "inner", role: "inner", posture: "unknown", generation: 7 },
    screenSize: { width: 1600, height: 1200 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: { hierarchy: {} },
    freshness: { isFresh: true, verified: true },
    ...(displayRevision === undefined ? {} : { displayRevision }),
  });
}

describe("refreshStaleIosPanelGeometry", () => {
  let observe: FakeObserveScreen;
  let transitions: FakeDisplayTransitionReader;

  beforeEach(() => {
    observe = new FakeObserveScreen();
    transitions = new FakeDisplayTransitionReader();
    observe.setObserveResult(observation(transitions.fullRevision + 1, "fresh"));
  });

  test("observes fresh when the cached revision predates a fold", async () => {
    await observe.cacheObserveResult(observation(transitions.fullRevision, "pre-fold"));
    transitions.transition();
    const signal = new AbortController().signal;

    const refreshed = await refreshStaleIosPanelGeometry(duo, tapAt, {
      observer: observe,
      transitions,
      observeOptions: { freshness: "cached-ok", signal },
    });

    expect(refreshed?.observationId).toBe("fresh");
    expect(observe.getExecuteOptions()).toEqual([{ freshness: "fresh", signal }]);
  });

  test("observes fresh when no cached observation can prove the revision", async () => {
    const empty = new FakeObserveScreen();
    let executed = 0;
    const observer = {
      getMostRecentCachedObserveResult: () => empty.getMostRecentCachedObserveResult(),
      execute: async () => {
        executed++;
        return observation(transitions.fullRevision, "fresh");
      },
    };
    await refreshStaleIosPanelGeometry(duo, tapAt, { observer, transitions });
    expect(executed).toBe(1);
  });

  test("observes fresh when the cached observation has no display revision", async () => {
    await observe.cacheObserveResult(observation(undefined, "unstamped"));
    await refreshStaleIosPanelGeometry(duo, tapAt, { observer: observe, transitions });
    expect(observe.getExecuteCallCount()).toBe(1);
  });

  test("keeps a cached observation recorded at the current revision", async () => {
    await observe.cacheObserveResult(observation(transitions.fullRevision, "current"));
    expect(
      await refreshStaleIosPanelGeometry(duo, tapAt, { observer: observe, transitions }),
    ).toBeUndefined();
    expect(observe.getExecuteCallCount()).toBe(0);
  });

  test.each([singlePanel, androidFoldable])(
    "never reads or observes for $deviceId",
    async (device) => {
      await observe.cacheObserveResult(observation(transitions.fullRevision, "pre-fold"));
      transitions.transition();
      expect(
        await refreshStaleIosPanelGeometry(device, tapAt, { observer: observe, transitions }),
      ).toBeUndefined();
      expect(observe.getGetMostRecentCachedObserveResultCallCount()).toBe(0);
      expect(observe.getExecuteCallCount()).toBe(0);
    },
  );

  test("leaves a stale caller stamp to the caller fence", async () => {
    await observe.cacheObserveResult(observation(transitions.fullRevision, "pre-fold"));
    transitions.transition();
    const refreshed = await refreshStaleIosPanelGeometry(duo, tapAt, {
      observer: observe,
      transitions,
      callerStampIsStale: () => true,
    });
    expect(refreshed).toBeUndefined();
    expect(observe.getExecuteCallCount()).toBe(0);
  });

  test("a failed fresh capture fails instead of dispatching on stale geometry", async () => {
    await observe.cacheObserveResult(observation(transitions.fullRevision, "pre-fold"));
    transitions.transition();
    observe.setFailureMode("execute", new Error("runner unavailable"));
    await expect(
      refreshStaleIosPanelGeometry(duo, tapAt, { observer: observe, transitions }),
    ).rejects.toThrow("runner unavailable");
  });
});

describe("coordinate actions re-observe after a posture change", () => {
  let timer: FakeTimer;
  let observe: FakeObserveScreen;
  let transitions: FakeDisplayTransitionReader;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    observe = new FakeObserveScreen();
    transitions = new FakeDisplayTransitionReader();
    // The post-action observation every interaction ends with.
    observe.setObserveResult(observation(transitions.fullRevision, "post-action"));
  });

  afterEach(() => timer.reset());

  function action(device: BootedDevice): BaseVisualChange {
    return new BaseVisualChange(device, {
      adb: new FakeAdbExecutor(),
      timer,
      renderedDisplayRevision: () => undefined,
      displayFence: {
        observeScreen: observe,
        awaitIdle: new FakeAwaitIdle(),
        window: new FakeWindow(),
        displayTransitions: transitions,
        renderedDisplayGeneration: () => undefined,
      },
    });
  }

  /** Runs one coordinate action and records which observe reads happened before its dispatch. */
  async function dispatch(
    device: BootedDevice,
    toolName: string,
    extra: { display?: string; previousObservation?: ObserveResult } = {},
  ): Promise<string[]> {
    let beforeDispatch: string[] = [];
    await action(device).observedInteraction(
      async () => {
        beforeDispatch = observe.getExecutedOperations();
        return { success: true };
      },
      {
        changeExpected: false,
        skipPreviousObserve: true,
        skipUiStability: true,
        predictionContext: { toolName, toolArgs: {} },
        ...extra,
      },
    );
    return beforeDispatch;
  }

  const coordinateTools = [...COORDINATE_ACTIONS];

  test("covers tapAt, swipeAt, dragAndDrop, pinchOn and multiTouch", () => {
    expect(coordinateTools).toEqual(
      expect.arrayContaining(["tapAt", "swipeAt", "dragAndDrop", "pinchOn", "multiTouch"]),
    );
  });

  test.each(coordinateTools)("%s observes fresh before dispatch after a fold", async (tool) => {
    await observe.cacheObserveResult(observation(transitions.fullRevision, "pre-fold"));
    transitions.transition();
    observe.setObserveResult(observation(transitions.fullRevision, "post-fold"));

    const before = await dispatch(duo, tool);

    expect(before).toEqual(["cacheObserveResult", "getMostRecentCachedObserveResult", "execute"]);
    expect(observe.getExecuteOptions()[0]?.freshness).toBe("fresh");
  });

  test.each(coordinateTools)(
    "%s dispatches without re-observing on an unchanged posture",
    async (tool) => {
      await observe.cacheObserveResult(observation(transitions.fullRevision, "current"));

      const before = await dispatch(duo, tool);

      expect(before).not.toContain("execute");
    },
  );

  test.each(["tapOn", "tapAny", "swipeOn"])(
    "%s skips the re-observe when its own read is at the current revision (#17593)",
    async (tool) => {
      await observe.cacheObserveResult(observation(transitions.fullRevision, "pre-fold"));
      transitions.transition();
      const ownRead = observation(transitions.fullRevision, "action-read");

      const before = await dispatch(duo, tool, { previousObservation: ownRead });

      expect(before).toEqual(["cacheObserveResult"]);
    },
  );

  test.each(["tapOn", "tapAny", "swipeOn"])(
    "%s still re-observes when its own read predates the fold",
    async (tool) => {
      await observe.cacheObserveResult(observation(transitions.fullRevision, "pre-fold"));
      const ownRead = observation(transitions.fullRevision, "action-read");
      transitions.transition();
      observe.setObserveResult(observation(transitions.fullRevision, "post-fold"));

      const before = await dispatch(duo, tool, { previousObservation: ownRead });

      expect(before).toEqual(["cacheObserveResult", "getMostRecentCachedObserveResult", "execute"]);
    },
  );

  test("an explicit display target resolves its own panel and is not refreshed here", async () => {
    await observe.cacheObserveResult(observation(transitions.fullRevision, "pre-fold"));
    transitions.transition();
    observe.setObserveResult(observation(transitions.fullRevision, "post-fold"));

    const before = await dispatch(duo, "tapAt", { display: "inner" });

    expect(before).not.toContain("getMostRecentCachedObserveResult");
  });

  test("a non-coordinate action is not refreshed", async () => {
    await observe.cacheObserveResult(observation(transitions.fullRevision, "pre-fold"));
    transitions.transition();

    expect(await dispatch(duo, "inputText")).toEqual(["cacheObserveResult"]);
  });
});

describe("tapAt on a folded Duo", () => {
  test("re-observes before the iOS dispatch when the cache predates the fold", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const transitions = new FakeDisplayTransitionReader();
    const observe = new FakeObserveScreen();
    await observe.cacheObserveResult(observation(transitions.fullRevision, "pre-fold"));
    transitions.transition();
    observe.setObserveResult(observation(transitions.fullRevision, "post-fold"));
    let readsBeforeDispatch: string[] = [];
    const client = { requestTapCoordinates: async () => ({ success: true }) };
    const tapAt = new TapAtCoordinate(duo, new FakeAdbExecutor(), {
      timer,
      displayTransitions: transitions,
      renderedDisplayRevision: () => undefined,
      lastRenderedObservation: () => undefined,
      androidClient: client,
      iosClient: { ...client, requestDoubleTapCoordinates: async () => ({ success: true }) },
      dispatchIosCoordinateTap: async () => {
        readsBeforeDispatch = observe.getExecuteOptions().map((options) => options.freshness ?? "");
      },
      invalidateIosCache: () => {},
    });
    setFakeTapAtWindow(tapAt);
    tapAt.observeScreen = observe;

    const result = await tapAt.execute({ x: 10, y: 20 });

    expect(result.success).toBe(true);
    expect(readsBeforeDispatch[0]).toBe("fresh");
    timer.reset();
  });
});
