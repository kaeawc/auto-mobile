import type { BootedDevice, ViewHierarchyResult } from "../../src/models";
import type { ObserveScreenDependencies } from "../../src/features/observe/ObserveScreenDependencies";
import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import { displayTransitions } from "../../src/features/observe/DisplayTransition";
import { ObservedAndroidDisplayCache } from "../../src/features/observe/ObservationDisplay";
import { resetObserveCacheStore } from "../../src/features/observe/cache/ObserveCacheRegistry";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeObserveCacheStore } from "../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeHierarchyCapture } from "../fakes/FakeHierarchyCapture";
import { FakeViewHierarchy } from "../fakes/FakeViewHierarchy";

export const transientFailures = [
  ["connect-failed", "Failed to establish CtrlProxy WebSocket connection"],
  [
    "socket-unavailable",
    "Unable to request hierarchy for Android display 2: CtrlProxy WebSocket is unavailable",
  ],
  ["send-failed", "Unable to request hierarchy for Android display 2: send exploded"],
  ["socket-closed-before-wait", "CtrlProxy WebSocket closed or changed before hierarchy wait"],
  ["socket-changed", "CtrlProxy WebSocket changed while waiting for hierarchy response"],
  ["socket-disconnected", "CtrlProxy WebSocket disconnected while waiting for hierarchy response"],
  ["timeout", "Timed out waiting for hierarchy response after 100ms"],
  ["no-answer", "Hierarchy service did not answer the sync request"],
] as const;

export const terminalFailures = [
  ["runner-error", "runner error: selected panel extraction failed"],
  ["screen-off", "Screen is off while waiting for hierarchy response"],
  ["capture-error", "Unable to capture hierarchy: malformed nodes"],
  ["timestamp-floor", "Hierarchy capture did not satisfy the device timestamp floor"],
  ["unknown", "unexpected failure"],
] as const;

export const selectedDisplayDevice: BootedDevice = {
  name: "Selected display retry fake",
  platform: "android",
  deviceId: "selected-display-retry-test",
  displays: {
    panels: [
      { key: "cover", role: "cover", sizePx: { width: 100, height: 100 } },
      { key: "inner", role: "inner", sizePx: { width: 200, height: 200 } },
    ],
    postures: [],
  },
};

export const readOptions = {
  skipScreenshot: true,
  skipBackStack: true,
  skipPerformanceAudit: true,
  skipRecompositionTracking: true,
  skipAccessibilityAudit: true,
};

export function selectedHierarchy(): ViewHierarchyResult {
  return {
    hierarchy: { node: { bounds: { left: 0, top: 0, right: 200, bottom: 200 } } },
    displayId: 2,
    screenWidth: 200,
    screenHeight: 200,
    frameContext: "second-capture",
    captureSequence: 2,
    fresh: true,
  };
}

export function selectedDisplayHarness(options: {
  read: () => ViewHierarchyResult | Promise<ViewHierarchyResult>;
  timer?: FakeTimer;
  selectedDisplayRead?: ObserveScreenDependencies["selectedDisplayRead"];
}) {
  const timer = options.timer ?? new FakeTimer();
  timer.enableAutoAdvance();
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("cmd display get-displays", {
    stdout:
      'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:inner" type INTERNAL, real 200 x 200}',
    stderr: "",
  });
  const capture = new FakeHierarchyCapture(options.read);
  const viewHierarchy = new FakeViewHierarchy();
  viewHierarchy.configureHierarchy(selectedHierarchy());
  const screen = new RealObserveScreen(
    selectedDisplayDevice,
    new FakeAdbClientFactory(adb),
    {
      hierarchyCapture: capture,
      viewHierarchy,
      cacheStore: new FakeObserveCacheStore(timer),
      selectedDisplayRead: options.selectedDisplayRead,
    },
    timer,
  );
  return { timer, adb, capture, screen };
}

export function resetSelectedDisplayHarness(): void {
  displayTransitions.reset(selectedDisplayDevice.deviceId);
  ObservedAndroidDisplayCache.release(selectedDisplayDevice.deviceId);
  resetObserveCacheStore();
}
