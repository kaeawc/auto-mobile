import { afterEach, describe, expect, test } from "bun:test";
import { TapAtCoordinate } from "../../../src/features/action/TapAtCoordinate";
import type { CoordinateTapClient } from "../../../src/features/action/coordinateTapDispatch";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import {
  readOptions,
  resetSelectedDisplayHarness,
  selectedDisplayDevice,
  selectedDisplayHarness,
  selectedHierarchy,
  transientFailures,
} from "../../helpers/selectedDisplayRead";

afterEach(resetSelectedDisplayHarness);

function gestureHarness(reason: string, fold = false) {
  let reads = 0;
  const h = selectedDisplayHarness({
    read: () => {
      reads++;
      if (reads === 1) {
        if (fold) {
          h.timer.setTimeout(
            () => displayTransitions.notifyTransition(selectedDisplayDevice.deviceId, "fold"),
            100,
          );
        }
        throw new Error(`Device fake hierarchy service did not answer: ${reason}`);
      }
      return selectedHierarchy();
    },
  });
  const dispatches: { x: number; y: number; displayId?: number }[] = [];
  const client: CoordinateTapClient & { supportsCommand: () => Promise<boolean> } = {
    supportsCommand: async () => true,
    requestTapCoordinates: async (
      x,
      y,
      _duration,
      _timeout,
      _perf,
      _context,
      _dispatch,
      _signal,
      displayId,
      beforeSend,
    ) => {
      beforeSend?.();
      dispatches.push({ x, y, displayId });
      return { success: true };
    },
  };
  const tap = new TapAtCoordinate(selectedDisplayDevice, h.adb, {
    timer: h.timer,
    androidClient: client,
    iosClient: client,
    lastRenderedObservation: () => ({
      display: { key: "inner", generation: 0 },
      displayRevision: 0,
    }),
  });
  // Exercise real observation with fake capture and disable unrelated screenshot/audit work.
  const execute = h.screen.execute.bind(h.screen);
  h.screen.execute = (options) => execute({ ...readOptions, ...options });
  tap.observeScreen = h.screen;
  // Keep target preparation and dispatch real; settlement after dispatch is outside this retry.
  tap.observedInteraction = async (block, options) => {
    if (!options.previousObservation) {
      throw new Error("Expected the target capture");
    }
    expect(options.previousObservation.viewHierarchy?.frameContext).toBe("second-capture");
    return block(options.previousObservation);
  };
  return { ...h, tap, dispatches };
}

describe("selected-display retry before gesture dispatch", () => {
  test.each(transientFailures)(
    "%s dispatches exactly once from attempt two",
    async (_kind, reason) => {
      const h = gestureHarness(reason);
      const result = await h.tap.execute({
        x: 0.5,
        y: 0.25,
        coordinateSpace: "normalized",
        display: "inner",
      });
      expect(result.success).toBe(true);
      expect(h.capture.requests).toHaveLength(2);
      expect(h.dispatches).toEqual([{ x: 100, y: 50, displayId: 2 }]);
    },
  );

  test("fold during backoff dispatches nothing and does not reread", async () => {
    const h = gestureHarness(
      "CtrlProxy WebSocket disconnected while waiting for hierarchy response",
      true,
    );
    const result = await h.tap.execute({
      x: 0.5,
      y: 0.25,
      coordinateSpace: "normalized",
      display: "inner",
    });
    expect(result.success).toBe(false);
    expect(result.staleDisplay).toMatchObject({
      observedGeneration: 0,
      currentGeneration: 1,
      retry: "observe",
    });
    expect(h.capture.requests).toHaveLength(1);
    expect(h.dispatches).toEqual([]);
  });
});
