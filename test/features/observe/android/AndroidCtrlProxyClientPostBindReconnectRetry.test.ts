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
  client = AndroidCtrlProxyClient.createForTesting(
    device,
    adb,
    createTimeGatedWebSocketFactory(gateMs, timer, 4, onGateStart),
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
  return client;
}

test("post-bind reconnect retries until the fake WebSocket server is listening", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const subject = createHarness(timer, 500);

  for (let attempt = 0; attempt < 3; attempt++) {
    expect(await subject.ensureConnected()).toBe(false);
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
  const observed = await hierarchy.getViewHierarchy(undefined, undefined, false, 0);

  expect(observed).toBe(freshHierarchy);
  expect(observed.hierarchy.unavailableReason).toBeUndefined();
  expect(hierarchyReads).toBe(2);
  expect(subject.isConnected()).toBe(true);
  expect(timer.now()).toBeGreaterThanOrEqual(500);
  hierarchySpy.mockRestore();
});

test("post-bind reconnect gives up at the observe recovery budget", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const warn = spyOn(logger, "warn");
  let retryStartedAt = 0;
  const subject = createHarness(timer, Number.POSITIVE_INFINITY, () => {
    retryStartedAt = timer.now();
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    expect(await subject.ensureConnected()).toBe(false);
  }

  expect(
    await subject.awaitRecovery(AndroidCtrlProxyClient.OBSERVE_RECOVERY_WAIT_MS + 1000),
  ).not.toBe("recovered");
  const retryElapsed = timer.now() - retryStartedAt;
  expect(retryElapsed).toBeGreaterThanOrEqual(AndroidCtrlProxyClient.OBSERVE_RECOVERY_WAIT_MS);
  expect(retryElapsed).toBeLessThanOrEqual(AndroidCtrlProxyClient.OBSERVE_RECOVERY_WAIT_MS + 100);
  expect(warn).toHaveBeenCalledWith(
    "[AndroidCtrlProxyClient] WebSocket reconnect failed after CtrlProxy recovery",
  );
  warn.mockRestore();
});
