import { afterEach, describe, expect, test } from "bun:test";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios";
import { BootedDevice } from "../../../../src/models";
import { createInstantFailureWebSocketFactory } from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";
import type { CtrlProxyIosManager } from "../../../../src/utils/IOSCtrlProxyManager";
import { FakeIOSCtrlProxyManager } from "../../../fakes/FakeIOSCtrlProxyManager";

function createFakeManager(): CtrlProxyIosManager & { forceRestartCount: number } {
  const manager = {
    forceRestartCount: 0,
    async setup() {
      return { success: false as const, message: "test" };
    },
    async isInstalled() {
      return false;
    },
    async isRunning() {
      return false;
    },
    async isAvailable() {
      return false;
    },
    async start() {},
    async stop() {},
    getServicePort() {
      return 0;
    },
    setAutoRestart() {},
    isAutoRestartEnabled() {
      return false;
    },
    async forceRestart() {
      manager.forceRestartCount++;
    },
  };
  return manager;
}

const testDevice: BootedDevice = {
  deviceId: "test-sim-id",
  platform: "ios",
  name: "Test iPhone",
};

describe("IOSCtrlProxyClient restart threshold", () => {
  let client: IOSCtrlProxyClient | null = null;

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
    IOSCtrlProxyClient.resetInstances();
  });

  test("triggerServiceRestart fires exactly once at failure threshold", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    const fakeManager = createFakeManager();
    const serviceManagerFactory = (_device: BootedDevice) => fakeManager;

    client = IOSCtrlProxyClient.createForTesting(
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
    await new Promise((resolve) => fakeTimer.setTimeout(resolve, 10));

    // forceRestart should have been called exactly once (at failure #3)
    expect(fakeManager.forceRestartCount).toBe(1);
  });

  test("restart re-triggers every N failures via modulo", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    const fakeManager = createFakeManager();
    const serviceManagerFactory = (_device: BootedDevice) => fakeManager;

    client = IOSCtrlProxyClient.createForTesting(
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
    await new Promise((resolve) => fakeTimer.setTimeout(resolve, 10));
    expect(fakeManager.forceRestartCount).toBe(1);

    // Advance past cooldown to allow more attempts
    fakeTimer.advanceTime(11000);

    await client.ensureConnected(); // 4
    await client.ensureConnected(); // 5
    await client.ensureConnected(); // 6 → restart again
    await new Promise((resolve) => fakeTimer.setTimeout(resolve, 10));
    expect(fakeManager.forceRestartCount).toBe(2);
  });

  test("no restart triggered when failures below threshold", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    const fakeManager = createFakeManager();
    const serviceManagerFactory = (_device: BootedDevice) => fakeManager;

    client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
      serviceManagerFactory,
    );

    // Only 2 failures — below threshold of 3
    await client.ensureConnected();
    await client.ensureConnected();

    await new Promise((resolve) => fakeTimer.setTimeout(resolve, 10));

    expect(fakeManager.forceRestartCount).toBe(0);
  });

  describe("triggerServiceRestart branches", () => {
    const driveFailuresPastThreshold = async (
      c: IOSCtrlProxyClient,
      fakeTimer: FakeTimer,
    ): Promise<void> => {
      // Mirror the threshold-crossing pattern the other tests use: a batch of
      // attempts, then advance past the connection cooldown so the failure counter
      // can climb to a multiple of MAX_FAILURES_BEFORE_RESTART (3).
      for (let i = 0; i < 3; i++) {
        await c.ensureConnected();
      }
      fakeTimer.advanceTime(11000);
      for (let i = 0; i < 3; i++) {
        await c.ensureConnected();
      }
      // Let the async isRunning()/forceRestart() chain settle.
      await new Promise((resolve) => fakeTimer.setTimeout(resolve, 10));
    };

    test("does not force-restart when the manager reports the runner is still running", async () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const manager = new FakeIOSCtrlProxyManager();
      manager.setSetupShouldFail(true);
      // Runner is alive; the WebSocket failure is transient, so no restart is due.
      manager.setRunning(true);

      client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        8765,
        createInstantFailureWebSocketFactory(fakeTimer),
        fakeTimer,
        (_device: BootedDevice) => manager,
      );

      await driveFailuresPastThreshold(client, fakeTimer);

      expect(manager.getCallCount("forceRestart")).toBe(0);
    });

    test("force-restarts a down runner and recovers when the restart rejects", async () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const manager = new FakeIOSCtrlProxyManager();
      // Failed setup must not flip runningState, so isRunning() stays false and the
      // restart path is taken; the restart itself then rejects.
      manager.setSetupShouldFail(true);
      manager.setForceRestartShouldFail(true);

      client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        8765,
        createInstantFailureWebSocketFactory(fakeTimer),
        fakeTimer,
        (_device: BootedDevice) => manager,
      );

      await driveFailuresPastThreshold(client, fakeTimer);

      // The restart was attempted (down-branch entered, not the already-running branch)...
      expect(manager.getCallCount("forceRestart")).toBeGreaterThanOrEqual(1);

      // ...and the catch branch reset the in-flight-restart guard, so a further
      // threshold crossing retries. Without that reset the guard wedges forever
      // and forceRestart never fires again.
      fakeTimer.advanceTime(11000);
      for (let i = 0; i < 6; i++) {
        await client.ensureConnected();
      }
      await new Promise((resolve) => fakeTimer.setTimeout(resolve, 10));
      expect(manager.getCallCount("forceRestart")).toBeGreaterThanOrEqual(2);
    });

    test("probes the running-state and never force-restarts across repeated threshold crossings while running", async () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const manager = new FakeIOSCtrlProxyManager();
      manager.setSetupShouldFail(true);
      manager.setRunning(true);

      client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        8765,
        createInstantFailureWebSocketFactory(fakeTimer),
        fakeTimer,
        (_device: BootedDevice) => manager,
      );

      await driveFailuresPastThreshold(client, fakeTimer);

      // Running-state is probed as part of the restart decision on every crossing...
      expect(manager.getCallCount("isRunning")).toBeGreaterThan(0);
      // ...and because it stays running, no threshold crossing ever force-restarts.
      expect(manager.getCallCount("forceRestart")).toBe(0);
    });

    test("recovers when the status probe rejects so a later crossing probes again", async () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const manager = new FakeIOSCtrlProxyManager();
      manager.setSetupShouldFail(true);
      // The status probe itself rejects — the SEPARATE outer catch (distinct from the
      // forceRestart-failure catch) must reset the in-flight-restart guard, or every
      // later restart attempt is suppressed forever.
      manager.setIsRunningShouldFail(true);

      client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        8765,
        createInstantFailureWebSocketFactory(fakeTimer),
        fakeTimer,
        (_device: BootedDevice) => manager,
      );

      await driveFailuresPastThreshold(client, fakeTimer);
      // The probe rejected before ever reaching forceRestart, so nothing restarted yet.
      expect(manager.getCallCount("isRunning")).toBeGreaterThan(0);
      expect(manager.getCallCount("forceRestart")).toBe(0);

      // The probe now succeeds and reports the runner DOWN, so the next crossing is
      // due to force-restart. That can only happen if the outer catch reset the
      // in-flight guard; if it wedged the guard, this crossing early-returns and
      // forceRestart never fires.
      manager.setIsRunningShouldFail(false);
      fakeTimer.advanceTime(11000);
      for (let i = 0; i < 6; i++) {
        await client.ensureConnected();
      }
      await new Promise((resolve) => fakeTimer.setTimeout(resolve, 10));
      expect(manager.getCallCount("forceRestart")).toBeGreaterThanOrEqual(1);
    });
  });
});
