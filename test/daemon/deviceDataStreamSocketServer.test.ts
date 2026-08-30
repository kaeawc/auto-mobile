import { describe, it, expect, beforeEach } from "bun:test";
import { Socket } from "node:net";
import {
  DeviceDataStreamSocketServer,
  type NavigationGraphStreamData,
  type RequestedObservation,
} from "../../src/daemon/deviceDataStreamSocketServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeDeviceSessionResolver } from "../fakes/FakeDeviceSessionResolver";
import { loadCoordinateMappingVectors } from "../parity/coordinateMappingGoldenVectors";

/** Deterministic deviceSessionUuid the harness mints for a given serial. */
function sessionUuidFor(deviceId: string): string {
  return `session-${deviceId}`;
}

/**
 * Test helper that wraps DeviceDataStreamSocketServer to allow injecting fake sockets
 * without requiring real network connections.
 *
 * The device-session routing key (epic #5256, item 3) is transparent to existing
 * device-scoped tests: `simulateSubscription({ deviceId })` mints a deterministic
 * `deviceSessionUuid` for that serial, binds it in the shared resolver, and keys the
 * subscription on it — so a `pushHierarchyUpdate(deviceId, ...)` resolves to the same
 * uuid and routes correctly without every test naming a uuid.
 */
class TestableDeviceDataStreamSocketServer extends DeviceDataStreamSocketServer {
  readonly sessionResolver = new FakeDeviceSessionResolver();

