import { streamSubscribeAuthCases } from "../helpers/streamSubscribeAuthCases";
import type { StreamSocketAuthenticator } from "../../src/daemon/streamSocketAuth";
import { describe, it, expect, beforeEach } from "bun:test";
import { Socket } from "node:net";
import {
  PerformancePushSocketServer,
  DEFAULT_THRESHOLDS,
  type LivePerformanceData,
} from "../../src/daemon/performancePushSocketServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeDeviceSessionResolver } from "../fakes/FakeDeviceSessionResolver";
import { livePerformanceFrameSchema } from "../helpers/wireMessageSchemas";

/**
 * Test helper that wraps PerformancePushSocketServer to allow injecting fake sockets
 * without requiring real network connections.
 */
class TestablePerformancePushSocketServer extends PerformancePushSocketServer {
  constructor(timer: FakeTimer) {
    // Use a dummy path since we won't actually create the socket
    super("/fake/path/test.sock", timer);
  }

  /**
   * Simulate starting the server without creating real socket file
   */
  async startFake(): Promise<void> {
    // Start keepalive using injected timer
    this.onServerStarted();
  }

  /**
   * Simulate closing the server
   */
  async closeFake(): Promise<void> {
    this.onServerClosing();
  }

  /**
   * Simulate a client connection and subscription
   */
  simulateSubscription(options: { deviceSessionUuid?: string | null; packageName?: string }): {
    socket: FakeSocket;
    subscriptionId: string;
  } {
    const socket = new FakeSocket();

    // Create subscription directly using protected members
    const subscriptionId = `performancepush-${++this.subscriptionCounter}`;
    this.subscribers.set(subscriptionId, {
      socket: socket,
      subscriptionId,
      lastActivity: this.timer.now(),
      filter: {
        deviceSessionUuid: options.deviceSessionUuid ?? null,
        packageName: options.packageName ?? null,
      },
      backfilling: false,
      drainPending: false,
    });

    return { socket, subscriptionId };
  }

  setBackfilling(subscriptionId: string, backfilling: boolean): void {
    const subscriber = this.subscribers.get(subscriptionId);
    if (subscriber) {
      subscriber.backfilling = backfilling;
    }
  }

  /**
   * Simulate a pong response from a subscriber
   */
  simulatePong(subscriptionId: string): void {
    const subscriber = this.subscribers.get(subscriptionId);
    if (subscriber) {
      subscriber.lastActivity = this.timer.now();
    }
  }

  /**
   * Get subscriber info for testing
   */
  getSubscriber(subscriptionId: string): {
    deviceSessionUuid: string | null;
    packageName: string | null;
    lastActivity: number;
  } | null {
    const subscriber = this.subscribers.get(subscriptionId);
    if (!subscriber) {
      return null;
    }
    return {
      deviceSessionUuid: subscriber.filter.deviceSessionUuid,
      packageName: subscriber.filter.packageName,
      lastActivity: subscriber.lastActivity,
    };
  }

  /**
   * Trigger keepalive check manually
   */
  triggerKeepalive(): void {
    this.checkKeepalive();
  }
}

