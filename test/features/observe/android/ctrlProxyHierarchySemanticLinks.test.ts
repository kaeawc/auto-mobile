import { describe, expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/android/CtrlProxyHierarchy";
import type { HierarchyDelegateContext } from "../../../../src/features/observe/android/types";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeTimer } from "../../../fakes/FakeTimer";

function createHierarchy(): CtrlProxyHierarchy {
  const timer = new FakeTimer();
  const context: HierarchyDelegateContext = {
    getWebSocket: () => null,
    requestManager: new RequestManager(timer),
    timer,
    ensureConnected: async () => true,
    cancelScreenshotBackoff: () => {},
    device: { deviceId: "emulator-5554", platform: "android" } as never,
    adb: {} as never,
    getCachedHierarchy: () => null,
    setCachedHierarchy: () => {},
    getLastWebSocketTimeout: () => 0,
    setLastWebSocketTimeout: () => {},
  };
  return new CtrlProxyHierarchy(context);
}

describe("CtrlProxyHierarchy semantic links", () => {
  test("retains Android runner semantic-link metadata in the converted hierarchy", () => {
    const result = createHierarchy().convertToViewHierarchyResult({
      hierarchy: {
        text: "Read the Terms of Service",
        bounds: { left: 0, top: 0, right: 200, bottom: 40 },
        "semantic-links": [{ text: "Terms of Service", occurrence: 0, start: 9, end: 25 }],
      },
      updatedAt: 1,
    });

    expect(result.hierarchy["semantic-links"]).toEqual([
      { text: "Terms of Service", occurrence: 0, start: 9, end: 25 },
    ]);
  });
});
