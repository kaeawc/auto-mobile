import { afterEach, describe, expect, test } from "bun:test";
import {
  AndroidCtrlProxyClient,
  type AndroidServiceRecoveryManager,
} from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import type { ProxySetupResult } from "../../../../src/utils/interfaces/ProxyManager";
import { BootedDevice } from "../../../../src/models";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { createInstantFailureWebSocketFactory } from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";

/**
 * Regression coverage (issue #7532): AndroidCtrlProxyClient never escalated
 * repeated connection failures to service recovery. `onConnectAttemptFailed()`
 * (the shared #7537 funnel that fires once per failed dial and once per lost
 * open connection) now counts consecutive failures and, at the threshold,
 * checks the accessibility service's health through an injected manager seam,
 * rebinding (#7470) or running full setup only when it is actually unhealthy.
 */
describe("AndroidCtrlProxyClient - connection-failure escalation to service recovery", function () {
  const testDevice: BootedDevice = {
    deviceId: "test-device-recovery",
    platform: "android",
    isEmulator: true,
    name: "Test Device",
  };

  let client: AndroidCtrlProxyClient | null = null;

  afterEach(async function () {
    if (client) {
      await client.close();
      client = null;
    }
  });

  const buildFakeAdb = (present: boolean = true): FakeAdbExecutor => {
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("forward", { stdout: "8765", stderr: "" });
    if (present) {
      fakeAdb.setDeviceStates([{ deviceId: testDevice.deviceId, state: "device" }]);
    }
    return fakeAdb;
  };

  /** Minimal configurable fake for the narrow AndroidServiceRecoveryManager seam. */
  class FakeManager implements AndroidServiceRecoveryManager {
    healthy = false;
    rebindRestoresHealth = true;
    setupSucceeds = true;
    isAccessibilityServiceHealthyCallCount = 0;
    rebindIfUnhealthyCallCount = 0;
    setupCallCount = 0;

    async isAccessibilityServiceHealthy(): Promise<boolean> {
      this.isAccessibilityServiceHealthyCallCount++;
      return this.healthy;
    }

    async rebindIfUnhealthy(): Promise<boolean> {
      this.rebindIfUnhealthyCallCount++;
      if (this.rebindRestoresHealth) {
        this.healthy = true;
      }
      return true;
    }

    async setup(): Promise<ProxySetupResult> {
      this.setupCallCount++;
      if (this.setupSucceeds) {
        this.healthy = true;
      }
      return {
        success: this.setupSucceeds,
        message: this.setupSucceeds ? "setup ok" : "setup failed",
      };
    }
  }

  /** Drive `count` connection failures, each a separate ensureConnected() dial. */
  const driveFailures = async (c: AndroidCtrlProxyClient, count: number): Promise<void> => {
    for (let i = 0; i < count; i++) {
      await c.ensureConnected();
    }
  };

  const flushMicrotasks = async (): Promise<void> => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };

  test("recovers exactly once after 3 consecutive connection failures", async function () {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const fakeAdb = buildFakeAdb();
    const manager = new FakeManager();

    client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
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

    await driveFailures(client, 3);
    await flushMicrotasks();

    expect(manager.rebindIfUnhealthyCallCount).toBe(1);
    expect(manager.setupCallCount).toBe(0);
    // An actual rebind repair resets the foreground cooldown immediately.
    expect(client.getReconnectStatus()).toBeNull();
  });

  test("a second recovery cannot start while the first is in flight", async function () {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const fakeAdb = buildFakeAdb();

    let releaseHealthCheck: (() => void) | null = null;
    let healthCheckCallCount = 0;
    const manager: AndroidServiceRecoveryManager = {
      async isAccessibilityServiceHealthy(): Promise<boolean> {
        healthCheckCallCount++;
        await new Promise<void>((resolve) => {
          releaseHealthCheck = resolve;
        });
        return false;
      },
      async rebindIfUnhealthy(): Promise<boolean> {
        return true;
      },
      async setup(): Promise<ProxySetupResult> {
        return { success: true, message: "setup ok" };
      },
    };

    client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
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

    // First 3 failures cross the threshold; the health probe blocks forever
    // until released, keeping this recovery "in flight".
    await driveFailures(client, 3);
    await flushMicrotasks();
    expect(healthCheckCallCount).toBe(1);

    // Advance past the connection cooldown and drive 3 more failures — a
    // second threshold crossing — while the first recovery is still blocked.
    fakeTimer.advanceTime(11000);
    await driveFailures(client, 3);
    await flushMicrotasks();

    // No second recovery attempt started: the health probe was not called again.
    expect(healthCheckCallCount).toBe(1);

    releaseHealthCheck?.();
    await flushMicrotasks();
  });

  test("a healthy service is never rebound; the client reconnects in the background without resetting the foreground cooldown", async function () {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const fakeAdb = buildFakeAdb();
    const manager = new FakeManager();
    manager.healthy = true;

    client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
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

    await driveFailures(client, 3);
    await flushMicrotasks();

    expect(manager.isAccessibilityServiceHealthyCallCount).toBeGreaterThanOrEqual(1);
    expect(manager.rebindIfUnhealthyCallCount).toBe(0);
    expect(manager.setupCallCount).toBe(0);
    // #6260: a service that was already healthy is not evidence the WS refusal
    // is fixed, so recovery must not clear the foreground cooldown — only an
    // actual rebind/setup repair earns that reset.
    expect(client.getReconnectStatus()).not.toBeNull();
  });

  test("a closed client triggers no recovery", async function () {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const fakeAdb = buildFakeAdb();
    const manager = new FakeManager();

    client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
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

    await driveFailures(client, 2);
    await client.close();
    // Closing disables auto-reconnect and latches `closed`; any further
    // dial attempt (e.g. a straggling background reconnect) must not count
    // toward — or act on — the recovery threshold.
    await client.ensureConnected();
    await flushMicrotasks();

    expect(manager.isAccessibilityServiceHealthyCallCount).toBe(0);
    expect(manager.rebindIfUnhealthyCallCount).toBe(0);
    expect(manager.setupCallCount).toBe(0);
    client = null;
  });

  test("a device adb reports missing triggers no recovery", async function () {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    // Device absent: buildFakeAdb(false) leaves getDeviceStates() empty.
    const fakeAdb = buildFakeAdb(false);
    const manager = new FakeManager();

    client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
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

    await driveFailures(client, 3);
    await flushMicrotasks();

    expect(manager.isAccessibilityServiceHealthyCallCount).toBe(0);
    expect(manager.rebindIfUnhealthyCallCount).toBe(0);
    expect(manager.setupCallCount).toBe(0);
  });

  test("falls back to full setup when rebind does not restore health", async function () {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const fakeAdb = buildFakeAdb();
    const manager = new FakeManager();
    manager.rebindRestoresHealth = false;

    client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
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

    await driveFailures(client, 3);
    await flushMicrotasks();

    expect(manager.rebindIfUnhealthyCallCount).toBe(1);
    expect(manager.setupCallCount).toBe(1);
  });
});
