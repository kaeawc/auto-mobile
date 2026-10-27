import { CtrlProxyHierarchy } from "../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  AccessibilityHierarchy,
  HierarchyDelegateContext,
} from "../../src/features/observe/android/types";
import type { BootedDevice } from "../../src/models";
import { RequestManager } from "../../src/utils/RequestManager";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";

const CONVERTER_DEVICE: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};

/** A fully typed, never-connected delegate context: conversion reads only its timer. */
function inertHierarchyContext(timer: FakeTimer): HierarchyDelegateContext {
  let lastWebSocketTimeout = 0;
  return {
    device: CONVERTER_DEVICE,
    adb: new FakeAdbExecutor(),
    timer,
    requestManager: new RequestManager(timer),
    getWebSocket: () => null,
    ensureConnected: async () => false,
    cancelScreenshotBackoff: () => {},
    getCachedHierarchy: () => null,
    setCachedHierarchy: () => {},
    getLastWebSocketTimeout: () => lastWebSocketTimeout,
    setLastWebSocketTimeout: (time) => {
      lastWebSocketTimeout = time;
    },
  };
}

/** The production accessibility-wire to view-hierarchy converter, driven by an inert context. */
export function createAndroidHierarchyConverter(timer = new FakeTimer()): CtrlProxyHierarchy {
  return new CtrlProxyHierarchy(inertHierarchyContext(timer));
}

/**
 * Shallow wire-boundary check, as `isCapturedObservation` does for observations: the runner
 * serializes absent optionals as JSON null and may send malformed reason lists, which the static
 * `AccessibilityHierarchy` type cannot express. The converter tolerates them, as production does.
 */
export function isWireHierarchy(value: unknown): value is AccessibilityHierarchy {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates a (possibly sentinel-bearing) runner payload and returns it typed. Throws otherwise. */
export function wireHierarchyFrom(raw: unknown, label = "wire hierarchy"): AccessibilityHierarchy {
  if (!isWireHierarchy(raw)) {
    throw new Error(`${label} is not an accessibility hierarchy object`);
  }
  return raw;
}