  constructor(timer: FakeTimer) {
    super("/fake/path/test.sock", timer);
    this.setDeviceSessionResolver(this.sessionResolver);
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
    deviceSessionUuid?: string | null;
    screenshotIntervalMs?: number | null;
    hierarchyIntervalMs?: number | null;
  }): { socket: FakeSocket; subscriptionId: string } {
    const socket = new FakeSocket();
    const subscriptionId = `devicedatastream-${++(this as any).subscriptionCounter}`;
    const timer = (this as any).timer as FakeTimer;
    // Bind serial↔uuid so pushes for this device resolve to the same key we filter on.
    let deviceSessionUuid: string | null;
    if (options.deviceSessionUuid !== undefined) {
      deviceSessionUuid = options.deviceSessionUuid;
    } else if (options.deviceId) {
      deviceSessionUuid = sessionUuidFor(options.deviceId);
      this.sessionResolver.bind(options.deviceId, deviceSessionUuid);
    } else {
      deviceSessionUuid = null;
    }
    this.subscribers.set(subscriptionId, {
      socket: socket as unknown as Socket,
      subscriptionId,
      lastActivity: timer.now(),
      filter: {
        deviceSessionUuid,
        deviceId: options.deviceId ?? null,
        screenshotIntervalMs: options.screenshotIntervalMs ?? null,
        hierarchyIntervalMs: options.hierarchyIntervalMs ?? null,
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

  it("records a device-authored frame context even without an IDE subscriber", () => {
    server.pushHierarchyUpdate(
      "device-1",
      {
        updatedAt: 123,
        packageName: "com.example.app",
        hierarchy: { text: "Home" },
      } as any,
      "frame-A",
    );

    expect(server.getCurrentFrameContext("device-1")).toBe("frame-A");
  });

  it("clears a device frame context when a hierarchy has no proven context", () => {
    const hierarchy = {
      updatedAt: 123,
      packageName: "com.example.app",
      hierarchy: { text: "Home" },
    } as any;
    server.pushHierarchyUpdate("device-1", hierarchy, "frame-A");
    server.pushHierarchyUpdate("device-1", hierarchy);

    expect(server.getCurrentFrameContext("device-1")).toBeUndefined();
  });

  describe("request_observation", () => {
    const requestedObservation = (
      deviceId: string,
      frameContext?: string,
    ): RequestedObservation => ({
      deviceId,
      observation: {
        updatedAt: "2026-06-24T00:00:00.000Z",
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        viewHierarchy: {
          updatedAt: 123,
          packageName: "com.example.app",
          hierarchy: { text: "Home" },
          ...(frameContext === undefined ? {} : { frameContext }),
        } as any,
      },
    });

    it("triggers callback, pushes hierarchy update, and acknowledges success", async () => {
      let requestedDeviceId: string | null | undefined;
      let requestSignal: AbortSignal | undefined;
      server.setOnObservationRequested(async (request) => {
        requestedDeviceId = request.deviceId;
        requestSignal = request.signal;
        return [requestedObservation("emulator-5554")];
      });
      const { socket } = server.simulateSubscription({ deviceId: "emulator-5554" });

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-1",
          command: "request_observation",
          deviceId: "emulator-5554",
        }),
      );

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

    it("forwards proven frame context and clears it when an explicit observation lacks provenance", async () => {
      server.setOnObservationRequested(async (request) => [
        requestedObservation(request.deviceId ?? "emulator-5554", "frame-A"),
      ]);
      const { socket } = server.simulateSubscription({ deviceId: "emulator-5554" });

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-context",
          command: "request_observation",
          deviceId: "emulator-5554",
        }),
      );

      const firstMessages = socket.getWrittenMessages<{
        type: string;
        frameContext?: string;
      }>();
      expect(firstMessages[0].frameContext).toBe("frame-A");
      expect(server.getCurrentFrameContext("emulator-5554")).toBe("frame-A");

      server.setOnObservationRequested(async (request) => [
        requestedObservation(request.deviceId ?? "emulator-5554"),
      ]);
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-contextless",
          command: "request_observation",
          deviceId: "emulator-5554",
        }),
      );

      expect(server.getCurrentFrameContext("emulator-5554")).toBeUndefined();
    });

    it("does not let a completed explicit observation replace a newer live frame context", async () => {
      let resolveObservation: ((observations: RequestedObservation[]) => void) | undefined;
      server.setOnObservationRequested(
        () =>
          new Promise((resolve) => {
            resolveObservation = resolve;
          }),
      );
      const { socket } = server.simulateSubscription({ deviceId: "emulator-5554" });

      const request = server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-race",
          command: "request_observation",
          deviceId: "emulator-5554",
        }),
      );
      await Promise.resolve();
      expect(resolveObservation).toBeDefined();

      server.pushHierarchyUpdate(
        "emulator-5554",
        requestedObservation("emulator-5554", "frame-B").observation.viewHierarchy!,
        "frame-B",
      );
      resolveObservation!([requestedObservation("emulator-5554", "frame-A")]);
      await request;

      expect(server.getCurrentFrameContext("emulator-5554")).toBe("frame-B");
      expect(
        socket
          .getWrittenMessages<{ type: string }>()
          .filter((message) => message.type === "hierarchy_update"),
      ).toHaveLength(1);
    });

    it("returns error when no observation callback is configured", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-2",
          command: "request_observation",
        }),
      );

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
      server.setOnObservationRequested(async () => [
        {
          deviceId: "emulator-5554",
          observation: {
            updatedAt: "2026-06-24T00:00:00.000Z",
            screenSize: { width: 0, height: 0 },
            systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
            errors: [{ phase: "viewHierarchy", message: "Accessibility service unavailable" }],
            error: "Accessibility service unavailable",
          },
        },
      ]);
      const { socket } = server.simulateSubscription({ deviceId: "emulator-5554" });

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-no-hierarchy",
          command: "request_observation",
          deviceId: "emulator-5554",
        }),
      );

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
        "Observation request failed for emulator-5554: Accessibility service unavailable",
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

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-partial",
          command: "request_observation",
        }),
      );

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
        "Observation request failed for emulator-5556: CtrlProxy unavailable",
      );
    });

    it("returns error when observation callback returns no devices", async () => {
      server.setOnObservationRequested(async () => []);
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-empty",
          command: "request_observation",
        }),
      );

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

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-3",
          command: "request_observation",
        }),
      );

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
      server.setOnObservationRequested((request) => {
        requestSignal = request.signal;
        return new Promise<RequestedObservation[]>(() => {});
      }, 100);
      const socket = new FakeSocket();

      const requestPromise = server.processLineForTest(
        socket,
        JSON.stringify({
          id: "obs-4",
          command: "request_observation",
        }),
      );
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
      edges: [{ id: 1, from: "Home", to: "Settings", toolName: "tapOn", traversalCount: 2 }],
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

    it("rejects a malformed deviceSessionUuid at the socket boundary", async () => {
      const screenshotChanges: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged((deviceId) => screenshotChanges.push(deviceId));
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-invalid-session",
          command: "subscribe",
          deviceSessionUuid: 42,
          screenshotIntervalMs: 500,
        }),
      );

      expect(socket.getWrittenMessages()).toEqual([
        {
          id: "sub-invalid-session",
          type: "error",
          success: false,
          error: "deviceSessionUuid must be a string or null",
        },
      ]);
      expect(server.getSubscriberCount()).toBe(0);
      expect(screenshotChanges).toEqual([]);
    });

    it("treats an omitted deviceSessionUuid as an intentional all-devices subscription", async () => {
      const screenshotChanges: Array<string | null> = [];
      const hierarchyChanges: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged((deviceId) => screenshotChanges.push(deviceId));
      server.setOnHierarchyCadenceChanged((deviceId) => hierarchyChanges.push(deviceId));
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-all-devices",
          command: "subscribe",
          screenshotIntervalMs: 750,
          hierarchyIntervalMs: 500,
        }),
      );

      expect(screenshotChanges).toEqual([null]);
      expect(hierarchyChanges).toEqual([null]);
      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(750);
      expect(server.getScreenshotIntervalMsForDevice("device-2")).toBe(750);
      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(500);
      expect(server.getHierarchyIntervalMsForDevice("device-2")).toBe(500);
    });

    it("rejects an unresolved deviceSessionUuid before creating a subscription", async () => {
      const screenshotChanges: Array<string | null> = [];
      const hierarchyChanges: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged((deviceId) => screenshotChanges.push(deviceId));
      server.setOnHierarchyCadenceChanged((deviceId) => hierarchyChanges.push(deviceId));
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-unknown-session",
          command: "subscribe",
          deviceSessionUuid: "session-unknown",
          screenshotIntervalMs: 250,
          hierarchyIntervalMs: 250,
        }),
      );

      expect(
        socket.getWrittenMessages<{ type: string; success?: boolean; error?: string }>(),
      ).toEqual([
        {
          id: "sub-unknown-session",
          type: "error",
          success: false,
          error: "deviceSessionUuid 'session-unknown' does not identify a live device session",
        },
      ]);
      expect(screenshotChanges).toEqual([]);
      expect(hierarchyChanges).toEqual([]);
      expect(server.getSubscriberCount()).toBe(0);
      expect(server.hasSubscriberForDevice("device-1")).toBe(false);
      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(3000);
      // No subscriber: the hierarchy cadence is paused, not the 1Hz default (#5472).
      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(2_147_483_647);
    });

    it("rejects a blank deviceSessionUuid", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-blank-session",
          command: "subscribe",
          deviceSessionUuid: "  ",
        }),
      );

      expect(socket.getWrittenMessages()).toEqual([
        {
          id: "sub-blank-session",
          type: "error",
          success: false,
          error: "deviceSessionUuid must not be blank",
        },
      ]);
      expect(server.getSubscriberCount()).toBe(0);
    });

    it("handles unsubscribe command", async () => {
      const { socket } = server.simulateSubscription({});
      expect(server.getSubscriberCount()).toBe(1);

      const requestLine = JSON.stringify({
        id: "unsub-1",
        command: "unsubscribe",
        subscriptionId: "devicedatastream-1",
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

    it("multiplexes device filters and cadence updates by subscriptionId", async () => {
      server.sessionResolver
        .bind("device-1", "session-device-1")
        .bind("device-2", "session-device-2");
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-device-1",
          command: "subscribe",
          deviceSessionUuid: "session-device-1",
          screenshotIntervalMs: 500,
        }),
      );
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-device-2",
          command: "subscribe",
          deviceSessionUuid: "session-device-2",
          screenshotIntervalMs: 1000,
        }),
      );

      const [firstResponse, secondResponse] = socket.getWrittenMessages<{
        id: string;
        subscriptionId: string;
      }>();
      expect(server.getSubscriberCount()).toBe(2);
      expect(firstResponse.subscriptionId).toBe("devicedatastream-1");
      expect(secondResponse.subscriptionId).toBe("devicedatastream-2");

      server.pushScreenshotUpdate("device-1", "device-1-frame", 100, 200);
      server.pushScreenshotUpdate("device-2", "device-2-frame", 100, 200);
      expect(
        socket
          .getWrittenMessages<{
            type: string;
            subscriptionId: string;
            screenshotBase64?: string;
          }>()
          .filter((message) => message.type === "screenshot_update"),
      ).toMatchObject([
        { subscriptionId: firstResponse.subscriptionId, screenshotBase64: "device-1-frame" },
        { subscriptionId: secondResponse.subscriptionId, screenshotBase64: "device-2-frame" },
      ]);

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "relax-device-2",
          command: "update_cadence",
          subscriptionId: secondResponse.subscriptionId,
          screenshotIntervalMs: 1500,
        }),
      );

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(500);
      expect(server.getScreenshotIntervalMsForDevice("device-2")).toBe(1500);
    });

    it("removes every multiplexed device subscription on connection close", async () => {
      const screenshotChanges: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged((deviceId) => screenshotChanges.push(deviceId));
      server.sessionResolver
        .bind("device-1", "session-device-1")
        .bind("device-2", "session-device-2");
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-device-1",
          command: "subscribe",
          deviceSessionUuid: "session-device-1",
        }),
      );
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-device-2",
          command: "subscribe",
          deviceSessionUuid: "session-device-2",
        }),
      );
      screenshotChanges.length = 0;

      server.closeConnectionForTest(socket);

      expect(server.getSubscriberCount()).toBe(0);
      // Cadence notifications carry the resolved serial (the polling key), not the uuid.
      expect(screenshotChanges).toEqual(["device-1", "device-2"]);
    });
  });

  describe("screenshot updates", () => {
    it("includes optional screenshot metadata when pushing updates", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      server.pushScreenshotUpdate("device-1", "png-frame", 1080, 2340, {
        screenshotMimeType: "image/png",
        screenshotFormat: "png",
        screenshotCaptureSource: "android_adb_screencap",
        screenshotFallback: true,
        screenshotFallbackReason: "websocket_unavailable",
        screenshotCaptureDurationMs: 42,
        screenshotEncodeDurationMs: 7,
        screenshotByteLength: 1200,
        screenshotBase64Length: 1600,
        checksum: "internal-checksum",
      } as any);

      const msgs = socket.getWrittenMessages<{
        type: string;
        deviceId?: string;
        screenshotBase64?: string;
        screenWidth?: number;
        screenHeight?: number;
        screenshotMimeType?: string;
        screenshotFormat?: string;
        screenshotCaptureSource?: string;
        screenshotFallback?: boolean;
        screenshotFallbackReason?: string;
        screenshotCaptureDurationMs?: number;
        screenshotEncodeDurationMs?: number;
        screenshotByteLength?: number;
        screenshotBase64Length?: number;
      }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({
        type: "screenshot_update",
        deviceId: "device-1",
        screenshotBase64: "png-frame",
        screenWidth: 1080,
        screenHeight: 2340,
        screenshotMimeType: "image/png",
        screenshotFormat: "png",
        screenshotCaptureSource: "android_adb_screencap",
        screenshotFallback: true,
        screenshotFallbackReason: "websocket_unavailable",
        screenshotCaptureDurationMs: 42,
        screenshotEncodeDurationMs: 7,
        screenshotByteLength: 1200,
        screenshotBase64Length: 1600,
      });
      expect(msgs[0]).not.toHaveProperty("checksum");
    });

    it("omits screenshot performance metadata when it is not provided", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      server.pushScreenshotUpdate("device-1", "legacy-frame", 1080, 2340, {
        screenshotMimeType: "image/jpeg",
        screenshotFormat: "jpeg",
        screenshotCaptureSource: "android_ctrlproxy_a11y",
        screenshotFallback: false,
      });

      const [message] = socket.getWrittenMessages<Record<string, unknown>>();
      expect(message).toMatchObject({
        type: "screenshot_update",
        screenshotBase64: "legacy-frame",
        screenshotMimeType: "image/jpeg",
      });
      expect(message).not.toHaveProperty("screenshotCaptureDurationMs");
      expect(message).not.toHaveProperty("screenshotEncodeDurationMs");
      expect(message).not.toHaveProperty("screenshotByteLength");
      expect(message).not.toHaveProperty("screenshotBase64Length");
    });
  });

  /** A minimal PNG whose IHDR declares the given pixel size, base64-encoded as CtrlProxy sends it. */
  const pngFrame = (width: number, height: number): string => {
    const buffer = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
    buffer.writeUInt32BE(13, 8); // IHDR data length, fixed by the PNG spec
    buffer.write("IHDR", 12, "ascii");
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer.toString("base64");
  };

  describe("hierarchy diff annotation", () => {
    const frame = (text: string, rotation: number = 0) =>
      ({
        hierarchy: { node: { $: { class: "Root" }, node: [{ $: { class: "Child", text } }] } },
        rotation,
      }) as any;

    it("reports no baseline and annotates nothing on the first frame", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      server.pushHierarchyUpdate("device-1", frame("a"));

      const [message] = socket.getWrittenMessages<any>();
      expect(message.type).toBe("hierarchy_update");
      expect(message.hierarchyDiff).toEqual({
        hasBaseline: false,
        added: 0,
        changed: 0,
        removed: 0,
      });
      expect(message.data.hierarchy.node.node[0].$.diffState).toBeUndefined();
    });

    it("annotates changed nodes and summarizes the diff against the previous frame", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      server.pushHierarchyUpdate("device-1", frame("a"));
      server.pushHierarchyUpdate("device-1", frame("b"));

      const messages = socket.getWrittenMessages<any>();
      expect(messages).toHaveLength(2);
      expect(messages[1].hierarchyDiff).toEqual({
        hasBaseline: true,
        added: 0,
        changed: 1,
        removed: 0,
      });
      expect(messages[1].data.hierarchy.node.node[0].$.diffState).toBe("changed");
    });

    it("resets the diff baseline when the device connection is lost", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      server.pushHierarchyUpdate("device-1", frame("a"));
      server.onDeviceConnectionLost("device-1");
      server.pushHierarchyUpdate("device-1", frame("b"));

      // The post-reconnect frame is diffed against a fresh baseline, not the
      // pre-drop tree, so it reports no baseline rather than a spurious change.
      const messages = socket.getWrittenMessages<any>();
      const hierarchyMessages = messages.filter((m) => m.type === "hierarchy_update");
      expect(hierarchyMessages[hierarchyMessages.length - 1].hierarchyDiff.hasBaseline).toBe(false);
    });

    it("forgets a device frame context when the connection is lost", () => {
      server.pushHierarchyUpdate("device-1", frame("a"), "frame-A");
      server.onDeviceConnectionLost("device-1");

      expect(server.getCurrentFrameContext("device-1")).toBeUndefined();
    });

    it("stamps a monotonic capture identity on each hierarchy and echoes it on matching screenshots", () => {
      // Issue #3348: a control client pairs a screenshot with the hierarchy its geometry came from
      // by requiring equal captureSequence. The echo happens only when the frame's REAL pixels
      // match the geometry the capture client claimed for it.
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      const first = server.pushHierarchyUpdate("device-1", frame("a", 0));
      server.pushScreenshotUpdate(
        "device-1",
        pngFrame(1080, 2340),
        1080,
        2340,
        {},
        {
          captureSequence: first ?? undefined,
          rotation: 0,
        },
      );
      const second = server.pushHierarchyUpdate("device-1", frame("b", 1));
      server.pushScreenshotUpdate(
        "device-1",
        pngFrame(720, 1560),
        720,
        1560,
        {},
        {
          captureSequence: second ?? undefined,
          rotation: 1,
        },
      );

      const [h1, s1, h2, s2] = socket
        .getWrittenMessages<any>()
        .filter((m) => m.type === "hierarchy_update" || m.type === "screenshot_update");

      expect(h1.captureSequence).toBe(1);
      expect(s1.captureSequence).toBe(1);
      expect(h2.captureSequence).toBe(2);
      expect(s2.captureSequence).toBe(2);
      expect(h1.rotation).toBe(0);
      expect(s1.rotation).toBe(0);
      expect(h2.rotation).toBe(1);
      expect(s2.rotation).toBe(1);
    });

    it("omits the capture identity when fresh pixels outran the hierarchy that claimed the geometry", () => {
      // THE defect this pairing exists for. The device drops to 720x1560. The next screenshot
      // carries the new pixels, but the capture client's screen-dimension cache is still the
      // previous hierarchy's 1080x2340 — so it CLAIMS 1080x2340 for a 720x1560 frame. Stamping the
      // outstanding capture id here would let a client pair those pixels with the stale hierarchy
      // and map a tap through the wrong absolute bounds. The two resolutions share an aspect ratio
      // exactly, so nothing downstream could detect it.
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      const captureSequence = server.pushHierarchyUpdate("device-1", frame("a"));
      server.pushScreenshotUpdate(
        "device-1",
        pngFrame(720, 1560),
        1080,
        2340,
        {},
        {
          captureSequence: captureSequence ?? undefined,
        },
      );

      const screenshot = socket
        .getWrittenMessages<any>()
        .find((m) => m.type === "screenshot_update");
      expect(screenshot.captureSequence).toBeUndefined();
      // The published geometry is the frame's real size, not the stale claim, so a client that
      // falls back to it maps through the pixels it is actually rendering.
      expect(screenshot.screenWidth).toBe(720);
      expect(screenshot.screenHeight).toBe(1560);
    });

    it("omits the capture identity for callers whose geometry has no tracked capture", () => {
      // TakeScreenshot reads dimensions out of the PNG it just captured; they match the pixels by
      // construction but have no relationship to any hierarchy, so they must never be paired.
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      server.pushHierarchyUpdate("device-1", frame("a"));
      server.pushScreenshotUpdate("device-1", pngFrame(1080, 2340), 1080, 2340);

      const screenshot = socket
        .getWrittenMessages<any>()
        .find((m) => m.type === "screenshot_update");
      expect(screenshot.captureSequence).toBeUndefined();
    });

    it("accepts a landscape claim against a native-portrait frame (orientation swap)", () => {
      // iOS landscape: hierarchy geometry is display-oriented (2532x1170) while the screenshot
      // arrives in native portrait pixel orientation (1170x2532) - the rotation the renderer
      // already corrects for. Rejecting this would strip the identity from every landscape frame
      // and make device control impossible in that orientation.
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      const captureSequence = server.pushHierarchyUpdate("device-1", frame("a"));
      server.pushScreenshotUpdate(
        "device-1",
        pngFrame(1170, 2532),
        2532,
        1170,
        {},
        {
          captureSequence: captureSequence ?? undefined,
        },
      );

      const screenshot = socket
        .getWrittenMessages<any>()
        .find((m) => m.type === "screenshot_update");
      expect(screenshot.captureSequence).toBe(captureSequence);
      // The MEASURED dimensions are still what gets published, so a client maps through the pixels
      // it actually renders rather than the claim.
      expect(screenshot.screenWidth).toBe(1170);
      expect(screenshot.screenHeight).toBe(2532);
    });

    it("still rejects a scale change that happens to preserve aspect", () => {
      // The swap accepts exactly ONE alternative. A uniform scale is not it.
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      const captureSequence = server.pushHierarchyUpdate("device-1", frame("a"));
      server.pushScreenshotUpdate(
        "device-1",
        pngFrame(720, 1560),
        1080,
        2340,
        {},
        {
          captureSequence: captureSequence ?? undefined,
        },
      );

      const screenshot = socket
        .getWrittenMessages<any>()
        .find((m) => m.type === "screenshot_update");
      expect(screenshot.captureSequence).toBeUndefined();
    });

    it("still rejects dimensions unrelated to the claim", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      const captureSequence = server.pushHierarchyUpdate("device-1", frame("a"));
      server.pushScreenshotUpdate(
        "device-1",
        pngFrame(800, 600),
        1080,
        2340,
        {},
        {
          captureSequence: captureSequence ?? undefined,
        },
      );

      const screenshot = socket
        .getWrittenMessages<any>()
        .find((m) => m.type === "screenshot_update");
      expect(screenshot.captureSequence).toBeUndefined();
    });

    it("omits the capture identity for a frame with a malformed header", () => {
      // A PNG signature with a bad IHDR chunk must read as unmeasurable, not as whatever bytes sit
      // at the width offset — otherwise the "measure, don't trust the claim" guarantee is silently
      // defeated and a bogus measurement could match the claim and get stamped.
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });
      const malformed = Buffer.from(pngFrame(1080, 2340), "base64");
      malformed.write("IDAT", 12, "ascii");

      const captureSequence = server.pushHierarchyUpdate("device-1", frame("a"));
      server.pushScreenshotUpdate(
        "device-1",
        malformed.toString("base64"),
        1080,
        2340,
        {},
        {
          captureSequence: captureSequence ?? undefined,
        },
      );

      const screenshot = socket
        .getWrittenMessages<any>()
        .find((m) => m.type === "screenshot_update");
      expect(screenshot.captureSequence).toBeUndefined();
    });

    it("omits the capture identity for a frame whose dimensions cannot be measured", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      const captureSequence = server.pushHierarchyUpdate("device-1", frame("a"));
      server.pushScreenshotUpdate(
        "device-1",
        Buffer.from("not-an-image").toString("base64"),
        1080,
        2340,
        {},
        {
          captureSequence: captureSequence ?? undefined,
        },
      );

      const screenshot = socket
        .getWrittenMessages<any>()
        .find((m) => m.type === "screenshot_update");
      expect(screenshot.captureSequence).toBeUndefined();
      // Unmeasurable: fall back to the caller's claim for display, but never pair on it.
      expect(screenshot.screenWidth).toBe(1080);
    });

    it("omits the capture identity until a hierarchy has been pushed", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      server.pushScreenshotUpdate("device-1", pngFrame(1080, 2340), 1080, 2340);

      const screenshot = socket
        .getWrittenMessages<any>()
        .find((m) => m.type === "screenshot_update");
      expect(screenshot.captureSequence).toBeUndefined();
    });

    it("keeps a screenshot bound to the capture it was REQUESTED under, not the newest one", () => {
      // Same-resolution navigation, the case no measurement can catch. A frame is requested while
      // screen A's hierarchy is current; screen B's hierarchy — identical dimensions — is forwarded
      // before the frame is pushed. Reading "the newest capture" at push time would label A's
      // pixels with B's identity and let a control client tap stale content.
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      const screenA = server.pushHierarchyUpdate("device-1", frame("screen-a"));
      // ... screenshot request goes out here, bound to screenA ...
      const screenB = server.pushHierarchyUpdate("device-1", frame("screen-b"));
      expect(screenB).toBeGreaterThan(screenA!);
      // ... and only now does the in-flight frame arrive and get pushed.
      server.pushScreenshotUpdate(
        "device-1",
        pngFrame(1080, 2340),
        1080,
        2340,
        {},
        {
          captureSequence: screenA ?? undefined,
        },
      );

      const screenshot = socket
        .getWrittenMessages<any>()
        .find((m) => m.type === "screenshot_update");
      expect(screenshot.captureSequence).toBe(screenA);
      expect(screenshot.captureSequence).not.toBe(screenB);
    });

    it("never reuses a capture identity after a reconnect", () => {
      // Resetting the counter to 1 on connection loss would COLLIDE with a pre-drop hierarchy a
      // client may still hold, letting a post-reconnect screenshot pair with stale geometry.
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      server.pushHierarchyUpdate("device-1", frame("a"));
      server.pushHierarchyUpdate("device-1", frame("b"));
      server.onDeviceConnectionLost("device-1");
      server.pushHierarchyUpdate("device-1", frame("c"));

      const ids = socket
        .getWrittenMessages<any>()
        .filter((m) => m.type === "hierarchy_update")
        .map((m) => m.captureSequence);

      expect(new Set(ids).size).toBe(ids.length);
      expect(ids[2]).toBeGreaterThan(ids[1]);
    });

    it("drops the device's current capture so a pre-reconnect screenshot cannot pair", () => {
      const { socket } = server.simulateSubscription({ deviceId: "device-1" });

      server.pushHierarchyUpdate("device-1", frame("a"));
      server.onDeviceConnectionLost("device-1");
      // The client drops its binding when the connection goes away, so nothing is supplied.
      server.pushScreenshotUpdate("device-1", pngFrame(1080, 2340), 1080, 2340);

      const screenshot = socket
        .getWrittenMessages<any>()
        .find((m) => m.type === "screenshot_update");
      expect(screenshot.captureSequence).toBeUndefined();
    });

    it("does not mutate the caller's hierarchy when annotating", () => {
      server.simulateSubscription({ deviceId: "device-1" });

      server.pushHierarchyUpdate("device-1", frame("a"));
      const second = frame("b");
      server.pushHierarchyUpdate("device-1", second);

      expect(second.hierarchy.node.node[0].$.diffState).toBeUndefined();
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

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-fast",
          command: "subscribe",
          deviceId: "device-1",
          screenshotIntervalMs: 500,
        }),
      );

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(500);
    });

    it("clamps requested screenshot cadence to the safe minimum", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-clamped",
          command: "subscribe",
          deviceId: "device-1",
          screenshotIntervalMs: 50,
        }),
      );

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(250);
    });

    it("clamps requested screenshot cadence to the maximum timer delay", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-max-clamped",
          command: "subscribe",
          deviceId: "device-1",
          screenshotIntervalMs: 3_000_000_000,
        }),
      );

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
      const { socket } = server.simulateSubscription({
        deviceId: "device-1",
        screenshotIntervalMs: 500,
      });

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "unsub-fast",
          command: "unsubscribe",
          subscriptionId: "devicedatastream-1",
        }),
      );

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(3000);
    });

    it("ignores destroyed subscriber sockets when aggregating cadence", () => {
      const { socket } = server.simulateSubscription({
        deviceId: "device-1",
        screenshotIntervalMs: 500,
      });
      socket.destroy();

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(3000);
    });

    it("notifies when subscribe changes screenshot cadence", async () => {
      const changedDevices: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged((deviceId) => {
        changedDevices.push(deviceId);
      });
      server.sessionResolver.bind("device-1", "session-device-1");
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-fast",
          command: "subscribe",
          deviceSessionUuid: "session-device-1",
          screenshotIntervalMs: 500,
        }),
      );

      // Cadence notifications carry the resolved serial, not the uuid.
      expect(changedDevices).toEqual(["device-1"]);
    });

    it("notifies when unsubscribe removes screenshot cadence", async () => {
      const changedDevices: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged((deviceId) => {
        changedDevices.push(deviceId);
      });
      const { socket } = server.simulateSubscription({
        deviceId: "device-1",
        screenshotIntervalMs: 500,
      });

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "unsub-fast",
          command: "unsubscribe",
          subscriptionId: "devicedatastream-1",
        }),
      );

      expect(changedDevices).toEqual(["device-1"]);
    });

    it("does not notify when unsubscribe has no active subscription", async () => {
      const changedDevices: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged((deviceId) => {
        changedDevices.push(deviceId);
      });
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "unsub-missing",
          command: "unsubscribe",
          subscriptionId: "devicedatastream-missing",
        }),
      );

      expect(changedDevices).toEqual([]);
    });

    it("notifies when connection close removes screenshot cadence", () => {
      const changedDevices: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged((deviceId) => {
        changedDevices.push(deviceId);
      });
      const { socket } = server.simulateSubscription({
        deviceId: "device-1",
        screenshotIntervalMs: 500,
      });

      server.closeConnectionForTest(socket);

      expect(changedDevices).toEqual(["device-1"]);
    });
  });

  describe("hierarchy cadence aggregation", () => {
    it("uses the default hierarchy polling cadence when subscribers omit cadence", () => {
      server.simulateSubscription({ deviceId: "device-1" });

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(1000);
    });

    it("uses a caller-provided hierarchy fallback when subscribers omit cadence", () => {
      server.simulateSubscription({ deviceId: "device-1" });

      expect(server.getHierarchyIntervalMsForDevice("device-1", 250)).toBe(250);
    });

    it("pauses hierarchy cadence when no subscriber wants the device (#5472)", () => {
      // No subscription at all: do NOT instruct the runner to poll at 1Hz.
      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(2_147_483_647);
      // A caller-provided fallback is still overridden by the no-subscriber pause.
      expect(server.getHierarchyIntervalMsForDevice("device-1", 250)).toBe(2_147_483_647);
    });

    it("restores fast hierarchy cadence once a subscriber appears (#5472)", () => {
      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(2_147_483_647);

      server.simulateSubscription({ deviceId: "device-1", hierarchyIntervalMs: 500 });

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(500);
    });

    it("pauses only devices with no subscriber, leaving subscribed peers fast (#5472)", () => {
      server.simulateSubscription({ deviceId: "device-1", hierarchyIntervalMs: 500 });

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(500);
      expect(server.getHierarchyIntervalMsForDevice("device-2")).toBe(2_147_483_647);
    });

    it("parses requested hierarchy cadence from subscribe commands", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-fast-hierarchy",
          command: "subscribe",
          deviceId: "device-1",
          hierarchyIntervalMs: 500,
        }),
      );

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(500);
    });

    it("clamps requested hierarchy cadence to the safe minimum", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-clamped-hierarchy",
          command: "subscribe",
          deviceId: "device-1",
          hierarchyIntervalMs: 50,
        }),
      );

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(250);
    });

    it("clamps requested hierarchy cadence to the maximum timer delay", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-hierarchy-max-clamped",
          command: "subscribe",
          deviceId: "device-1",
          hierarchyIntervalMs: 3_000_000_000,
        }),
      );

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(2_147_483_647);
    });

    it("uses the fastest active requested hierarchy cadence for a device", () => {
      server.simulateSubscription({ deviceId: "device-1", hierarchyIntervalMs: 1000 });
      server.simulateSubscription({ deviceId: "device-1", hierarchyIntervalMs: 500 });
      server.simulateSubscription({ deviceId: "device-2", hierarchyIntervalMs: 250 });

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(500);
    });

    it("applies all-device subscriber hierarchy cadence to each device", () => {
      server.simulateSubscription({ hierarchyIntervalMs: 750 });

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(750);
      expect(server.getHierarchyIntervalMsForDevice("device-2")).toBe(750);
    });

    it("uses the slowest explicit hierarchy cadence when omitted subscribers do not request one", () => {
      server.simulateSubscription({ deviceId: "device-1" });
      server.simulateSubscription({ deviceId: "device-1", hierarchyIntervalMs: 10_000 });

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(10_000);
    });

    it("ignores subscribers that omit hierarchy cadence when another subscriber requests one", () => {
      server.simulateSubscription({ deviceId: "device-1" });
      server.simulateSubscription({ deviceId: "device-1", hierarchyIntervalMs: 500 });

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(500);
    });

    it("pauses hierarchy cadence after unsubscribe leaves no subscriber", async () => {
      const { socket } = server.simulateSubscription({
        deviceId: "device-1",
        hierarchyIntervalMs: 500,
      });

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "unsub-fast-hierarchy",
          command: "unsubscribe",
          subscriptionId: "devicedatastream-1",
        }),
      );

      // No subscriber remains: pause runner polling rather than fall back to 1Hz (#5472).
      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(2_147_483_647);
    });

    it("ignores destroyed subscriber sockets when aggregating hierarchy cadence", () => {
      const { socket } = server.simulateSubscription({
        deviceId: "device-1",
        hierarchyIntervalMs: 500,
      });
      socket.destroy();

      // A destroyed socket is not an active subscriber, so cadence is paused (#5472).
      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(2_147_483_647);
    });

    it("notifies when subscribe changes hierarchy cadence", async () => {
      const changedDevices: Array<string | null> = [];
      server.setOnHierarchyCadenceChanged((deviceId: string | null) => {
        changedDevices.push(deviceId);
      });
      server.sessionResolver.bind("device-1", "session-device-1");
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub-fast-hierarchy",
          command: "subscribe",
          deviceSessionUuid: "session-device-1",
          hierarchyIntervalMs: 500,
        }),
      );

      // Cadence notifications carry the resolved serial, not the uuid.
      expect(changedDevices).toEqual(["device-1"]);
    });

    it("notifies when unsubscribe removes hierarchy cadence", async () => {
      const changedDevices: Array<string | null> = [];
      server.setOnHierarchyCadenceChanged((deviceId: string | null) => {
        changedDevices.push(deviceId);
      });
      const { socket } = server.simulateSubscription({
        deviceId: "device-1",
        hierarchyIntervalMs: 500,
      });

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "unsub-hierarchy-fast",
          command: "unsubscribe",
          subscriptionId: "devicedatastream-1",
        }),
      );

      expect(changedDevices).toEqual(["device-1"]);
    });

    it("notifies when connection close removes hierarchy cadence", () => {
      const changedDevices: Array<string | null> = [];
      server.setOnHierarchyCadenceChanged((deviceId: string | null) => {
        changedDevices.push(deviceId);
      });
      const { socket } = server.simulateSubscription({
        deviceId: "device-1",
        hierarchyIntervalMs: 500,
      });

      server.closeConnectionForTest(socket);

      expect(changedDevices).toEqual(["device-1"]);
    });
  });

  describe("update_cadence", () => {
    it("raises the screenshot cadence for an existing subscription in place", async () => {
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub",
          command: "subscribe",
          deviceId: "device-1",
        }),
      );
      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(3000);

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "upd",
          command: "update_cadence",
          subscriptionId: "devicedatastream-1",
          deviceId: "device-1",
          screenshotIntervalMs: 500,
        }),
      );

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(500);
    });

    it("does not add a second subscriber when updating cadence", async () => {
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub",
          command: "subscribe",
          deviceId: "device-1",
        }),
      );

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "upd",
          command: "update_cadence",
          subscriptionId: "devicedatastream-1",
          deviceId: "device-1",
          screenshotIntervalMs: 500,
        }),
      );

      expect((server as any).subscribers.size).toBe(1);
    });

    it("relaxes cadence back to the default when the field is omitted", async () => {
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub",
          command: "subscribe",
          deviceId: "device-1",
          screenshotIntervalMs: 500,
        }),
      );
      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(500);

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "upd",
          command: "update_cadence",
          subscriptionId: "devicedatastream-1",
          deviceId: "device-1",
        }),
      );

      expect(server.getScreenshotIntervalMsForDevice("device-1")).toBe(3000);
    });

    it("clamps the updated hierarchy cadence and notifies both cadence listeners", async () => {
      const changedScreenshot: Array<string | null> = [];
      const changedHierarchy: Array<string | null> = [];
      server.setOnScreenshotCadenceChanged((deviceId) => changedScreenshot.push(deviceId));
      server.setOnHierarchyCadenceChanged((deviceId) => changedHierarchy.push(deviceId));
      server.sessionResolver.bind("device-1", "session-device-1");
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub",
          command: "subscribe",
          deviceSessionUuid: "session-device-1",
        }),
      );
      changedScreenshot.length = 0;
      changedHierarchy.length = 0;

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "upd",
          command: "update_cadence",
          subscriptionId: "devicedatastream-1",
          hierarchyIntervalMs: 50,
        }),
      );

      expect(server.getHierarchyIntervalMsForDevice("device-1")).toBe(250);
      // Cadence notifications carry the resolved serial, not the uuid.
      expect(changedScreenshot).toEqual(["device-1"]);
      expect(changedHierarchy).toEqual(["device-1"]);
    });

    it("acknowledges update_cadence with a subscription_response", async () => {
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "sub",
          command: "subscribe",
          deviceId: "device-1",
        }),
      );

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "upd-ack",
          command: "update_cadence",
          subscriptionId: "devicedatastream-1",
          deviceId: "device-1",
          screenshotIntervalMs: 500,
        }),
      );

      const ack = socket
        .getWrittenMessages<{ id?: string; type: string; success?: boolean }>()
        .find((message) => message.id === "upd-ack");
      expect(ack?.type).toBe("subscription_response");
      expect(ack?.success).toBe(true);
    });

    it("acknowledges update_cadence even when the socket has no active subscription", async () => {
      const socket = new FakeSocket();

      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "upd-no-sub",
          command: "update_cadence",
          subscriptionId: "devicedatastream-missing",
          deviceId: "device-1",
          screenshotIntervalMs: 500,
        }),
      );

      const ack = socket
        .getWrittenMessages<{ id?: string; type: string; success?: boolean }>()
        .find((message) => message.id === "upd-no-sub");
      expect(ack?.type).toBe("subscription_response");
      expect(ack?.success).toBe(true);
      expect((server as any).subscribers.size).toBe(0);
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
        deviceSessionUuid?: string | null;
        timestamp?: number;
        error?: string;
      }>();
      expect(msgs).toEqual([
        {
          type: "error",
          success: false,
          subscriptionId: "devicedatastream-1",
          deviceId: "emulator-5554",
          // Resolved from the serial by the harness's auto-bound resolver (epic #5256).
          deviceSessionUuid: "session-emulator-5554",
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

  describe("canonical-pixel conversion at the wire (issue #4549)", () => {
    // A hierarchy carrying the #4548 runner scale metadata: iOS points + nativeScale + reported
    // physical pixel dims. Element bounds live under $.bounds as {left,top,right,bottom}.
    const iosFrame = () =>
      ({
        hierarchy: {
          bounds: { left: 0, top: 0, right: 390, bottom: 844 },
          node: {
            $: { class: "UIWindow", bounds: { left: 0, top: 0, right: 390, bottom: 844 } },
            node: [
              {
                $: {
                  class: "UIButton",
                  text: "Go",
                  bounds: { left: 10, top: 20, right: 100, bottom: 60 },
                },
              },
            ],
          },
        },
        screenWidth: 390,
        screenHeight: 844,
        screenScale: 3,
        nativeScale: 3,
        pixelWidth: 1170,
        pixelHeight: 2532,
      }) as any;

    it("publishes iOS element bounds and screen dims in pixels and stamps coordinateSpace:px", () => {
      const { socket } = server.simulateSubscription({ deviceId: "ios-1" });
      server.pushHierarchyUpdate("ios-1", iosFrame());

      const [message] = socket.getWrittenMessages<any>();
      expect(message.type).toBe("hierarchy_update");
      expect(message.coordinateSpace).toBe("px");
      expect(message.nativeScale).toBe(3);
      expect(message.data.screenWidth).toBe(1170);
      expect(message.data.screenHeight).toBe(2532);
      expect(message.data.hierarchy.node.$.bounds).toEqual({
        left: 0,
        top: 0,
        right: 1170,
        bottom: 2532,
      });
      expect(message.data.hierarchy.node.node[0].$.bounds).toEqual({
        left: 30,
        top: 60,
        right: 300,
        bottom: 180,
      });
      expect(message.data.hierarchy.bounds).toEqual({ left: 0, top: 0, right: 1170, bottom: 2532 });
    });

    it("does not mutate the caller's hierarchy (MCP observe keeps point-space bounds)", () => {
      server.simulateSubscription({ deviceId: "ios-1" });
      const input = iosFrame();
      server.pushHierarchyUpdate("ios-1", input);
      // The push converts a clone; the object the caller (and MCP observe) holds is untouched.
      expect(input.data ?? input.hierarchy.node.$.bounds).toEqual({
        left: 0,
        top: 0,
        right: 390,
        bottom: 844,
      });
      expect(input.screenWidth).toBe(390);
    });

    it("LEGACY: a hierarchy without runner metadata is byte-identical (points, no px stamp)", () => {
      const { socket } = server.simulateSubscription({ deviceId: "ios-legacy" });
      const legacy = iosFrame();
      delete legacy.nativeScale;
      delete legacy.pixelWidth;
      delete legacy.pixelHeight;
      server.pushHierarchyUpdate("ios-legacy", legacy);

      const [message] = socket.getWrittenMessages<any>();
      expect(message.coordinateSpace).toBeUndefined();
      expect(message.nativeScale).toBeUndefined();
      // Point-space bounds and dims pass through unchanged.
      expect(message.data.screenWidth).toBe(390);
      expect(message.data.hierarchy.node.node[0].$.bounds).toEqual({
        left: 10,
        top: 20,
        right: 100,
        bottom: 60,
      });
    });

    it("Android (nativeScale 1) leaves bounds numerically identical but still declares px", () => {
      const { socket } = server.simulateSubscription({ deviceId: "android-1" });
      const androidFrame = {
        hierarchy: {
          node: {
            $: { class: "FrameLayout", bounds: { left: 0, top: 0, right: 1080, bottom: 2340 } },
          },
        },
        screenWidth: 1080,
        screenHeight: 2340,
        nativeScale: 1,
        pixelWidth: 1080,
        pixelHeight: 2340,
      } as any;
      server.pushHierarchyUpdate("android-1", androidFrame);

      const [message] = socket.getWrittenMessages<any>();
      expect(message.coordinateSpace).toBe("px");
      expect(message.data.hierarchy.node.$.bounds).toEqual({
        left: 0,
        top: 0,
        right: 1080,
        bottom: 2340,
      });
    });

    it("stamps coordinateSpace:px on a screenshot when the caller declares px", () => {
      const { socket } = server.simulateSubscription({ deviceId: "ios-1" });
      const seq = server.pushHierarchyUpdate("ios-1", iosFrame());
      server.pushScreenshotUpdate(
        "ios-1",
        pngFrame(1170, 2532),
        1170,
        2532,
        {},
        {
          captureSequence: seq ?? undefined,
          coordinateSpace: "px",
          nativeScale: 3,
        },
      );
      const shot = socket.getWrittenMessages<any>().find((m) => m.type === "screenshot_update");
      expect(shot.coordinateSpace).toBe("px");
      expect(shot.nativeScale).toBe(3);
      expect(shot.captureSequence).toBe(seq);
    });

    it("omits coordinateSpace on a screenshot from a legacy (non-px) caller", () => {
      const { socket } = server.simulateSubscription({ deviceId: "ios-legacy" });
      server.pushScreenshotUpdate("ios-legacy", pngFrame(1170, 2532), 1170, 2532, {}, {});
      const shot = socket.getWrittenMessages<any>().find((m) => m.type === "screenshot_update");
      expect(shot.coordinateSpace).toBeUndefined();
      expect(shot.nativeScale).toBeUndefined();
    });
  });

  describe("coordinate-mapping golden vectors: geometry pairing (issue #4547)", () => {
    // Cross-language golden suite, B0 of the canonical-pixel campaign (#4547 -> #4549). Each
    // vector drives the daemon's REAL header-measurement pairing (pixelsMatchClaimedGeometry via
    // pushScreenshotUpdate): the capture identity is echoed on the screenshot exactly when the
    // frame's measured pixels are consistent with the claimed geometry (exact match or swapped
    // orientation — never a scale change, never an unmeasurable frame).
    const goldenFrame = (text: string) =>
      ({
        hierarchy: { node: { $: { class: "Root" }, node: [{ $: { class: "Child", text } }] } },
      }) as any;

    const vectors = loadCoordinateMappingVectors().geometryPairing;

    for (const [index, vector] of vectors.entries()) {
      it(`row ${index}: measured ${vector.measuredWidth}x${vector.measuredHeight} vs claimed ${vector.claimedWidth}x${vector.claimedHeight} -> ${vector.expectedMatch === 1 ? "paired" : "not paired"}`, () => {
        const { socket } = server.simulateSubscription({ deviceId: "device-golden" });

        const captureSequence = server.pushHierarchyUpdate("device-golden", goldenFrame("a"));
        // measuredWidth/Height of -1 encodes an unmeasurable frame (not a decodable PNG header).
        const screenshotBase64 =
          vector.measuredWidth < 0
            ? Buffer.from("not-an-image").toString("base64")
            : pngFrame(vector.measuredWidth, vector.measuredHeight);
        server.pushScreenshotUpdate(
          "device-golden",
          screenshotBase64,
          vector.claimedWidth,
          vector.claimedHeight,
          {},
          { captureSequence: captureSequence ?? undefined },
        );

        const screenshot = socket
          .getWrittenMessages<any>()
          .find((m) => m.type === "screenshot_update");
        if (vector.expectedMatch === 1) {
          expect(screenshot.captureSequence).toBe(captureSequence);
        } else {
          expect(screenshot.captureSequence).toBeUndefined();
        }
      });
    }
  });

  describe("deviceSessionUuid routing (#5259)", () => {
    interface Frame {
      type: string;
      deviceId?: string;
      deviceSessionUuid?: string | null;
      platform?: string;
      navigationGraph?: NavigationGraphStreamData;
    }
    const frames = (socket: FakeSocket) => socket.getWrittenMessages<Frame>();
    const hierarchy = { hierarchy: { node: { $: {}, node: [] } } } as any;

    it("stamps deviceId and the resolved deviceSessionUuid on every device frame (AC1)", () => {
      const { socket } = server.simulateSubscription({ deviceId: "emulator-5554" });

      server.pushHierarchyUpdate("emulator-5554", hierarchy);
      server.pushScreenshotUpdate("emulator-5554", "png", 100, 200);
      server.pushPerformanceUpdate("emulator-5554", { fps: 60 } as any);
      server.pushStorageUpdate("emulator-5554", { key: "k" } as any);

      const got = frames(socket).filter((f) => f.type.endsWith("_update"));
      expect(got.length).toBe(4);
      for (const f of got) {
        expect(f.deviceId).toBe("emulator-5554");
        expect(f.deviceSessionUuid).toBe("session-emulator-5554");
      }
    });

    it("isolates two devices by deviceSessionUuid across the observation stream (AC2)", () => {
      const a = server.simulateSubscription({ deviceId: "device-a" });
      const b = server.simulateSubscription({ deviceId: "device-b" });

      server.pushHierarchyUpdate("device-a", hierarchy);
      server.pushHierarchyUpdate("device-b", hierarchy);

      expect(
        frames(a.socket)
          .filter((f) => f.type === "hierarchy_update")
          .map((f) => f.deviceSessionUuid),
      ).toEqual(["session-device-a"]);
      expect(
        frames(b.socket)
          .filter((f) => f.type === "hierarchy_update")
          .map((f) => f.deviceSessionUuid),
      ).toEqual(["session-device-b"]);
    });

    it("yields zero events and stops capture for a stale/retired deviceSessionUuid subscriber (AC4)", () => {
      const { socket } = server.simulateSubscription({
        deviceId: "device-a",
        screenshotIntervalMs: 250,
        hierarchyIntervalMs: 250,
      });
      expect(server.hasSubscriberForDevice("device-a")).toBe(true);
      expect(server.getScreenshotIntervalMsForDevice("device-a")).toBe(250);
      expect(server.getHierarchyIntervalMsForDevice("device-a")).toBe(250);

      // device-a reconnects under a new epoch: the serial now resolves to a new uuid.
      server.sessionResolver.retire("device-a").bind("device-a", "session-device-a-2");

      server.pushHierarchyUpdate("device-a", hierarchy);

      expect(frames(socket).filter((f) => f.type === "hierarchy_update")).toHaveLength(0);
      expect(server.hasSubscriberForDevice("device-a")).toBe(false);
      expect(server.getScreenshotIntervalMsForDevice("device-a")).toBe(3000);
      // Retired subscriber: hierarchy cadence pauses instead of the 1Hz default (#5472).
      expect(server.getHierarchyIntervalMsForDevice("device-a")).toBe(2_147_483_647);
    });

    it("retires the previous uuid when a fake resolver rebinds a device", () => {
      server.sessionResolver.bind("device-a", "session-device-a");
      server.sessionResolver.bind("device-a", "session-device-a-2");

      expect(server.sessionResolver.resolveUuid("device-a")).toBe("session-device-a-2");
      expect(server.sessionResolver.resolveDeviceId("session-device-a")).toBeNull();
      expect(server.sessionResolver.resolveDeviceId("session-device-a-2")).toBe("device-a");
    });

    describe("navigation targeting (AC3, closes #4837)", () => {
      it("targets the device that owns the graph; other panes see nothing", () => {
        const a = server.simulateSubscription({ deviceId: "device-a" });
        const b = server.simulateSubscription({ deviceId: "device-b" });

        server.pushNavigationGraphUpdate(
          { appId: "com.x", nodes: [], edges: [], currentScreen: null },
          "device-a",
        );

        expect(
          frames(a.socket)
            .filter((f) => f.type === "navigation_update")
            .map((f) => f.deviceSessionUuid),
        ).toEqual(["session-device-a"]);
        expect(frames(b.socket).filter((f) => f.type === "navigation_update")).toHaveLength(0);
      });

      it("reaches only all-device subscribers when provenance is unknown (deviceId null)", () => {
        const scoped = server.simulateSubscription({ deviceId: "device-a" });
        const all = server.simulateSubscription({});

        server.pushNavigationGraphUpdate(
          { appId: null, nodes: [], edges: [], currentScreen: null },
          null,
        );

        expect(frames(scoped.socket).filter((f) => f.type === "navigation_update")).toHaveLength(0);
        const allNav = frames(all.socket).filter((f) => f.type === "navigation_update");
        expect(allNav).toHaveLength(1);
        expect(allNav[0].deviceSessionUuid).toBeNull();
      });

      it("echoes the requester's deviceSessionUuid on an on-demand request response", async () => {
        server.sessionResolver.bind("device-a", "session-device-a");
        server.setOnNavigationGraphRequested(async () => ({
          appId: "com.x",
          nodes: [],
          edges: [],
          currentScreen: null,
        }));
        const socket = new FakeSocket();

        await server.processLineForTest(
          socket,
          JSON.stringify({
            id: "r1",
            command: "request_navigation_graph",
            deviceSessionUuid: "session-device-a",
            appId: "com.x",
          }),
        );

        const nav = frames(socket).filter((f) => f.type === "navigation_update");
        expect(nav).toHaveLength(1);
        expect(nav[0].deviceSessionUuid).toBe("session-device-a");
        expect(nav[0].deviceId).toBe("device-a");
      });
    });

    describe("session lifecycle frames (AC5)", () => {
      const record = (
        over: Partial<{ deviceSessionUuid: string; deviceId: string; platform: string }> = {},
      ) => ({
        deviceSessionUuid: "session-device-a",
        deviceId: "device-a",
        platform: "android" as const,
        epochStartedAt: 0,
        ...over,
      });

      it("pushes device_session_started to a matching-uuid and an all-device subscriber", () => {
        server.sessionResolver.bind("device-a", "session-device-a");
        const scoped = server.simulateSubscription({
          deviceId: "device-a",
          deviceSessionUuid: "session-device-a",
        });
        const all = server.simulateSubscription({});
        const other = server.simulateSubscription({ deviceSessionUuid: "session-other" });

        server.pushDeviceSessionStarted(record());

        for (const s of [scoped, all]) {
          const f = frames(s.socket).filter((x) => x.type === "device_session_started");
          expect(f).toHaveLength(1);
          expect(f[0]).toMatchObject({
            deviceSessionUuid: "session-device-a",
            deviceId: "device-a",
            platform: "android",
          });
        }
        expect(
          frames(other.socket).filter((x) => x.type === "device_session_started"),
        ).toHaveLength(0);
      });

      it("pushes device_session_ended with the retired identity", () => {
        server.sessionResolver.bind("device-a", "session-device-a");
        const { socket } = server.simulateSubscription({
          deviceId: "device-a",
          deviceSessionUuid: "session-device-a",
        });
        server.sessionResolver.retire("device-a");
        server.pushDeviceSessionEnded(record());

        const f = frames(socket).filter((x) => x.type === "device_session_ended");
        expect(f).toHaveLength(1);
        expect(f[0]).toMatchObject({
          deviceSessionUuid: "session-device-a",
          deviceId: "device-a",
          platform: "android",
        });
      });
    });
  });

  describe("subscribe_storage / unsubscribe_storage", () => {
    interface StorageSubReq {
      deviceId: string | null;
      packageName: string;
      fileName: string;
      subscribe: boolean;
    }

    it("starts subscriber setup before a concurrently received storage subscription", async () => {
      const callOrder: string[] = [];
      server.setOnSubscriberConnected(() => {
        callOrder.push("subscriber");
      });
      server.setOnStorageSubscriptionRequested(async () => {
        callOrder.push("storage");
      });

      const socket = new FakeSocket();
      await Promise.all([
        server.processLineForTest(
          socket,
          JSON.stringify({
            id: "stream-subscribe",
            command: "subscribe",
            deviceId: "emulator-5554",
          }),
        ),
        server.processLineForTest(
          socket,
          JSON.stringify({
            id: "storage-subscribe",
            command: "subscribe_storage",
            deviceId: "emulator-5554",
            packageName: "com.example.app",
            fileName: "prefs.xml",
          }),
        ),
      ]);

      expect(callOrder).toEqual(["subscriber", "storage"]);
    });

    it("invokes the callback with the raw deviceId and acknowledges a subscribe", async () => {
      const calls: StorageSubReq[] = [];
      server.setOnStorageSubscriptionRequested(async (req) => {
        calls.push(req);
      });

      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-1",
          command: "subscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );

      expect(calls).toEqual([
        {
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
          subscribe: true,
        },
      ]);
      const msgs = socket.getWrittenMessages<{ id?: string; type: string; success?: boolean }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("subscription_response");
      expect(msgs[0].id).toBe("s-1");
      expect(msgs[0].success).toBe(true);
    });

    it("passes subscribe:false for an unsubscribe", async () => {
      const calls: StorageSubReq[] = [];
      server.setOnStorageSubscriptionRequested(async (req) => {
        calls.push(req);
      });

      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-2-subscribe",
          command: "subscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );
      calls.length = 0;
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-2",
          command: "unsubscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );

      expect(calls[0].subscribe).toBe(false);
      expect(socket.getWrittenMessages<{ type: string }>()[0].type).toBe("subscription_response");
    });

    it("waits to acknowledge storage subscription until the device registration completes", async () => {
      let completeRegistration: (() => void) | undefined;
      server.setOnStorageSubscriptionRequested(
        () =>
          new Promise<void>((resolve) => {
            completeRegistration = resolve;
          }),
      );
      const socket = new FakeSocket();

      const request = server.processLineForTest(
        socket,
        JSON.stringify({
          id: "storage-await",
          command: "subscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(socket.getWrittenMessages()).toEqual([]);
      expect(completeRegistration).toBeDefined();
      completeRegistration!();
      await request;
      expect(socket.getWrittenMessages<{ id?: string; success?: boolean }>()).toEqual([
        expect.objectContaining({ id: "storage-await", success: true }),
      ]);
    });

    it("serializes lifecycle commands for one storage file", async () => {
      const calls: StorageSubReq[] = [];
      let releaseSubscribe: (() => void) | undefined;
      server.setOnStorageSubscriptionRequested(
        (request) =>
          new Promise<void>((resolve) => {
            calls.push(request);
            if (request.subscribe) {
              releaseSubscribe = resolve;
            } else {
              resolve();
            }
          }),
      );
      const socket = new FakeSocket();

      const subscribe = server.processLineForTest(
        socket,
        JSON.stringify({
          id: "storage-subscribe",
          command: "subscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );
      await Promise.resolve();
      const unsubscribe = server.processLineForTest(
        socket,
        JSON.stringify({
          id: "storage-unsubscribe",
          command: "unsubscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );
      await Promise.resolve();

      expect(calls).toEqual([expect.objectContaining({ fileName: "prefs.xml", subscribe: true })]);
      releaseSubscribe?.();
      await Promise.all([subscribe, unsubscribe]);
      expect(calls).toEqual([
        expect.objectContaining({ fileName: "prefs.xml", subscribe: true }),
        expect.objectContaining({ fileName: "prefs.xml", subscribe: false }),
      ]);
    });

    it("resolves a deviceSessionUuid to its serial before invoking the callback", async () => {
      server.sessionResolver.bind("emulator-5556", "session-emulator-5556");
      const calls: StorageSubReq[] = [];
      server.setOnStorageSubscriptionRequested(async (req) => {
        calls.push(req);
      });

      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-3",
          command: "subscribe_storage",
          deviceSessionUuid: "session-emulator-5556",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );

      expect(calls[0].deviceId).toBe("emulator-5556");
    });

    it("rejects a supplied-but-unresolved deviceSessionUuid without invoking the callback", async () => {
      // A stale/unknown UUID must NOT fall through to a null (all-device) target: daemon.ts treats
      // null as every device, so the observer would otherwise be registered/released on every
      // Android device and still ack success (#4709 review).
      let invoked = false;
      server.setOnStorageSubscriptionRequested(async () => {
        invoked = true;
      });

      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-unresolved",
          command: "subscribe_storage",
          deviceSessionUuid: "session-unknown",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );

      expect(invoked).toBe(false);
      const msgs = socket.getWrittenMessages<{ type: string; success?: boolean; error?: string }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].success).toBe(false);
      expect(msgs[0].error).toBe(
        "deviceSessionUuid 'session-unknown' does not identify a live device session",
      );
    });

    it("rejects an unresolved deviceSessionUuid on unsubscribe too", async () => {
      let invoked = false;
      server.setOnStorageSubscriptionRequested(async () => {
        invoked = true;
      });

      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-unresolved-unsub",
          command: "unsubscribe_storage",
          deviceSessionUuid: "session-unknown",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );

      expect(invoked).toBe(false);
      expect(socket.getWrittenMessages<{ type: string }>()[0].type).toBe("error");
    });

    it("rejects a malformed (non-string) deviceSessionUuid without invoking the callback", async () => {
      let invoked = false;
      server.setOnStorageSubscriptionRequested(async () => {
        invoked = true;
      });

      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-malformed",
          command: "subscribe_storage",
          deviceSessionUuid: 42,
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );

      expect(invoked).toBe(false);
      const msgs = socket.getWrittenMessages<{ type: string; error?: string }>();
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].error).toBe("deviceSessionUuid must be a string or null");
    });

    it("rejects a request missing packageName or fileName without invoking the callback", async () => {
      let invoked = false;
      server.setOnStorageSubscriptionRequested(async () => {
        invoked = true;
      });

      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-4",
          command: "subscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
        }),
      );

      expect(invoked).toBe(false);
      const msgs = socket.getWrittenMessages<{ type: string; success?: boolean; error?: string }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("error");
      expect(msgs[0].success).toBe(false);
    });

    it("acknowledges success even when no callback is configured (fire-and-forget)", async () => {
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "s-5",
          command: "subscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );

      const msgs = socket.getWrittenMessages<{ type: string; success?: boolean }>();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("subscription_response");
      expect(msgs[0].success).toBe(true);
    });

    it("keeps a shared observer until its final desktop owner unsubscribes", async () => {
      const calls: StorageSubReq[] = [];
      server.setOnStorageSubscriptionRequested(async (request) => {
        calls.push(request);
      });
      const first = new FakeSocket();
      const second = new FakeSocket();
      const subscribe = (socket: FakeSocket, id: string) =>
        server.processLineForTest(
          socket,
          JSON.stringify({
            id,
            command: "subscribe_storage",
            deviceId: "emulator-5554",
            packageName: "com.example.app",
            fileName: "prefs.xml",
          }),
        );
      const unsubscribe = (socket: FakeSocket, id: string) =>
        server.processLineForTest(
          socket,
          JSON.stringify({
            id,
            command: "unsubscribe_storage",
            deviceId: "emulator-5554",
            packageName: "com.example.app",
            fileName: "prefs.xml",
          }),
        );

      await subscribe(first, "subscribe-first");
      await subscribe(second, "subscribe-second");
      await unsubscribe(first, "unsubscribe-first");
      expect(calls).toEqual([expect.objectContaining({ subscribe: true, fileName: "prefs.xml" })]);

      await unsubscribe(second, "unsubscribe-second");
      expect(calls).toEqual([
        expect.objectContaining({ subscribe: true, fileName: "prefs.xml" }),
        expect.objectContaining({ subscribe: false, fileName: "prefs.xml" }),
      ]);
    });

    it("retries a shared observer after concurrent registration failures", async () => {
      const calls: StorageSubReq[] = [];
      server.setOnStorageSubscriptionRequested(async (request) => {
        calls.push(request);
        throw new Error("runner unavailable");
      });
      const subscribe = (socket: FakeSocket, id: string) =>
        server.processLineForTest(
          socket,
          JSON.stringify({
            id,
            command: "subscribe_storage",
            deviceId: "emulator-5554",
            packageName: "com.example.app",
            fileName: "prefs.xml",
          }),
        );

      const first = new FakeSocket();
      const firstRequest = subscribe(first, "subscribe-first");
      await Promise.resolve();
      const second = new FakeSocket();
      await Promise.all([firstRequest, subscribe(second, "subscribe-second")]);

      expect(calls).toHaveLength(1);
      for (const socket of [first, second]) {
        expect(socket.getWrittenMessages<{ type: string; success?: boolean }>()[0]).toMatchObject({
          type: "error",
          success: false,
        });
      }

      server.setOnStorageSubscriptionRequested(async (request) => {
        calls.push(request);
      });
      const retry = new FakeSocket();
      await subscribe(retry, "subscribe-retry");

      expect(calls).toHaveLength(2);
      expect(retry.getWrittenMessages<{ type: string; success?: boolean }>()[0]).toMatchObject({
        type: "subscription_response",
        success: true,
      });
    });

    it("replays active observers when the Android CtrlProxy reconnects", async () => {
      const calls: StorageSubReq[] = [];
      server.setOnStorageSubscriptionRequested(async (request) => {
        calls.push(request);
      });
      const socket = new FakeSocket();
      await server.processLineForTest(
        socket,
        JSON.stringify({
          id: "subscribe",
          command: "subscribe_storage",
          deviceId: "emulator-5554",
          packageName: "com.example.app",
          fileName: "prefs.xml",
        }),
      );

      await server.reapplyStorageSubscriptionsForDevice("emulator-5554");

      expect(calls).toEqual([
        expect.objectContaining({ subscribe: true, fileName: "prefs.xml" }),
        expect.objectContaining({ subscribe: true, fileName: "prefs.xml" }),
      ]);
    });
  });
});
