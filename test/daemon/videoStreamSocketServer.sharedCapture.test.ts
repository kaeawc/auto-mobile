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
import type {
  H264CaptureSource,
  H264CaptureSourceOptions,
} from "../../src/features/webrtc/H264CaptureSource";
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
  keyFrames = 0;
  requestKeyFrame(): boolean {
    this.keyFrames++;
    return true;
  }
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
  snapshot() {
    return (
      Reflect.get(this, "captures") as Map<
        string,
        {
          generation: number;
          parser: object;
          waitingForKeyFrame: Set<FakeSocket>;
          lastEncodedDataMs: number | null;
          firstEvidenceMs: number | null;
          encodedSinceSourceFrame: boolean;
          heartbeatTimer: unknown;
          appliedHints: { fps?: number; size?: { width: number; height: number } };
        }
      >
    ).get(device.deviceId)!;
  }
  async replaceHints(hints: { fps?: number }): Promise<void> {
    const replace = Reflect.get(this, "reconfigureCapture") as (
      deviceId: string,
      capture: object,
      hints: { fps?: number },
    ) => Promise<void>;
    await replace.call(this, device.deviceId, this.snapshot(), hints);
  }
  async request(
    socket: FakeSocket,
    action: "subscribe" | "unsubscribe",
    hints: Record<string, unknown> = {},
  ): Promise<void> {
    await this.processLine(socket, JSON.stringify({ action, deviceId: device.deviceId, ...hints }));
  }
}
function harness(platform: "android" | "ios" = "android") {
  const captureDevice = { ...device, platform };
  const timer = new FakeTimer();
  const captureRegistry = createDeviceCaptureRegistry();
  const sources: Source[] = [];
  const events: string[] = [];
  const options: H264CaptureSourceOptions[] = [];
  let relayCreates = 0;
  let webrtcCreates = 0;
  const create = (value: H264CaptureSourceOptions) => {
    options.push(value);
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
    createSource: (value) => {
      webrtcCreates++;
      return create(value);
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
      resolveDevice: async () => captureDevice,
      nowUs: () => 1n,
      createCaptureSource: async (value) => {
        relayCreates++;
        return create(value);
      },
    },
    "/unused/shared-capture.sock",
    timer,
    { authorize: () => {} },
    permissiveDeviceAdmissionGate,
  );
  return {
    timer,
    sources,
    options,
    device: captureDevice,
    relay,
    events,
    counts: () => [webrtcCreates, relayCreates],
  };
}
afterEach(() => resetWebRtcStreamManager());
for (const first of ["webrtc", "relay"] as const) {
  test(`${first} first respects callback capabilities and source lifetime`, async () => {
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
      // Either order shares one capture (#9798): the webrtc-created entry never sees the relay
      // create, and a relay-created entry now fans frame metrics out to the late WebRTC joiner.
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

test("incompatible relay reconfigure uses a private source and leaves WebRTC untouched", async () => {
  const h = harness();
  const stream = await startWebRtcStream({
    device,
    overrides: { whipEndpoint: "https://example.test/whip" },
  });
  try {
    await h.relay.request(new FakeSocket(), "subscribe");
    await h.relay.request(new FakeSocket(), "subscribe", { quality: "high", fps: 15 });
    h.timer.advanceTime(200);
    for (let i = 0; i < 24; i++) {
      await Promise.resolve();
    }
    expect(h.counts()).toEqual([1, 1]);
    expect(h.sources).toHaveLength(2);
    expect(h.options[1].quality).toBe("high");
    expect(h.options[1].fps).toBe(15);
    expect(h.sources[0].stops).toBe(0);
    expect(h.events).toEqual(["create1", "start1", "create2", "start2"]);
  } finally {
    await h.relay.close();
    await stopWebRtcStream(stream.streamId);
  }
});
test("satisfied shared relay reconfigure preserves viewers and skips keyframe requests", async () => {
  const info = spyOn(logger, "info").mockImplementation(() => {});
  const h = harness();
  const stream = await startWebRtcStream({
    device,
    overrides: { whipEndpoint: "https://example.test/whip" },
  });
  try {
    await h.relay.request(new FakeSocket(), "subscribe");
    await h.relay.request(new FakeSocket(), "subscribe", { fps: 30 });
    const before = h.relay.snapshot();
    const parser = before.parser;
    const generation = before.generation,
      waiters = [...before.waitingForKeyFrame];
    const keyFrames = h.sources[0].keyFrames;
    info.mockClear();
    h.timer.advanceTime(200);
    for (let i = 0; i < 24; i++) {
      await Promise.resolve();
    }
    const after = h.relay.snapshot();
    expect(h.events).toEqual(["create1", "start1"]);
    expect(after.parser).toBe(parser);
    expect(after.generation).toBe(generation);
    expect([...after.waitingForKeyFrame]).toEqual(waiters);
    expect(h.sources[0].keyFrames).toBe(keyFrames);
    expect(
      info.mock.calls.some(([message]) =>
        String(message).includes("shared capture quality changed"),
      ),
    ).toBe(false);
    expect(after.appliedHints.fps).toBe(30);
  } finally {
    await h.relay.close();
    await stopWebRtcStream(stream.streamId);
    info.mockRestore();
  }
});
test("relay replay parses parameter sets without liveness evidence", async () => {
  const h = harness();
  try {
    await h.relay.request(new FakeSocket(), "subscribe");
    h.timer.advanceTime(50);
    const sps = Buffer.from([0, 0, 0, 1, 7, 11]),
      pps = Buffer.from([0, 0, 0, 1, 8, 12]);
    expect(h.options[0].onReplayData).toBeDefined();
    h.options[0].onReplayData?.(sps);
    h.options[0].onReplayData?.(pps);
    const state = h.relay.snapshot();
    expect(state.lastEncodedDataMs).toBeNull();
    expect(state.firstEvidenceMs).toBeNull();
    expect(state.encodedSinceSourceFrame).toBe(false);
    expect(state.heartbeatTimer).toBeNull();
    h.options[0].onData(Buffer.from([0, 0, 0, 1, 5, 128]));
    expect(state.lastEncodedDataMs).toBe(50);
    expect(state.firstEvidenceMs).toBe(50);
    expect(state.encodedSinceSourceFrame).toBe(true);
    expect(state.heartbeatTimer).not.toBeNull();
  } finally {
    await h.relay.close();
  }
});
for (const first of ["relay", "webrtc"] as const) {
  test(`iOS ${first} first shares one capture at the highest requested rate (#10711)`, async () => {
    const h = harness("ios");
    let streamId = "";
    const start = async () => {
      streamId = (
        await startWebRtcStream({
          device: h.device,
          overrides: { whipEndpoint: "https://example.test/whip" },
        })
      ).streamId;
    };
    try {
      if (first === "relay") {
        await h.relay.request(new FakeSocket(), "subscribe");
        await start();
        // The relay's capture is restarted in place at WebRTC's binding rate; no second capture.
        expect(h.counts()).toEqual([0, 2]);
        expect(h.options.map((value) => value.fps)).toEqual([5, 15]);
        expect(h.events).toEqual(["create1", "start1", "stop1", "create2", "start2"]);
      } else {
        await start();
        await h.relay.request(new FakeSocket(), "subscribe");
        expect(h.counts()).toEqual([1, 0]);
        expect(h.options.map((value) => value.fps)).toEqual([15]);
        // A slower binding relay hint is satisfied by the faster shared capture.
        await h.relay.request(new FakeSocket(), "subscribe", { fps: 5 });
        h.timer.advanceTime(200);
        for (let i = 0; i < 24; i++) {
          await Promise.resolve();
        }
        expect(h.counts()).toEqual([1, 0]);
        expect(h.events).toEqual(["create1", "start1"]);
      }
    } finally {
      await h.relay.close();
      if (streamId) {
        await stopWebRtcStream(streamId);
      }
    }
    expect(h.sources.every((source) => source.stops === 1)).toBe(true);
  });
}

test("sole relay recreates even when replacement hints are a satisfied subset", async () => {
  const h = harness();
  try {
    await h.relay.request(new FakeSocket(), "subscribe", { quality: "low", fps: 30 });
    await h.relay.replaceHints({ fps: 30 });
    expect(h.events).toEqual(["create1", "start1", "stop1", "create2", "start2"]);
    expect(h.options[1].quality).toBeUndefined();
    expect(h.options[1].fps).toBe(30);
  } finally {
    await h.relay.close();
  }
});
for (const explicit of [false, true]) {
  test(`relay header uses only actual or unknown source size (explicit=${explicit})`, async () => {
    const h = harness();
    const stream = await startWebRtcStream({
      device,
      overrides: {
        whipEndpoint: "https://example.test/whip",
        size: { width: 640, height: 360 },
        bitrateKbps: 1000,
      },
    });
    try {
      const socket = new FakeSocket();
      const size = { width: 100, height: 200 };
      await h.relay.request(socket, "subscribe", explicit ? { size } : {});
      expect(h.counts()).toEqual(explicit ? [1, 1] : [1, 0]);
      const header = socket.written.find((value): value is Buffer => Buffer.isBuffer(value))!;
      expect(header.readInt32BE(4)).toBe(explicit ? 100 : 0);
      expect(header.readInt32BE(8)).toBe(explicit ? 200 : 0);
      if (explicit) {
        expect(h.options[1].size).toEqual(size);
      }
    } finally {
      await h.relay.close();
      await stopWebRtcStream(stream.streamId);
    }
  });
}
