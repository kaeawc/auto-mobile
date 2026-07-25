import { afterEach, describe, expect, test } from "bun:test";
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

const ANDROID: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "a" } as BootedDevice;
const IOS: BootedDevice = { deviceId: "simulator-1", platform: "ios", name: "iPhone 16" } as BootedDevice;

function descriptor(streamId: string, state: WebRtcStreamDescriptor["state"] = "connected"): WebRtcStreamDescriptor {
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

class TestableServer extends WebRtcStreamSocketServer {
  constructor(deps: WebRtcStreamSocketServerDependencies) {
    super("/fake/webrtc-stream.sock", new FakeTimer(), deps);
  }
  async simulate(socket: FakeSocket, request: WebRtcStreamSocketRequest): Promise<void> {
    await (this as any).processLine(socket as unknown as Socket, JSON.stringify(request));
    const pending = (this as any).pendingBySocket.get(socket);
    if (pending) {
      await pending;
    }
  }
}

let started: Array<{
  device: BootedDevice;
  streamId?: string;
  overrides?: WebRtcStreamingOverrides;
}> = [];
let stopped: string[] = [];

function makeDeps(overrides: Partial<WebRtcStreamSocketServerDependencies> = {}): WebRtcStreamSocketServerDependencies {
  const active = new Map<string, WebRtcStreamDescriptor>();
  return {
    resolveDevice: async () => ANDROID,
    startStream: async request => {
      const streamId = request.streamId ?? "webrtc_generated";
      started.push({ device: request.device, streamId: request.streamId, overrides: request.overrides });
      const d = descriptor(streamId);
      active.set(streamId, d);
      return d;
    },
    stopStream: async streamId => {
      const id = streamId ?? "webrtc_generated";
      stopped.push(id);
      active.delete(id);
      return descriptor(id, "stopped");
    },
    listStreams: () => Array.from(active.values()),
    getStream: streamId => active.get(streamId) ?? null,
    ...overrides,
  };
}

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
  test("device resolution scans only the requested platform", async () => {
    const requestedPlatforms: string[] = [];
    const device = await resolveWebRtcStreamDevice(
      {
        getBootedDevices: async platform => {
          requestedPlatforms.push(platform);
          return platform === "ios" ? [IOS] : [ANDROID];
        },
      },
      undefined,
      "ios"
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

  test("list returns all active streams", async () => {
    const server = new TestableServer(makeDeps());
    const socket = new FakeSocket();
    await server.simulate(socket, { id: "5", action: "start", streamId: "s1" });
    await server.simulate(socket, { id: "6", action: "start", streamId: "s2" });
    await server.simulate(socket, { id: "7", action: "list" });
    const response = lastResponse(socket);
    expect(response.action).toBe("list");
    expect(response.streams?.map(s => s.streamId).sort()).toEqual(["s1", "s2"]);
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
    expect(listed.streams?.map(s => s.streamId)).toEqual(["debug-1"]);
    expect(status.stream?.streamId).toBe("debug-1");
    expect(stoppedResponse.stream?.state).toBe("stopped");
    expect(stopped).toEqual(["debug-1"]);
    expect(afterStop.streams).toEqual([]);
  });

  test("start reaches the real manager, posts WHIP, and remains visible until stop", async () => {
    const posts: RecordedWhipRequest[] = [];
    const sources: FakeH264Source[] = [];
    setWebRtcStreamManagerDependencies({
      createPublisher: (config, deps) =>
        new WebRtcPublisher(config, {
          ...deps,
          createPeerConnection: () => new FakeConnectedPeerConnection() as unknown as RTCPeerConnection,
          createWhipClient: (options: WhipClientOptions) =>
            new WhipClient({
              ...options,
              fetchImpl: createSuccessfulWhipFetch(posts),
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
    expect(posts.filter(request => request.method === "POST")).toEqual([
      { method: "POST", url: "http://localhost:8000/api/v1/webrtc/whip?streamId=debug-1" },
    ]);
    expect(posts.filter(request => request.method === "DELETE")).toEqual([
      { method: "DELETE", url: "http://localhost:8000/whip/resource/debug-1" },
    ]);
    expect(list.streams?.map(stream => stream.streamId)).toEqual(["debug-1"]);
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
      })
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
});
