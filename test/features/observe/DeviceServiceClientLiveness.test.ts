import { describe, expect, test, afterEach } from "bun:test";
import { DeviceServiceClient } from "../../../src/features/observe/DeviceServiceClient";
import { FakeWebSocket, createSuccessWebSocketFactory } from "../../fakes/FakeWebSocket";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { PerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import type WebSocket from "ws";

/**
 * Tests for the protocol-level liveness probe (issue #7554): `readyState`
 * alone cannot tell a healthy peer from a half-open connection whose TCP
 * stream stalled without a close reaching the host. The probe pings on each
 * health-check tick, treats a pong or ANY inbound frame as proof of life, and
 * terminates the socket through the normal was-open close path if neither
 * arrives within a bounded deadline.
 */
class TestDeviceServiceClient extends DeviceServiceClient {
  protected readonly logTag = "TestLivenessClient";
  connectionEstablishedCount = 0;
  connectionClosedCount = 0;
  private nextRequestId = 0;

  constructor(
    timer: FakeTimer,
    wsFactory: (url: string) => WebSocket,
    config: { healthCheckIntervalMs?: number } = {},
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

  disableAutoReconnect(): void {
    this.autoReconnectEnabled = false;
  }

  isAutoReconnectScheduled(): boolean {
    return this.reconnectTimeoutId !== null;
  }

  /** Register a RequestManager entry that times out on its own after `timeoutMs`. */
  registerTimingOutRequest(timeoutMs: number): void {
    this.nextRequestId++;
    void this.getRequestManager().register<{ success: boolean }>(
      `test_${this.nextRequestId}`,
      "test",
      timeoutMs,
      () => ({ success: false }),
    );
  }
}

async function advanceAndSettle(timer: FakeTimer, ms: number): Promise<void> {
  timer.advanceTime(ms);
  for (let turn = 0; turn < 3; turn++) {
    await timer.resolvePromise(new Promise<void>((resolve) => timer.setTimeout(resolve, 1)), 1);
  }
}

describe("DeviceServiceClient liveness probe", () => {
  let client: TestDeviceServiceClient | null = null;

  afterEach(async () => {
    if (client) {
      client.disableAutoReconnect();
      await client.close();
      client = null;
    }
  });

  test("terminates a connection whose peer withholds pong, and schedules reconnect", async () => {
    const timer = new FakeTimer();
    client = new TestDeviceServiceClient(timer, createSuccessWebSocketFactory(timer, "withhold"), {
      healthCheckIntervalMs: 1000,
    });

    expect(await client.ensureConnected(new NoOpPerformanceTracker())).toBe(true);
    expect(client.connectionClosedCount).toBe(0);

    // First health-check tick (t=1000ms) sends a ping; the deadline is
    // 2x the interval (2000ms), so the connection is still healthy here.
    await advanceAndSettle(timer, 1000);
    expect(client.isConnected()).toBe(true);
    expect(client.connectionClosedCount).toBe(0);

    // The deadline elapses with no pong and no other inbound frame: the
    // probe terminates the socket through the normal was-open close path.
    await advanceAndSettle(timer, 2000);
    expect(client.isConnected()).toBe(false);
    expect(client.connectionClosedCount).toBe(1);
    expect(client.isAutoReconnectScheduled()).toBe(true);
  });

  test("a connection that answers every ping stays alive across many health-check intervals", async () => {
    const timer = new FakeTimer();
    client = new TestDeviceServiceClient(timer, createSuccessWebSocketFactory(timer, "auto"), {
      healthCheckIntervalMs: 1000,
    });
    client.disableAutoReconnect();

    expect(await client.ensureConnected(new NoOpPerformanceTracker())).toBe(true);

    for (let i = 0; i < 5; i++) {
      await advanceAndSettle(timer, 1000);
    }

    expect(client.isConnected()).toBe(true);
    expect(client.connectionClosedCount).toBe(0);
  });

  test("inbound messages alone keep a connection alive even without pong replies", async () => {
    const timer = new FakeTimer();
    let socket: FakeWebSocket | null = null;
    client = new TestDeviceServiceClient(
      timer,
      (url) => {
        socket = new FakeWebSocket(url, "none", 0, timer, "withhold");
        return socket;
      },
      { healthCheckIntervalMs: 1000 },
    );
    client.disableAutoReconnect();

    expect(await client.ensureConnected(new NoOpPerformanceTracker())).toBe(true);

    // First health-check tick sends a ping that will never be answered;
    // before its 2000ms deadline elapses, an inbound frame refreshes liveness.
    await advanceAndSettle(timer, 1000);
    socket!.simulateMessage(JSON.stringify({ type: "keepalive" }));
    await advanceAndSettle(timer, 2000);

    expect(client.isConnected()).toBe(true);
    expect(client.connectionClosedCount).toBe(0);
  });

  test("a server-initiated ping refreshes liveness even without a host-sent ping's pong", async () => {
    const timer = new FakeTimer();
    let socket: FakeWebSocket | null = null;
    client = new TestDeviceServiceClient(
      timer,
      (url) => {
        // "withhold" means THIS socket never answers the host's own ping()
        // with a pong; the only liveness signal available is the server's
        // own periodic ping (e.g. Android's Ktor CtrlProxy `pingPeriod`).
        socket = new FakeWebSocket(url, "none", 0, timer, "withhold");
        return socket;
      },
      { healthCheckIntervalMs: 1000 },
    );
    client.disableAutoReconnect();

    expect(await client.ensureConnected(new NoOpPerformanceTracker())).toBe(true);

    // First health-check tick (t=1000ms) sends a ping that goes unanswered;
    // before its 2000ms deadline elapses, the peer's own "ping" event arrives.
    await advanceAndSettle(timer, 1000);
    socket!.simulatePing();
    await advanceAndSettle(timer, 2000);

    expect(client.isConnected()).toBe(true);
    expect(client.connectionClosedCount).toBe(0);
  });

  test("a frame landing in the same millisecond as the probe's baseline still counts as liveness", async () => {
    const timer = new FakeTimer();
    let socket: FakeWebSocket | null = null;
    client = new TestDeviceServiceClient(
      timer,
      (url) => {
        socket = new FakeWebSocket(url, "none", 0, timer, "withhold");
        return socket;
      },
      { healthCheckIntervalMs: 1000 },
    );
    client.disableAutoReconnect();

    // FakeTimer breaks same-due-time ties by registration order. Registered
    // BEFORE the connect below — and so before the health check's
    // setInterval — this timeout is also due at t=1000ms but fires FIRST: it
    // moves the liveness baseline to exactly 1000, one tick before the probe
    // captures ITS baseline from that same value.
    timer.setTimeout(() => {
      socket!.simulateMessage(JSON.stringify({ type: "warm-up" }));
    }, 1000);

    expect(await client.ensureConnected(new NoOpPerformanceTracker())).toBe(true);

    // Registered AFTER the connect — and so after the health check's
    // setInterval — this timeout fires LAST among the three t=1000 ties:
    // after the probe has already captured checkStartedAt === 1000 from the
    // frame above, this delivers a SECOND frame at that identical
    // millisecond. A timestamp-only comparison (`lastLivenessAt >
    // checkStartedAt`) sees 1000 === 1000 and wrongly calls this "no
    // progress" — timer resolution can't distinguish the two events, only
    // their order can. The monotonic sequence counter still catches it
    // because markLivenessSeen() always increments, tie or not.
    timer.setTimeout(() => {
      socket!.simulateMessage(JSON.stringify({ type: "keepalive" }));
    }, 1000);

    // Advance past the probe's deadline (started at t=1000, 2000ms later).
    await advanceAndSettle(timer, 3000);

    expect(client.isConnected()).toBe(true);
    expect(client.connectionClosedCount).toBe(0);
  });

  test("consecutive RequestManager timeouts trigger an immediate liveness probe on a suspect connection", async () => {
    const timer = new FakeTimer();
    // A very long health-check interval isolates this test to the
    // request-timeout feedback path: only that path can trigger a probe
    // within the time this test advances.
    client = new TestDeviceServiceClient(timer, createSuccessWebSocketFactory(timer, "withhold"), {
      healthCheckIntervalMs: 100000,
    });

    expect(await client.ensureConnected(new NoOpPerformanceTracker())).toBe(true);

    for (let i = 0; i < 3; i++) {
      client.registerTimingOutRequest(10);
      await advanceAndSettle(timer, 10);
    }

    // Three consecutive timeouts with no inbound frame in between started an
    // immediate probe; its deadline (2x the health-check interval) elapses
    // well before the periodic health check ever would.
    await advanceAndSettle(timer, 210000);
    expect(client.isConnected()).toBe(false);
    expect(client.connectionClosedCount).toBe(1);
    expect(client.isAutoReconnectScheduled()).toBe(true);
  });

  test("a request timeout followed by an inbound frame does not count toward the suspect threshold", async () => {
    const timer = new FakeTimer();
    let socket: FakeWebSocket | null = null;
    client = new TestDeviceServiceClient(
      timer,
      (url) => {
        socket = new FakeWebSocket(url, "none", 0, timer, "withhold");
        return socket;
      },
      { healthCheckIntervalMs: 100000 },
    );

    expect(await client.ensureConnected(new NoOpPerformanceTracker())).toBe(true);

    // Two timeouts, then a frame that resets the counter, then two more:
    // never three CONSECUTIVE timeouts, so no probe is triggered.
    client.registerTimingOutRequest(10);
    await advanceAndSettle(timer, 10);
    client.registerTimingOutRequest(10);
    await advanceAndSettle(timer, 10);
    socket!.simulateMessage(JSON.stringify({ type: "keepalive" }));
    client.registerTimingOutRequest(10);
    await advanceAndSettle(timer, 10);

    expect(client.isConnected()).toBe(true);
    expect(client.connectionClosedCount).toBe(0);
  });
});
