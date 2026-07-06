import { describe, it, expect, beforeEach } from "bun:test";
import { Socket } from "node:net";
import {
  DeviceDataStreamSocketServer,
  type NavigationGraphStreamData,
  type RequestedObservation,
} from "../../src/daemon/deviceDataStreamSocketServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeSocket } from "../fakes/FakeNetServer";

/**
 * Test helper that wraps DeviceDataStreamSocketServer to allow injecting fake sockets
 * without requiring real network connections.
 */
class TestableDeviceDataStreamSocketServer extends DeviceDataStreamSocketServer {
  constructor(timer: FakeTimer) {
    super("/fake/path/test.sock", timer);
  }

  async startFake(): Promise<void> {
    (this as any).server = { listening: true };
    (this as any).onServerStarted();
  }

  async closeFake(): Promise<void> {
    (this as any).onServerClosing();
    (this as any).server = null;
  }

  simulateSubscription(options: {
    deviceId?: string;
    screenshotIntervalMs?: number | null;
  }): { socket: FakeSocket; subscriptionId: string } {
    const socket = new FakeSocket();
    const subscriptionId = `devicedatastream-${++(this as any).subscriptionCounter}`;
    const timer = (this as any).timer as FakeTimer;
    this.subscribers.set(subscriptionId, {
      socket: socket as unknown as Socket,
      subscriptionId,
      lastActivity: timer.now(),
      filter: {
        deviceId: options.deviceId ?? null,
        screenshotIntervalMs: options.screenshotIntervalMs ?? null,
      },
      backfilling: false,
      drainPending: false,
    });
    return { socket, subscriptionId };
  }

  async processLineForTest(socket: FakeSocket, line: string): Promise<void> {
    await this.processLine(socket as unknown as Socket, line);
  }

  closeConnectionForTest(socket: FakeSocket): void {
    this.onConnectionClose(socket as unknown as Socket);
  }
}