describe("PerformancePushSocketServer", () => {
  let server: TestablePerformancePushSocketServer;
  let timer: FakeTimer;
  let resolver: FakeDeviceSessionResolver;

  beforeEach(async () => {
    timer = new FakeTimer();
    server = new TestablePerformancePushSocketServer(timer);
    resolver = new FakeDeviceSessionResolver()
      .bind("emulator-5554", "uuid-a")
      .bind("device-1", "uuid-1")
      .bind("device-2", "uuid-2");
    server.setDeviceSessionResolver(resolver);
    await server.startFake();
  });

  const performanceData = (deviceId: string): LivePerformanceData => ({
    deviceId,
    deviceSessionUuid: null,
    packageName: "com.example.app",
    timestamp: 1000,
    nodeId: null,
    screenName: null,
    metrics: {
      fps: 60,
      frameTimeMs: 16,
      jankFrames: 0,
      touchLatencyMs: null,
      ttffMs: null,
      ttiMs: null,
      cpuUsagePercent: null,
      memoryUsageMb: null,
    },
    thresholds: DEFAULT_THRESHOLDS,
    health: "healthy",
  });

  it("tracks subscriber count correctly", () => {
    expect(server.getSubscriberCount()).toBe(0);

    server.simulateSubscription({});
    expect(server.getSubscriberCount()).toBe(1);

    server.simulateSubscription({ deviceSessionUuid: "uuid-1" });
    expect(server.getSubscriberCount()).toBe(2);
  });

  it("reports demand using live UUID and package filters", () => {
    expect(server.hasSubscriberForDevice("device-1", "com.example.app")).toBe(false);
    server.simulateSubscription({ deviceSessionUuid: "uuid-1", packageName: "com.example.app" });
    expect(server.hasSubscriberForDevice("device-1", "com.example.app")).toBe(true);
    expect(server.hasSubscriberForDevice("device-2", "com.example.app")).toBe(false);
    expect(server.hasSubscriberForDevice("device-1", "other.app")).toBe(false);
    resolver.bind("device-1", "new-uuid");
    expect(server.hasSubscriberForDevice("device-1", "com.example.app")).toBe(false);
  });

  it("supports null filters and ignores destroyed and backfilling subscribers", () => {
    const { socket, subscriptionId } = server.simulateSubscription({ packageName: "app" });
    expect(server.hasSubscriberForDevice("unresolved-device", "app")).toBe(true);
    expect(server.hasSubscriberForDevice("device-1", "other")).toBe(false);
    server.setBackfilling(subscriptionId, true);
    expect(server.hasSubscriberForDevice("device-1", "app")).toBe(false);
    server.setBackfilling(subscriptionId, false);
    socket.destroy();
    expect(server.hasSubscriberForDevice("device-1", "app")).toBe(false);
    server.simulateSubscription({ deviceSessionUuid: "uuid-1" });
    expect(server.hasSubscriberForDevice("device-1", "other")).toBe(true);
    server.simulateSubscription({});
    expect(server.hasSubscriberForDevice("unresolved-device", "other")).toBe(true);
  });

  it("does not demand samples for quarantined identities and resumes after resolution", () => {
    server.simulateSubscription({});
    expect(server.hasSubscriberForDevice("device-1", "app")).toBe(true);
    resolver.quarantine("device-1");
    expect(server.hasSubscriberForDevice("device-1", "app")).toBe(false);
    expect(server.hasSubscriberForDevice("device-1", "app")).toBe(false);
    expect(server.hasSubscriberForDevice("device-2", "app")).toBe(true);
    resolver.resolveIdentity("device-1");
    expect(server.hasSubscriberForDevice("device-1", "app")).toBe(true);
  });

  it("stores subscription filters correctly", () => {
    const { subscriptionId } = server.simulateSubscription({
      deviceSessionUuid: "uuid-a",
      packageName: "com.example.app",
    });

    const subscriber = server.getSubscriber(subscriptionId);
    expect(subscriber).not.toBeNull();
    expect(subscriber?.deviceSessionUuid).toBe("uuid-a");
    expect(subscriber?.packageName).toBe("com.example.app");
  });

  it("pushes data to all subscribers when no filter", async () => {
    const { socket: socket1 } = server.simulateSubscription({});
    const { socket: socket2 } = server.simulateSubscription({});

    const testData: LivePerformanceData = {
      deviceId: "emulator-5554",
      deviceSessionUuid: null,
      packageName: "com.example.app",
      timestamp: Date.now(),
      nodeId: 42,
      screenName: "Home",
      metrics: {
        fps: 60,
        frameTimeMs: 16.5,
        jankFrames: 0,
        touchLatencyMs: 45,
        ttffMs: 300,
        ttiMs: 500,
        cpuUsagePercent: 15,
        memoryUsageMb: 128,
      },
      thresholds: DEFAULT_THRESHOLDS,
      health: "healthy",
    };

    server.pushPerformanceData(testData);

    const msgs1 = socket1.getWrittenMessages(livePerformanceFrameSchema);
    const msgs2 = socket2.getWrittenMessages(livePerformanceFrameSchema);

    expect(msgs1).toHaveLength(1);
    expect(msgs1[0].type).toBe("performance_push");
    expect(msgs1[0].data?.deviceId).toBe("emulator-5554");
    // Server resolves the stable epoch key from the serial (AC1).
    expect(msgs1[0].data?.deviceSessionUuid).toBe("uuid-a");

    expect(msgs2).toHaveLength(1);
    expect(msgs2[0].type).toBe("performance_push");
  });

  it("filters pushes by deviceSessionUuid (AC2)", async () => {
    const { socket: socket1 } = server.simulateSubscription({ deviceSessionUuid: "uuid-1" });
    const { socket: socket2 } = server.simulateSubscription({ deviceSessionUuid: "uuid-2" });

    const testData: LivePerformanceData = {
      deviceId: "device-1",
      deviceSessionUuid: null,
      packageName: "com.example.app",
      timestamp: Date.now(),
      nodeId: null,
      screenName: null,
      metrics: {
        fps: 60,
        frameTimeMs: 16,
        jankFrames: 0,
        touchLatencyMs: null,
        ttffMs: null,
        ttiMs: null,
        cpuUsagePercent: null,
        memoryUsageMb: null,
      },
      thresholds: DEFAULT_THRESHOLDS,
      health: "healthy",
    };

    server.pushPerformanceData(testData);

    const msgs1 = socket1.getWrittenMessages(livePerformanceFrameSchema);
    const msgs2 = socket2.getWrittenMessages(livePerformanceFrameSchema);

    expect(msgs1).toHaveLength(1);
    expect(msgs2).toHaveLength(0);
  });

  // While the pool cannot say which AVD is on the serial, the entry's epoch is
  // preserved but withheld: a possible replacement's metrics must not land on the
  // previous AVD's pane, nor on an all-device one (#6863 review).
  it("drops performance data while the device's pooled identity is quarantined", () => {
    const scoped = server.simulateSubscription({ deviceSessionUuid: "uuid-1" });
    const all = server.simulateSubscription({});
    resolver.quarantine("device-1");

    server.pushPerformanceData(performanceData("device-1"));

    expect(scoped.socket.getWrittenMessages(livePerformanceFrameSchema)).toHaveLength(0);
    expect(all.socket.getWrittenMessages(livePerformanceFrameSchema)).toHaveLength(0);
  });

  it("resumes performance delivery under the same uuid once the quarantine lifts", () => {
    const { socket } = server.simulateSubscription({ deviceSessionUuid: "uuid-1" });
    resolver.quarantine("device-1");
    server.pushPerformanceData(performanceData("device-1"));

    resolver.resolveIdentity("device-1");
    server.pushPerformanceData(performanceData("device-1"));

    const msgs = socket.getWrittenMessages(livePerformanceFrameSchema);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].data?.deviceSessionUuid).toBe("uuid-1");
  });

  it("yields zero events to a stale/retired deviceSessionUuid filter (AC4)", async () => {
    const { socket } = server.simulateSubscription({ deviceSessionUuid: "uuid-1" });
    // device-1 reconnects under a new epoch: uuid-1 is retired, serial now maps to uuid-1b.
    resolver.retire("device-1").bind("device-1", "uuid-1b");

    server.pushPerformanceData({
      deviceId: "device-1",
      deviceSessionUuid: null,
      packageName: "com.app",
      timestamp: Date.now(),
      nodeId: null,
      screenName: null,
      metrics: {
        fps: 60,
        frameTimeMs: 16,
        jankFrames: 0,
        touchLatencyMs: null,
        ttffMs: null,
        ttiMs: null,
        cpuUsagePercent: null,
        memoryUsageMb: null,
      },
      thresholds: DEFAULT_THRESHOLDS,
      health: "healthy",
    });

    expect(socket.getWrittenMessages(livePerformanceFrameSchema)).toHaveLength(0);
  });

  it("filters pushes by packageName", async () => {
    const { socket: socket1 } = server.simulateSubscription({ packageName: "com.app.one" });
    const { socket: socket2 } = server.simulateSubscription({ packageName: "com.app.two" });

    const testData: LivePerformanceData = {
      deviceId: "device-1",
      deviceSessionUuid: null,
      packageName: "com.app.one",
      timestamp: Date.now(),
      nodeId: null,
      screenName: null,
      metrics: {
        fps: 60,
        frameTimeMs: 16,
        jankFrames: 0,
        touchLatencyMs: null,
        ttffMs: null,
        ttiMs: null,
        cpuUsagePercent: null,
        memoryUsageMb: null,
      },
      thresholds: DEFAULT_THRESHOLDS,
      health: "healthy",
    };

    server.pushPerformanceData(testData);

    expect(socket1.getWrittenMessages(livePerformanceFrameSchema)).toHaveLength(1);
    expect(socket2.getWrittenMessages(livePerformanceFrameSchema)).toHaveLength(0);
  });

  it("removes destroyed sockets on push", async () => {
    const { socket: socket1 } = server.simulateSubscription({});
    server.simulateSubscription({});

    expect(server.getSubscriberCount()).toBe(2);

    // Destroy socket1
    socket1.destroy();

    // Push data - should clean up destroyed socket
    const testData: LivePerformanceData = {
      deviceId: "device-1",
      deviceSessionUuid: null,
      packageName: "com.app",
      timestamp: Date.now(),
      nodeId: null,
      screenName: null,
      metrics: {
        fps: 60,
        frameTimeMs: 16,
        jankFrames: 0,
        touchLatencyMs: null,
        ttffMs: null,
        ttiMs: null,
        cpuUsagePercent: null,
        memoryUsageMb: null,
      },
      thresholds: DEFAULT_THRESHOLDS,
      health: "healthy",
    };

    server.pushPerformanceData(testData);

    expect(server.getSubscriberCount()).toBe(1);
  });

  it("removes timed out subscribers on keepalive check", async () => {
    server.simulateSubscription({});
    expect(server.getSubscriberCount()).toBe(1);

    // Advance time past the timeout (30 seconds)
    timer.advanceTimersByTime(31_000);

    // Trigger keepalive check
    server.triggerKeepalive();

    expect(server.getSubscriberCount()).toBe(0);
  });

  it("keeps subscribers alive when they respond to pongs", async () => {
    const { subscriptionId } = server.simulateSubscription({});
    expect(server.getSubscriberCount()).toBe(1);

    // Advance time but not past timeout
    timer.advanceTimersByTime(15_000);

    // Simulate pong response
    server.simulatePong(subscriptionId);

    // Advance more time
    timer.advanceTimersByTime(20_000);

    // Trigger keepalive - subscriber should still be alive
    server.triggerKeepalive();

    expect(server.getSubscriberCount()).toBe(1);
  });

  describe("calculateHealth", () => {
    it("returns healthy when all metrics are good", () => {
      const metrics = {
        fps: 60,
        frameTimeMs: 16,
        jankFrames: 0,
        touchLatencyMs: 50,
        ttffMs: 300,
        ttiMs: 500,
        cpuUsagePercent: 20,
        memoryUsageMb: 100,
      };
      expect(PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS)).toBe(
        "healthy",
      );
    });

    it("returns warning when fps is below warning threshold", () => {
      const metrics = {
        fps: 50,
        frameTimeMs: 16,
        jankFrames: 0,
        touchLatencyMs: null,
        ttffMs: null,
        ttiMs: null,
        cpuUsagePercent: null,
        memoryUsageMb: null,
      };
      expect(PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS)).toBe(
        "warning",
      );
    });

    it("returns critical when fps is below critical threshold", () => {
      const metrics = {
        fps: 40,
        frameTimeMs: 16,
        jankFrames: 0,
        touchLatencyMs: null,
        ttffMs: null,
        ttiMs: null,
        cpuUsagePercent: null,
        memoryUsageMb: null,
      };
      expect(PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS)).toBe(
        "critical",
      );
    });

    it("returns warning when frame time exceeds warning threshold", () => {
      const metrics = {
        fps: 60,
        frameTimeMs: 25,
        jankFrames: 0,
        touchLatencyMs: null,
        ttffMs: null,
        ttiMs: null,
        cpuUsagePercent: null,
        memoryUsageMb: null,
      };
      expect(PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS)).toBe(
        "warning",
      );
    });

    it("returns critical when frame time exceeds critical threshold", () => {
      const metrics = {
        fps: 60,
        frameTimeMs: 40,
        jankFrames: 0,
        touchLatencyMs: null,
        ttffMs: null,
        ttiMs: null,
        cpuUsagePercent: null,
        memoryUsageMb: null,
      };
      expect(PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS)).toBe(
        "critical",
      );
    });

    it("returns warning when touch latency is high", () => {
      const metrics = {
        fps: 60,
        frameTimeMs: 16,
        jankFrames: 0,
        touchLatencyMs: 150,
        ttffMs: null,
        ttiMs: null,
        cpuUsagePercent: null,
        memoryUsageMb: null,
      };
      expect(PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS)).toBe(
        "warning",
      );
    });

    it("returns critical when touch latency is very high", () => {
      const metrics = {
        fps: 60,
        frameTimeMs: 16,
        jankFrames: 0,
        touchLatencyMs: 250,
        ttffMs: null,
        ttiMs: null,
        cpuUsagePercent: null,
        memoryUsageMb: null,
      };
      expect(PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS)).toBe(
        "critical",
      );
    });

    it("returns warning when jank frames exceed warning threshold", () => {
      const metrics = {
        fps: 60,
        frameTimeMs: 16,
        jankFrames: 7,
        touchLatencyMs: null,
        ttffMs: null,
        ttiMs: null,
        cpuUsagePercent: null,
        memoryUsageMb: null,
      };
      expect(PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS)).toBe(
        "warning",
      );
    });

    it("returns critical when jank frames exceed critical threshold", () => {
      const metrics = {
        fps: 60,
        frameTimeMs: 16,
        jankFrames: 15,
        touchLatencyMs: null,
        ttffMs: null,
        ttiMs: null,
        cpuUsagePercent: null,
        memoryUsageMb: null,
      };
      expect(PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS)).toBe(
        "critical",
      );
    });

    it("returns warning when TTFF exceeds warning threshold", () => {
      const metrics = {
        fps: 60,
        frameTimeMs: 16,
        jankFrames: 0,
        touchLatencyMs: null,
        ttffMs: 600,
        ttiMs: null,
        cpuUsagePercent: null,
        memoryUsageMb: null,
      };
      expect(PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS)).toBe(
        "warning",
      );
    });

    it("returns critical when TTFF exceeds critical threshold", () => {
      const metrics = {
        fps: 60,
        frameTimeMs: 16,
        jankFrames: 0,
        touchLatencyMs: null,
        ttffMs: 1200,
        ttiMs: null,
        cpuUsagePercent: null,
        memoryUsageMb: null,
      };
      expect(PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS)).toBe(
        "critical",
      );
    });

    it("returns warning when TTI exceeds warning threshold", () => {
      const metrics = {
        fps: 60,
        frameTimeMs: 16,
        jankFrames: 0,
        touchLatencyMs: null,
        ttffMs: null,
        ttiMs: 800,
        cpuUsagePercent: null,
        memoryUsageMb: null,
      };
      expect(PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS)).toBe(
        "warning",
      );
    });

    it("returns critical when TTI exceeds critical threshold", () => {
      const metrics = {
        fps: 60,
        frameTimeMs: 16,
        jankFrames: 0,
        touchLatencyMs: null,
        ttffMs: null,
        ttiMs: 1600,
        cpuUsagePercent: null,
        memoryUsageMb: null,
      };
      expect(PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS)).toBe(
        "critical",
      );
    });

    it("handles all null metrics as healthy", () => {
      const metrics = {
        fps: null,
        frameTimeMs: null,
        jankFrames: null,
        touchLatencyMs: null,
        ttffMs: null,
        ttiMs: null,
        cpuUsagePercent: null,
        memoryUsageMb: null,
      };
      expect(PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS)).toBe(
        "healthy",
      );
    });
  });
});

class AuthPerformanceServer extends PerformancePushSocketServer {
  private subscribed = 0;
  constructor(timer: FakeTimer, authenticator: StreamSocketAuthenticator) {
    super("/fake/performance.sock", timer, { authenticator });
  }
  receive(socket: Socket, line: string): Promise<void> {
    return this.processLine(socket, line);
  }
  protected override onSubscribed(): void {
    this.subscribed++;
  }
  effects(): number {
    return this.subscribed;
  }
}
streamSubscribeAuthCases(
  "performance-push",
  (timer, authenticator) => new AuthPerformanceServer(timer, authenticator),
);
