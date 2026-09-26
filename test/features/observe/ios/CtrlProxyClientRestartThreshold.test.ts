import { afterEach, describe, expect, test } from "bun:test";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios";
import { BootedDevice } from "../../../../src/models";
import {
  createInstantFailureWebSocketFactory,
  createSuccessWebSocketFactory,
  FakeWebSocket,
} from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";
import type { CtrlProxyIosManager } from "../../../../src/utils/IOSCtrlProxyManager";
import { FakeIOSCtrlProxyManager } from "../../../fakes/FakeIOSCtrlProxyManager";
import { ForcedRestartBudget } from "../../../../src/utils/ctrlProxy/ForcedRestartBudget";

function createFakeManager(timer: FakeTimer): CtrlProxyIosManager & { forceRestartCount: number } {
  const budget = new ForcedRestartBudget(timer);
  const manager = {
    getForcedRestartBudget: () => budget,
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

    const fakeManager = createFakeManager(fakeTimer);
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

    const fakeManager = createFakeManager(fakeTimer);
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
    const fakeManager = createFakeManager(fakeTimer);
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

    const fakeManager = createFakeManager(fakeTimer);
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

      const manager = new FakeIOSCtrlProxyManager(fakeTimer);
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

    test("retries a rejected forced restart only after backoff", async () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const manager = new FakeIOSCtrlProxyManager(fakeTimer);
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

      // A further threshold is denied during backoff, then admitted after 30s.
      fakeTimer.advanceTime(11000);
      for (let i = 0; i < 6; i++) {
        await client.ensureConnected();
      }
      await new Promise((resolve) => fakeTimer.setTimeout(resolve, 10));
      expect(manager.getCallCount("forceRestart")).toBe(1);
      fakeTimer.advanceTime(31000);
      for (let i = 0; i < 6; i++) {
        await client.ensureConnected();
      }
      await new Promise((resolve) => fakeTimer.setTimeout(resolve, 10));
      expect(manager.getCallCount("forceRestart")).toBeGreaterThanOrEqual(2);
    });

    test("startup timeouts exhaust three attempts and reappearance rearms one", async () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const manager = new FakeIOSCtrlProxyManager(fakeTimer);
      manager.setForceRestartShouldFail(true);
      client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        8765,
        createInstantFailureWebSocketFactory(fakeTimer),
        fakeTimer,
        () => manager,
      );

      for (const delay of [0, 30_000, 60_000]) {
        fakeTimer.advanceTime(delay);
        await driveFailuresPastThreshold(client, fakeTimer);
      }
      expect(manager.getCallCount("forceRestart")).toBe(3);
      expect(manager.getForcedRestartBudget().snapshot()).toMatchObject({
        state: "exhausted",
        attempts: 3,
        lastFailureReason: "Failed to force-restart IOSCtrlProxy",
      });
      fakeTimer.advanceTime(3_600_000);
      for (let i = 0; i < 30; i++) {
        await client.ensureConnected();
      }
      expect(manager.getCallCount("forceRestart")).toBe(3);

      manager.getForcedRestartBudget().rearm("device reappeared");
      await driveFailuresPastThreshold(client, fakeTimer);
      expect(manager.getCallCount("forceRestart")).toBe(4);
    });

    test("two clients for one device share the manager's budget", async () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const manager = new FakeIOSCtrlProxyManager(fakeTimer);
      manager.setForceRestartShouldFail(true);
      const factory = () => manager;
      client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        8765,
        createInstantFailureWebSocketFactory(fakeTimer),
        fakeTimer,
        factory,
      );
      const second = IOSCtrlProxyClient.createForTesting(
        testDevice,
        8765,
        createInstantFailureWebSocketFactory(fakeTimer),
        fakeTimer,
        factory,
      );
      try {
        await driveFailuresPastThreshold(client, fakeTimer);
        await driveFailuresPastThreshold(second, fakeTimer);
        expect(manager.getCallCount("forceRestart")).toBe(1);
        fakeTimer.advanceTime(30_000);
        await driveFailuresPastThreshold(second, fakeTimer);
        expect(manager.getCallCount("forceRestart")).toBe(2);
      } finally {
        await second.close();
      }
    });

    test("does not restart a simulator absent from booted discovery", async () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const manager = new FakeIOSCtrlProxyManager(fakeTimer);
      let bootedDeviceLister = async (): Promise<BootedDevice[]> => [];
      client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        8765,
        createInstantFailureWebSocketFactory(fakeTimer),
        fakeTimer,
        () => manager,
        () => bootedDeviceLister(),
      );
      await driveFailuresPastThreshold(client, fakeTimer);
      expect(manager.getCallCount("forceRestart")).toBe(0);
      expect(manager.getForcedRestartBudget().snapshot().state).toBe("idle");

      bootedDeviceLister = async () => [testDevice];
      await driveFailuresPastThreshold(client, fakeTimer);
      expect(manager.getCallCount("forceRestart")).toBeGreaterThan(0);
    });

    test("a late WebSocket connection cannot clear removal suspension", async () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const manager = new FakeIOSCtrlProxyManager(fakeTimer);
      manager.getForcedRestartBudget().suspend("device disappeared from discovery");
      client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        8765,
        createSuccessWebSocketFactory(fakeTimer),
        fakeTimer,
        () => manager,
      );
      expect(await client.ensureConnected()).toBe(true);
      expect(manager.getForcedRestartBudget().snapshot().state).toBe("suspended");
    });

    test("synchronizes the client to a replacement port after forced restart", async () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const manager = new FakeIOSCtrlProxyManager(fakeTimer);
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

      const manager = new FakeIOSCtrlProxyManager(fakeTimer);
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
