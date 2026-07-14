import { afterEach, describe, expect, test } from "bun:test";
import {
  getWebRtcStreamDescriptor,
  listWebRtcStreams,
  resetWebRtcStreamManager,
  setWebRtcStreamManagerDependencies,
  startWebRtcStream,
  stopWebRtcStream,
} from "../../src/server/webrtcStreamManager";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import type { BootedDevice } from "../../src/models";
import type {
  AndroidH264Source,
  WebRtcPublisher,
  WebRtcStreamDescriptor,
} from "../../src/features/webrtc";

const ANDROID: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "a" } as BootedDevice;
const IOS: BootedDevice = {
  deviceId: "4DA8AF35-C59B-43D3-A8FE-5640A7B0B8C1",
  platform: "ios",
  name: "iPhone 16",
} as BootedDevice;

const ENDPOINT = "https://coord.example.com/whip";

class FakePublisher {
  started = false;
  stopped = false;
  sourceFailedCount = 0;
  onBeforeEstablish?: () => Promise<void> | void;
  onConnected?: () => Promise<void> | void;
  constructor(
    public readonly config: { streamId: string; whipEndpoint: string },
    deps: {
      onBeforeEstablish?: () => Promise<void> | void;
      onConnected?: () => Promise<void> | void;
    }
  ) {
    this.onBeforeEstablish = deps.onBeforeEstablish;
    this.onConnected = deps.onConnected;
  }
  async start(): Promise<void> {
    // Simulate establish: stop any prior source, connect, then start capture.
    await this.onBeforeEstablish?.();
    await this.onConnected?.();
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  writeH264Chunk(): void {}
  notifySourceFailed(): void {
    this.sourceFailedCount++;
  }
  getState() {
    return this.stopped ? "stopped" : this.started ? "connected" : "idle";
  }
  getDescriptor(): WebRtcStreamDescriptor {
    return {
      streamId: this.config.streamId,
      state: this.getState() as WebRtcStreamDescriptor["state"],
      whipEndpoint: this.config.whipEndpoint,
      resourceUrl: `${this.config.whipEndpoint}/r/${this.config.streamId}`,
      iceServers: [],
      framesSent: 0,
      packetsSent: 0,
    };
  }
}

class FakeSource {
  started = false;
  stopped = false;
  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
}

function installFakes() {
  const publishers: FakePublisher[] = [];
  const sources: FakeSource[] = [];
  setWebRtcStreamManagerDependencies({
    idGenerator: new CountingIdGenerator("id"),
    createPublisher: (config, deps) => {
      const publisher = new FakePublisher(config, deps);
      publishers.push(publisher);
      return publisher as unknown as WebRtcPublisher;
    },
    createSource: () => {
      const source = new FakeSource();
      sources.push(source);
      return source as unknown as AndroidH264Source;
    },
    now: () => new Date("2026-07-11T00:00:00.000Z"),
  });
  return { publishers, sources };
}

afterEach(() => {
  resetWebRtcStreamManager();
});

describe("webrtcStreamManager", () => {
  test("start creates a publisher, starts the source, and returns a descriptor", async () => {
    const { publishers, sources } = installFakes();
    const descriptor = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });

    expect(descriptor.streamId).toBe("webrtc_id-1");
    expect(descriptor.whipEndpoint).toBe(ENDPOINT);
    expect(descriptor.resourceUrl).toContain("webrtc_id-1");
    expect(publishers[0].started).toBe(true);
    // onBeforeEstablish started the capture source.
    expect(sources[0].started).toBe(true);
    expect(listWebRtcStreams()).toHaveLength(1);
  });

  test("rejects a second stream for the same device", async () => {
    installFakes();
    await startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } });
    await expect(
      startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } })
    ).rejects.toThrow(/already active/);
  });

  test("rejects a duplicate explicit streamId (even on a different device)", async () => {
    installFakes();
    const other: BootedDevice = { deviceId: "emulator-5556", platform: "android", name: "b" } as BootedDevice;
    await startWebRtcStream({ device: ANDROID, streamId: "dup", overrides: { whipEndpoint: ENDPOINT } });
    await expect(
      startWebRtcStream({ device: other, streamId: "dup", overrides: { whipEndpoint: ENDPOINT } })
    ).rejects.toThrow(/already active/);
  });

  test("starts iOS devices when a capture source is available", async () => {
    const { sources } = installFakes();
    const descriptor = await startWebRtcStream({
      device: IOS,
      overrides: { whipEndpoint: ENDPOINT },
    });

    expect(descriptor.streamId).toBe("webrtc_id-1");
    expect(sources[0].started).toBe(true);
    expect(listWebRtcStreams()).toHaveLength(1);
  });

  test("requires a configured WHIP endpoint", async () => {
    installFakes();
    await expect(
      startWebRtcStream({ device: ANDROID, overrides: {} })
    ).rejects.toThrow(/WHIP endpoint/);
  });

  test("stop terminates publisher and source and reports stopped", async () => {
    const { publishers, sources } = installFakes();
    const started = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });

    const stopped = await stopWebRtcStream(started.streamId);
    expect(stopped.state).toBe("stopped");
    expect(publishers[0].stopped).toBe(true);
    expect(sources[0].stopped).toBe(true);
    expect(listWebRtcStreams()).toHaveLength(0);
    expect(getWebRtcStreamDescriptor(started.streamId)).toBeNull();
  });

  test("stop without id resolves the single active stream", async () => {
    installFakes();
    await startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } });
    const stopped = await stopWebRtcStream();
    expect(stopped.state).toBe("stopped");
  });

  test("does not leave an orphaned source when the stream is stopped mid-start", async () => {
    // A source whose start() stops the stream (simulating stopWebRtcStream racing
    // the async onConnected startup path). The manager must re-check ownership
    // after the await and tear the just-started source down instead of leaking it.
    const sources: FakeSource[] = [];
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) => new FakePublisher(config, deps) as unknown as WebRtcPublisher,
      createSource: () => {
        const source = new FakeSource();
        const originalStart = source.start.bind(source);
        source.start = async () => {
          await originalStart();
          await stopWebRtcStream("race");
        };
        sources.push(source);
        return source as unknown as AndroidH264Source;
      },
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    await startWebRtcStream({ device: ANDROID, streamId: "race", overrides: { whipEndpoint: ENDPOINT } });

    expect(sources[0].started).toBe(true);
    expect(sources[0].stopped).toBe(true);
    expect(listWebRtcStreams()).toHaveLength(0);
  });

  test("routes source failures reported during start to the publisher", async () => {
    const publishers: FakePublisher[] = [];
    const sources: FakeSource[] = [];
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) => {
        const publisher = new FakePublisher(config, deps);
        publishers.push(publisher);
        return publisher as unknown as WebRtcPublisher;
      },
      createSource: options => {
        const source = new FakeSource();
        source.start = async () => {
          source.started = true;
          options.onError?.(new Error("helper exited after first frame"));
        };
        sources.push(source);
        return source as unknown as AndroidH264Source;
      },
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    await startWebRtcStream({ device: IOS, overrides: { whipEndpoint: ENDPOINT } });

    expect(sources).toHaveLength(1);
    expect(sources[0].started).toBe(true);
    expect(publishers[0].sourceFailedCount).toBe(1);
    expect(listWebRtcStreams()).toHaveLength(1);
  });

  test("uses an explicit streamId when provided", async () => {
    installFakes();
    const descriptor = await startWebRtcStream({
      device: ANDROID,
      streamId: "ci-run-42",
      overrides: { whipEndpoint: ENDPOINT },
    });
    expect(descriptor.streamId).toBe("ci-run-42");
  });
});
