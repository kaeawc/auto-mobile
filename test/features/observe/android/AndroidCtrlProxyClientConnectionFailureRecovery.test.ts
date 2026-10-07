import { installFakeCtrlProxyManagers } from "../../../helpers/hermeticDeviceTools";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AndroidCtrlProxyClient,
  type AndroidServiceRecoveryManager,
} from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import type { ProxySetupResult } from "../../../../src/utils/interfaces/ProxyManager";
import { BootedDevice } from "../../../../src/models";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import {
  createInstantFailureWebSocketFactory,
  createSuccessWebSocketFactory,
  FakeWebSocket,
} from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { ForcedRestartBudget } from "../../../../src/ctrlProxy/ForcedRestartBudget";
import {
  RealCtrlProxyWebSocketInTestError,
  defaultWebSocketFactory,
} from "../../../../src/features/observe/DeviceServiceClient";
import { maskRealCtrlProxyWebSocketOptIn } from "../../../helpers/maskRealCtrlProxyWebSocketOptIn";

/**
 * Regression coverage (issue #7532): AndroidCtrlProxyClient never escalated
 * repeated connection failures to service recovery. `onConnectAttemptFailed()`
 * (the shared #7537 funnel that fires once per failed dial and once per lost
 * open connection) now counts consecutive failures and, at the threshold,
 * checks the accessibility service's health through an injected manager seam,
 * rebinding (#7470) or running full setup only when it is actually unhealthy.
 */
let restoreDeviceToolProviders: () => void;
beforeEach(() => {
  restoreDeviceToolProviders = installFakeCtrlProxyManagers();
});
afterEach(() => {
  restoreDeviceToolProviders();
});

