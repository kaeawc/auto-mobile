import { expect, test } from "bun:test";
import { SingleDisplayEnrichStage } from "../../../src/features/observe/SingleDisplayEnrichStage";
import { ObserveElementsBuilder } from "../../../src/features/observe/ObserveElementsBuilder";
import { SafeAreaAuditor } from "../../../src/features/observe/audits/SafeAreaAuditor";
import { ObservedAndroidDisplayCache } from "../../../src/features/observe/ObservationDisplay";
import type { SingleDisplayRun } from "../../../src/features/observe/singleDisplayRun";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import type { ObserveResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import { spatialPanelObservation } from "../../helpers/xrSpatialPanelFixture";

function unused(): never {
  throw new Error("Unexpected stage dependency");
}

function stage(xr: boolean): SingleDisplayEnrichStage {
  const timer = new FakeTimer();
  return new SingleDisplayEnrichStage({
    device: () => ({ name: "fake", deviceId: "xr-refresh", platform: "android" }),
    isAndroidXr: () => xr,
    timer: () => timer,
    platformTraits: unused,
    screenshotRecorder: unused,
    pathProtection: unused,
    performanceAuditor: unused,
    accessibilityAuditor: unused,
    accessibilityStateDetector: unused,
    predictiveUIState: unused,
    safeAreaAuditor: () => new SafeAreaAuditor(),
    elementsBuilder: () => new ObserveElementsBuilder(),
    screenRound: unused,
    deferredBackStackDisplays: unused,
    stampScreenSizeUnits: () => {},
    processRecomposition: async () => {},
    captureSettledScreenshot: async () => {},
  });
}

function run(result: ObserveResult): SingleDisplayRun {
  return {
    options: undefined,
    perf: new NoOpPerformanceTracker(),
    queryOptions: undefined,
    skipWaitForFresh: true,
    minTimestamp: 0,
    signal: undefined,
    skipBackStack: true,
    observerMode: true,
    preserveDisplayState: false,
    displayRequest: undefined,
    androidDisplayCache: new ObservedAndroidDisplayCache(new FakeTimer()),
    screenshotMode: "none",
    iosLockState: undefined,
    observedAndroid: undefined,
    explicitlyRouted: false,
    requestedPanel: undefined,
    requestedDisplayId: undefined,
    result,
    startTime: 0,
    captureStart: { revision: 0, identityRevision: 0 },
    routedAggregateSecondary: false,
    cacheGeneration: 0,
  };
}

/** A waitFor poll captures without the stack; the terminal read attaches the captured one later. */
async function enrichWithoutBackStack(xr: boolean) {
  const observation = spatialPanelObservation();
  const backStack = observation.backStack;
  delete observation.backStack;
  const enrich = stage(xr);
  await enrich.enrichSingleDisplay(run(observation));
  observation.backStack = backStack;
  return { observation, enrich };
}

test("a deferred back stack restores XR panel-space fields", async () => {
  const { observation, enrich } = await enrichWithoutBackStack(true);
  expect(observation.xrPanelSpace).toBeUndefined();
  expect(JSON.stringify(observation.elements)).not.toContain("boundsSpace");
  enrich.refreshXrPanelSpace(observation);
  expect(observation.xrPanelSpace).toEqual({
    windowId: 93,
    bounds: { left: 0, top: 0, right: 2768, bottom: 2400 },
  });
  const settings = observation.elements!.text.find((row) => row.text === "Settings");
  expect(settings?.boundsSpace).toBe("panel");
});

test("off XR a deferred back stack leaves the observation untouched", async () => {
  const { observation, enrich } = await enrichWithoutBackStack(false);
  const before = JSON.stringify(observation);
  const elements = observation.elements;
  enrich.refreshXrPanelSpace(observation);
  expect(observation.elements).toBe(elements);
  expect(JSON.stringify(observation)).toBe(before);
});
