import { describe, expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/android/CtrlProxyHierarchy";
import type { HierarchyDelegateContext } from "../../../../src/features/observe/android/types";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";

function convert(accessibilityTool: boolean | null | undefined, sdkInt = 34) {
  const timer = new FakeTimer();
  const context: HierarchyDelegateContext = {
    timer,
    requestManager: new RequestManager(timer),
    getWebSocket: () => null,
    ensureConnected: async () => true,
    cancelScreenshotBackoff: () => {},
    device: { name: "Fake Android", deviceId: "fake-android", platform: "android" },
    adb: new FakeAdbExecutor(),
    getCachedHierarchy: () => null,
    setCachedHierarchy: () => {},
    getLastWebSocketTimeout: () => 0,
    setLastWebSocketTimeout: () => {},
  };
  return new CtrlProxyHierarchy(context).convertToViewHierarchyResult({
    updatedAt: 1,
    packageName: "app",
    hierarchy: { node: { className: "android.widget.FrameLayout" } },
    sdkInt,
    accessibilityTool,
  });
}

describe("CtrlProxyHierarchy accessibilityTool metadata (#6233)", () => {
  test("a reported boolean is carried onto the hierarchy result", () => {
    expect(convert(true).accessibilityTool).toBe(true);
    expect(convert(false).accessibilityTool).toBe(false);
  });

  test("a null or absent value stays unknown", () => {
    expect(convert(null).accessibilityTool).toBeUndefined();
    expect(convert(undefined).accessibilityTool).toBeUndefined();
  });
});