describe("DeviceDataStreamSocketServer", () => {
  let server: TestableDeviceDataStreamSocketServer;
  let timer: FakeTimer;

  beforeEach(async () => {
    timer = new FakeTimer();
    server = new TestableDeviceDataStreamSocketServer(timer);
    await server.startFake();
  });

  describe("request_observation", () => {
    const requestedObservation = (deviceId: string): RequestedObservation => ({
      deviceId,
      observation: {
        updatedAt: "2026-06-24T00:00:00.000Z",
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        viewHierarchy: {
          updatedAt: 123,
          packageName: "com.example.app",
          hierarchy: { text: "Home" },
        } as any,
      },
    });

    it("triggers callback, pushes hierarchy update, and acknowledges success", async () => {
      let requestedDeviceId: string | null | undefined;
      let requestSignal: AbortSignal | undefined;
      server.setOnObservationRequested(async request => {
        requestedDeviceId = request.deviceId;
        requestSignal = request.signal;
        return [requestedObservation("emulator-5554")];
      });
      const { socket } = server.simulateSubscription({ deviceId: "emulator-5554" });

      await server.processLineForTest(socket, JSON.stringify({
        id: "obs-1",
        command: "request_observation",
        deviceId: "emulator-5554",
      }));

      expect(requestedDeviceId).toBe("emulator-5554");
      expect(requestSignal?.aborted).toBe(false);
      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
        deviceId?: string;
        data?: { packageName?: string };
      }>();
      expect(msgs).toHaveLength(2);
      expect(msgs[0].type).toBe("hierarchy_update");
      expect(msgs[0].deviceId).toBe("emulator-5554");
      expect(msgs[0].data?.packageName).toBe("com.example.app");
      expect(msgs[1].type).toBe("subscription_response");
      expect(msgs[1].id).toBe("obs-1");
      expect(msgs[1].success).toBe(true);
    });

    it("returns error when no observation callback is configured", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(socket, JSON.stringify({
        id: "obs-2",
        command: "request_observation",
      }));

      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
        error?: string;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].id).toBe("obs-2");
      expect(msgs[0].success).toBe(false);
      expect(msgs[0].error).toBe("Observation requests are not available");
    });

    it("returns error when observation has no hierarchy", async () => {
      server.setOnObservationRequested(async () => [{
        deviceId: "emulator-5554",
        observation: {
          updatedAt: "2026-06-24T00:00:00.000Z",
          screenSize: { width: 0, height: 0 },
          systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
          errors: [{ phase: "viewHierarchy", message: "Accessibility service unavailable" }],
          error: "Accessibility service unavailable",
        },
      }]);
      const { socket } = server.simulateSubscription({ deviceId: "emulator-5554" });

      await server.processLineForTest(socket, JSON.stringify({
        id: "obs-no-hierarchy",
        command: "request_observation",
        deviceId: "emulator-5554",
      }));

      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
        error?: string;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].id).toBe("obs-no-hierarchy");
      expect(msgs[0].success).toBe(false);
      expect(msgs[0].error).toBe(
        "Observation request failed for emulator-5554: Accessibility service unavailable"
      );
    });

    it("pushes healthy hierarchies and reports failures on partial all-device refresh", async () => {
      server.setOnObservationRequested(async () => [
        requestedObservation("emulator-5554"),
        {
          deviceId: "emulator-5556",
          observation: {
            updatedAt: "2026-06-24T00:00:00.000Z",
            screenSize: { width: 0, height: 0 },
            systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
            errors: [{ phase: "viewHierarchy", message: "CtrlProxy unavailable" }],
            error: "CtrlProxy unavailable",
          },
        },
      ]);
      const { socket } = server.simulateSubscription({});

      await server.processLineForTest(socket, JSON.stringify({
        id: "obs-partial",
        command: "request_observation",
      }));

      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
        deviceId?: string;
        error?: string;
      }>();
      // Healthy device still receives its hierarchy_update...
      expect(msgs).toHaveLength(2);
      expect(msgs[0].type).toBe("hierarchy_update");
      expect(msgs[0].deviceId).toBe("emulator-5554");
      // ...and the failed device is surfaced in the response error.
      expect(msgs[1].type).toBe("error");
      expect(msgs[1].id).toBe("obs-partial");
      expect(msgs[1].success).toBe(false);
      expect(msgs[1].error).toBe(
        "Observation request failed for emulator-5556: CtrlProxy unavailable"
      );
    });

    it("returns error when observation callback returns no devices", async () => {
      server.setOnObservationRequested(async () => []);
      const socket = new FakeSocket();

      await server.processLineForTest(socket, JSON.stringify({
        id: "obs-empty",
        command: "request_observation",
      }));

      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
        error?: string;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].id).toBe("obs-empty");
      expect(msgs[0].success).toBe(false);
      expect(msgs[0].error).toBe("Observation request did not capture any devices");
    });

    it("returns error when observation callback throws", async () => {
      server.setOnObservationRequested(async () => {
        throw new Error("Observe failed");
      });
      const socket = new FakeSocket();

      await server.processLineForTest(socket, JSON.stringify({
        id: "obs-3",
        command: "request_observation",
      }));

      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
        error?: string;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].id).toBe("obs-3");
      expect(msgs[0].success).toBe(false);
      expect(msgs[0].error).toBe("Observe failed");
    });

    it("returns error and aborts request when observation times out", async () => {
      let requestSignal: AbortSignal | undefined;
      server.setOnObservationRequested(request => {
        requestSignal = request.signal;
        return new Promise<RequestedObservation[]>(() => {});
      }, 100);
      const socket = new FakeSocket();

      const requestPromise = server.processLineForTest(socket, JSON.stringify({
        id: "obs-4",
        command: "request_observation",
      }));
      await Promise.resolve();
      timer.advanceTime(100);
      await requestPromise;

      expect(requestSignal?.aborted).toBe(true);
      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
        error?: string;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].id).toBe("obs-4");
      expect(msgs[0].success).toBe(false);
      expect(msgs[0].error).toBe("Observation request timed out after 100ms");
    });
  });

  describe("request_navigation_graph", () => {
    const sampleGraphData: NavigationGraphStreamData = {
      appId: "com.example.app",
      nodes: [
        { id: 1, screenName: "Home", visitCount: 3 },
        { id: 2, screenName: "Settings", visitCount: 1 },
      ],
      edges: [
        { id: 1, from: "Home", to: "Settings", toolName: "tapOn", traversalCount: 2 },
      ],
      currentScreen: "Home",
    };

    it("returns navigation_update to requesting socket only when callback returns data", async () => {
      server.setOnNavigationGraphRequested(async () => sampleGraphData);

      // Subscribe two sockets
      const { socket: socket1 } = server.simulateSubscription({});
      const requestSocket = new FakeSocket();

      const requestLine = JSON.stringify({
        id: "req-1",
        command: "request_navigation_graph",
      });

      await server.processLineForTest(requestSocket, requestLine);

      // Requesting socket should receive the navigation_update
      const msgs = requestSocket.getWrittenMessages<{
        id?: string;
        type: string;
        navigationGraph?: NavigationGraphStreamData;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("navigation_update");
      expect(msgs[0].id).toBe("req-1");
      expect(msgs[0].navigationGraph?.appId).toBe("com.example.app");
      expect(msgs[0].navigationGraph?.nodes).toHaveLength(2);
      expect(msgs[0].navigationGraph?.edges).toHaveLength(1);

      // Other subscriber should NOT receive anything
      const otherMsgs = socket1.getWrittenMessages();
      expect(otherMsgs).toHaveLength(0);
    });

    it("returns success acknowledgement when no callback is set", async () => {
      const requestSocket = new FakeSocket();

      const requestLine = JSON.stringify({
        id: "req-2",
        command: "request_navigation_graph",
      });

      await server.processLineForTest(requestSocket, requestLine);

      const msgs = requestSocket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("subscription_response");
      expect(msgs[0].id).toBe("req-2");
      expect(msgs[0].success).toBe(true);
    });

    it("returns success acknowledgement when callback returns null", async () => {
      server.setOnNavigationGraphRequested(async () => null);

      const requestSocket = new FakeSocket();

      const requestLine = JSON.stringify({
        id: "req-3",
        command: "request_navigation_graph",
      });

      await server.processLineForTest(requestSocket, requestLine);

      const msgs = requestSocket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("subscription_response");
      expect(msgs[0].id).toBe("req-3");
      expect(msgs[0].success).toBe(true);
    });

    it("returns error response when callback throws", async () => {
      server.setOnNavigationGraphRequested(async () => {
        throw new Error("Graph export failed");
      });

      const requestSocket = new FakeSocket();

      const requestLine = JSON.stringify({
        id: "req-4",
        command: "request_navigation_graph",
      });

      await server.processLineForTest(requestSocket, requestLine);

      const msgs = requestSocket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
        error?: string;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].id).toBe("req-4");
      expect(msgs[0].success).toBe(false);
      expect(msgs[0].error).toBe("Graph export failed");
    });
  });

  describe("subscribe and unsubscribe", () => {
    it("handles subscribe command", async () => {
      const socket = new FakeSocket();

      const requestLine = JSON.stringify({
        id: "sub-1",
        command: "subscribe",
        deviceId: "emulator-5554",
      });

      await server.processLineForTest(socket, requestLine);

      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("subscription_response");
      expect(msgs[0].success).toBe(true);
      expect(server.getSubscriberCount()).toBe(1);
    });

    it("handles unsubscribe command", async () => {
      const { socket } = server.simulateSubscription({});
      expect(server.getSubscriberCount()).toBe(1);

      const requestLine = JSON.stringify({
        id: "unsub-1",
        command: "unsubscribe",
      });

      await server.processLineForTest(socket, requestLine);

      const msgs = socket.getWrittenMessages<{
        id?: string;
        type: string;
        success?: boolean;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("subscription_response");
      expect(msgs[0].success).toBe(true);
      expect(server.getSubscriberCount()).toBe(0);
    });
  });

  describe("hasSubscriberForDevice", () => {
    it("returns false when there are no subscribers", () => {
      expect(server.hasSubscriberForDevice("device-1")).toBe(false);
    });

    it("returns true for all-device subscribers", () => {
      server.simulateSubscription({});

      expect(server.hasSubscriberForDevice("device-1")).toBe(true);
    });

    it("returns true for subscribers targeting the same device", () => {
      server.simulateSubscription({ deviceId: "device-1" });

      expect(server.hasSubscriberForDevice("device-1")).toBe(true);
    });

    it("returns false when subscribers target a different device", () => {
      server.simulateSubscription({ deviceId: "device-2" });

      expect(server.hasSubscriberForDevice("device-1")).toBe(false);
    });

    it("ignores destroyed subscriber sockets", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });
      socket.destroy();

      expect(server.hasSubscriberForDevice("device-1")).toBe(false);
    });
  });

  describe("screenshot cadence aggregation", () => {
    it("uses the default screenshot keepalive cadence when subscribers omit cadence", () => {
      server.simulateSubscription({ deviceId: "device-1" });

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(3000);
    });

    it("parses requested screenshot cadence from subscribe commands", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(socket, JSON.stringify({
        id: "sub-fast",
        command: "subscribe",
        deviceId: "device-1",
        screenshotIntervalMs: 500,
      }));

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(500);
    });

    it("clamps requested screenshot cadence to the safe minimum", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(socket, JSON.stringify({
        id: "sub-clamped",
        command: "subscribe",
        deviceId: "device-1",
        screenshotIntervalMs: 50,
      }));

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(250);
    });

    it("clamps requested screenshot cadence to the maximum timer delay", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(socket, JSON.stringify({
        id: "sub-max-clamped",
        command: "subscribe",
        deviceId: "device-1",
        screenshotIntervalMs: 3_000_000_000,
      }));

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(2_147_483_647);
    });

    it("uses the fastest active requested cadence for a device", () => {
      server.simulateSubscription({ deviceId: "device-1", screenshotIntervalMs: 1000 });
      server.simulateSubscription({ deviceId: "device-1", screenshotIntervalMs: 500 });
      server.simulateSubscription({ deviceId: "device-2", screenshotIntervalMs: 250 });

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(500);
    });

    it("keeps default cadence when another subscriber requests a slower cadence", () => {
      server.simulateSubscription({ deviceId: "device-1" });
      server.simulateSubscription({ deviceId: "device-1", screenshotIntervalMs: 10_000 });

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(3000);
    });

    it("applies all-device subscriber cadence to each device", () => {
      server.simulateSubscription({ screenshotIntervalMs: 750 });

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(750);
      expect(server.getScreenshotIntervalMsForDevice("device-2")).toBe(750);
    });

    it("removes requested cadence after unsubscribe", async () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1", screenshotIntervalMs: 500 });

      await server.processLineForTest(socket, JSON.stringify({
        id: "unsub-fast",
        command: "unsubscribe",
      }));

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(3000);
    });

    it("ignores destroyed subscriber sockets when aggregating cadence", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1", screenshotIntervalMs: 500 });
      socket.destroy();

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(3000);
    });

    it("notifies when subscribe changes screenshot cadence", async () => {
      const changedDevices: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged(deviceId => {
        changedDevices.push(deviceId);
      });
      const socket = new FakeSocket();

      await server.processLineForTest(socket, JSON.stringify({
        id: "sub-fast",
        command: "subscribe",
        deviceId: "device-1",
        screenshotIntervalMs: 500,
      }));

      expect(changedDevices).toEqual(["device-1"]);
    });

    it("notifies when unsubscribe removes screenshot cadence", async () => {
      const changedDevices: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged(deviceId => {
        changedDevices.push(deviceId);
      });
      const { socket } = server.simulateSubscription({ deviceId: "device-1", screenshotIntervalMs: 500 });

      await server.processLineForTest(socket, JSON.stringify({
        id: "unsub-fast",
        command: "unsubscribe",
      }));

      expect(changedDevices).toEqual(["device-1"]);
    });

    it("does not notify when unsubscribe has no active subscription", async () => {
      const changedDevices: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged(deviceId => {
        changedDevices.push(deviceId);
      });
      const socket = new FakeSocket();

      await server.processLineForTest(socket, JSON.stringify({
        id: "unsub-missing",
        command: "unsubscribe",
      }));

      expect(changedDevices).toEqual([]);
    });

    it("notifies when connection close removes screenshot cadence", () => {
      const changedDevices: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged(deviceId => {
        changedDevices.push(deviceId);
      });
      const { socket } = server.simulateSubscription({ deviceId: "device-1", screenshotIntervalMs: 500 });

      server.closeConnectionForTest(socket);

      expect(changedDevices).toEqual(["device-1"]);
    });
  });

  describe("onDeviceConnectionLost", () => {
    it("pushes a device-scoped error to subscribers for that device", () => {
      const { socket } = server.simulateSubscription({ deviceId: "emulator-5554" });
      timer.advanceTime(1234);

      server.onDeviceConnectionLost("emulator-5554");

      const msgs = socket.getWrittenMessages<{
        type: string;
        success?: boolean;
        deviceId?: string;
        timestamp?: number;
        error?: string;
      }>();
      expect(msgs).toEqual([
        {
          type: "error",
          success: false,
          deviceId: "emulator-5554",
          timestamp: 1234,
          error: "device connection lost",
        },
      ]);
    });

    it("pushes device connection errors to all-device subscribers", () => {
      const { socket } = server.simulateSubscription({});

      server.onDeviceConnectionLost("emulator-5554");

      const msgs = socket.getWrittenMessages<{ type: string; deviceId?: string; error?: string }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({
        type: "error",
        deviceId: "emulator-5554",
        error: "device connection lost",
      });
    });

    it("does not push device connection errors to other device subscribers", () => {
      const { socket } = server.simulateSubscription({ deviceId: "emulator-5556" });

      server.onDeviceConnectionLost("emulator-5554");

      expect(socket.getWrittenMessages()).toHaveLength(0);
    });
  });
});
