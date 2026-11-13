import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SetPosture } from "../../../src/features/device/SetPosture";
import {
  POSTURE_GEOMETRY_POLL_MS,
  POSTURE_GEOMETRY_WAIT_MS,
} from "../../../src/features/device/postureGeometryCheck";
import { DisplayTransitionTracker } from "../../../src/features/observe/DisplayTransition";
import {
  ObservedAndroidDisplayCache,
  observedIosDisplay,
} from "../../../src/features/observe/ObservationDisplay";
import type { ObserveScreen } from "../../../src/features/observe/interfaces/ObserveScreen";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import {
  parseSimulatorDisplays,
  simulatorDeviceDisplays,
} from "../../../src/utils/ios-cmdline-tools/SimulatorDisplays";
import { logger } from "../../../src/utils/logger";
import { FakeDevicectlDisplayInfoSource } from "../../fakes/FakeDevicectlDisplayInfoSource";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { loadDuoEnumerate } from "../../fixtures/loadDuoEnumerate";

const duo: BootedDevice = {
  name: "iPhone Duo",
  platform: "ios",
  deviceId: "5E0D7C2A-1824-4E74-B8C0-668FF03E49F5",
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
  displays: simulatorDeviceDisplays(
    parseSimulatorDisplays(loadDuoEnumerate()),
    "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
  ),
};
const innerPixels = { pixelWidth: 2007, pixelHeight: 2853 };

/** Inner-panel observation: the runner's raw rotation rides on the hierarchy (#18245). */
function innerObservation(
  rotation: number,
  runnerRotation: number,
  size: { width: number; height: number },
): ObserveResult {
  return {
    display: observedIosDisplay(duo, innerPixels),
    screenSize: size,
    rotation,
    viewHierarchy: {
      rotation: runnerRotation,
      hierarchy: {
        node: { node: [{ bounds: { left: 0, top: 0, right: 951, bottom: 60 } }] },
      },
    },
  } as ObserveResult;
}

const consistent = innerObservation(1, 1, { width: 951, height: 669 });
// The runner still reads portrait while observe already corrected the inner panel to landscape.
const lagging = innerObservation(1, 0, { width: 951, height: 669 });
// The captured sample: rotation 0, 669x951, elements laid out landscape up to x=951.
const staleTransposed = innerObservation(0, 0, { width: 669, height: 951 });
// A fixed portrait display: the runner reads landscape, observe normalizes it to portrait.
const fixedPortrait = {
  ...innerObservation(0, 1, { width: 669, height: 951 }),
  viewHierarchy: {
    rotation: 1,
    hierarchy: { node: { node: [{ bounds: { left: 0, top: 0, right: 669, bottom: 60 } }] } },
  },
} as ObserveResult;

function harness(observeFor: (refreshes: number) => ObserveResult) {
  const client = new FakeIOSCtrlProxy();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tracker = new DisplayTransitionTracker(() => {});
  const refresh = spyOn(client, "requestHierarchySyncWithoutObservationStreamPush");
  const feature = new SetPosture(duo, {
    iosClientProvider: () => client,
    iosDisplayInfoSource: new FakeDevicectlDisplayInfoSource(),
    timer,
    transitionSink: tracker,
    observeFactory: () =>
      ({
        execute: async () => ({
          ...observeFor(refresh.mock.calls.length),
          displayRevision: tracker.revision(duo.deviceId),
        }),
      }) as ObserveScreen,
  });
  return { feature, refresh, timer };
}

describe("setPosture iOS geometry post-condition", () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  afterEach(() => {
    warn.mockClear();
    ObservedAndroidDisplayCache.release(duo.deviceId);
  });

  test("consistent geometry returns no warning and sends no refresh", async () => {
    const h = harness(() => consistent);
    const result = await h.feature.execute("opened");
    expect(result).toMatchObject({ posture: "opened" });
    expect(result).not.toHaveProperty("warnings");
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("a fixed portrait display with a landscape runner rotation is consistent", async () => {
    const h = harness(() => fixedPortrait);
    const result = await h.feature.execute("opened");
    expect(result).toMatchObject({ posture: "opened" });
    expect(result).not.toHaveProperty("warnings");
    expect(h.refresh).not.toHaveBeenCalled();
  });

  test("a lagging runner that refreshes within the wait returns no warning", async () => {
    const h = harness((refreshes) => (refreshes >= 2 ? consistent : lagging));
    const result = await h.feature.execute("opened");
    expect(result).toMatchObject({ posture: "opened" });
    expect(result).not.toHaveProperty("warnings");
    expect(h.refresh).toHaveBeenCalledTimes(2);
    expect(h.timer.getSleepHistory()).toEqual([POSTURE_GEOMETRY_POLL_MS]);
  });

  test.each([
    [
      "lagging runner rotation",
      lagging,
      "the runner reports rotation 0 but observe reports rotation 1 at 951x669",
    ],
    [
      "portrait size with a landscape layout",
      staleTransposed,
      "observe reports rotation 0 and 669x951, but elements are laid out for 951x669",
    ],
  ] as const)("a persistent %s returns success with a warning", async (_name, stale, detail) => {
    const h = harness(() => stale);
    const result = await h.feature.execute("opened");
    expect(result).toMatchObject({ posture: "opened" });
    const warnings = "warnings" in result ? (result.warnings ?? []) : [];
    expect(warnings).toEqual([
      `Screen geometry is still inconsistent ${POSTURE_GEOMETRY_WAIT_MS} ms after the posture change: ${detail}. Taps may land in the wrong place; observe again before tapping.`,
    ]);
    const slept = h.timer.getSleepHistory().reduce((sum, ms) => sum + ms, 0);
    expect(slept).toBe(POSTURE_GEOMETRY_WAIT_MS);
    expect(h.refresh).toHaveBeenCalledTimes(
      POSTURE_GEOMETRY_WAIT_MS / POSTURE_GEOMETRY_POLL_MS + 1,
    );
  });

  test("a failing re-check still returns success with a warning", async () => {
    const h = harness((refreshes) => {
      if (refreshes > 0) {
        throw new Error("runner disconnected");
      }
      return lagging;
    });
    const result = await h.feature.execute("opened");
    expect(result).toMatchObject({
      posture: "opened",
      warnings: [
        "Could not re-check screen geometry after the posture change (runner disconnected); the last observation was inconsistent: the runner reports rotation 0 but observe reports rotation 1 at 951x669. Observe again before tapping.",
      ],
    });
    expect(warn).toHaveBeenCalledWith(
      "[SetPosture] Geometry re-check failed: runner disconnected",
      expect.any(Error),
    );
  });
});
