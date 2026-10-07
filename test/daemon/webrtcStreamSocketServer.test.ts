import { createDeviceCaptureRegistry } from "../../src/features/webrtc/deviceCaptureRegistry";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { WEBRTC_ENV } from "../../src/features/webrtc/webrtcStreamingConfig";
import {
  SessionScopedStreamAuthenticator,
  type StreamAuthSessionManager,
  type StreamSocketAuthenticator,
} from "../../src/daemon/streamSocketAuth";
import { Socket } from "node:net";
import {
  resolveWebRtcStreamDevice,
  WebRtcStreamSocketServer,
  type WebRtcStreamSocketServerDependencies,
} from "../../src/daemon/webrtcStreamSocketServer";
import {
  getWebRtcStreamDescriptor,
  listWebRtcStreams,
  resetWebRtcStreamManager,
  setWebRtcStreamManagerDependencies,
  startWebRtcStream,
  stopWebRtcStream,
} from "../../src/server/webrtcStreamManager";
import type {
  WebRtcStreamSocketRequest,
  WebRtcStreamSocketResponse,
} from "../../src/daemon/webrtcStreamSocketTypes";
import type { BootedDevice } from "../../src/models";
import { ActionableError } from "../../src/models";
import {
  permissiveDeviceAdmissionGate,
  type DeviceAdmissionGate,
} from "../../src/daemon/deviceAdmissionGate";
import { WebRtcPublisher, WhipClient } from "../../src/features/webrtc";
import type {
  AndroidH264Source,
  WebRtcStreamDescriptor,
  WebRtcStreamingOverrides,
} from "../../src/features/webrtc";
import type { WhipClientOptions } from "../../src/features/webrtc/WhipClient";
import type { RTCPeerConnection } from "werift";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  createSuccessfulWhipFetch,
  FakeConnectedPeerConnection,
  FakeH264Source,
  type RecordedWhipRequest,
} from "../helpers/webrtcFakes";

const ANDROID: BootedDevice = {
  deviceId: "emulator-5554",
  platform: "android",
  name: "a",
} as BootedDevice;
const IOS: BootedDevice = {
  deviceId: "simulator-1",
  platform: "ios",
  name: "iPhone 16",
} as BootedDevice;

function descriptor(
  streamId: string,
  state: WebRtcStreamDescriptor["state"] = "connected",
): WebRtcStreamDescriptor {
  return {
    streamId,
    state,
    whipEndpoint: "https://coord/whip",
    resourceUrl: `https://coord/whip/r/${streamId}`,
    iceServers: [],
    framesSent: 0,
    packetsSent: 0,
    audioPacketsSent: 0,
    audioSamplesSent: 0,
    readiness: {
      lastEncodedFrameTimestampUs: null,
      lastIdrTimestampUs: null,
      idrRequestCount: null,
      idrCompletionCount: null,
      encodedAccessUnitCount: null,
      publisherRtpPacketCount: null,
      captureSourceState: "not_initialized",
      lastSourceError: null,
    },
  };
}

/** Accepts every request; auth enforcement is exercised in dedicated tests below. */
const allowAllAuthenticator: StreamSocketAuthenticator = { authorize: () => {} };

class TestableServer extends WebRtcStreamSocketServer {
  simulateStarted(): void {
    this.onServerStarted();
  }
  constructor(
    deps: WebRtcStreamSocketServerDependencies,
    authenticator: StreamSocketAuthenticator = allowAllAuthenticator,
    // Explicit rather than defaulted: the real default consults the running
    // daemon's pool, which another suite in this process may have initialized.
    admissionGate: DeviceAdmissionGate = permissiveDeviceAdmissionGate,
  ) {
    super("/fake/webrtc-stream.sock", new FakeTimer(), deps, authenticator, admissionGate);
  }
  async simulate(socket: FakeSocket, request: WebRtcStreamSocketRequest): Promise<void> {
    await (this as any).processLine(socket as unknown as Socket, JSON.stringify(request));
    const pending = (this as any).pendingBySocket.get(socket);
    if (pending) {
      await pending;
    }
  }

