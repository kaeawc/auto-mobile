import { afterEach, describe, expect, test } from "bun:test";
import { CtrlProxyClient } from "../../../../src/features/observe/ios";
import { BootedDevice } from "../../../../src/models";
import {
  createInstantFailureWebSocketFactory,
} from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";
import type { CtrlProxyIosManager } from "../../../../src/utils/IOSCtrlProxyManager";

function createFakeManager(overrides: Partial<CtrlProxyIosManager> = {}): CtrlProxyIosManager & { forceRestartCount: number } {
  const manager = {
    forceRestartCount: 0,
    async setup() { return { success: false as const, message: "test" }; },
    async isInstalled() { return false; },
    async isRunning() { return false; },
    async isAvailable() { return false; },
    async start() {},
    async stop() {},
    getServicePort() { return 0; },
    setAutoRestart() {},
    isAutoRestartEnabled() { return false; },
    async forceRestart() { manager.forceRestartCount++; },
    ...overrides,
  };
  return manager;
}

const testDevice: BootedDevice = {
  deviceId: "test-sim-id",
  platform: "ios",
  name: "Test iPhone",
};

describe("CtrlProxyClient restart threshold", () => {
  let client: CtrlProxyClient | null = null;

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
    CtrlProxyClient.resetInstances();
  });

  test("triggerServiceRestart fires exactly once at failure threshold", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    const fakeManager = createFakeManager();
    const serviceManagerFactory = (_device: BootedDevice) => fakeManager;

    client = CtrlProxyClient.createForTesting(
      testDevice,
      8765,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
      serviceManagerFactory,
    );

    // Trigger 5 connection failures
    for (let i = 0; i < 5; i++) {
      await client.ensureConnected();
    }

    // Allow async restart callbacks to complete
    await new Promise(resolve => fakeTimer.setTimeout(resolve, 10));

    // forceRestart should have been called exactly once (at failure #3)
    expect(fakeManager.forceRestartCount).toBe(1);
  });

  test("restart re-triggers every N failures via modulo", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    const fakeManager = createFakeManager();
    const serviceManagerFactory = (_device: BootedDevice) => fakeManager;

    client = CtrlProxyClient.createForTesting(
      testDevice,
      8765,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
      serviceManagerFactory,
    );

    // Trigger 6 connection failures — restart should fire at failure #3 and #6
    // DeviceServiceClient cooldown is 3 attempts with 10s reset, so we advance time
    // between batches to allow more connection attempts
    await client.ensureConnected(); // 1
    await client.ensureConnected(); // 2
    await client.ensureConnected(); // 3 → restart
    await new Promise(resolve => fakeTimer.setTimeout(resolve, 10));
    expect(fakeManager.forceRestartCount).toBe(1);

    // Advance past cooldown to allow more attempts
    fakeTimer.advanceTime(11000);

    await client.ensureConnected(); // 4
    await client.ensureConnected(); // 5
    await client.ensureConnected(); // 6 → restart again
    await new Promise(resolve => fakeTimer.setTimeout(resolve, 10));
    expect(fakeManager.forceRestartCount).toBe(2);
  });

  test("restart counter resets after successful connection allows re-triggering", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    const fakeManager = createFakeManager();
    const serviceManagerFactory = (_device: BootedDevice) => fakeManager;

    // Fail 3 times (triggers restart), then succeed on attempt 4, then fail again
    // DeviceServiceClient has maxConnectionAttempts=3 by default, so we use a fresh
    // factory that tracks total calls
    let wsAttempt = 0;
    const wsFactory = (url: string) => {
      wsAttempt++;
      const { FakeWebSocket } = require("../../../fakes/FakeWebSocket");
      // Succeed on attempt 4, fail otherwise
      return new FakeWebSocket(url, wsAttempt === 4 ? "none" : "instant", 0, fakeTimer);
    };

    client = CtrlProxyClient.createForTesting(
      testDevice,
      8765,
      wsFactory,
      fakeTimer,
      serviceManagerFactory,
    );

    // 3 failures → triggers restart
    await client.ensureConnected();
    await client.ensureConnected();
    await client.ensureConnected();
    await new Promise(resolve => fakeTimer.setTimeout(resolve, 10));
    expect(fakeManager.forceRestartCount).toBe(1);

    // Advance past the DeviceServiceClient connection cooldown (default 10s)
    fakeTimer.advanceTime(11000);

    // 4th attempt succeeds → resets consecutiveConnectionFailures to 0
    const result = await client.ensureConnected();
    expect(result).toBe(true);

    // Now close and fail 3 more times — should trigger a second restart
    await client.close();
    CtrlProxyClient.resetInstances();

    // New client for the next cycle
    wsAttempt = 0; // Reset factory
    const fakeManager2 = createFakeManager();
    client = CtrlProxyClient.createForTesting(
      testDevice,
      8765,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
      (_device: BootedDevice) => fakeManager2,
    );

    for (let i = 0; i < 3; i++) {
      await client.ensureConnected();
    }
    await new Promise(resolve => fakeTimer.setTimeout(resolve, 10));
    expect(fakeManager2.forceRestartCount).toBe(1);
  });

  test("no restart triggered when failures below threshold", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    const fakeManager = createFakeManager();
    const serviceManagerFactory = (_device: BootedDevice) => fakeManager;

    client = CtrlProxyClient.createForTesting(
      testDevice,
      8765,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
      serviceManagerFactory,
    );

    // Only 2 failures — below threshold of 3
    await client.ensureConnected();
    await client.ensureConnected();

    await new Promise(resolve => fakeTimer.setTimeout(resolve, 10));

    expect(fakeManager.forceRestartCount).toBe(0);
  });
});
