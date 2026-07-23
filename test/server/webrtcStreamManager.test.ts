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
import { ActionableError, type BootedDevice } from "../../src/models";
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
  sourceFailureErrors: Error[] = [];
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
  pcmAudioChunks: Buffer[] = [];
  writePcmAudioChunk(chunk: Buffer): void {
    this.pcmAudioChunks.push(chunk);
  }
  notifySourceFailed(error?: Error): void {
    this.sourceFailedCount++;
    if (error) {
      this.sourceFailureErrors.push(error);
    }
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

class AsyncConnectedPublisher extends FakePublisher {
  override async start(): Promise<void> {
    await this.onBeforeEstablish?.();
    this.started = true;
    void Promise.resolve(this.onConnected?.()).catch(() => this.notifySourceFailed());
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
    // Hermetic: never resolve the real jar (which could attempt a GitHub
    // download once the registry carries a videoJarSha256).
    resolveVideoJar: async () => null,
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

  test("reserves a device before asynchronous jar resolution completes", async () => {
    let releaseJar: ((path: string | null) => void) | undefined;
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) => new FakePublisher(config, deps) as unknown as WebRtcPublisher,
      createSource: () => new FakeSource() as unknown as AndroidH264Source,
      resolveVideoJar: () => new Promise(resolve => { releaseJar = resolve; }),
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    const first = startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } });
    await expect(
      startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } })
    ).rejects.toThrow(/already active or starting/);

    releaseJar?.(null);
    await first;
  });

  test("cancels an explicit stream while jar resolution is pending", async () => {
    let releaseJar: ((path: string | null) => void) | undefined;
    let publishersCreated = 0;
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) => {
        publishersCreated++;
        return new FakePublisher(config, deps) as unknown as WebRtcPublisher;
      },
      createSource: () => new FakeSource() as unknown as AndroidH264Source,
      resolveVideoJar: () => new Promise(resolve => { releaseJar = resolve; }),
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    const starting = startWebRtcStream({
      device: ANDROID,
      streamId: "pending-stop",
      overrides: { whipEndpoint: ENDPOINT },
    });
    const stopped = await stopWebRtcStream("pending-stop");
    releaseJar?.(null);

    await expect(starting).rejects.toThrow(/stopped before startup/);
    expect(stopped.state).toBe("stopped");
    expect(publishersCreated).toBe(0);
    expect(listWebRtcStreams()).toEqual([]);
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

  test("stop without id rejects an active stream plus a different pending start as ambiguous", async () => {
    let releaseJar: ((path: string | null) => void) | undefined;
    installFakes();
    await startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } });
    setWebRtcStreamManagerDependencies({
      resolveVideoJar: () => new Promise(resolve => { releaseJar = resolve; }),
    });
    const pending = startWebRtcStream({ device: IOS, overrides: { whipEndpoint: ENDPOINT } });

    await expect(stopWebRtcStream()).rejects.toThrow(/specify streamId/);
    releaseJar?.(null);
    await pending;
  });

  test("rejects audio startup promptly when stopped before the publisher connects", async () => {
    let releaseStart: (() => void) | undefined;
    let enteredStart: (() => void) | undefined;
    const startEntered = new Promise<void>(resolve => { enteredStart = resolve; });
    const allowStartToReturn = new Promise<void>(resolve => { releaseStart = resolve; });
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) => {
        const publisher = new FakePublisher(config, deps);
        publisher.start = async () => {
          await publisher.onBeforeEstablish?.();
          enteredStart?.();
          await allowStartToReturn;
        };
        return publisher as unknown as WebRtcPublisher;
      },
      createSource: () => new FakeSource() as unknown as AndroidH264Source,
      resolveVideoJar: async () => null,
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    const starting = startWebRtcStream({
      device: ANDROID,
      streamId: "audio-stop-before-connect",
      overrides: { whipEndpoint: ENDPOINT, audioEnabled: true },
    });
    await startEntered;
    await stopWebRtcStream("audio-stop-before-connect");
    releaseStart?.();

    await expect(starting).rejects.toThrow(/stopped before capture source started/);
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
      resolveVideoJar: async () => null,
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
      resolveVideoJar: async () => null,
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    await startWebRtcStream({ device: IOS, overrides: { whipEndpoint: ENDPOINT } });

    expect(sources).toHaveLength(1);
    expect(sources[0].started).toBe(true);
    expect(publishers[0].sourceFailedCount).toBe(1);
    expect(publishers[0].sourceFailureErrors[0].message).toBe("helper exited after first frame");
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

  // --- #3836: async jar resolution wiring ---

  test("resolves the jar once at stream start and threads the path into createSource", async () => {
    let resolveCalls = 0;
    const jarPaths: (string | null)[] = [];
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) => new FakePublisher(config, deps) as unknown as WebRtcPublisher,
      createSource: (_options, jarPath) => {
        jarPaths.push(jarPath);
        return new FakeSource() as unknown as AndroidH264Source;
      },
      resolveVideoJar: async () => {
        resolveCalls++;
        return "/verified/automobile-video.jar";
      },
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    await startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } });

    expect(resolveCalls).toBe(1);
    expect(jarPaths).toEqual(["/verified/automobile-video.jar"]);
  });

  test("degrade (null) proceeds and passes null (screenrecord) to createSource", async () => {
    const jarPaths: (string | null)[] = [];
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) => new FakePublisher(config, deps) as unknown as WebRtcPublisher,
      createSource: (_options, jarPath) => {
        jarPaths.push(jarPath);
        return new FakeSource() as unknown as AndroidH264Source;
      },
      resolveVideoJar: async () => null,
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    const descriptor = await startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } });
    expect(descriptor.streamId).toBeDefined();
    expect(jarPaths).toEqual([null]);
  });

  test("a fatal jar fail-mode aborts stream start before any publisher/stream is created", async () => {
    let publisherCreated = 0;
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) => {
        publisherCreated++;
        return new FakePublisher(config, deps) as unknown as WebRtcPublisher;
      },
      createSource: () => new FakeSource() as unknown as AndroidH264Source,
      resolveVideoJar: async () => {
        throw new ActionableError("video-server jar checksum verification failed");
      },
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    await expect(
      startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } })
    ).rejects.toThrow(/checksum verification failed/);
    expect(publisherCreated).toBe(0);
    expect(listWebRtcStreams()).toHaveLength(0);
  });

  test("passes audio config to publisher/source and routes PCM audio chunks", async () => {
    const publishers: FakePublisher[] = [];
    let capturedSourceOptions:
      | Parameters<NonNullable<Parameters<typeof setWebRtcStreamManagerDependencies>[0]["createSource"]>>[0]
      | undefined;
    let capturedJarPath: string | null | undefined;
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) => {
        const publisher = new FakePublisher(config, deps);
        publishers.push(publisher);
        return publisher as unknown as WebRtcPublisher;
      },
      createSource: (options, jarPath) => {
        capturedSourceOptions = options;
        capturedJarPath = jarPath;
        return new FakeSource() as unknown as AndroidH264Source;
      },
      resolveVideoJar: async () => "/verified/automobile-video.jar",
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT, audioEnabled: true },
    });

    expect((publishers[0].config as { audioEnabled?: boolean }).audioEnabled).toBe(true);
    expect(capturedSourceOptions?.audioEnabled).toBe(true);
    expect(capturedJarPath).toBe("/verified/automobile-video.jar");

    capturedSourceOptions?.onAudioData?.(Buffer.from([1, 2, 3, 4]));
    expect(publishers[0].pcmAudioChunks).toEqual([Buffer.from([1, 2, 3, 4])]);
  });

  test("threads the resolved iOS Simulator fps into the capture source options", async () => {
    let capturedSourceOptions:
      | Parameters<NonNullable<Parameters<typeof setWebRtcStreamManagerDependencies>[0]["createSource"]>>[0]
      | undefined;
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) => new FakePublisher(config, deps) as unknown as WebRtcPublisher,
      createSource: options => {
        capturedSourceOptions = options;
        return new FakeSource() as unknown as AndroidH264Source;
      },
      resolveVideoJar: async () => null,
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });

    await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT, iosSimulatorFps: 24 },
    });

    expect(capturedSourceOptions?.fps).toBe(24);
  });

  test("rejects audio stream start when the initial async source start fails", async () => {
    const publishers: AsyncConnectedPublisher[] = [];
    const sources: FakeSource[] = [];
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) => {
        const publisher = new AsyncConnectedPublisher(config, deps);
        publishers.push(publisher);
        return publisher as unknown as WebRtcPublisher;
      },
      createSource: () => {
        const source = new FakeSource();
        source.start = async () => {
          source.started = true;
          throw new Error("REMOTE_SUBMIX failed");
        };
        sources.push(source);
        return source as unknown as AndroidH264Source;
      },
      resolveVideoJar: async () => "/verified/automobile-video.jar",
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    await expect(
      startWebRtcStream({
        device: ANDROID,
        overrides: { whipEndpoint: ENDPOINT, audioEnabled: true },
      })
    ).rejects.toThrow(/REMOTE_SUBMIX failed/);

    expect(sources).toHaveLength(1);
    expect(sources[0].started).toBe(true);
    expect(sources[0].stopped).toBe(true);
    expect(publishers[0].stopped).toBe(true);
    expect(publishers[0].sourceFailedCount).toBe(1);
    expect(listWebRtcStreams()).toHaveLength(0);
  });

  test("failed async audio startup cleanup does not delete a replacement stream with the same id", async () => {
    const publishers: AsyncConnectedPublisher[] = [];
    const sources: FakeSource[] = [];
    let firstStartReject: ((error: Error) => void) | undefined;
    let firstSourceStarted!: () => void;
    const firstSourceStartedPromise = new Promise<void>(resolve => {
      firstSourceStarted = resolve;
    });
    let createSourceCalls = 0;
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) => {
        const publisher = new AsyncConnectedPublisher(config, deps);
        publishers.push(publisher);
        return publisher as unknown as WebRtcPublisher;
      },
      createSource: () => {
        createSourceCalls++;
        const source = new FakeSource();
        if (createSourceCalls === 1) {
          source.start = async () => {
            source.started = true;
            firstSourceStarted();
            await new Promise<void>((_resolve, reject) => {
              firstStartReject = reject;
            });
          };
        }
        sources.push(source);
        return source as unknown as AndroidH264Source;
      },
      resolveVideoJar: async () => "/verified/automobile-video.jar",
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    const firstStart = startWebRtcStream({
      device: ANDROID,
      streamId: "replace-me",
      overrides: { whipEndpoint: ENDPOINT, audioEnabled: true },
    });
    await firstSourceStartedPromise;
    expect(listWebRtcStreams().map(stream => stream.streamId)).toEqual(["replace-me"]);

    await stopWebRtcStream("replace-me");
    const replacement = await startWebRtcStream({
      device: ANDROID,
      streamId: "replace-me",
      overrides: { whipEndpoint: ENDPOINT, audioEnabled: true },
    });

    firstStartReject?.(new Error("REMOTE_SUBMIX failed after replacement"));
    await expect(firstStart).rejects.toThrow(/REMOTE_SUBMIX failed after replacement/);

    expect(replacement.streamId).toBe("replace-me");
    expect(getWebRtcStreamDescriptor("replace-me")?.streamId).toBe("replace-me");
    expect(listWebRtcStreams().map(stream => stream.streamId)).toEqual(["replace-me"]);
    expect(publishers[1].stopped).toBe(false);
    expect(sources[1].stopped).toBe(false);
  });
});
