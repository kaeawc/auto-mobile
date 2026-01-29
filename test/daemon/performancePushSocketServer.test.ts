import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { unlink, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Socket } from "node:net";
import {
  PerformancePushSocketServer,
  DEFAULT_THRESHOLDS,
  type LivePerformanceData,
} from "../../src/daemon/performancePushSocketServer";

const TEST_SOCKET_DIR = path.join(os.tmpdir(), "automobile-test");
const TEST_SOCKET_PATH = path.join(TEST_SOCKET_DIR, `perf-push-test-${Date.now()}.sock`);

describe("PerformancePushSocketServer", () => {
  let server: PerformancePushSocketServer;

  beforeEach(async () => {
    await mkdir(TEST_SOCKET_DIR, { recursive: true });
    server = new PerformancePushSocketServer(TEST_SOCKET_PATH);
    await server.start();
  });

  afterEach(async () => {
    await server.close();
    if (existsSync(TEST_SOCKET_PATH)) {
      await unlink(TEST_SOCKET_PATH);
    }
  });

  it("creates socket file on start", () => {
    expect(existsSync(TEST_SOCKET_PATH)).toBe(true);
    expect(server.isListening()).toBe(true);
  });

  it("removes socket file on close", async () => {
    await server.close();
    expect(existsSync(TEST_SOCKET_PATH)).toBe(false);
    expect(server.isListening()).toBe(false);
  });

  it("accepts client connections", async () => {
    const client = await connectClient(TEST_SOCKET_PATH);
    expect(client.writable).toBe(true);
    client.destroy();
  });

  it("handles subscribe command", async () => {
    const { client, messages } = await connectAndSubscribe(TEST_SOCKET_PATH, {
      deviceId: "emulator-5554",
      packageName: "com.example.app",
    });

    // Wait for subscription response
    await waitForMessage(messages, msg => msg.type === "subscription_response");
    const response = messages.find(m => m.type === "subscription_response");

    expect(response).toBeDefined();
    expect(response?.success).toBe(true);
    expect(server.getSubscriberCount()).toBe(1);

    client.destroy();
  });

  it("pushes data to subscribed clients", async () => {
    const { client, messages } = await connectAndSubscribe(TEST_SOCKET_PATH, {});

    // Wait for subscription confirmation
    await waitForMessage(messages, msg => msg.type === "subscription_response");

    // Push data
    const testData: LivePerformanceData = {
      deviceId: "emulator-5554",
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

    // Wait for push message
    await waitForMessage(messages, msg => msg.type === "performance_push");
    const pushMsg = messages.find(m => m.type === "performance_push");

    expect(pushMsg).toBeDefined();
    expect(pushMsg?.data?.deviceId).toBe("emulator-5554");
    expect(pushMsg?.data?.metrics.fps).toBe(60);

    client.destroy();
  });

  it("filters pushes by deviceId", async () => {
    // Subscribe to specific device
    const { client: client1, messages: msgs1 } = await connectAndSubscribe(TEST_SOCKET_PATH, {
      deviceId: "device-1",
    });
    const { client: client2, messages: msgs2 } = await connectAndSubscribe(TEST_SOCKET_PATH, {
      deviceId: "device-2",
    });

    await waitForMessage(msgs1, msg => msg.type === "subscription_response");
    await waitForMessage(msgs2, msg => msg.type === "subscription_response");

    // Push data for device-1
    const testData: LivePerformanceData = {
      deviceId: "device-1",
      packageName: "com.example.app",
      timestamp: Date.now(),
      nodeId: null,
      screenName: null,
      metrics: {
        fps: 60, frameTimeMs: 16, jankFrames: 0, touchLatencyMs: null,
        ttffMs: null, ttiMs: null, cpuUsagePercent: null, memoryUsageMb: null,
      },
      thresholds: DEFAULT_THRESHOLDS,
      health: "healthy",
    };

    server.pushPerformanceData(testData);

    // Give time for message delivery
    await new Promise(r => setTimeout(r, 50));

    // Client 1 should receive it, client 2 should not
    const client1Push = msgs1.find(m => m.type === "performance_push");
    const client2Push = msgs2.find(m => m.type === "performance_push");

    expect(client1Push).toBeDefined();
    expect(client2Push).toBeUndefined();

    client1.destroy();
    client2.destroy();
  });

  describe("calculateHealth", () => {
    it("returns healthy when all metrics are good", () => {
      const metrics = {
        fps: 60, frameTimeMs: 16, jankFrames: 0, touchLatencyMs: 50,
        ttffMs: 300, ttiMs: 500, cpuUsagePercent: 20, memoryUsageMb: 100,
      };
      expect(PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS)).toBe("healthy");
    });

    it("returns warning when fps is below warning threshold", () => {
      const metrics = {
        fps: 50, frameTimeMs: 16, jankFrames: 0, touchLatencyMs: null,
        ttffMs: null, ttiMs: null, cpuUsagePercent: null, memoryUsageMb: null,
      };
      expect(PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS)).toBe("warning");
    });

    it("returns critical when fps is below critical threshold", () => {
      const metrics = {
        fps: 40, frameTimeMs: 16, jankFrames: 0, touchLatencyMs: null,
        ttffMs: null, ttiMs: null, cpuUsagePercent: null, memoryUsageMb: null,
      };
      expect(PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS)).toBe("critical");
    });

    it("returns warning when touch latency is high", () => {
      const metrics = {
        fps: 60, frameTimeMs: 16, jankFrames: 0, touchLatencyMs: 150,
        ttffMs: null, ttiMs: null, cpuUsagePercent: null, memoryUsageMb: null,
      };
      expect(PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS)).toBe("warning");
    });

    it("returns critical when touch latency is very high", () => {
      const metrics = {
        fps: 60, frameTimeMs: 16, jankFrames: 0, touchLatencyMs: 250,
        ttffMs: null, ttiMs: null, cpuUsagePercent: null, memoryUsageMb: null,
      };
      expect(PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS)).toBe("critical");
    });

    it("returns critical when jank frames exceed critical threshold", () => {
      const metrics = {
        fps: 60, frameTimeMs: 16, jankFrames: 15, touchLatencyMs: null,
        ttffMs: null, ttiMs: null, cpuUsagePercent: null, memoryUsageMb: null,
      };
      expect(PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS)).toBe("critical");
    });
  });
});

// Helper to connect a client
function connectClient(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.connect({ path: socketPath });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

// Helper to connect and subscribe
async function connectAndSubscribe(
  socketPath: string,
  options: { deviceId?: string; packageName?: string }
): Promise<{ client: Socket; messages: Array<Record<string, unknown>> }> {
  const client = await connectClient(socketPath);
  const messages: Array<Record<string, unknown>> = [];

  let buffer = "";
  client.on("data", data => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) {
        try {
          messages.push(JSON.parse(line));
        } catch {
          // Ignore parse errors in test
        }
      }
    }
  });

  // Send subscribe request
  const request = {
    id: `test-${Date.now()}`,
    command: "subscribe",
    deviceId: options.deviceId,
    packageName: options.packageName,
  };
  client.write(JSON.stringify(request) + "\n");

  return { client, messages };
}

// Helper to wait for a specific message
async function waitForMessage(
  messages: Array<Record<string, unknown>>,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 1000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (messages.some(predicate)) {
      return;
    }
    await new Promise(r => setTimeout(r, 10));
  }
}
