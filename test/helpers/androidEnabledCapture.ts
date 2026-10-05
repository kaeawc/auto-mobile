import capturedIme from "../fixtures/android-ime-window/playground-gboard-api36.json";
import { CtrlProxyHierarchy } from "../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  AccessibilityHierarchy,
  AccessibilityNode,
  HierarchyDelegateContext,
} from "../../src/features/observe/android/types";
import { DefaultObserveElementCollector } from "../../src/features/observe/ObserveElementCollector";
import type { ObserveResult } from "../../src/models/ObserveResult";
import { RequestManager } from "../../src/utils/RequestManager";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";

// Existing raw device capture, also used by skeletonProjection.test.ts. No real
// disabled Android capture was found in test/fixtures or the mt26–mt30 evidence
// tree (including its other scratch batches). Derive the disabled wire value
// in-test, exactly as ViewHierarchyExtractor emits it; never edit the capture.
export function capturedAndroidControl(enabled?: string): AccessibilityNode {
  const capture = structuredClone(capturedIme) as AccessibilityHierarchy;
  const pending = [capture.hierarchy];
  while (pending.length) {
    const node = pending.pop();
    if (!node) {
      continue;
    }
    if (node["view-id"] === "6b9279dc-8ced-8c76-7de6-a9d07f621ae5") {
      if (enabled !== undefined) {
        node.enabled = enabled;
      }
      return node;
    }
    if (node.node) {
      pending.push(...(Array.isArray(node.node) ? node.node : [node.node]));
    }
  }
  throw new Error("Expected Basic Text Field in captured Android hierarchy");
}

export function androidEnabledObservation(enabled?: string): ObserveResult {
  const timer = new FakeTimer();
  const context: HierarchyDelegateContext = {
    timer,
    requestManager: new RequestManager(timer),
    getWebSocket: () => null,
    ensureConnected: async () => false,
    cancelScreenshotBackoff: () => {},
    device: { name: "Fake Android", deviceId: "fake-android", platform: "android" },
    adb: new FakeAdbExecutor(),
    getCachedHierarchy: () => null,
    setCachedHierarchy: () => {},
    getLastWebSocketTimeout: () => 0,
    setLastWebSocketTimeout: () => {},
  };
  const viewHierarchy = new CtrlProxyHierarchy(context).convertToViewHierarchyResult({
    updatedAt: 1,
    packageName: capturedIme.packageName,
    hierarchy: { node: capturedAndroidControl(enabled) },
  });
  return {
    updatedAt: 1,
    display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
    screenSize: { width: 1080, height: 2400 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy,
    elements: new DefaultObserveElementCollector().collect(viewHierarchy, "android"),
  };
}
