import capture from "../fixtures/android-enabled/playground-disabled-control-api36.json";
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

// Parse the raw wire hierarchy once; the top-level viewHierarchy is already converted.
const rawHierarchy: AccessibilityHierarchy = JSON.parse(capture.rawViewHierarchy.json);
const disabledControl = findDisabledControl();

function findDisabledControl(): AccessibilityNode {
  const pending = [rawHierarchy.hierarchy];
  while (pending.length) {
    const node = pending.pop();
    if (!node) {
      continue;
    }
    if (node.enabled === "false") {
      return node;
    }
    if (node.node) {
      pending.push(...(Array.isArray(node.node) ? node.node : [node.node]));
    }
  }
  throw new Error("Expected Disabled button in captured Android hierarchy");
}

export function capturedAndroidControl(
  state: "disabled" | "enabled" = "disabled",
): AccessibilityNode {
  const node = structuredClone(disabledControl);
  if (state === "enabled") {
    // State-only comparisons need the same node: enabled wire nodes omit this key.
    delete node.enabled;
  }
  return node;
}

export function androidControlObservation(
  state: "disabled" | "enabled" = "disabled",
): ObserveResult {
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
    packageName: rawHierarchy.packageName,
    hierarchy: { node: capturedAndroidControl(state) },
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