describe("AndroidCtrlProxyClient - connection-failure escalation to service recovery", function () {
  maskRealCtrlProxyWebSocketOptIn();

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

  test("the unit-test WebSocket guard propagates and never escalates to recovery (#10470)", async function () {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const manager = new FakeManager();

    client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      buildFakeAdb(),
      (url) => defaultWebSocketFactory(url),
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

    for (let i = 0; i < 3; i++) {
      await expect(client.ensureConnected()).rejects.toBeInstanceOf(
        RealCtrlProxyWebSocketInTestError,
      );
    }
    await expect(client.requestTapCoordinates(10, 20)).rejects.toBeInstanceOf(
      RealCtrlProxyWebSocketInTestError,
    );
    // The typed-result wrappers must rethrow it too, not resolve a failed action.
    await expect(client.requestAction("click")).rejects.toBeInstanceOf(
      RealCtrlProxyWebSocketInTestError,
    );
    await expect(client.requestActivateAccessibilityLink("Terms", 0)).rejects.toBeInstanceOf(
      RealCtrlProxyWebSocketInTestError,
    );
    await flushMicrotasks();

    expect(manager.isAccessibilityServiceHealthyCallCount).toBe(0);
    expect(manager.rebindIfUnhealthyCallCount).toBe(0);
    expect(manager.setupCallCount).toBe(0);
    expect(client.getLastConnectionFailureMessage()).toBeUndefined();
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

  test("healthy service with failed WebSocket reconnect records a budget failure", async function () {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeManager();
    manager.healthy = true;
    client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      buildFakeAdb(),
      createInstantFailureWebSocketFactory(timer),
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
    client.ensureRecoveryStarted();
    expect(await client.awaitRecovery(10_000)).toBe("failed");
    const budget = (client as any).forcedRestartBudget as ForcedRestartBudget;
    expect(budget.snapshot()).toMatchObject({ state: "backoff", attempts: 1 });
    expect(manager.rebindIfUnhealthyCallCount).toBe(0);
  });

  test("briefly opened recovery sockets never rearm the Android restart budget", async function () {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeManager();
    manager.healthy = true;
    client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      buildFakeAdb(),
      (url) => {
        const socket = new FakeWebSocket(url, "none", 0, timer);
        socket.on("open", () => timer.setTimeout(() => socket.terminate(), 1000));
        return socket as WebSocket;
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
    for (const delay of [0, 30_000, 60_000]) {
      timer.advanceTime(delay);
      client.ensureRecoveryStarted();
      await client.awaitRecovery(10_000);
      await timer.advanceTimeAsync(2000);
    }
    const budget = (client as any).forcedRestartBudget as ForcedRestartBudget;
    expect(budget.snapshot()).toMatchObject({ state: "exhausted", attempts: 3 });
  });

  test("stable external Android reconnect rearms an exhausted restart budget", async function () {
    const timer = new FakeTimer();
    client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      buildFakeAdb(),
      createSuccessWebSocketFactory(timer),
      timer,
    );
    const budget = (client as any).forcedRestartBudget as ForcedRestartBudget;
    for (const delay of [0, 30_000, 60_000]) {
      timer.advanceTime(delay);
      const token = budget.tryBeginAttempt();
      expect(token).toBeDefined();
      budget.recordFailure("runner unavailable", token!);
    }
    expect(budget.snapshot().state).toBe("exhausted");
    expect(await client.ensureConnected()).toBe(true);
    await timer.advanceTimeAsync(2000);
    expect(budget.snapshot()).toMatchObject({ state: "idle", attempts: 0 });
  });

  test("stable reconnect during recovery health check satisfies that recovery", async function () {
    const timer = new FakeTimer();
    let releaseHealth: ((healthy: boolean) => void) | undefined;
    const manager: AndroidServiceRecoveryManager = {
      isAccessibilityServiceHealthy: () =>
        new Promise<boolean>((resolve) => {
          releaseHealth = resolve;
        }),
      rebindIfUnhealthy: async () => false,
      setup: async () => ({ success: false, message: "not needed" }),
    };
    client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      buildFakeAdb(),
      createSuccessWebSocketFactory(timer),
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
    client.ensureRecoveryStarted();
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
    expect(releaseHealth).toBeDefined();
    const waiting = client.awaitRecovery(10_000);
    expect(await client.ensureConnected()).toBe(true);
    await timer.advanceTimeAsync(2000);
    releaseHealth!(true);
    expect(await waiting).toBe("recovered");
  });

  test("setup replaces an interim rebind socket without failing recovery", async function () {
    const timer = new FakeTimer();
    const sockets: FakeWebSocket[] = [];
    let healthChecks = 0;
    const manager: AndroidServiceRecoveryManager = {
      isAccessibilityServiceHealthy: async () => ++healthChecks === 3,
      rebindIfUnhealthy: async () => {
        expect(await client!.ensureConnected()).toBe(true);
        return true;
      },
      setup: async () => {
        const interim = sockets[0]!;
        const closed = new Promise<void>((resolve) => interim.once("close", resolve));
        interim.terminate();
        await closed;
        return { success: true, message: "setup ok" };
      },
    };
    client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      buildFakeAdb(),
      (url) => {
        const socket = new FakeWebSocket(url, "none", 0, timer);
        sockets.push(socket);
        return socket as WebSocket;
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
    client.ensureRecoveryStarted();
    const waiting = client.awaitRecovery(10_000);
    await flushMicrotasks();
    expect(sockets).toHaveLength(2);
    await timer.advanceTimeAsync(2000);
    expect(await waiting).toBe("recovered");
    expect(await client.ensureConnected()).toBe(true);
    expect((client as any).forcedRestartBudget.snapshot()).toMatchObject({
      state: "idle",
      attempts: 0,
    });
  });

  test("budget-denied observe recovery returns not_recovering without waiting", async function () {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeManager();
    manager.healthy = true;
    client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      buildFakeAdb(),
      createInstantFailureWebSocketFactory(timer),
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
    client.ensureRecoveryStarted();
    expect(await client.awaitRecovery(10_000)).toBe("failed");
    const before = timer.now();
    const healthChecks = manager.isAccessibilityServiceHealthyCallCount;
    client.ensureRecoveryStarted();
    expect(await client.awaitRecovery(10_000)).toBe("not_recovering");
    expect(timer.now()).toBe(before);
    expect(manager.isAccessibilityServiceHealthyCallCount).toBe(healthChecks);
  });

  test("older Android recovery completion preserves a newer recovery promise", async function () {
    const timer = new FakeTimer();
    const releases: Array<() => void> = [];
    const manager: AndroidServiceRecoveryManager = {
      isAccessibilityServiceHealthy: () =>
        new Promise<boolean>((resolve) => {
          releases.push(() => resolve(false));
        }),
      rebindIfUnhealthy: async () => false,
      setup: async () => ({ success: false, message: "failed" }),
    };
    client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      buildFakeAdb(),
      createInstantFailureWebSocketFactory(timer),
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
    const internals = client as any;
    client.ensureRecoveryStarted();
    const first = internals.recoveryPromise;
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
    expect(releases).toHaveLength(1);
    // Model a replacement started while an old completion is pending.
    internals.forcedRestartBudget.rearm("replacement");
    internals.isRecoveringService = false;
    internals.recoveryPromise = null;
    client.ensureRecoveryStarted();
    const second = internals.recoveryPromise;
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
    expect(releases).toHaveLength(2);
    releases[0]!();
    await first;
    expect(internals.recoveryPromise).toBe(second);
    expect(internals.isRecoveringService).toBe(true);
    releases[1]!();
    await second;
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

  test("waits for an existing bind instead of force-stopping it through setup", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let healthy = false;
    let setupCalls = 0;
    let bindingWaits = 0;
    const manager: AndroidServiceRecoveryManager = {
      isAccessibilityServiceHealthy: async () => healthy,
      rebindIfUnhealthy: async () => false,
      waitForAccessibilityServiceBinding: async () => {
        bindingWaits++;
        await timer.sleep(6_000);
        healthy = true;
        return "recovered";
      },
      setup: async () => {
        setupCalls++;
        return { success: true, message: "setup ok" };
      },
    };
    client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      buildFakeAdb(),
      createSuccessWebSocketFactory(timer),
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

    client.ensureRecoveryStarted();
    expect(await client.awaitRecovery(10_000)).toBe("recovered");
    expect(bindingWaits).toBe(1);
    expect(setupCalls).toBe(0);
  });

  test("a completed binding clears foreground cooldown and dials immediately", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const dialTimes: number[] = [];
    let setupCalls = 0;
    const manager: AndroidServiceRecoveryManager = {
      isAccessibilityServiceHealthy: async () => false,
      rebindIfUnhealthy: async () => false,
      waitForAccessibilityServiceBinding: async () => {
        await timer.sleep(100);
        return "recovered";
      },
      setup: async () => {
        setupCalls++;
        return { success: true, message: "setup ok" };
      },
    };
    const successSocket = createSuccessWebSocketFactory(timer);
    client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      buildFakeAdb(),
      (url) => {
        dialTimes.push(timer.now());
        return successSocket(url);
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
    const internals = client as any;
    internals.connectionAttempts = 3;
    internals.lastConnectionAttempt = timer.now();
    internals.config.connectionResetMs = 30_000;
    expect(client.getReconnectStatus()?.connectionAttempts).toBe(3);

    client.ensureRecoveryStarted();
    expect(await client.awaitRecovery(10_000)).toBe("recovered");
    expect(dialTimes).toEqual([100]);
    expect(setupCalls).toBe(0);
  });

  test("an already-bound service leaves foreground connection cooldown intact", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const dialTimes: number[] = [];
    let setupCalls = 0;
    const manager: AndroidServiceRecoveryManager = {
      isAccessibilityServiceHealthy: async () => false,
      rebindIfUnhealthy: async () => false,
      waitForAccessibilityServiceBinding: async () => "already-bound",
      setup: async () => {
        setupCalls++;
        return { success: true, message: "setup ok" };
      },
    };
    const successSocket = createSuccessWebSocketFactory(timer);
    client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      buildFakeAdb(),
      (url) => {
        dialTimes.push(timer.now());
        return successSocket(url);
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
      undefined,
      () => manager,
    );
    const internals = client as any;
    internals.connectionAttempts = 3;
    internals.lastConnectionAttempt = timer.now();
    internals.config.connectionResetMs = 30_000;
    expect(client.getReconnectStatus()?.connectionAttempts).toBe(3);

    client.ensureRecoveryStarted();
    expect(await client.awaitRecovery(10_000)).toBe("timed_out");
    expect(dialTimes).toEqual([]);
    expect(client.getReconnectStatus()?.connectionAttempts).toBe(3);
    expect(setupCalls).toBe(0);
  });
});
