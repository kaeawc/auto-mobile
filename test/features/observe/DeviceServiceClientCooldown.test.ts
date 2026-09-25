import { describe, expect, test, afterEach } from "bun:test";
import { DeviceServiceClient } from "../../../src/features/observe/DeviceServiceClient";
import {
  FakeWebSocket,
  createInstantFailureWebSocketFactory,
  createSuccessWebSocketFactory,
  createNthAttemptSuccessWebSocketFactory,
  WebSocketState,
} from "../../fakes/FakeWebSocket";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { PerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import type WebSocket from "ws";

/**
 * Concrete subclass of DeviceServiceClient for testing.
 * Exposes protected internals needed by tests.
 */
class TestDeviceServiceClient extends DeviceServiceClient {
  protected readonly logTag = "TestClient";
  connectionEstablishedCount = 0;
  connectionClosedCount = 0;

  constructor(
    timer: FakeTimer,
    wsFactory: (url: string) => WebSocket,
    config: {
      maxConnectionAttempts?: number;
      connectionResetMs?: number;
      reconnectDelayMs?: number;
    } = {},
  ) {
    super(timer, wsFactory, config);
  }

  protected getWebSocketUrl(): string {
    return "ws://localhost:9999/ws";
  }

  protected handleMessage(_data: WebSocket.Data): void {}

  protected onConnectionEstablished(): void {
    this.connectionEstablishedCount++;
  }

  protected onConnectionClosed(): void {
    this.connectionClosedCount++;
  }

  protected async setupBeforeConnect(
    _perf: PerformanceTracker,
    _signal: AbortSignal,
  ): Promise<void> {}

  getConnectionAttempts(): number {
    return this.connectionAttempts;
  }

  disableAutoReconnect(): void {
    this.autoReconnectEnabled = false;
  }

  isAutoReconnectScheduled(): boolean {
    return this.reconnectTimeoutId !== null;
  }
}

async function advanceAndSettle(timer: FakeTimer, ms: number): Promise<void> {
  timer.advanceTime(ms);
  for (let turn = 0; turn < 3; turn++) {
    await timer.resolvePromise(new Promise<void>((resolve) => timer.setTimeout(resolve, 1)), 1);
  }
}

describe("DeviceServiceClient connection cooldown", () => {
  let client: TestDeviceServiceClient | null = null;

  afterEach(async () => {
    if (client) {
      client.disableAutoReconnect();
      await client.close();
      client = null;
    }
  });

  test("enforces cooldown after max connection attempts", async () => {
    const timer = new FakeTimer();
    client = new TestDeviceServiceClient(timer, createInstantFailureWebSocketFactory(timer), {
      maxConnectionAttempts: 3,
      connectionResetMs: 10000,
      reconnectDelayMs: 2000,
    });
    client.disableAutoReconnect();

    // Attempt 1, 2, 3 — all fail
    const r1 = await client.ensureConnected(new NoOpPerformanceTracker());
    expect(r1).toBe(false);
    expect(client.getConnectionAttempts()).toBe(1);

    const r2 = await client.ensureConnected(new NoOpPerformanceTracker());
    expect(r2).toBe(false);
    expect(client.getConnectionAttempts()).toBe(2);

    const r3 = await client.ensureConnected(new NoOpPerformanceTracker());
    expect(r3).toBe(false);
    expect(client.getConnectionAttempts()).toBe(3);

    // Attempt 4 — should be rejected by cooldown (returns false without incrementing)
    const r4 = await client.ensureConnected(new NoOpPerformanceTracker());
    expect(r4).toBe(false);
    expect(client.getConnectionAttempts()).toBe(3);
    expect(client.getReconnectStatus()).toEqual({
      state: "cooldown",
      retryAfterMs: 10000,
      retryAfterSeconds: 10,
      connectionAttempts: 3,
      maxConnectionAttempts: 3,
    });
  });

  test("reports remaining cooldown without incrementing attempts", async () => {
    const timer = new FakeTimer();
    client = new TestDeviceServiceClient(timer, createInstantFailureWebSocketFactory(timer), {
      maxConnectionAttempts: 3,
      connectionResetMs: 10000,
      reconnectDelayMs: 2000,
    });
    client.disableAutoReconnect();

    await client.ensureConnected(new NoOpPerformanceTracker());
    await client.ensureConnected(new NoOpPerformanceTracker());
    await client.ensureConnected(new NoOpPerformanceTracker());

    timer.advanceTime(6500);

    expect(client.getReconnectStatus()).toEqual({
      state: "cooldown",
      retryAfterMs: 3500,
      retryAfterSeconds: 4,
      connectionAttempts: 3,
      maxConnectionAttempts: 3,
    });

    const blocked = await client.ensureConnected(new NoOpPerformanceTracker());
    expect(blocked).toBe(false);
    expect(client.getConnectionAttempts()).toBe(3);
  });

  test("resets connectionAttempts on successful connection", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    client = new TestDeviceServiceClient(timer, createSuccessWebSocketFactory(timer), {
      maxConnectionAttempts: 3,
      connectionResetMs: 10000,
    });
    client.disableAutoReconnect();

    const result = await client.ensureConnected(new NoOpPerformanceTracker());
    expect(result).toBe(true);
    expect(client.getConnectionAttempts()).toBe(0);
    expect(client.connectionEstablishedCount).toBe(1);
  });

  test("connectionAttempts persists across close events", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    client = new TestDeviceServiceClient(timer, createInstantFailureWebSocketFactory(timer), {
      maxConnectionAttempts: 3,
      connectionResetMs: 10000,
      reconnectDelayMs: 2000,
    });
    client.disableAutoReconnect();

    await client.ensureConnected(new NoOpPerformanceTracker());
    await client.ensureConnected(new NoOpPerformanceTracker());
    expect(client.getConnectionAttempts()).toBe(2);

    const r3 = await client.ensureConnected(new NoOpPerformanceTracker());
    expect(r3).toBe(false);
    expect(client.getConnectionAttempts()).toBe(3);

    const r4 = await client.ensureConnected(new NoOpPerformanceTracker());
    expect(r4).toBe(false);
  });

  test("cooldown resets after connectionResetMs elapses", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    client = new TestDeviceServiceClient(timer, createInstantFailureWebSocketFactory(timer), {
      maxConnectionAttempts: 3,
      connectionResetMs: 10000,
      reconnectDelayMs: 2000,
    });
    client.disableAutoReconnect();

    // Exhaust all 3 attempts
    await client.ensureConnected(new NoOpPerformanceTracker());
    await client.ensureConnected(new NoOpPerformanceTracker());
    await client.ensureConnected(new NoOpPerformanceTracker());
    expect(client.getConnectionAttempts()).toBe(3);

    // Still in cooldown — rejected
    const rejected = await client.ensureConnected(new NoOpPerformanceTracker());
    expect(rejected).toBe(false);
    expect(client.getConnectionAttempts()).toBe(3);

    // Advance past cooldown period
    timer.advanceTime(10001);

    // Should now allow 3 more attempts (cooldown expired, counter resets)
    const r1 = await client.ensureConnected(new NoOpPerformanceTracker());
    expect(r1).toBe(false); // Still fails, but attempt was allowed
    expect(client.getConnectionAttempts()).toBe(1); // Reset to 0 then incremented to 1
  });

  test("failed foreground handshakes do not schedule reconnect or report a lost connection", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    client = new TestDeviceServiceClient(timer, createInstantFailureWebSocketFactory(timer), {
      maxConnectionAttempts: 3,
      connectionResetMs: 10000,
      reconnectDelayMs: 2000,
    });
    // Keep auto-reconnect enabled for this test

    // A failed handshake is never an established connection loss.
    await client.ensureConnected(new NoOpPerformanceTracker());
    expect(client.getConnectionAttempts()).toBe(1);

    await client.ensureConnected(new NoOpPerformanceTracker());
    expect(client.getConnectionAttempts()).toBe(2);

    await client.ensureConnected(new NoOpPerformanceTracker());
    expect(client.getConnectionAttempts()).toBe(3);

    expect(client.connectionClosedCount).toBe(0);
    expect(client.isAutoReconnectScheduled()).toBe(false);
    timer.advanceTime(2000);
    expect(client.getConnectionAttempts()).toBe(3);
  });

  test("a connect timeout does not report an established connection loss", async () => {
    const timer = new FakeTimer();
    let socketCreated = false;
    client = new TestDeviceServiceClient(timer, (url) => {
      socketCreated = true;
      return new FakeWebSocket(url, "timeout", 10000, timer);
    });
    const connecting = client.ensureConnected();
    await timer.resolvePromise(
      new Promise<void>((resolve) => {
        const interval = timer.setInterval(() => {
          if (socketCreated) {
            timer.clearInterval(interval);
            resolve();
          }
        }, 1);
      }),
      1,
    );
    timer.advanceTime(5000);
    expect(await connecting).toBe(false);
    expect(client.connectionClosedCount).toBe(0);
    expect(client.isAutoReconnectScheduled()).toBe(false);
  });

  test("an eager pending-connect abort does not report an established connection loss", async () => {
    const timer = new FakeTimer();
    let socketCreated = false;
    client = new TestDeviceServiceClient(timer, (url) => {
      socketCreated = true;
      return new FakeWebSocket(url, "timeout", 10000, timer);
    });
    const connecting = client.ensureConnected();
    await timer.resolvePromise(
      new Promise<void>((resolve) => {
        const interval = timer.setInterval(() => {
          if (socketCreated) {
            timer.clearInterval(interval);
            resolve();
          }
        }, 1);
      }),
      1,
    );
    await client.close();
    expect(await connecting).toBe(false);
    expect(client.connectionClosedCount).toBe(0);
  });

  test("close treats an established socket in CLOSING as connected", async () => {
    const timer = new FakeTimer();
    let socket: FakeWebSocket | null = null;
    client = new TestDeviceServiceClient(timer, (url) => {
      socket = new FakeWebSocket(url, "none", 0, timer);
      return socket;
    });

    expect(await client.ensureConnected()).toBe(true);
    socket!.close();
    expect(socket!.readyState).toBe(WebSocketState.CLOSING);
    await client.close();
    expect(client.connectionClosedCount).toBe(1);
  });

  test("background recovery preserves the caller budget and stops after the cap", async () => {
    const timer = new FakeTimer();
    let factoryCalls = 0;
    let firstSocket: FakeWebSocket | null = null;
    const factory = (url: string): FakeWebSocket => {
      factoryCalls++;
      const socket = new FakeWebSocket(url, factoryCalls === 1 ? "none" : "instant", 0, timer);
      firstSocket ??= socket;
      return socket;
    };
    client = new TestDeviceServiceClient(timer, factory, {
      maxConnectionAttempts: 3,
      connectionResetMs: 10000,
      reconnectDelayMs: 2000,
    });

    expect(await client.ensureConnected()).toBe(true);
    firstSocket!.close();
    await timer.resolvePromise(new Promise<void>((resolve) => timer.setTimeout(resolve, 1)), 1);

    for (const [index, delay] of [2000, 4000, 8000].entries()) {
      await advanceAndSettle(timer, delay);
      expect(factoryCalls).toBe(index + 2);
      expect(client.getConnectionAttempts()).toBe(0);
    }
    expect(client.isAutoReconnectScheduled()).toBe(false);
    await advanceAndSettle(timer, 60000);
    expect(factoryCalls).toBe(4);
    expect(client.connectionClosedCount).toBe(1);
  });

  test("background recovery waits for a closed caller cooldown gate and then stops at the cap", async () => {
    const timer = new FakeTimer();
    let factoryCalls = 0;
    let firstSocket: FakeWebSocket | null = null;
    client = new TestDeviceServiceClient(
      timer,
      (url) => {
        factoryCalls++;
        const socket = new FakeWebSocket(url, factoryCalls === 1 ? "none" : "instant", 0, timer);
        firstSocket ??= socket;
        return socket;
      },
      { maxConnectionAttempts: 3, connectionResetMs: 10000, reconnectDelayMs: 2000 },
    );

    expect(await client.ensureConnected()).toBe(true);
    firstSocket!.close();
    await timer.resolvePromise(new Promise<void>((resolve) => timer.setTimeout(resolve, 1)), 1);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await client.ensureConnected()).toBe(false);
    }
    expect(factoryCalls).toBe(4);
    for (let tick = 0; tick < 4; tick++) {
      await advanceAndSettle(timer, 2000);
      expect(factoryCalls).toBe(4);
      expect(client.isAutoReconnectScheduled()).toBe(true);
    }
    await advanceAndSettle(timer, 2000);
    expect(factoryCalls).toBe(5);
    expect(client.isAutoReconnectScheduled()).toBe(true);
    await advanceAndSettle(timer, 4000);
    await advanceAndSettle(timer, 8000);
    expect(factoryCalls).toBe(7);
    expect(client.isAutoReconnectScheduled()).toBe(false);
  });

  test("foreground ensureConnected after the cap re-seeds a fresh background run", async () => {
    const timer = new FakeTimer();
    let factoryCalls = 0;
    let lastSocket: FakeWebSocket | null = null;
    client = new TestDeviceServiceClient(timer, (url) => {
      factoryCalls++;
      const socket = new FakeWebSocket(
        url,
        factoryCalls === 1 || factoryCalls === 6 ? "none" : "instant",
        0,
        timer,
      );
      lastSocket = socket;
      return socket;
    });

    expect(await client.ensureConnected()).toBe(true);
    lastSocket!.close();
    await timer.resolvePromise(new Promise<void>((resolve) => timer.setTimeout(resolve, 1)), 1);
    for (const delay of [2000, 4000, 8000]) {
      await advanceAndSettle(timer, delay);
    }
    expect(factoryCalls).toBe(4);
    expect(client.isAutoReconnectScheduled()).toBe(false);

    expect(await client.ensureConnected()).toBe(false);
    expect(factoryCalls).toBe(5);
    expect(client.getConnectionAttempts()).toBe(1);
    expect(client.isAutoReconnectScheduled()).toBe(false);

    expect(await client.ensureConnected()).toBe(true);
    lastSocket!.close();
    await timer.resolvePromise(new Promise<void>((resolve) => timer.setTimeout(resolve, 1)), 1);
    for (const delay of [2000, 4000, 8000]) {
      await advanceAndSettle(timer, delay);
    }
    expect(factoryCalls).toBe(9);
    expect(client.isAutoReconnectScheduled()).toBe(false);
  });

  test("recovery after cooldown with Nth-attempt success", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();

    // Fail first 3 attempts, succeed on 4th
    client = new TestDeviceServiceClient(timer, createNthAttemptSuccessWebSocketFactory(4, timer), {
      maxConnectionAttempts: 3,
      connectionResetMs: 10000,
      reconnectDelayMs: 2000,
    });
    client.disableAutoReconnect();

    // Attempts 1-3 fail
    await client.ensureConnected(new NoOpPerformanceTracker());
    await client.ensureConnected(new NoOpPerformanceTracker());
    await client.ensureConnected(new NoOpPerformanceTracker());
    expect(client.getConnectionAttempts()).toBe(3);
    expect(client.connectionEstablishedCount).toBe(0);

    // Attempt 4 blocked by cooldown
    const blocked = await client.ensureConnected(new NoOpPerformanceTracker());
    expect(blocked).toBe(false);

    // Advance past cooldown
    timer.advanceTime(10001);

    // Attempt 5 (factory's 4th attempt) — succeeds
    const result = await client.ensureConnected(new NoOpPerformanceTracker());
    expect(result).toBe(true);
    expect(client.getConnectionAttempts()).toBe(0); // Reset on success
    expect(client.connectionEstablishedCount).toBe(1);
  });

  test("waitForConnection fails when cooldown is active", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    client = new TestDeviceServiceClient(timer, createInstantFailureWebSocketFactory(timer), {
      maxConnectionAttempts: 3,
      connectionResetMs: 10000,
      reconnectDelayMs: 2000,
    });
    client.disableAutoReconnect();

    // Exhaust all attempts via direct ensureConnected
    await client.ensureConnected(new NoOpPerformanceTracker());
    await client.ensureConnected(new NoOpPerformanceTracker());
    await client.ensureConnected(new NoOpPerformanceTracker());
    expect(client.getConnectionAttempts()).toBe(3);

    // waitForConnection should also fail because cooldown is active
    const connected = await client.waitForConnection(1, 1);
    expect(connected).toBe(false);
  });
});