  enqueue(socket: FakeSocket, request: WebRtcStreamSocketRequest): Promise<void> {
    return this.processLine(socket, JSON.stringify(request));
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

let started: Array<{
  device: BootedDevice;
  streamId?: string;
  overrides?: WebRtcStreamingOverrides;
  subscriptionKind?: "owner" | "viewer";
}> = [];
let stopped: string[] = [];

function makeDeps(
  overrides: Partial<WebRtcStreamSocketServerDependencies> = {},
): WebRtcStreamSocketServerDependencies {
  const active = new Map<string, WebRtcStreamDescriptor>();
  return {
    resolveDevice: async () => ANDROID,
    startStream: async (request) => {
      const streamId = request.streamId ?? "webrtc_generated";
      started.push({
        device: request.device,
        streamId: request.streamId,
        overrides: request.overrides,
        subscriptionKind: request.subscriptionKind,
      });
      const d = descriptor(streamId);
      active.set(streamId, d);
      return d;
    },
    stopStream: async (streamId) => {
      const id = streamId ?? "webrtc_generated";
      stopped.push(id);
      active.delete(id);
      return descriptor(id, "stopped");
    },
    listStreams: () => Array.from(active.values()),
    getStream: (streamId) => active.get(streamId) ?? null,
    ...overrides,
  };
}

// The `https://coord` origin is the trusted coordination server these tests
// publish to; allow-list it so wire overrides pointing at it pass the #4751
// origin policy. Loopback overrides are always permitted regardless.
let previousAllowedOrigins: string | undefined;
beforeAll(() => {
  previousAllowedOrigins = process.env[WEBRTC_ENV.WHIP_ALLOWED_ORIGINS];
  process.env[WEBRTC_ENV.WHIP_ALLOWED_ORIGINS] = "https://coord";
});
afterAll(() => {
  if (previousAllowedOrigins === undefined) {
    delete process.env[WEBRTC_ENV.WHIP_ALLOWED_ORIGINS];
  } else {
    process.env[WEBRTC_ENV.WHIP_ALLOWED_ORIGINS] = previousAllowedOrigins;
  }
});

afterEach(() => {
  started = [];
  stopped = [];
  resetWebRtcStreamManager();
});

function lastResponse(socket: FakeSocket): WebRtcStreamSocketResponse {
  const messages = socket.getWrittenMessages<WebRtcStreamSocketResponse>();
  return messages[messages.length - 1];
}

describe("WebRtcStreamSocketServer", () => {
  test("ownership hooks stay lazy, reauthorize resolved sessions, and unsubscribe on close", async () => {
    let notify: (deviceId: string) => void = () => {
      throw new Error("not subscribed");
    };
    let unsubscribed = 0;
    let reconciled = 0;
    let stoppedAll = 0;
    const authorized: string[] = [];
    const server = new TestableServer(
      makeDeps({
        ownershipChanges: () => ({
          onDeviceOwnershipChange: (callback) => {
            notify = callback;
            return () => {
              unsubscribed++;
            };
          },
        }),
        reconcileOwnership: async (deviceId, isAuthorized) => {
          reconciled++;
          expect(deviceId).toBe(ANDROID.deviceId);
          expect(isAuthorized("session-owner")).toEqual({
            authEnabled: true,
            sessionExists: true,
            ownsDevice: true,
          });
          expect(isAuthorized("session-released")).toEqual({
            authEnabled: true,
            sessionExists: false,
            ownsDevice: false,
          });
        },
        stopAllStreams: async () => {
          stoppedAll++;
        },
      }),
      {
        authorize: ({ sessionUuid, requireOwnership }) => {
          if (!requireOwnership) {
            return;
          }
          authorized.push(sessionUuid ?? "missing");
          if (sessionUuid !== "session-owner") {
            throw new ActionableError("ownership lost");
          }
        },
      },
    );
    server.simulateStarted();
    notify(ANDROID.deviceId);
    expect(reconciled).toBe(0);
    await server.simulate(new FakeSocket(), { action: "list", id: "load" });
    expect(() => notify(ANDROID.deviceId)).not.toThrow();
    await flushMicrotasks();
    expect(reconciled).toBe(1);
    expect(authorized).toEqual(["session-owner", "session-released"]);
    await server.close();
    await server.close();
    expect(unsubscribed).toBe(1);
    expect(stoppedAll).toBe(1);
    notify(ANDROID.deviceId);
    expect(reconciled).toBe(1);
  });

  test("close does not load unused dependencies and bounds failing cleanup", async () => {
    let unusedCleanupCalls = 0;
    const unused = new TestableServer(
      makeDeps({
        stopAllStreams: async () => {
          unusedCleanupCalls++;
        },
      }),
    );
    await unused.close();
    expect(unusedCleanupCalls).toBe(0);
    const timer = new FakeTimer();
    // A list request loads the injected manager seam without binding a socket.
    class RequestHarness extends WebRtcStreamSocketServer {
      load(): Promise<WebRtcStreamSocketResponse> {
        return this.handleRequest({ action: "list" });
      }
    }
    const harness = new RequestHarness(
      "/fake/webrtc-stream.sock",
      timer,
      makeDeps({ stopAllStreams: () => new Promise<void>(() => {}) }),
      allowAllAuthenticator,
      permissiveDeviceAdmissionGate,
    );
    await harness.load();
    const closing = harness.close();
    timer.advanceTime(5000);
    await expect(closing).resolves.toBeUndefined();
  });

  test("shutdown prevents a pending device resolution from starting a new capture", async () => {
    let resolveDevice: (device: BootedDevice) => void = () => {
      throw new Error("not resolving");
    };
    const server = new TestableServer(
      makeDeps({
        resolveDevice: () =>
          new Promise<BootedDevice>((resolve) => {
            resolveDevice = resolve;
          }),
      }),
    );
    const socket = new FakeSocket();
    const request = server.simulate(socket, { action: "start", id: "pending" });
    await flushMicrotasks();
    await server.close();
    resolveDevice(ANDROID);
    await request;
    expect(started).toEqual([]);
    expect(lastResponse(socket).success).toBe(false);
    await server.simulate(socket, { action: "list", id: "closed" });
    expect(lastResponse(socket).success).toBe(false);
  });

  test("an unexpected synchronous reconcile failure stays outside the ownership notifier", async () => {
    let notify: (deviceId: string) => void = () => {};
    const server = new TestableServer(
      makeDeps({
        ownershipChanges: () => ({
          onDeviceOwnershipChange: (callback) => {
            notify = callback;
            return () => {};
          },
        }),
        reconcileOwnership: () => {
          throw new Error("unexpected reconcile failure");
        },
      }),
    );
    server.simulateStarted();
    await server.simulate(new FakeSocket(), { action: "list" });
    expect(() => notify(ANDROID.deviceId)).not.toThrow();
    await flushMicrotasks();
    await server.close();
  });

  test("fails empty default Android discovery without retrying or sleeping", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let calls = 0;
    await expect(
      resolveWebRtcStreamDevice(
        {
          getBootedDevices: async () => {
            calls++;
            return [];
          },
        },
        undefined,
        undefined,
        timer,
      ),
    ).rejects.toThrow("No connected android devices found.");
    expect(calls).toBe(1);
    expect(timer.getSleepCallCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("retries an empty device discovery and reconciles the recovered device", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let calls = 0;
    const device = await resolveWebRtcStreamDevice(
      {
        getBootedDevices: async () => (++calls < 3 ? [] : [IOS]),
      },
      undefined,
      "ios",
      timer,
    );
    expect(device).toBe(IOS);
    expect(calls).toBe(3);
  });

  test("reports an actionable error after bounded empty discovery retries", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    await expect(
      resolveWebRtcStreamDevice(
        {
          getBootedDevices: async () => [],
        },
        undefined,
        "ios",
        timer,
      ),
    ).rejects.toThrow(/No connected ios devices found/);
  });

  test("aborts promptly while waiting between discovery retries", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    const pending = resolveWebRtcStreamDevice(
      { getBootedDevices: async () => [] },
      undefined,
      "ios",
      timer,
      controller.signal,
    );
    while (timer.getPendingTimeoutCount() === 0) {
      await Promise.resolve();
    }
    expect(timer.getPendingTimeouts()).toEqual([250]);
    timer.advanceTime(100);
    controller.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow("stopped");
  });

  test("device resolution scans only the requested platform", async () => {
    const requestedPlatforms: string[] = [];
    const device = await resolveWebRtcStreamDevice(
      {
        getBootedDevices: async (platform) => {
          requestedPlatforms.push(platform);
          return platform === "ios" ? [IOS] : [ANDROID];
        },
      },
      undefined,
      "ios",
    );

    expect(requestedPlatforms).toEqual(["ios"]);
    expect(device).toBe(IOS);
  });

  test("start resolves a device and returns the stream descriptor", async () => {
    const server = new TestableServer(makeDeps());
    const socket = new FakeSocket();

    await server.simulate(socket, { id: "1", action: "start", whipEndpoint: "https://coord/whip" });

    const response = lastResponse(socket);
    expect(response.success).toBe(true);
    expect(response.action).toBe("start");
    expect(response.stream?.streamId).toBe("webrtc_generated");
    expect(started).toHaveLength(1);
    expect(started[0].device.deviceId).toBe("emulator-5554");
  });

  test("start honors an explicit streamId", async () => {
    const server = new TestableServer(makeDeps());
    const socket = new FakeSocket();
    await server.simulate(socket, { id: "2", action: "start", streamId: "ci-42" });
    expect(lastResponse(socket).stream?.streamId).toBe("ci-42");
    expect(started[0].streamId).toBe("ci-42");
  });

  test("stop terminates a stream and reports stopped state", async () => {
    const server = new TestableServer(makeDeps());
    const socket = new FakeSocket();
    await server.simulate(socket, { id: "3", action: "start", streamId: "s1" });
    await server.simulate(socket, { id: "4", action: "stop", streamId: "s1" });
    const response = lastResponse(socket);
    expect(response.action).toBe("stop");
    expect(response.stream?.state).toBe("stopped");
    expect(stopped).toContain("s1");
  });

  test("owner stop falls back to normal stop for injected dependencies without the new seam", async () => {
    const server = new TestableServer(
      makeDeps({
        getControlContext: () => ({
          streamId: "s1",
          deviceId: ANDROID.deviceId,
          holdsLease: false,
          parametersMatch: true,
        }),
      }),
      {
        authorize: () => {},
        resolveSubscriptionIdentity: () => ({
          authEnabled: true,
          sessionExists: true,
          ownsDevice: true,
        }),
      },
    );
    const socket = new FakeSocket();
    await server.simulate(socket, { action: "stop", streamId: "s1", sessionUuid: "session-1" });
    expect(lastResponse(socket)).toMatchObject({ success: true, stream: { state: "stopped" } });
    expect(stopped).toEqual(["s1"]);
  });

  test("answers stop while await is pending and keeps other awaits ordered", async () => {
    let releaseAwait!: (stream: WebRtcStreamDescriptor) => void;
    const gate = new Promise<WebRtcStreamDescriptor>((resolve) => {
      releaseAwait = resolve;
    });
    const calls: string[] = [];
    const deps = makeDeps({
      awaitReadiness: (streamId) => {
        calls.push(`await:${streamId}`);
        return streamId === "first" ? gate : Promise.resolve(descriptor(streamId));
      },
      stopStream: async (streamId) => {
        calls.push(`stop:${streamId}`);
        return descriptor(streamId ?? "first", "stopped");
      },
    });
    const server = new TestableServer(deps);
    const socket = new FakeSocket();

    await server.enqueue(socket, { id: "first", action: "await", streamId: "first" });
    await flushMicrotasks();
    await server.enqueue(socket, { id: "second", action: "await", streamId: "second" });
    await server.enqueue(socket, { id: "stop", action: "stop", streamId: "first" });
    await server.enqueue(socket, { id: "list", action: "list" });
    await flushMicrotasks();

    expect(calls).toEqual(["await:first", "stop:first"]);
    expect(
      socket.getWrittenMessages<WebRtcStreamSocketResponse>().map((response) => response.id),
    ).toEqual(["stop"]);

    releaseAwait(descriptor("first"));
    await flushMicrotasks();
    expect(calls).toEqual(["await:first", "stop:first", "await:second"]);
    expect(
      socket.getWrittenMessages<WebRtcStreamSocketResponse>().map((response) => response.id),
    ).toEqual(["stop", "first", "second", "list"]);
  });

  test("list returns all active streams", async () => {
    const server = new TestableServer(makeDeps());
    const socket = new FakeSocket();
    await server.simulate(socket, { id: "5", action: "start", streamId: "s1" });
    await server.simulate(socket, { id: "6", action: "start", streamId: "s2" });
    await server.simulate(socket, { id: "7", action: "list" });
    const response = lastResponse(socket);
    expect(response.action).toBe("list");
    expect(response.streams?.map((s) => s.streamId).sort()).toEqual(["s1", "s2"]);
  });

  test("start forwards the iOS Simulator fps override into the streaming config", async () => {
    const server = new TestableServer(makeDeps());
    const socket = new FakeSocket();

    await server.simulate(socket, {
      id: "start",
      action: "start",
      streamId: "fps-1",
      iosSimulatorFps: 24,
    });

    expect(started[0].overrides).toEqual({ iosSimulatorFps: 24 });
  });

  test("start forwards an explicit empty ICE server list to disable the default STUN server", async () => {
    const server = new TestableServer(makeDeps());
    const socket = new FakeSocket();

    await server.simulate(socket, {
      id: "start-without-ice",
      action: "start",
      streamId: "no-ice",
      iceServers: [],
    });

    expect(started[0].overrides).toEqual({ iceServers: [] });
  });

  test("start forwards WHIP endpoint and stream stays visible until stop", async () => {
    const server = new TestableServer(makeDeps());
    const socket = new FakeSocket();

    await server.simulate(socket, {
      id: "start",
      action: "start",
      streamId: "debug-1",
      whipEndpoint: "http://localhost:8000/api/v1/webrtc/whip?streamId=debug-1",
      audio: true,
    });
    await server.simulate(socket, { id: "list", action: "list" });
    const listed = lastResponse(socket);
    await server.simulate(socket, { id: "status", action: "status", streamId: "debug-1" });
    const status = lastResponse(socket);
    await server.simulate(socket, { id: "stop", action: "stop", streamId: "debug-1" });
    const stoppedResponse = lastResponse(socket);
    await server.simulate(socket, { id: "after-stop", action: "list" });
    const afterStop = lastResponse(socket);

    expect(started[0].overrides).toEqual({
      whipEndpoint: "http://localhost:8000/api/v1/webrtc/whip?streamId=debug-1",
      audioEnabled: true,
    });
    expect(listed.streams?.map((s) => s.streamId)).toEqual(["debug-1"]);
    expect(status.stream?.streamId).toBe("debug-1");
    expect(stoppedResponse.stream?.state).toBe("stopped");
    expect(stopped).toEqual(["debug-1"]);
    expect(afterStop.streams).toEqual([]);
  });

  test("await returns a typed screenshot fallback when capture degrades", async () => {
    const server = new TestableServer({
      resolveDevice: async () => ANDROID,
      startStream: async () => descriptor("unused"),
      stopStream: async () => descriptor("unused", "stopped"),
      listStreams: () => [],
      getStream: () => null,
      awaitReadiness: async () => ({
        ...descriptor("debug-1"),
        lifecycleState: "degraded",
        failure: {
          code: "capture_runtime_failed",
          message: "adb forward lost",
          at: "2026-07-24T00:00:00.000Z",
        },
        fallback: { mode: "screenshots", reason: "capture_runtime_failed" },
      }),
    });
    const socket = new FakeSocket();

    await server.simulate(socket, {
      id: "await-degraded",
      action: "await",
      streamId: "debug-1",
      readiness: "publishing",
      timeoutMs: 100,
    });

    const response = lastResponse(socket);
    expect(response.success).toBe(false);
    expect(response.failure?.code).toBe("capture_runtime_failed");
    expect(response.stream?.fallback).toEqual({
      mode: "screenshots",
      reason: "capture_runtime_failed",
    });
  });

  test("start returns a typed screenshot fallback when capture preparation fails", async () => {
    const server = new TestableServer(
      makeDeps({
        startStream: async () => ({
          ...descriptor("debug-1"),
          lifecycleState: "degraded",
          failure: {
            code: "capture_start_failed",
            message: "adb forward failed",
            at: "2026-07-24T00:00:00.000Z",
          },
          fallback: { mode: "screenshots", reason: "capture_start_failed" },
        }),
      }),
    );
    const socket = new FakeSocket();

    await server.simulate(socket, { id: "start-degraded", action: "start" });

    const response = lastResponse(socket);
    expect(response.success).toBe(false);
    expect(response.failure?.code).toBe("capture_start_failed");
    expect(response.stream?.fallback).toEqual({
      mode: "screenshots",
      reason: "capture_start_failed",
    });
  });

  test("start reaches the real manager, posts WHIP, and remains visible until stop", async () => {
    const posts: RecordedWhipRequest[] = [];
    const sources: FakeH264Source[] = [];
    setWebRtcStreamManagerDependencies({
      captureRegistry: createDeviceCaptureRegistry(),
      createPublisher: (config, deps) =>
        new WebRtcPublisher(config, {
          ...deps,
          createPeerConnection: () =>
            new FakeConnectedPeerConnection() as unknown as RTCPeerConnection,
          createWhipClient: (options: WhipClientOptions) =>
            new WhipClient({
              ...options,
              // ANDROID negotiates Main (issue #4756); a conformant WHIP server
              // echoes the offered Main profile-level-id.
              fetchImpl: createSuccessfulWhipFetch(posts, "/whip/resource/debug-1", "4d002a"),
            }),
          timer: new FakeTimer(),
        }),
      createSource: () => {
        const source = new FakeH264Source();
        sources.push(source);
        return source as unknown as AndroidH264Source;
      },
      resolveVideoJar: async () => null,
      now: () => new Date("2026-07-14T00:00:00.000Z"),
    });
    const server = new TestableServer({
      resolveDevice: async () => ANDROID,
      startStream: startWebRtcStream,
      stopStream: stopWebRtcStream,
      listStreams: listWebRtcStreams,
      getStream: getWebRtcStreamDescriptor,
    });
    const socket = new FakeSocket();

    await server.simulate(socket, {
      id: "start-real",
      action: "start",
      streamId: "debug-1",
      whipEndpoint: "http://localhost:8000/api/v1/webrtc/whip?streamId=debug-1",
    });
    const start = lastResponse(socket);
    await server.simulate(socket, { id: "list-real", action: "list" });
    const list = lastResponse(socket);
    await server.simulate(socket, { id: "status-real", action: "status", streamId: "debug-1" });
    const status = lastResponse(socket);
    await server.simulate(socket, { id: "stop-real", action: "stop", streamId: "debug-1" });
    const stop = lastResponse(socket);
    await server.simulate(socket, { id: "after-stop-real", action: "list" });
    const afterStop = lastResponse(socket);

    expect(start.success).toBe(true);
    expect(posts.filter((request) => request.method === "POST")).toEqual([
      { method: "POST", url: "http://localhost:8000/api/v1/webrtc/whip?streamId=debug-1" },
    ]);
    expect(posts.filter((request) => request.method === "DELETE")).toEqual([
      { method: "DELETE", url: "http://localhost:8000/whip/resource/debug-1" },
    ]);
    expect(list.streams?.map((stream) => stream.streamId)).toEqual(["debug-1"]);
    expect(status.stream?.resourceUrl).toBe("http://localhost:8000/whip/resource/debug-1");
    expect(stop.stream?.state).toBe("stopped");
    expect(sources[0].started).toBe(true);
    expect(sources[0].stopped).toBe(true);
    expect(afterStop.streams).toEqual([]);
  });

  test("status for an unknown stream returns an error response", async () => {
    const server = new TestableServer(makeDeps());
    const socket = new FakeSocket();
    await server.simulate(socket, { id: "8", action: "status", streamId: "nope" });
    const response = lastResponse(socket);
    expect(response.success).toBe(false);
    expect(response.error).toContain("nope");
  });

  test("device resolution failure surfaces as an error response", async () => {
    const server = new TestableServer(
      makeDeps({
        resolveDevice: async () => {
          throw new Error("No connected android devices found.");
        },
      }),
    );
    const socket = new FakeSocket();
    await server.simulate(socket, { id: "9", action: "start" });
    const response = lastResponse(socket);
    expect(response.success).toBe(false);
    expect(response.error).toContain("No connected android devices");
  });

  test("invalid JSON yields an error response", async () => {
    const server = new TestableServer(makeDeps());
    const socket = new FakeSocket();
    await (server as any).processLine(socket as unknown as Socket, "{not json");
    const response = lastResponse(socket);
    expect(response.success).toBe(false);
    expect(response.error).toContain("Invalid JSON");
  });

  // FUNNEL 2: the quarantine deliberately preserves the owning session, so
  // authorization still succeeds on a serial whose AVD identity the pool can no
  // longer prove. A capture started on it would publish whichever runtime now
  // answers ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
  describe("device admission (issue #6863)", () => {
    const quarantineGate: DeviceAdmissionGate = {
      assertDeviceActionable: (deviceId, purpose) => {
        if (deviceId === "emulator-5554") {
          throw new ActionableError(`Refusing ${purpose} on device '${deviceId}'`);
        }
      },
    };

    test("refuses a start on a quarantined serial without starting the stream", async () => {
      const server = new TestableServer(makeDeps(), allowAllAuthenticator, quarantineGate);
      const socket = new FakeSocket();

      await server.simulate(socket, {
        id: "1",
        action: "start",
        deviceId: "emulator-5554",
        whipEndpoint: "https://coord/whip",
      });

      const response = lastResponse(socket);
      expect(response.success).toBe(false);
      expect(response.error).toContain("Refusing to start a WebRTC stream on device");
      expect(started).toHaveLength(0);
    });

    test("refuses a start whose omitted deviceId resolves to a quarantined serial", async () => {
      const server = new TestableServer(makeDeps(), allowAllAuthenticator, quarantineGate);
      const socket = new FakeSocket();

      await server.simulate(socket, {
        id: "1",
        action: "start",
        whipEndpoint: "https://coord/whip",
      });

      expect(lastResponse(socket).success).toBe(false);
      expect(started).toHaveLength(0);
    });
  });

  describe("authentication (issue #4751)", () => {
    function fakeSessionManager(
      overrides: Partial<StreamAuthSessionManager> = {},
    ): StreamAuthSessionManager {
      return {
        getSession: (sessionUuid) => (sessionUuid === "session-1" ? {} : null),
        getSessionForDevice: () => null,
        getDeviceLabels: () => undefined,
        ...overrides,
      };
    }

    function enforcingServer(sm: StreamAuthSessionManager): TestableServer {
      return new TestableServer(
        makeDeps(),
        new SessionScopedStreamAuthenticator(() => sm, "webrtcStream", {} as NodeJS.ProcessEnv),
      );
    }

    test("rejects a start with no sessionUuid", async () => {
      const server = enforcingServer(fakeSessionManager());
      const socket = new FakeSocket();
      await server.simulate(socket, {
        id: "1",
        action: "start",
        whipEndpoint: "https://coord/whip",
      });
      const response = lastResponse(socket);
      expect(response.success).toBe(false);
      expect(response.error).toContain("authenticated daemon session");
      expect(started).toHaveLength(0);
    });

    test("rejects a start whose session is unknown/expired", async () => {
      const server = enforcingServer(fakeSessionManager());
      const socket = new FakeSocket();
      await server.simulate(socket, {
        id: "2",
        action: "start",
        sessionUuid: "ghost",
        whipEndpoint: "https://coord/whip",
      });
      const response = lastResponse(socket);
      expect(response.success).toBe(false);
      expect(response.error).toContain("not an active daemon session");
      expect(started).toHaveLength(0);
    });

    test("accepts a start with a live session", async () => {
      const server = enforcingServer(fakeSessionManager());
      const socket = new FakeSocket();
      await server.simulate(socket, {
        id: "3",
        action: "start",
        sessionUuid: "session-1",
        whipEndpoint: "https://coord/whip",
      });
      expect(lastResponse(socket).success).toBe(true);
      expect(started).toHaveLength(1);
    });

    test("forwards the resolved base session to every lease operation", async () => {
      const identities: string[] = [];
      const sm = fakeSessionManager({
        getDeviceLabels: (uuid) =>
          uuid === "session-1" ? { phone: "session-1:phone" } : undefined,
      });
      const server = new TestableServer(
        makeDeps({
          startStream: async (request) => {
            identities.push(request.sessionUuid ?? "missing");
            return descriptor("stream-1");
          },
          getStream: (_streamId, _leaseId, sessionUuid) => {
            identities.push(sessionUuid ?? "missing");
            return descriptor("stream-1");
          },
          awaitReadiness: async (_streamId, _readiness, _timeoutMs, _leaseId, sessionUuid) => {
            identities.push(sessionUuid ?? "missing");
            return descriptor("stream-1");
          },
          stopStream: async (_streamId, _leaseId, sessionUuid) => {
            identities.push(sessionUuid ?? "missing");
            return descriptor("stream-1", "stopped");
          },
        }),
        new SessionScopedStreamAuthenticator(() => sm, "webrtcStream", {} as NodeJS.ProcessEnv),
      );
      const socket = new FakeSocket();
      for (const action of ["start", "status", "await", "stop"] as const) {
        await server.simulate(socket, {
          id: action,
          action,
          streamId: "stream-1",
          sessionUuid: "session-1:phone",
          whipEndpoint: action === "start" ? "https://coord/whip" : undefined,
        });
        expect(lastResponse(socket).success).toBe(true);
      }
      expect(identities).toEqual(Array(4).fill("session-1"));
    });

    test("forwards the wire identity when no resolver is available or auth is disabled", async () => {
      const identities: string[] = [];
      const deps = makeDeps({
        getStream: (_streamId, _leaseId, sessionUuid) => {
          identities.push(sessionUuid ?? "missing");
          return descriptor("stream-1");
        },
      });
      const socket = new FakeSocket();
      const request: WebRtcStreamSocketRequest = {
        id: "status",
        action: "status",
        streamId: "stream-1",
        sessionUuid: "session-1:phone",
      };
      await new TestableServer(deps).simulate(socket, request);
      const disabled = new SessionScopedStreamAuthenticator(
        () => fakeSessionManager(),
        "webrtcStream",
        { AUTOMOBILE_DAEMON_STREAM_AUTH: "0" } as NodeJS.ProcessEnv,
      );
      await new TestableServer(deps, disabled).simulate(socket, request);
      expect(identities).toEqual(["session-1:phone", "session-1:phone"]);
    });

    test("admits a viewer targeting a device owned by another session", async () => {
      const server = enforcingServer(
        fakeSessionManager({ getSessionForDevice: () => "other-session" }),
      );
      const socket = new FakeSocket();
      await server.simulate(socket, {
        id: "4",
        action: "start",
        sessionUuid: "session-1",
        deviceId: "emulator-5554",
        whipEndpoint: "https://coord/whip",
      });
      const response = lastResponse(socket);
      expect(response).toMatchObject({ success: true, subscriptionKind: "viewer" });
      expect(started).toHaveLength(1);
      expect(started[0].subscriptionKind).toBe("viewer");
    });

    test("admits a viewer with omitted deviceId when another session owns the resolved device", async () => {
      const server = enforcingServer(
        fakeSessionManager({ getSessionForDevice: () => "other-session" }),
      );
      const socket = new FakeSocket();
      await server.simulate(socket, {
        id: "omitted-other",
        action: "start",
        sessionUuid: "session-1",
        whipEndpoint: "https://coord/whip",
      });
      expect(lastResponse(socket)).toMatchObject({ success: true, subscriptionKind: "viewer" });
      expect(started).toHaveLength(1);
      expect(started[0].subscriptionKind).toBe("viewer");
    });

    test("accepts an omitted deviceId when the resolved device belongs to the caller", async () => {
      const server = enforcingServer(
        fakeSessionManager({ getSessionForDevice: () => "session-1" }),
      );
      const socket = new FakeSocket();
      await server.simulate(socket, {
        id: "omitted-owner",
        action: "start",
        sessionUuid: "session-1",
        whipEndpoint: "https://coord/whip",
      });
      expect(lastResponse(socket).success).toBe(true);
      expect(started).toHaveLength(1);
    });
  });

  describe("WHIP override policy (issue #4751)", () => {
    test("rejects an arbitrary non-allow-listed WHIP override from the wire", async () => {
      const server = new TestableServer(makeDeps());
      const socket = new FakeSocket();
      await server.simulate(socket, {
        id: "w1",
        action: "start",
        sessionUuid: "session-1",
        whipEndpoint: "https://attacker.example/whip",
      });
      const response = lastResponse(socket);
      expect(response.success).toBe(false);
      expect(response.error).toContain("not allow-listed");
      expect(started).toHaveLength(0);
    });

    test("permits a loopback http WHIP override", async () => {
      const server = new TestableServer(makeDeps());
      const socket = new FakeSocket();
      await server.simulate(socket, {
        id: "w2",
        action: "start",
        sessionUuid: "session-1",
        whipEndpoint: "http://127.0.0.1:8000/whip",
      });
      expect(lastResponse(socket).success).toBe(true);
      expect(started).toHaveLength(1);
    });
  });
});
