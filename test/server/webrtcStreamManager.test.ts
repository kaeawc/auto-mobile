import { afterEach, describe, expect, test } from "bun:test";
import {
  getWebRtcStreamDescriptor,
  listWebRtcStreams,
  resetWebRtcStreamManager,
  setWebRtcStreamManagerDependencies,
  startWebRtcStream,
  stopWebRtcStream,
  waitForWebRtcStreamReadiness,
  WEBRTC_STREAM_LEASE_TTL_MS,
  type WebRtcStreamManagerDependencies,
} from "../../src/server/webrtcStreamManager";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { ActionableError, type BootedDevice } from "../../src/models";
import type {
  AndroidH264Source,
  H264CaptureSourceMetrics,
  WebRtcPublisher,
  WebRtcPublisherLifecycleEvent,
  WebRtcStreamDescriptor,
} from "../../src/features/webrtc";

const ANDROID: BootedDevice = {
  deviceId: "emulator-5554",
  platform: "android",
  name: "a",
} as BootedDevice;
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
  onKeyFrameRequest?: () => boolean;
  onSourceFailure?: (error: Error) => void;
  onLifecycleEvent?: (event: WebRtcPublisherLifecycleEvent) => void;
  parameterSetPrimes: Array<{ sps: Buffer | null; pps: Buffer | null }> = [];
  constructor(
    public readonly config: { streamId: string; whipEndpoint: string },
    deps: {
      onBeforeEstablish?: () => Promise<void> | void;
      onConnected?: () => Promise<void> | void;
      onKeyFrameRequest?: () => boolean;
      onSourceFailure?: (error: Error) => void;
      onLifecycleEvent?: (event: WebRtcPublisherLifecycleEvent) => void;
    },
  ) {
    this.onBeforeEstablish = deps.onBeforeEstablish;
    this.onConnected = deps.onConnected;
    this.onKeyFrameRequest = deps.onKeyFrameRequest;
    this.onSourceFailure = deps.onSourceFailure;
    this.onLifecycleEvent = deps.onLifecycleEvent;
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
  primeH264ParameterSets(sps: Buffer | null, pps: Buffer | null): void {
    this.parameterSetPrimes.push({ sps, pps });
  }
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
  keyFrameRequests = 0;
  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  requestKeyFrame(): boolean {
    this.keyFrameRequests++;
    return true;
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

async function flushPublisherStart(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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
    expect(descriptor.lifecycleState).toBe("capture_ready");
    await flushPublisherStart();
    expect(publishers[0].started).toBe(true);
    // onBeforeEstablish started the capture source.
    expect(sources[0].started).toBe(true);
    expect(listWebRtcStreams()).toHaveLength(1);
    expect(descriptor.readiness.captureSourceState).toBe("running");
    expect(descriptor.readiness.lastSourceError).toBeNull();
  });

  test("relays a downstream keyframe request (WHEP viewer PLI) to the capture source", async () => {
    const { publishers, sources } = installFakes();
    await startWebRtcStream({ device: IOS, overrides: { whipEndpoint: ENDPOINT } });
    await flushPublisherStart();

    // Warm capture asks for an IDR after the WHIP connection attaches.
    expect(sources[0].keyFrameRequests).toBe(1);
    // Simulate the publisher relaying a viewer PLI up to the manager.
    publishers[0].onKeyFrameRequest?.();
    expect(sources[0].keyFrameRequests).toBe(2);
  });

  test("reuses a capture source when a second consumer starts the same device", async () => {
    const { publishers, sources } = installFakes();
    const first = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    const second = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });

    expect(second.streamId).toBe(first.streamId);
    expect(second.consumerCount).toBe(2);
    expect(second.lease?.id).not.toBe(first.lease?.id);
    expect(publishers).toHaveLength(1);
    expect(sources).toHaveLength(1);
  });

  test("adds a second lease while asynchronous jar resolution is pending", async () => {
    let releaseJar: ((path: string | null) => void) | undefined;
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) =>
        new FakePublisher(config, deps) as unknown as WebRtcPublisher,
      createSource: () => new FakeSource() as unknown as AndroidH264Source,
      resolveVideoJar: () =>
        new Promise((resolve) => {
          releaseJar = resolve;
        }),
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    const first = startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } });
    const second = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });

    releaseJar?.(null);
    const descriptor = await first;
    expect(second.streamId).toBe(descriptor.streamId);
    expect(second.consumerCount).toBe(2);
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
      resolveVideoJar: () =>
        new Promise((resolve) => {
          releaseJar = resolve;
        }),
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    const starting = startWebRtcStream({
      device: ANDROID,
      streamId: "pending-stop",
      overrides: { whipEndpoint: ENDPOINT },
    });
    const stopped = await stopWebRtcStream("pending-stop");
    releaseJar?.(null);

    expect((await starting).state).toBe("stopped");
    expect(stopped.state).toBe("stopped");
    expect(publishersCreated).toBe(1);
    expect(listWebRtcStreams()).toEqual([]);
  });

  test("rejects a duplicate explicit streamId (even on a different device)", async () => {
    installFakes();
    const other: BootedDevice = {
      deviceId: "emulator-5556",
      platform: "android",
      name: "b",
    } as BootedDevice;
    await startWebRtcStream({
      device: ANDROID,
      streamId: "dup",
      overrides: { whipEndpoint: ENDPOINT },
    });
    await expect(
      startWebRtcStream({ device: other, streamId: "dup", overrides: { whipEndpoint: ENDPOINT } }),
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
    await expect(startWebRtcStream({ device: ANDROID, overrides: {} })).rejects.toThrow(
      /WHIP endpoint/,
    );
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
      resolveVideoJar: () =>
        new Promise((resolve) => {
          releaseJar = resolve;
        }),
    });
    const pending = startWebRtcStream({ device: IOS, overrides: { whipEndpoint: ENDPOINT } });

    await expect(stopWebRtcStream()).rejects.toThrow(/Provide a streamId/);
    releaseJar?.(null);
    await pending;
  });

  test("rejects audio startup promptly when stopped before the publisher connects", async () => {
    let releaseStart: (() => void) | undefined;
    let enteredStart: (() => void) | undefined;
    const startEntered = new Promise<void>((resolve) => {
      enteredStart = resolve;
    });
    const allowStartToReturn = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
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

    expect((await starting).lifecycleState).toBe("capture_ready");
  });

  test("does not leave an orphaned source when the stream is stopped mid-start", async () => {
    // A source whose start() stops the stream (simulating stopWebRtcStream racing
    // the async onConnected startup path). The manager must re-check ownership
    // after the await and tear the just-started source down instead of leaking it.
    const sources: FakeSource[] = [];
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) =>
        new FakePublisher(config, deps) as unknown as WebRtcPublisher,
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

    expect(
      (
        await startWebRtcStream({
          device: ANDROID,
          streamId: "race",
          overrides: { whipEndpoint: ENDPOINT },
        })
      ).state,
    ).toBe("stopped");

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
      createSource: (options) => {
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
    await flushPublisherStart();
    const descriptor = getWebRtcStreamDescriptor("webrtc_id-1");
    expect(descriptor?.lifecycleState).toBe("degraded");
    expect(descriptor?.failure?.code).toBe("capture_runtime_failed");
    expect(descriptor?.fallback).toEqual({ mode: "screenshots", reason: "capture_runtime_failed" });
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
      createPublisher: (config, deps) =>
        new FakePublisher(config, deps) as unknown as WebRtcPublisher,
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
      createPublisher: (config, deps) =>
        new FakePublisher(config, deps) as unknown as WebRtcPublisher,
      createSource: (_options, jarPath) => {
        jarPaths.push(jarPath);
        return new FakeSource() as unknown as AndroidH264Source;
      },
      resolveVideoJar: async () => null,
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    const descriptor = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    expect(descriptor.streamId).toBeDefined();
    expect(jarPaths).toEqual([null]);
  });

  test("a fatal jar fail-mode returns a typed screenshot fallback", async () => {
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

    const descriptor = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    expect(descriptor.failure?.message).toContain("checksum verification failed");
    expect(descriptor.fallback).toEqual({ mode: "screenshots", reason: "capture_start_failed" });
    expect(publisherCreated).toBe(1);
    expect(listWebRtcStreams()).toHaveLength(1);
  });

  test("passes audio config to publisher/source and routes PCM audio chunks", async () => {
    const publishers: FakePublisher[] = [];
    let capturedSourceOptions:
      | Parameters<
          NonNullable<Parameters<typeof setWebRtcStreamManagerDependencies>[0]["createSource"]>
        >[0]
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

  test("surfaces capture pipeline metrics on the live stream descriptor", async () => {
    let sourceOptions:
      | Parameters<
          NonNullable<Parameters<typeof setWebRtcStreamManagerDependencies>[0]["createSource"]>
        >[0]
      | undefined;
    const metrics: H264CaptureSourceMetrics = {
      native: {
        captureTimestampMs: 10,
        frameQueueAgeMs: 20,
        frameQueueDepth: 1,
        droppedFrames: 1,
        bytesQueued: 2,
        highWaterMarkBytes: 3,
        lastOutputWriteDurationMs: 4,
      },
      helper: null,
      encoder: {
        captureTimestampMs: 5,
        frameAgeMs: null,
        queueDepth: 0,
        droppedFrames: 6,
        bytesQueued: 0,
        highWaterMarkBytes: 7,
        maxFrameBytes: 8,
        outputWriteDurationMs: 9,
        outputWriteHighWaterDurationMs: 10,
      },
    };
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) =>
        new FakePublisher(config, deps) as unknown as WebRtcPublisher,
      createSource: (options) => {
        sourceOptions = options;
        return new FakeSource() as unknown as AndroidH264Source;
      },
      resolveVideoJar: async () => null,
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    const descriptor = await startWebRtcStream({
      device: IOS,
      overrides: { whipEndpoint: ENDPOINT },
    });
    sourceOptions?.onFrameMetrics?.(metrics);

    expect(getWebRtcStreamDescriptor(descriptor.streamId)?.frameMetrics).toEqual(metrics);
    expect(listWebRtcStreams()[0].frameMetrics).toEqual(metrics);
  });

  test("threads the resolved Android fps into the capture source options", async () => {
    let capturedSourceOptions:
      | Parameters<
          NonNullable<Parameters<typeof setWebRtcStreamManagerDependencies>[0]["createSource"]>
        >[0]
      | undefined;
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) =>
        new FakePublisher(config, deps) as unknown as WebRtcPublisher,
      createSource: (options) => {
        capturedSourceOptions = options;
        return new FakeSource() as unknown as AndroidH264Source;
      },
      resolveVideoJar: async () => null,
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });

    await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT, androidFps: 24 },
    });

    // Android takes its capture rate from androidFps, not the iOS-tuned default.
    expect(capturedSourceOptions?.fps).toBe(24);
  });

  test("threads the resolved iOS Simulator fps into the capture source options", async () => {
    let capturedSourceOptions:
      | Parameters<
          NonNullable<Parameters<typeof setWebRtcStreamManagerDependencies>[0]["createSource"]>
        >[0]
      | undefined;
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) =>
        new FakePublisher(config, deps) as unknown as WebRtcPublisher,
      createSource: (options) => {
        capturedSourceOptions = options;
        return new FakeSource() as unknown as AndroidH264Source;
      },
      resolveVideoJar: async () => null,
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });

    await startWebRtcStream({
      device: IOS,
      overrides: { whipEndpoint: ENDPOINT, iosSimulatorFps: 24 },
    });

    expect(capturedSourceOptions?.fps).toBe(24);
  });

  test("reports a typed fallback when the initial audio source start fails", async () => {
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

    const descriptor = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT, audioEnabled: true },
    });

    expect(descriptor.failure?.message).toContain("REMOTE_SUBMIX failed");
    expect(sources).toHaveLength(1);
    expect(sources[0].started).toBe(true);
    expect(sources[0].stopped).toBe(true);
    expect(publishers[0].stopped).toBe(true);
    expect(publishers[0].sourceFailedCount).toBe(1);
    expect(listWebRtcStreams()).toHaveLength(1);
  });

  test("failed async audio startup cleanup does not delete a replacement stream with the same id", async () => {
    const publishers: AsyncConnectedPublisher[] = [];
    const sources: FakeSource[] = [];
    let firstStartReject: ((error: Error) => void) | undefined;
    let firstSourceStarted!: () => void;
    const firstSourceStartedPromise = new Promise<void>((resolve) => {
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
    expect(listWebRtcStreams().map((stream) => stream.streamId)).toEqual(["replace-me"]);

    await stopWebRtcStream("replace-me");
    const replacement = await startWebRtcStream({
      device: ANDROID,
      streamId: "replace-me",
      overrides: { whipEndpoint: ENDPOINT, audioEnabled: true },
    });

    firstStartReject?.(new Error("REMOTE_SUBMIX failed after replacement"));
    expect((await firstStart).state).toBe("stopped");

    expect(replacement.streamId).toBe("replace-me");
    expect(getWebRtcStreamDescriptor("replace-me")?.streamId).toBe("replace-me");
    expect(listWebRtcStreams().map((stream) => stream.streamId)).toEqual(["replace-me"]);
    expect(publishers[1].stopped).toBe(false);
    expect(sources[1].stopped).toBe(false);
  });

  test("reports sourceStarted only once the capture source has actually started (#4343)", async () => {
    const publishers: AsyncConnectedPublisher[] = [];
    const sources: FakeSource[] = [];
    let releaseSourceStart!: () => void;
    const sourceStartGate = new Promise<void>((resolve) => {
      releaseSourceStart = resolve;
    });
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
          await sourceStartGate;
          source.started = true;
        };
        sources.push(source);
        return source as unknown as AndroidH264Source;
      },
      resolveVideoJar: async () => null,
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    // Capture is prepared before WHIP, so callers can await it while signaling
    // remains blocked.
    const starting = startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    await Promise.resolve();
    const pending = listWebRtcStreams()[0];
    expect(pending.sourceStarted).toBe(false);

    releaseSourceStart();
    const descriptor = await starting;

    expect(sources[0].started).toBe(true);
    expect(getWebRtcStreamDescriptor(descriptor.streamId)?.sourceStarted).toBe(true);
    expect(listWebRtcStreams()[0].sourceStarted).toBe(true);
  });

  test("prepares capture before WHIP and keeps it warm through a signaling reconnect", async () => {
    const { publishers, sources } = installFakes();
    let releasePublish!: () => void;
    let publisherEntered!: () => void;
    const publishEntered = new Promise<void>((resolve) => {
      publisherEntered = resolve;
    });
    const publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    publishers.length = 0;
    setWebRtcStreamManagerDependencies({
      createPublisher: (config, deps) => {
        const publisher = new FakePublisher(config, deps);
        publisher.start = async () => {
          await publisher.onBeforeEstablish?.();
          publisherEntered();
          await publishGate;
          publisher.started = true;
        };
        publishers.push(publisher);
        return publisher as unknown as WebRtcPublisher;
      },
    });

    const starting = startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } });
    await publishEntered;

    const captureReady = await waitForWebRtcStreamReadiness("webrtc_id-1", "capture_ready", 100);
    expect(captureReady.lifecycleState).toBe("capture_ready");
    expect(captureReady.sourceStarted).toBe(true);
    expect(sources).toHaveLength(1);

    releasePublish();
    await starting;
    await publishers[0].onBeforeEstablish?.();

    expect(sources).toHaveLength(1);
    expect(sources[0].stopped).toBe(false);
  });

  test("does not report publishing until ICE connects", async () => {
    const { publishers } = installFakes();
    setWebRtcStreamManagerDependencies({
      createPublisher: (config, deps) => {
        const publisher = new FakePublisher(config, deps);
        publisher.start = async () => {
          await publisher.onBeforeEstablish?.();
          publisher.started = true;
        };
        publishers.push(publisher);
        return publisher as unknown as WebRtcPublisher;
      },
    });

    const started = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    publishers[0].onLifecycleEvent?.("whip_answer_received");
    expect(getWebRtcStreamDescriptor(started.streamId)?.lifecycleState).toBe("capture_ready");

    await publishers[0].onConnected?.();
    expect(getWebRtcStreamDescriptor(started.streamId)?.lifecycleState).toBe("publishing");
  });

  test("reports a packetization failure as a typed fallback and recreates capture on reconnect", async () => {
    const { publishers, sources } = installFakes();
    const started = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    await flushPublisherStart();

    publishers[0].onSourceFailure?.(new Error("H.264 SPS profile 6400 is incompatible"));
    const degraded = getWebRtcStreamDescriptor(started.streamId);
    expect(degraded?.lifecycleState).toBe("degraded");
    expect(degraded?.failure?.code).toBe("capture_runtime_failed");
    expect(degraded?.fallback).toEqual({ mode: "screenshots", reason: "capture_runtime_failed" });

    await publishers[0].onBeforeEstablish?.();
    expect(sources).toHaveLength(2);
    expect(sources[0].stopped).toBe(true);
  });

  test("discards partial media from a replaced capture source", async () => {
    const publishers: FakePublisher[] = [];
    const sourceOptions: Array<Parameters<WebRtcStreamManagerDependencies["createSource"]>[0]> = [];
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) => {
        const publisher = new FakePublisher(config, deps);
        publishers.push(publisher);
        return publisher as unknown as WebRtcPublisher;
      },
      createSource: (options) => {
        sourceOptions.push(options);
        return new FakeSource() as unknown as AndroidH264Source;
      },
      resolveVideoJar: async () => null,
    });

    await startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } });
    await flushPublisherStart();
    // A source can die mid-SPS. Its bytes must not become the replacement
    // source's cached codec configuration after reconnection.
    sourceOptions[0].onData(Buffer.from([0, 0, 0, 1, 0x67, 0x42]));
    publishers[0].onSourceFailure?.(new Error("encoder wedged"));
    await publishers[0].onBeforeEstablish?.();
    sourceOptions[1].onData(Buffer.from([0, 0, 0, 1, 0x65, 0x80, 0, 0, 0, 1, 0x41, 0x80]));
    await publishers[0].onConnected?.();

    expect(publishers[0].parameterSetPrimes.at(-1)).toEqual({ sps: null, pps: null });
  });

  test("replays warm-source codec configuration when the publisher attaches", async () => {
    const publishers: FakePublisher[] = [];
    let sourceOptions!: Parameters<NonNullable<WebRtcStreamManagerDependencies["createSource"]>>[0];
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) => {
        const publisher = new FakePublisher(config, deps);
        publisher.start = async () => {
          await publisher.onBeforeEstablish?.();
          publisher.started = true;
        };
        publishers.push(publisher);
        return publisher as unknown as WebRtcPublisher;
      },
      createSource: (options) => {
        sourceOptions = options;
        return new FakeSource() as unknown as AndroidH264Source;
      },
      resolveVideoJar: async () => "/verified/automobile-video.jar",
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    await startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } });
    const sps = Buffer.from([0x67, 0x42, 0xe0, 0x2a]);
    const pps = Buffer.from([0x68, 0xce, 0x06, 0xe2]);
    sourceOptions.onData(
      Buffer.concat([
        Buffer.from([0, 0, 0, 1]),
        sps,
        Buffer.from([0, 0, 0, 1]),
        pps,
        Buffer.from([0, 0, 0, 1]),
        Buffer.from([0x65, 0x88]),
        Buffer.from([0, 0, 0, 1]),
        Buffer.from([0x41, 0x00]),
      ]),
    );

    await publishers[0].onConnected?.();
    expect(publishers[0].parameterSetPrimes).toEqual([{ sps, pps }]);
  });

  test("returns a request-scoped readiness timeout without degrading the capture", async () => {
    const timer = new FakeTimer();
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) => {
        const publisher = new FakePublisher(config, deps);
        publisher.start = async () => {
          await publisher.onBeforeEstablish?.();
        };
        return publisher as unknown as WebRtcPublisher;
      },
      createSource: () => new FakeSource() as unknown as AndroidH264Source,
      resolveVideoJar: async () => null,
      timer,
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    const started = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    const timedOut = waitForWebRtcStreamReadiness(
      started.streamId,
      "publishing",
      1,
      started.lease?.id,
    );
    await Promise.resolve();
    timer.advanceTime(1);

    const result = await timedOut;
    expect(result.failure?.code).toBe("publishing_timeout");
    expect(result.fallback).toBeNull();
    expect(getWebRtcStreamDescriptor(started.streamId)?.lifecycleState).toBe("capture_ready");
    expect(getWebRtcStreamDescriptor(started.streamId)?.failure).toBeNull();
  });

  test("renews a waiting lease before its capture TTL expires", async () => {
    const timer = new FakeTimer();
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) => {
        const publisher = new FakePublisher(config, deps);
        publisher.start = async () => {
          await publisher.onBeforeEstablish?.();
        };
        return publisher as unknown as WebRtcPublisher;
      },
      createSource: () => new FakeSource() as unknown as AndroidH264Source,
      resolveVideoJar: async () => null,
      timer,
    });
    const started = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    const waiting = waitForWebRtcStreamReadiness(
      started.streamId,
      "publishing",
      WEBRTC_STREAM_LEASE_TTL_MS * 2,
      started.lease?.id,
    );

    for (let interval = 0; interval < 4; interval++) {
      timer.advanceTime(WEBRTC_STREAM_LEASE_TTL_MS / 2);
      await flushPublisherStart();
    }

    const timedOut = await waiting;
    expect(timedOut.failure?.code).toBe("publishing_timeout");
    expect(listWebRtcStreams()).toHaveLength(1);
  });

  test("renews an owned lease through a status descriptor before capture expiry", async () => {
    const timer = new FakeTimer();
    const { publishers, sources } = installFakes();
    setWebRtcStreamManagerDependencies({ timer });

    const started = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    expect(started.lease?.id).toBeDefined();

    timer.advanceTime(WEBRTC_STREAM_LEASE_TTL_MS - 1);
    const renewed = getWebRtcStreamDescriptor(started.streamId, started.lease?.id);
    expect(renewed?.lease?.id).toBe(started.lease?.id);

    // The original deadline has passed, but the status heartbeat retained the
    // manager-owned source for another lease interval.
    timer.advanceTime(1);
    await flushPublisherStart();
    expect(listWebRtcStreams()).toHaveLength(1);
    expect(publishers[0].stopped).toBe(false);
    expect(sources[0].stopped).toBe(false);

    timer.advanceTime(WEBRTC_STREAM_LEASE_TTL_MS - 2);
    expect(listWebRtcStreams()).toHaveLength(1);
    timer.advanceTime(1);
    await flushPublisherStart();
    expect(listWebRtcStreams()).toEqual([]);
    expect(publishers[0].stopped).toBe(true);
    expect(sources[0].stopped).toBe(true);
  });

  test("returns a typed stopped result when a waiting stream is stopped", async () => {
    const timer = new FakeTimer();
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) => {
        const publisher = new FakePublisher(config, deps);
        publisher.start = async () => {
          await publisher.onBeforeEstablish?.();
        };
        return publisher as unknown as WebRtcPublisher;
      },
      createSource: () => new FakeSource() as unknown as AndroidH264Source,
      resolveVideoJar: async () => null,
      timer,
    });
    const started = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    const waiting = waitForWebRtcStreamReadiness(
      started.streamId,
      "publishing",
      1_000,
      started.lease?.id,
    );
    await Promise.resolve();
    await stopWebRtcStream(started.streamId);

    const stopped = await waiting;
    expect(stopped.state).toBe("stopped");
    expect(stopped.failure?.code).toBe("stopped");
  });

  test("expires the final lease and stops only that manager-owned capture", async () => {
    const timer = new FakeTimer();
    const { publishers, sources } = installFakes();
    setWebRtcStreamManagerDependencies({ timer });

    await startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } });
    timer.advanceTime(WEBRTC_STREAM_LEASE_TTL_MS);
    await flushPublisherStart();

    expect(listWebRtcStreams()).toEqual([]);
    expect(publishers[0].stopped).toBe(true);
    expect(sources[0].stopped).toBe(true);
  });

  test("reports capture failure as a typed screenshot fallback", async () => {
    let sourceOptions!: Parameters<NonNullable<WebRtcStreamManagerDependencies["createSource"]>>[0];
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) =>
        new FakePublisher(config, deps) as unknown as WebRtcPublisher,
      createSource: (options) => {
        sourceOptions = options;
        return new FakeSource() as unknown as AndroidH264Source;
      },
      resolveVideoJar: async () => null,
    });

    const started = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    sourceOptions.onError?.(new Error("adb forward lost"));

    const degraded = await waitForWebRtcStreamReadiness(started.streamId, "publishing", 100);
    expect(degraded.lifecycleState).toBe("degraded");
    expect(degraded.failure?.code).toBe("capture_runtime_failed");
    expect(degraded.fallback).toEqual({ mode: "screenshots", reason: "capture_runtime_failed" });
  });
});
