import { spyOn } from "bun:test";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import { CtrlProxyHierarchy } from "../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  AccessibilityHierarchy,
  CachedHierarchy,
  HierarchyDelegateContext,
} from "../../src/features/observe/android/types";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import { ViewHierarchy } from "../../src/features/observe/ViewHierarchy";
import { RequestManager } from "../../src/utils/RequestManager";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeWebSocket } from "../fakes/FakeWebSocket";

export const DEVICE_CAPTURE_TIME = 1_700_000_000_000;

/** Constructed trees, not recorded device captures. Only request_hierarchy extracts a new frame. */
export async function deviceLikeAndroidHierarchy(
  label: (extraction: number) => string = () => "Still screen",
) {
  const timer = new FakeTimer();
  timer.setCurrentTime(DEVICE_CAPTURE_TIME + 10);
  timer.enableAutoAdvance();
  const device = {
    deviceId: "fake-settle-cache",
    name: "Fake Android",
    platform: "android",
  } as const;
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("shell dumpsys activity processes", {
    stdout: "ProcessRecord{abc 123:com.android.settings/u0a123}",
    stderr: "",
    exitCode: 0,
  });
  const tree = (extraction: number): AccessibilityHierarchy => ({
    packageName: "com.android.settings",
    foregroundActivity: "com.android.settings/.Settings",
    updatedAt: DEVICE_CAPTURE_TIME + extraction,
    screenWidth: 1080,
    screenHeight: 2400,
    wakefulness: "Awake",
    hierarchy: {
      className: "android.widget.FrameLayout",
      bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
      node: [{ text: label(extraction), bounds: { left: 0, top: 100, right: 200, bottom: 160 } }],
    },
  });
  let cached: CachedHierarchy | null = {
    hierarchy: tree(0),
    receivedAt: timer.now(),
    fresh: true,
  };
  const socket = new FakeWebSocket("ws://fake", "none", 0, timer);
  await Promise.resolve();
  const context: HierarchyDelegateContext = {
    getWebSocket: () => socket as never,
    requestManager: new RequestManager(timer),
    timer,
    ensureConnected: async () => true,
    cancelScreenshotBackoff: () => {},
    device,
    adb,
    getCachedHierarchy: () => cached,
    setCachedHierarchy: (value) => {
      cached = value;
    },
    getLastWebSocketTimeout: () => 0,
    setLastWebSocketTimeout: () => {},
  };
  const hierarchy = new CtrlProxyHierarchy(context);
  let extractions = 0;
  const displayIds: (number | undefined)[] = [];
  socket.send = (data) => {
    const request = JSON.parse(String(data)) as {
      type: string;
      requestId: string;
      displayId?: number;
    };
    if (request.type !== "request_hierarchy") {
      throw new Error(`Unexpected fake runner request: ${request.type}`);
    }
    extractions++;
    displayIds.push(request.displayId);
    const extracted = { ...tree(extractions), displayId: request.displayId };
    // Model the client's hierarchy_update handler: sync replies populate the
    // shared cache AND resolve their correlated waiter. No unsolicited pushes.
    timer.setTimeout(() => {
      cached = {
        hierarchy: extracted,
        receivedAt: timer.now(),
        fresh: true,
        requestId: request.requestId,
      };
      hierarchy.resolvePendingHierarchy(request.requestId, cached);
    }, 20);
  };
  const availability = spyOn(AndroidCtrlProxyManager, "getInstance").mockReturnValue({
    isAvailable: async () => true,
  } as never);
  const reads: { floor: number; fresh: boolean | undefined; updatedAt: number | undefined }[] = [];
  // Exercise the real ViewHierarchy and client forwarding method without constructing
  // a resident client. The concrete client has private state; only its hierarchy
  // delegate and no-op recomposition seam are needed by these fake-device reads.
  const client = {
    hierarchy,
    setRecompositionTrackingEnabled: async () => {},
    getAccessibilityHierarchy: async (
      ...args: Parameters<AndroidCtrlProxyClient["getAccessibilityHierarchy"]>
    ) => {
      const result = await AndroidCtrlProxyClient.prototype.getAccessibilityHierarchy.call(
        client as never,
        ...args,
      );
      if (result) {
        reads.push({ floor: args[3] ?? 0, fresh: result.fresh, updatedAt: result.updatedAt });
      }
      return result;
    },
  };
  const viewHierarchy = new ViewHierarchy(
    device,
    new FakeAdbClientFactory(adb),
    client as never,
    timer,
  );
  return {
    timer,
    device,
    adb,
    hierarchy,
    viewHierarchy,
    reads,
    displayIds,
    extractions: () => extractions,
    restore: () => availability.mockRestore(),
  };
}
