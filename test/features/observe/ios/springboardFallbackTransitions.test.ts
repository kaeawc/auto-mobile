import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/ios/CtrlProxyHierarchy";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios/IOSCtrlProxyClient";
import type {
  CtrlProxyCachedHierarchy,
  HierarchyDelegateContext,
  XCTestHierarchy,
} from "../../../../src/features/observe/ios/types";
import { logger } from "../../../../src/utils/logger";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { createSuccessWebSocketFactory } from "../../../fakes/FakeWebSocket";
import { FakeIosSdkEventIngestor } from "../../../fakes/FakeIosSdkEventIngestor";

let debug: ReturnType<typeof spyOn<typeof logger, "debug">>;
beforeEach(() => {
  debug = spyOn(logger, "debug").mockImplementation(() => {});
});
afterEach(() => debug.mockRestore());
const transitions = () =>
  debug.mock.calls
    .map(([message]) => String(message))
    .filter((message) => message.includes("fallback"));
let timestamp = 0;
function tree(flag?: boolean): XCTestHierarchy {
  return {
    updatedAt: ++timestamp,
    packageName: "com.apple.springboard",
    hierarchy: { text: "Home" },
    ...(flag === undefined ? {} : { fallbackToSpringboard: flag }),
  };
}
function client(deviceId = "device-a") {
  const timer = new FakeTimer();
  return IOSCtrlProxyClient.createForTesting(
    { deviceId, platform: "ios", name: deviceId },
    8765,
    createSuccessWebSocketFactory(timer),
    timer,
    undefined,
    undefined,
    { onDeviceConnectionLost() {} },
    new FakeIosSdkEventIngestor(),
  );
}
function push(target: IOSCtrlProxyClient, hierarchy: XCTestHierarchy) {
  target["processMessage"]({ type: "hierarchy_update", data: hierarchy });
}

describe("SpringBoard fallback transition logs", () => {
  test("false to true logs once with device, package, and home-screen reason", () => {
    const target = client();
    push(target, tree(false));
    push(target, tree(true));
    expect(transitions()).toHaveLength(1);
    expect(transitions()[0]).toContain("device-a");
    expect(transitions()[0]).toContain("com.apple.springboard");
    expect(transitions()[0]).toContain("foreground app");
    expect(transitions()[0]).toContain("home screen");
  });
  test("repeated true and duplicate conversions do not log again", async () => {
    const target = client();
    const first = tree(true);
    push(target, first);
    push(target, tree(true));
    target.convertToViewHierarchyResult(first);
    // Disconnected cache fallback is a read, not a new observation.
    target["hierarchy"]["context"].ensureConnected = async () => false;
    await target.getLatestHierarchy();
    expect(transitions()).toHaveLength(1);
  });
  test.each([false, undefined])("true to %s clears exactly once", (flag) => {
    const target = client();
    push(target, tree(true));
    push(target, tree(flag));
    push(target, tree(flag));
    expect(transitions()).toHaveLength(2);
    expect(transitions()[1]).toContain("fallback cleared");
  });
  test("converting an older cached tree cannot replay a cleared transition", () => {
    const target = client();
    const older = tree(true);
    push(target, older);
    push(target, tree(false));
    target.convertToViewHierarchyResult(older);
    expect(transitions()).toHaveLength(2);
    expect(transitions()[1]).toContain("fallback cleared");
  });
  test("two devices track transitions independently", () => {
    const a = client();
    const b = client("device-b");
    push(a, tree(true));
    push(b, tree(true));
    push(a, tree(false));
    push(b, tree(true));
    expect(transitions()).toHaveLength(3);
    expect(transitions()[1]).toContain("device-b");
    expect(transitions()[2]).toContain("device-a");
  });
  test.each(["clearCache", "onConnectionClosed", "close"] as const)(
    "%s resets transition memory",
    async (reset) => {
      const target = client();
      push(target, tree(true));
      await target[reset]();
      push(target, tree(true));
      expect(transitions()).toHaveLength(2);
      expect(transitions().every((message) => !message.includes("cleared"))).toBe(true);
    },
  );
  test("absent flags never log and conversion stays unchanged", () => {
    const target = client();
    const input = tree();
    const before = target.convertToViewHierarchyResult(input);
    push(target, input);
    push(target, tree());
    expect(target.convertToViewHierarchyResult(input)).toEqual(before);
    expect(before).not.toHaveProperty("fallbackToSpringboard");
    expect(target["hierarchy"].convertToViewHierarchyResult(tree(true)).fallbackToSpringboard).toBe(
      true,
    );
    expect(transitions()).toHaveLength(0);
  });
  test("synchronous delegate responses log without requiring stream conversion", async () => {
    const timer = new FakeTimer();
    const requestManager = new RequestManager(timer);
    let cached: CtrlProxyCachedHierarchy | null = null;
    const context: HierarchyDelegateContext = {
      timer,
      requestManager,
      cacheFreshTtlMs: 500,
      getDeviceId: () => "sync-device",
      getWebSocket: () =>
        ({
          readyState: 1,
          send(data: string) {
            const request: { requestId: string } = JSON.parse(data);
            requestManager.resolve(request.requestId, { hierarchy: tree(true) });
          },
        }) as never,
      ensureConnected: async () => true,
      cancelScreenshotBackoff() {},
      getCachedHierarchy: () => cached,
      setCachedHierarchy(value) {
        cached = value;
      },
    };
    const delegate = new CtrlProxyHierarchy(context);
    await delegate.getLatestHierarchy();
    await delegate.requestHierarchySync();
    expect(transitions()).toHaveLength(1);
    expect(transitions()[0]).toContain("sync-device");
  });
});
