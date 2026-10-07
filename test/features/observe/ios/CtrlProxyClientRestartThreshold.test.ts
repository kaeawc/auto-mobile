import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios";
import { BootedDevice } from "../../../../src/models";
import {
  createInstantFailureWebSocketFactory,
  createSuccessWebSocketFactory,
  FakeWebSocket,
} from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";
import type { CtrlProxyIosManager } from "../../../../src/ctrlProxy/IOSCtrlProxyManager";
import { FakeIOSCtrlProxyManager } from "../../../fakes/FakeIOSCtrlProxyManager";
import { ForcedRestartBudget } from "../../../../src/ctrlProxy/ForcedRestartBudget";
import {
  RealCtrlProxyWebSocketInTestError,
  defaultWebSocketFactory,
} from "../../../../src/features/observe/DeviceServiceClient";
import { fixedBackoff } from "../../../../src/utils/Backoff";
import { maskRealCtrlProxyWebSocketOptIn } from "../../../helpers/maskRealCtrlProxyWebSocketOptIn";
import { ActionableError } from "../../../../src/models/ActionableError";
import { ViewHierarchy } from "../../../../src/features/observe/ViewHierarchy";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import type { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";

function createFakeManager(
  timer: FakeTimer,
  budget = new ForcedRestartBudget(timer),
): CtrlProxyIosManager & { forceRestartCount: number } {
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
  maskRealCtrlProxyWebSocketOptIn();

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

  test("the unit-test WebSocket guard propagates and never triggers a restart (#10470)", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const fakeManager = createFakeManager(fakeTimer);
    let setupCalls = 0;
    fakeManager.setup = async () => {
      setupCalls++;
      return { success: false as const, message: "test" };
    };

    client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      (url) => defaultWebSocketFactory(url),
      fakeTimer,
      () => fakeManager,
    );

    for (let i = 0; i < 4; i++) {
      await expect(client.ensureConnected()).rejects.toBeInstanceOf(
        RealCtrlProxyWebSocketInTestError,
      );
    }
    await expect(client.requestTapCoordinates(10, 20)).rejects.toBeInstanceOf(
      RealCtrlProxyWebSocketInTestError,
    );
    await new Promise((resolve) => fakeTimer.setTimeout(resolve, 10));

    expect(fakeManager.forceRestartCount).toBe(0);
    expect(setupCalls).toBe(0);
  });

  test("the guard on the post-auto-setup redial is rethrown, not reported as setup failure", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const fakeManager = createFakeManager(fakeTimer);
    fakeManager.isRunning = async () => true;
    const failOnce = createInstantFailureWebSocketFactory(fakeTimer);
    let dials = 0;

    client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      (url) => (++dials === 1 ? failOnce(url) : defaultWebSocketFactory(url)),
      fakeTimer,
      () => fakeManager,
    );

    await expect(client.ensureConnected()).rejects.toBeInstanceOf(
      RealCtrlProxyWebSocketInTestError,
    );
    expect(dials).toBe(2);
  });

  test("restarts again after each three further failed handshakes only until budget exhaustion", async () => {
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

    // Runner launch succeeds, but each background handshake fails. Backoff
    // admits at most two more attempts, then exhaustion denies all later ones.
    for (const delay of [30_000, 60_000]) {
      fakeTimer.advanceTime(delay);
      for (let i = 0; i < 6; i++) {
        await client.ensureConnected();
      }
      await new Promise((resolve) => fakeTimer.setTimeout(resolve, 10));
    }
    expect(fakeManager.forceRestartCount).toBe(3);
    expect(fakeManager.getForcedRestartBudget().snapshot()).toMatchObject({
      state: "exhausted",
      attempts: 3,
    });
    fakeTimer.advanceTime(3_600_000);
    for (let i = 0; i < 12; i++) {
      await client.ensureConnected();
    }
    expect(fakeManager.forceRestartCount).toBe(3);
  });

  test("a genuinely successful reconnect clears failed restart attempts after rearm", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const fakeManager = createFakeManager(fakeTimer);
    let reconnectWorks = false;
    const failed = createInstantFailureWebSocketFactory(fakeTimer);
    const succeeds = createSuccessWebSocketFactory(fakeTimer);
    client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      (url) => (reconnectWorks ? succeeds(url) : failed(url)),
      fakeTimer,
      () => fakeManager,
    );
    for (const [attempt, delay] of [0, 30_000, 60_000].entries()) {
      fakeTimer.advanceTime(delay);
      client.ensureRecoveryStarted();
      if (attempt === 2) {
        await expect(client.awaitRecovery(20_000)).rejects.toBeInstanceOf(ActionableError);
      } else {
        expect(await client.awaitRecovery(20_000)).toBe("failed");
      }
    }
    expect(fakeManager.getForcedRestartBudget().snapshot().state).toBe("exhausted");
    // A fresh device-presence event is the existing external rearm seam.
    fakeManager.getForcedRestartBudget().rearm("device reappeared");
    reconnectWorks = true;
    client.ensureRecoveryStarted();
    expect(await client.awaitRecovery(20_000)).toBe("recovered");
    await fakeTimer.advanceTimeAsync(2000);
    expect(fakeManager.getForcedRestartBudget().snapshot()).toMatchObject({
      state: "idle",
      attempts: 0,
    });
  });

  test("a stable connection on the second attempt succeeds within the budget", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = createFakeManager(timer);
    let reconnectWorks = false;
    const failed = createInstantFailureWebSocketFactory(timer);
    const succeeds = createSuccessWebSocketFactory(timer);
    client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      (url) => (reconnectWorks ? succeeds(url) : failed(url)),
      timer,
      () => manager,
    );
    client.ensureRecoveryStarted();
    expect(await client.awaitRecovery(20_000)).toBe("failed");
    expect(manager.getForcedRestartBudget().snapshot().attempts).toBe(1);
    timer.advanceTime(30_000);
    reconnectWorks = true;
    client.ensureRecoveryStarted();
    expect(await client.awaitRecovery(20_000)).toBe("recovered");
    expect(manager.forceRestartCount).toBe(2);
    expect(manager.getForcedRestartBudget().snapshot()).toMatchObject({
      state: "idle",
      attempts: 0,
    });
  });

  test("briefly opened sockets never rearm the restart budget", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = createFakeManager(timer);
    client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      (url) => {
        const socket = new FakeWebSocket(url, "none", 0, timer);
        socket.on("open", () => socket.close());
        return socket;
      },
      timer,
      () => manager,
    );
    for (const [attempt, delay] of [0, 30_000, 60_000].entries()) {
      timer.advanceTime(delay);
      client.ensureRecoveryStarted();
      if (attempt === 2) {
        await expect(client.awaitRecovery(20_000)).rejects.toBeInstanceOf(ActionableError);
      } else {
        await client.awaitRecovery(20_000);
      }
      await timer.advanceTimeAsync(2000);
    }
    expect(manager.getForcedRestartBudget().snapshot()).toMatchObject({
      state: "exhausted",
      attempts: 3,
    });
  });

  test("awaitRecovery reports failure when iOS socket closes inside the stability window", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = createFakeManager(timer);
    client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      (url) => {
        const socket = new FakeWebSocket(url, "none", 0, timer);
        socket.on("open", () => timer.setTimeout(() => socket.terminate(), 1000));
        return socket;
      },
      timer,
      () => manager,
    );
    client.ensureRecoveryStarted();
    expect(await client.awaitRecovery(20_000)).toBe("failed");
    expect(manager.getForcedRestartBudget().snapshot().attempts).toBe(1);
  });

  test("time limit returns a typed terminal error while runner restart is unfinished", async () => {
    const timer = new FakeTimer();
    const budget = new ForcedRestartBudget(timer, 3, fixedBackoff(1_000), 5_000);
    const manager = createFakeManager(timer, budget);
    manager.forceRestart = async () => {
      manager.forceRestartCount++;
      await new Promise<void>(() => {});
    };
    client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      createInstantFailureWebSocketFactory(timer),
      timer,
      () => manager,
    );
    client.ensureRecoveryStarted();
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
    expect(manager.forceRestartCount).toBe(1);
    const waiting = client.awaitRecovery(20_000);
    timer.advanceTime(5_000);
    await expect(waiting).rejects.toThrow(/recovery exhausted.*Recovery exceeded 5000 ms/);
    await expect(client.awaitRecovery(20_000)).rejects.toBeInstanceOf(ActionableError);
    expect(budget.snapshot().state).toBe("exhausted");
    expect(budget.tryBeginAttempt()).toBeUndefined();
  });

  test("recovery waits for the replacement socket after an old reconnect stabilizes during teardown", async () => {
    const timer = new FakeTimer();
    const manager = createFakeManager(timer);
    let releaseRestart: (() => void) | undefined;
    manager.forceRestart = async () => {
      manager.forceRestartCount++;
      await new Promise<void>((resolve) => {
        releaseRestart = resolve;
      });
    };
    const sockets: FakeWebSocket[] = [];
    client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      (url) => {
        const socket = new FakeWebSocket(url, "none", 0, timer);
        sockets.push(socket);
        return socket;
      },
      timer,
      () => manager,
    );
    client.ensureRecoveryStarted();
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
    expect(releaseRestart).toBeDefined();
    const waiting = client.awaitRecovery(20_000);
    expect(await client.ensureConnected()).toBe(true);
    await timer.advanceTimeAsync(2000);
    expect((client as any).pendingRestartToken).toBeDefined();
    sockets[0]!.terminate();
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseRestart!();
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
    }
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    await timer.advanceTimeAsync(2000);
    expect(await waiting).toBe("recovered");
  });

  test("recovery accepts a replacement socket opened before forceRestart returns", async () => {
    const timer = new FakeTimer();
    const manager = createFakeManager(timer);
    manager.getServicePort = () => 8765;
    let releaseRestart: (() => void) | undefined;
    manager.forceRestart = async () => {
      manager.forceRestartCount++;
      await new Promise<void>((resolve) => {
        releaseRestart = resolve;
      });
    };
    const sockets: FakeWebSocket[] = [];
    client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      (url) => {
        const socket = new FakeWebSocket(url, "none", 0, timer);
        sockets.push(socket);
        return socket;
      },
      timer,
      () => manager,
    );
    client.ensureRecoveryStarted();
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
    expect(releaseRestart).toBeDefined();
    const waiting = client.awaitRecovery(20_000);
    expect(await client.ensureConnected()).toBe(true);
    expect(sockets).toHaveLength(1);
    await timer.advanceTimeAsync(2500);
    releaseRestart!();
    expect(await waiting).toBe("recovered");
    expect(await client.ensureConnected()).toBe(true);
    expect(manager.getForcedRestartBudget().snapshot()).toMatchObject({
      state: "idle",
      attempts: 0,
    });
  });

  test("ViewHierarchy does not refetch after iOS socket closes inside the stability window", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = createFakeManager(timer);
    client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      (url) => {
        const socket = new FakeWebSocket(url, "none", 0, timer);
        socket.on("open", () => timer.setTimeout(() => socket.terminate(), 1000));
        return socket;
      },
      timer,
      () => manager,
    );
    let reads = 0;
    const hierarchySpy = spyOn(client, "getLatestHierarchy").mockImplementation(async () => {
      reads++;
      return { hierarchy: null, unavailableReason: "runner_not_running" };
    });
    const instanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(client);
    try {
      const vh = new ViewHierarchy(
        testDevice,
        new FakeAdbClientFactory(),
        {} as AndroidCtrlProxyClient,
        timer,
      );
      const result = await vh.getViewHierarchy();
      expect(reads).toBe(1);
      expect(result.hierarchy.unavailableReason).toBe("runner_not_running");
    } finally {
      instanceSpy.mockRestore();
      hierarchySpy.mockRestore();
    }
  });

  test("older iOS recovery completion preserves a newer recovery promise", async () => {
    const timer = new FakeTimer();
    const releases: Array<() => void> = [];
    client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      createInstantFailureWebSocketFactory(timer),
      timer,
      () => createFakeManager(timer),
      () =>
        new Promise<BootedDevice[]>((resolve) => {
          releases.push(() => resolve([]));
        }),
    );
    const internals = client as any;
    client.ensureRecoveryStarted();
    const first = internals.recoveryPromise;
    expect(releases).toHaveLength(1);
    // Model replacement before the first boot probe's completion settles.
    internals.isRequestingServiceRestart = false;
    internals.recoveryPromise = null;
    client.ensureRecoveryStarted();
    const second = internals.recoveryPromise;
    expect(releases).toHaveLength(2);
    releases[0]!();
    await first;
    expect(internals.recoveryPromise).toBe(second);
    expect(internals.isRequestingServiceRestart).toBe(true);
    releases[1]!();
    await second;
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

    test("discovery rejection fails closed without starting or charging a restart", async () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const manager = new FakeIOSCtrlProxyManager(fakeTimer);
      client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        8765,
        createInstantFailureWebSocketFactory(fakeTimer),
        fakeTimer,
        () => manager,
        async () => {
          throw new Error("simctl unavailable");
        },
      );
      client.ensureRecoveryStarted();
      expect(await client.awaitRecovery(20_000)).toBe("failed");
      expect(manager.getCallCount("forceRestart")).toBe(0);
      expect(manager.getForcedRestartBudget().snapshot()).toMatchObject({
        state: "idle",
        attempts: 0,
      });
    });

    test("awaitRecovery uses the injected timer and leaves an unfinished restart bounded", async () => {
      const fakeTimer = new FakeTimer();
      const manager = new FakeIOSCtrlProxyManager(fakeTimer);
      let releaseDiscovery: ((devices: BootedDevice[]) => void) | undefined;
      const discovery = new Promise<BootedDevice[]>((resolve) => {
        releaseDiscovery = resolve;
      });
      client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        8765,
        createInstantFailureWebSocketFactory(fakeTimer),
        fakeTimer,
        () => manager,
        () => discovery,
      );
      expect(await client.awaitRecovery(20_000)).toBe("not_recovering");
      client.ensureRecoveryStarted();
      const waiting = client.awaitRecovery(20_000);
      expect(fakeTimer.getPendingTimeouts()).toContain(20_000);
      fakeTimer.advanceTime(20_000);
      expect(await waiting).toBe("timed_out");
      expect(manager.getCallCount("forceRestart")).toBe(0);
      releaseDiscovery?.([]);
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
