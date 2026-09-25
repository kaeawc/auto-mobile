import { afterEach, describe, expect, test } from "bun:test";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios";
import { BootedDevice } from "../../../../src/models";
import { createInstantFailureWebSocketFactory, FakeWebSocket } from "../../../fakes/FakeWebSocket";
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

  test("restarts again after each three further failed handshakes", async () => {
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

    // Trigger the first restart at failure #3.
    await client.ensureConnected(); // 1
    await client.ensureConnected(); // 2
    await client.ensureConnected(); // 3 → restart
    await new Promise((resolve) => fakeTimer.setTimeout(resolve, 10));
    expect(fakeManager.forceRestartCount).toBe(1);

    // Background reconnects no longer consume the foreground attempt budget,
    // so these six caller dials reach two further restart thresholds.
    fakeTimer.advanceTime(11000);

    for (let i = 0; i < 6; i++) {
      await client.ensureConnected();
    }
    await new Promise((resolve) => fakeTimer.setTimeout(resolve, 10));
    expect(fakeManager.forceRestartCount).toBe(3);
  });

  test("a permanently gone device triggers only one automatic restart", async () => {
    const fakeTimer = new FakeTimer();
    const fakeManager = createFakeManager();
    const failingFactory = createInstantFailureWebSocketFactory(fakeTimer);
    let firstSocket: FakeWebSocket | null = null;
    let socketCount = 0;
    client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      (url) => {
        socketCount++;
        if (firstSocket === null) {
          firstSocket = new FakeWebSocket(url, "none", 0, fakeTimer);
          return firstSocket;
        }
        return failingFactory(url);
      },
      fakeTimer,
      () => fakeManager,
    );

    expect(await client.ensureConnected()).toBe(true);
    firstSocket!.close();
    await fakeTimer.resolvePromise(
      new Promise<void>((resolve) => fakeTimer.setTimeout(resolve, 1)),
      1,
    );
    for (const delay of [2000, 4000, 8000]) {
      await fakeTimer.advanceTimeAsync(delay);
    }
    await fakeTimer.advanceTimeAsync(60000);
    expect(fakeManager.forceRestartCount).toBe(1);
    const stoppedAt = socketCount;
    await fakeTimer.advanceTimeAsync(60000);
    expect(socketCount).toBe(stoppedAt);
    expect(fakeManager.forceRestartCount).toBe(1);
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

    test("force-restarts after repeated WebSocket failures even when HTTP reports running", async () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const manager = new FakeIOSCtrlProxyManager();
      manager.setSetupShouldFail(true);
      // HTTP health is weaker than the WebSocket command path and must not veto
      // recovery after the connection-failure threshold.
      manager.setRunning(true);

      client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        8765,
        createInstantFailureWebSocketFactory(fakeTimer),
        fakeTimer,
        (_device: BootedDevice) => manager,
      );

      await driveFailuresPastThreshold(client, fakeTimer);

      expect(manager.getCallCount("forceRestart")).toBeGreaterThanOrEqual(1);
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

    test("synchronizes the client to a replacement port after forced restart", async () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const manager = new FakeIOSCtrlProxyManager();
      manager.setSetupShouldFail(true);
      manager.setServicePort(8771);

      client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        8765,
        createInstantFailureWebSocketFactory(fakeTimer),
        fakeTimer,
        (_device: BootedDevice) => manager,
      );

      await driveFailuresPastThreshold(client, fakeTimer);

      expect(manager.getCallCount("forceRestart")).toBeGreaterThanOrEqual(1);
      expect(client.getConnectionPortForDiagnostics()).toBe(8771);
    });

    test("force-restart does not depend on a successful HTTP status probe", async () => {
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
      expect(manager.getCallCount("forceRestart")).toBeGreaterThanOrEqual(1);
    });
  });
});
