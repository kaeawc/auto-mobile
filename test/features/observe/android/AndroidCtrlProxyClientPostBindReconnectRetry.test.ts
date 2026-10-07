import { afterEach, expect, spyOn, test } from "bun:test";
import {
  AndroidCtrlProxyClient,
  type AndroidServiceRecoveryManager,
} from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import type { ProxySetupResult } from "../../../../src/utils/interfaces/ProxyManager";
import { BootedDevice, ViewHierarchyResult } from "../../../../src/models";
import { ViewHierarchy } from "../../../../src/features/observe/ViewHierarchy";
import { logger } from "../../../../src/utils/logger";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { createTimeGatedWebSocketFactory } from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { settleByFakeEvents } from "../../../helpers/fakeTimerStepping";

const device: BootedDevice = {
  deviceId: "post-bind-retry",
  platform: "android",
  isEmulator: true,
  name: "Test Device",
};

let client: AndroidCtrlProxyClient | null = null;
afterEach(async () => {
  if (client) {
    await client.close();
    client = null;
  }
});

// Manual fake time only. Auto-advance spends a real event-loop turn per fake
// event, so under CI load the client's fake 5 s connection timeout could fire
// before a refused dial was delivered, burning the 10 s recovery budget.
function settle<T>(timer: FakeTimer, promise: Promise<T>, description: string): Promise<T> {
  return settleByFakeEvents(timer, promise, { description });
}

function createHarness(timer: FakeTimer, gateMs: number, onGateStart?: () => void) {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("forward", { stdout: "8765", stderr: "" });
  adb.setDeviceStates([{ deviceId: device.deviceId, state: "device" }]);
  let healthy = false;
  const manager: AndroidServiceRecoveryManager = {
    async isAccessibilityServiceHealthy(): Promise<boolean> {
      return healthy;
    },
    async rebindIfUnhealthy(): Promise<boolean> {
      healthy = true;
      return true;
    },
    async setup(): Promise<ProxySetupResult> {
      healthy = true;
      return { success: true, message: "setup ok" };
    },
  };
  const gatedFactory = createTimeGatedWebSocketFactory(gateMs, timer, 4, onGateStart);
  const dialTimes: number[] = [];
  client = AndroidCtrlProxyClient.createForTesting(
    device,
    adb,
    (url: string) => {
      dialTimes.push(timer.now());
      return gatedFactory(url);
    },
    timer,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => manager,
  );
  return { subject: client, dialTimes };
}

test("post-bind reconnect retries until the fake WebSocket server is listening", async () => {
  const timer = new FakeTimer();
  const { subject, dialTimes } = createHarness(timer, 500);

  for (let attempt = 0; attempt < 3; attempt++) {
    expect(await settle(timer, subject.ensureConnected(), "foreground connect")).toBe(false);
  }

  const freshHierarchy: ViewHierarchyResult = {
    hierarchy: {
      packageName: "com.android.settings",
      hierarchy: { node: [{ text: "fresh" }] },
    },
    updatedAt: timer.now(),
  };
  const firstRead: ViewHierarchyResult = {
    hierarchy: {
      error: "connection lost",
      unavailableReason: "connection_lost",
      transportFailure: true,
    },
    updatedAt: timer.now(),
  };
  let hierarchyReads = 0;
  const hierarchySpy = spyOn(subject, "getAccessibilityHierarchy").mockImplementation(async () => {
    hierarchyReads++;
    return hierarchyReads === 1 ? firstRead : freshHierarchy;
  });
  const hierarchy = new ViewHierarchy(device, undefined, subject, timer);
  const observed = await settle(
    timer,
    hierarchy.getViewHierarchy(undefined, undefined, false, 0),
    "observe after post-bind reconnect",
  );

  expect(observed).toBe(freshHierarchy);
  expect(observed.hierarchy.unavailableReason).toBeUndefined();
  expect(hierarchyReads).toBe(2);
  expect(subject.isConnected()).toBe(true);
  // Dials 1-3 are the foreground failures; dial 4 starts the 500 ms gate. Each
  // refused post-bind redial is one 100 ms backoff later (never a 5 s
  // connection-timeout jump), and the dial at the gate is the one that binds.
  const postBindDials = dialTimes.slice(3);
  expect(postBindDials.map((at) => at - postBindDials[0])).toEqual([0, 100, 200, 300, 400, 500]);
  hierarchySpy.mockRestore();
});

test("post-bind reconnect gives up at the observe recovery budget", async () => {
  const timer = new FakeTimer();
  const warn = spyOn(logger, "warn");
  let retryStartedAt = 0;
  const { subject } = createHarness(timer, Number.POSITIVE_INFINITY, () => {
    retryStartedAt = timer.now();
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    expect(await settle(timer, subject.ensureConnected(), "foreground connect")).toBe(false);
  }

  expect(
    await settle(
      timer,
      subject.awaitRecovery(AndroidCtrlProxyClient.OBSERVE_RECOVERY_WAIT_MS + 1000),
      "post-bind recovery",
    ),
  ).not.toBe("recovered");
  const retryElapsed = timer.now() - retryStartedAt;
  expect(retryElapsed).toBeGreaterThanOrEqual(AndroidCtrlProxyClient.OBSERVE_RECOVERY_WAIT_MS);
  expect(retryElapsed).toBeLessThanOrEqual(AndroidCtrlProxyClient.OBSERVE_RECOVERY_WAIT_MS + 100);
  expect(warn).toHaveBeenCalledWith(
    "[AndroidCtrlProxyClient] WebSocket reconnect failed after CtrlProxy recovery",
  );
  warn.mockRestore();
});
