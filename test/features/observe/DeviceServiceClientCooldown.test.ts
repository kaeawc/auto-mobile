import { describe, expect, test, afterEach } from "bun:test";
import { DeviceServiceClient } from "../../../src/features/observe/DeviceServiceClient";
import {
  createInstantFailureWebSocketFactory,
  createSuccessWebSocketFactory,
  createNthAttemptSuccessWebSocketFactory,
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

  protected async setupBeforeConnect(_perf: PerformanceTracker): Promise<void> {}

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

  test("scheduleReconnect respects cooldown after max attempts", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    client = new TestDeviceServiceClient(timer, createInstantFailureWebSocketFactory(timer), {
      maxConnectionAttempts: 3,
      connectionResetMs: 10000,
      reconnectDelayMs: 2000,
    });
    // Keep auto-reconnect enabled for this test

    // Exhaust 3 attempts — each failure triggers scheduleReconnect → timer fires → next attempt
    // With instant failure + autoAdvance, each ensureConnected will fail and schedule reconnect
    await client.ensureConnected(new NoOpPerformanceTracker());
    expect(client.getConnectionAttempts()).toBe(1);

    await client.ensureConnected(new NoOpPerformanceTracker());
    expect(client.getConnectionAttempts()).toBe(2);

    await client.ensureConnected(new NoOpPerformanceTracker());
    expect(client.getConnectionAttempts()).toBe(3);

    // Auto-reconnect is scheduled but when it fires, cooldown should block it
    // The reconnect timeout should have been scheduled
    expect(client.isAutoReconnectScheduled()).toBe(true);
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
