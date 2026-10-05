import { createDeviceCaptureRegistry } from "../../src/features/webrtc/deviceCaptureRegistry";
import { afterEach, expect, spyOn, test } from "bun:test";
import { VideoStreamSocketServer } from "../../src/daemon/videoStreamSocketServer";
import { permissiveDeviceAdmissionGate } from "../../src/daemon/deviceAdmissionGate";
import {
  resetWebRtcStreamManager,
  setWebRtcStreamManagerDependencies,
  startWebRtcStream,
  stopWebRtcStream,
} from "../../src/server/webrtcStreamManager";
import type { BootedDevice } from "../../src/models";
import type { H264CaptureSource } from "../../src/features/webrtc/H264CaptureSource";
import type { WebRtcPublisher } from "../../src/features/webrtc/WebRtcPublisher";
import { logger } from "../../src/utils/logger";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";

const device = { deviceId: "shared-device", platform: "android", name: "Pixel" } as BootedDevice;
class Source implements H264CaptureSource {
  constructor(
    private readonly events: string[],
    private readonly id: number,
  ) {}
  starts = 0;
  stops = 0;
  async start(): Promise<void> {
    this.starts++;
    this.events.push(`start${this.id}`);
  }
  async stop(): Promise<void> {
    this.stops++;
    this.events.push(`stop${this.id}`);
  }
}
class Relay extends VideoStreamSocketServer {
  async request(
    socket: FakeSocket,
    action: "subscribe" | "unsubscribe",
    hints: Record<string, unknown> = {},
  ): Promise<void> {
    await this.processLine(socket, JSON.stringify({ action, deviceId: device.deviceId, ...hints }));
  }
}
function harness() {
  const timer = new FakeTimer();
  const captureRegistry = createDeviceCaptureRegistry();
  const sources: Source[] = [];
  const events: string[] = [];
  let relayCreates = 0;
  let webrtcCreates = 0;
  const create = () => {
    const id = sources.length + 1;
    events.push(`create${id}`);
    const source = new Source(events, id);
    sources.push(source);
    return source;
  };
  setWebRtcStreamManagerDependencies({
    timer,
    captureRegistry,
    resolveVideoJar: async () => null,
    createSource: () => {
      webrtcCreates++;
      return create();
    },
    createPublisher: (config) =>
      ({
        start: async () => {},
        stop: async () => {},
        notifySourceFailed: () => {},
        writeH264Chunk: () => {},
        primeH264ParameterSets: () => {},
        getDescriptor: () => ({ streamId: config.streamId, state: "idle", iceServers: [] }),
      }) as unknown as WebRtcPublisher,
  });
  const relay = new Relay(
    {
      captureRegistry,
      resolveDevice: async () => device,
      nowUs: () => 1n,
      createCaptureSource: async () => {
        relayCreates++;
        return create();
      },
    },
    "/unused/shared-capture.sock",
    timer,
    { authorize: () => {} },
    permissiveDeviceAdmissionGate,
  );
  return { timer, sources, relay, events, counts: () => [webrtcCreates, relayCreates] };
}
afterEach(() => resetWebRtcStreamManager());
for (const first of ["webrtc", "relay"] as const) {
  test(`${first} first shares capture across modules and retains it until the final release`, async () => {
    const h = harness();
    const socket = new FakeSocket();
    let streamId = "";
    const startWebrtc = async () => {
      streamId = (
        await startWebRtcStream({
          device,
          overrides: { whipEndpoint: "https://example.test/whip" },
        })
      ).streamId;
    };
    try {
      if (first === "webrtc") {
        await startWebrtc();
        await h.relay.request(socket, "subscribe");
      } else {
        await h.relay.request(socket, "subscribe");
        await startWebrtc();
      }
      expect(h.counts()).toEqual(first === "webrtc" ? [1, 0] : [0, 1]);
      expect(h.sources).toHaveLength(1);
      expect(h.sources[0].starts).toBe(1);
      if (first === "webrtc") {
        await stopWebRtcStream(streamId);
        expect(h.sources[0].stops).toBe(0);
        await h.relay.request(socket, "unsubscribe");
        h.timer.advanceTime(3_000);
        await h.relay.close();
      } else {
        await h.relay.request(socket, "unsubscribe");
        h.timer.advanceTime(3_000);
        await h.relay.close();
        expect(h.sources[0].stops).toBe(0);
        await stopWebRtcStream(streamId);
      }
      expect(h.sources[0].stops).toBe(1);
    } finally {
      if (streamId) {
        await stopWebRtcStream(streamId).catch(() => {});
      }
      await h.relay.close();
    }
  });
}

for (const consumer of ["webrtc", "relay"] as const) {
  test(`single-consumer ${consumer} constructs, starts and stops once`, async () => {
    const h = harness();
    if (consumer === "relay") {
      const socket = new FakeSocket();
      await h.relay.request(socket, "subscribe");
      await h.relay.request(socket, "unsubscribe");
      h.timer.advanceTime(3_000);
      await h.relay.close();
    } else {
      const stream = await startWebRtcStream({
        device,
        overrides: { whipEndpoint: "https://example.test/whip" },
      });
      await stopWebRtcStream(stream.streamId);
      await h.relay.close();
    }
    expect(h.events).toEqual(["create1", "start1", "stop1"]);
    expect(h.counts()).toEqual(consumer === "webrtc" ? [1, 0] : [0, 1]);
  });
}
test("sole relay reconfigure stops the old source before constructing the new source", async () => {
  const h = harness();
  try {
    await h.relay.request(new FakeSocket(), "subscribe", { quality: "low" });
    await h.relay.request(new FakeSocket(), "subscribe", { quality: "high" });
    h.timer.advanceTime(200);
    for (let i = 0; i < 24; i++) {
      await Promise.resolve();
    }
    expect(h.events).toEqual(["create1", "start1", "stop1", "create2", "start2"]);
  } finally {
    await h.relay.close();
  }
  expect(h.sources.map((source) => source.stops)).toEqual([1, 1]);
});

test("relay reconfigure while WebRTC holds the source keeps it and warns about ignored hints", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const info = spyOn(logger, "info").mockImplementation(() => {});
  const h = harness();
  let streamId = "";
  try {
    // Start the relay first so the initial shared acquisition has matching defaults.
    await h.relay.request(new FakeSocket(), "subscribe", { fps: 30 });
    streamId = (
      await startWebRtcStream({
        device,
        overrides: { whipEndpoint: "https://example.test/whip", androidFps: 30 },
      })
    ).streamId;
    warn.mockClear();
    await h.relay.request(new FakeSocket(), "subscribe", { quality: "high", fps: 15 });
    h.timer.advanceTime(200);
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
    // The existing success log pins that the swap completed, rather than only scheduling it.
    expect(
      info.mock.calls.some(([message]) =>
        String(message).includes("shared capture quality changed"),
      ),
    ).toBe(true);
    expect(h.counts()).toEqual([0, 1]);
    expect(h.sources).toHaveLength(1);
    expect(h.events).toEqual(["create1", "start1"]);
    expect(h.sources[0].stops).toBe(0);
    expect(
      warn.mock.calls.some(([message]) =>
        String(message).includes(
          `${device.deviceId}: ignoring conflicting capture hints (quality, fps)`,
        ),
      ),
    ).toBe(true);
  } finally {
    await h.relay.close();
    if (streamId) {
      await stopWebRtcStream(streamId);
    }
    warn.mockRestore();
    info.mockRestore();
  }
  expect(h.sources[0].stops).toBe(1);
});
