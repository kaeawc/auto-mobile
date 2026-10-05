import { createDeviceCaptureRegistry } from "../../src/features/webrtc/deviceCaptureRegistry";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as manager from "../../src/server/webrtcStreamManager";
import { logger } from "../../src/utils/logger";
import { createWebRtcStreamDeviceIncarnationListener } from "../../src/server/webrtcStreamIncarnationListener";
import {
  getWebRtcStreamDescriptor,
  listWebRtcStreams,
  resetWebRtcStreamManager,
  setWebRtcStreamManagerDependencies,
  startWebRtcStream,
  stopWebRtcStream,
  endWebRtcStreamsForDevice,
  reconcileWebRtcStreamsForDeviceOwnership,
  stopAllWebRtcStreams,
  WEBRTC_STREAM_STOP_TIMEOUT_MS,
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
  stopCalls = 0;
  keyFrameRequests = 0;
  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopCalls++;
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

beforeEach(() => {
  setWebRtcStreamManagerDependencies({
    timer: new FakeTimer(),
    captureRegistry: createDeviceCaptureRegistry(),
  });
});

afterEach(() => {
  resetWebRtcStreamManager();
});

describe("webrtcStreamManager", () => {
  for (const boundary of ["ownership", "incarnation", "device", "shutdown"] as const) {
    test(`${boundary} cleanup claims streams before explicit stop and lease expiry`, async () => {
      const { sources } = installFakes();
      const timer = new FakeTimer();
      setWebRtcStreamManagerDependencies({ timer });
      const stream = await startWebRtcStream({
        device: ANDROID,
        sessionUuid: "released",
        overrides: { whipEndpoint: ENDPOINT },
      });
      await startWebRtcStream({
        device: IOS,
        sessionUuid: "other",
        overrides: { whipEndpoint: ENDPOINT },
      });
      const listener = createWebRtcStreamDeviceIncarnationListener();
      const cleanup =
        boundary === "ownership"
          ? reconcileWebRtcStreamsForDeviceOwnership(ANDROID.deviceId, () => ({
              authEnabled: true,
              sessionExists: false,
              ownsDevice: false,
            }))
          : boundary === "incarnation"
            ? Promise.resolve(listener.prepareForIncarnationChange?.(ANDROID.deviceId))
            : boundary === "device"
              ? endWebRtcStreamsForDevice({ deviceId: ANDROID.deviceId, reason: "device_removed" })
              : stopAllWebRtcStreams("daemon_shutdown");
      expect(sources[0].stopCalls).toBe(1);
      await expect(stopWebRtcStream(stream.streamId)).rejects.toThrow(ActionableError);
      await cleanup;
      await listener.onDeviceIncarnationChanged(ANDROID.deviceId);
      await cleanup;
      expect(sources[1].stopCalls).toBe(boundary === "shutdown" ? 1 : 0);
      timer.advanceTime(WEBRTC_STREAM_LEASE_TTL_MS);
      await flushPublisherStart();
      expect(sources[0].stopCalls).toBe(1);
    });
  }

  test("ownership revokes only unauthorized leases and retains anonymous leases", async () => {
    const { sources } = installFakes();
    const timer = new FakeTimer();
    setWebRtcStreamManagerDependencies({ timer, isSessionLive: () => true });
    const stream = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "released",
      overrides: { whipEndpoint: ENDPOINT },
    });
    await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "owner",
      overrides: { whipEndpoint: ENDPOINT },
    });
    await startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } });
    await startWebRtcStream({
      device: IOS,
      sessionUuid: "released",
      overrides: { whipEndpoint: ENDPOINT },
    });
    await reconcileWebRtcStreamsForDeviceOwnership(ANDROID.deviceId, (session) => ({
      authEnabled: true,
      sessionExists: session === "owner",
      ownsDevice: session === "owner",
    }));
    expect(getWebRtcStreamDescriptor(stream.streamId)?.consumerCount).toBe(2);
    expect(() => getWebRtcStreamDescriptor(stream.streamId, stream.lease?.id, "released")).toThrow(
      ActionableError,
    );
    expect(sources.map((source) => source.stopCalls)).toEqual([0, 0]);
    await reconcileWebRtcStreamsForDeviceOwnership(ANDROID.deviceId, () => ({
      authEnabled: true,
      sessionExists: false,
      ownsDevice: false,
    }));
    expect(getWebRtcStreamDescriptor(stream.streamId)?.consumerCount).toBe(1);
    expect(timer.getPendingTimeouts()).toEqual([
      WEBRTC_STREAM_LEASE_TTL_MS,
      WEBRTC_STREAM_LEASE_TTL_MS,
    ]);
  });

  test("explicit stop claims before lifecycle cleanup", async () => {
    const { sources } = installFakes();
    const timer = new FakeTimer();
    setWebRtcStreamManagerDependencies({ timer });
    const stream = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    const stop = stopWebRtcStream(stream.streamId);
    await endWebRtcStreamsForDevice({ deviceId: ANDROID.deviceId, reason: "device_removed" });
    await stop;
    timer.advanceTime(WEBRTC_STREAM_LEASE_TTL_MS);
    expect(sources[0].stopCalls).toBe(1);
  });

  test("an already queued lease callback cannot stop a lifecycle-claimed source twice", async () => {
    class QueuedTimer extends FakeTimer {
      callbacks: Array<() => void> = [];
      override setTimeout(callback: () => void, ms: number): NodeJS.Timeout {
        this.callbacks.push(callback);
        return super.setTimeout(callback, ms);
      }
    }
    const { sources } = installFakes();
    const timer = new QueuedTimer();
    setWebRtcStreamManagerDependencies({ timer });
    await startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } });
    const expiry = timer.callbacks[0];
    await endWebRtcStreamsForDevice({ deviceId: ANDROID.deviceId, reason: "device_removed" });
    expiry();
    expect(sources[0].stopCalls).toBe(1);
  });

  test("lifecycle cleanup during source startup retires its late completion exactly once", async () => {
    const { sources } = installFakes();
    setWebRtcStreamManagerDependencies({
      timer: new FakeTimer(),
      createSource: () => {
        const source = new FakeSource();
        source.start = async () => {
          source.started = true;
          await endWebRtcStreamsForDevice({ deviceId: ANDROID.deviceId, reason: "device_removed" });
        };
        sources.push(source);
        return source as unknown as AndroidH264Source;
      },
    });
    const stream = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    expect(stream.state).toBe("stopped");
    expect(sources[0].stopCalls).toBe(1);
    expect(listWebRtcStreams()).toEqual([]);
  });

  test("hung source cleanup is concurrent and bounded, and warns instead of throwing", async () => {
    const { sources, publishers } = installFakes();
    const timer = new FakeTimer();
    setWebRtcStreamManagerDependencies({ timer });
    await startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } });
    await startWebRtcStream({ device: IOS, overrides: { whipEndpoint: ENDPOINT } });
    sources[0].stop = () => {
      sources[0].stopCalls++;
      return new Promise<void>(() => {});
    };
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      let settled = false;
      const cleanup = stopAllWebRtcStreams("daemon_shutdown").then(() => {
        settled = true;
      });
      await flushPublisherStart();
      expect(sources.map((source) => source.stopCalls)).toEqual([1, 1]);
      expect(publishers.every((publisher) => publisher.stopped)).toBe(true);
      timer.advanceTime(WEBRTC_STREAM_STOP_TIMEOUT_MS - 1);
      await flushPublisherStart();
      expect(settled).toBe(false);
      timer.advanceTime(1);
      await cleanup;
      expect(warn).toHaveBeenCalled();
      expect(listWebRtcStreams()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("rejects another live session renewing an owned lease", async () => {
    installFakes();
    setWebRtcStreamManagerDependencies({ isSessionLive: () => true });
    const started = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "session-a",
      overrides: { whipEndpoint: ENDPOINT },
    });

    expect(() =>
      getWebRtcStreamDescriptor(started.streamId, started.lease?.id, "session-b"),
    ).toThrow(ActionableError);
    expect(getWebRtcStreamDescriptor(started.streamId)?.consumerCount).toBe(1);
    await expect(
      waitForWebRtcStreamReadiness(
        started.streamId,
        "capture_ready",
        100,
        started.lease?.id,
        "session-b",
      ),
    ).rejects.toThrow(ActionableError);
    await expect(
      stopWebRtcStream(started.streamId, started.lease?.id, "session-b"),
    ).rejects.toThrow(ActionableError);
    expect((await stopWebRtcStream(started.streamId, undefined, "session-b")).consumerCount).toBe(
      1,
    );
    expect(getWebRtcStreamDescriptor(started.streamId)?.consumerCount).toBe(1);
  });

  test("lease-less stop releases caller and unowned leases while another live owner continues", async () => {
    const timer = new FakeTimer();
    const { publishers } = installFakes();
    setWebRtcStreamManagerDependencies({ timer, isSessionLive: () => true });
    const own = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "session-a",
      overrides: { whipEndpoint: ENDPOINT },
    });
    const unowned = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    const foreign = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "session-b",
      overrides: { whipEndpoint: ENDPOINT },
    });

    const detached = await stopWebRtcStream(own.streamId, undefined, "session-a");
    expect(detached.consumerCount).toBe(1);
    expect(listWebRtcStreams()).toHaveLength(1);
    expect(publishers[0].stopped).toBe(false);
    expect(() => getWebRtcStreamDescriptor(own.streamId, own.lease?.id)).toThrow(ActionableError);
    expect(() => getWebRtcStreamDescriptor(own.streamId, unowned.lease?.id)).toThrow(
      ActionableError,
    );
    expect(getWebRtcStreamDescriptor(own.streamId, foreign.lease?.id, "session-b")?.lease?.id).toBe(
      foreign.lease?.id,
    );

    const stopped = await stopWebRtcStream(own.streamId, undefined, "session-b");
    expect(stopped.state).toBe("stopped");
    expect(stopped.consumerCount).toBe(0);
    expect(publishers[0].stopped).toBe(true);
    expect(listWebRtcStreams()).toHaveLength(0);
  });

  test("lease-less stop leaves dead foreign leases for teardown without deleting them", async () => {
    installFakes();
    setWebRtcStreamManagerDependencies({ isSessionLive: () => false });
    const foreign = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "session-b",
      overrides: { whipEndpoint: ENDPOINT },
    });
    const stopped = await stopWebRtcStream(foreign.streamId, undefined, "session-a");
    expect(stopped.state).toBe("stopped");
    expect(stopped.consumerCount).toBe(1);
    expect(listWebRtcStreams()).toHaveLength(0);
  });

  test("start mints a fresh lease for an unknown id on an active device stream", async () => {
    installFakes();
    setWebRtcStreamManagerDependencies({ isSessionLive: () => true });
    const first = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "session-a",
      overrides: { whipEndpoint: ENDPOINT },
    });
    const recovered = await startWebRtcStream({
      device: ANDROID,
      leaseId: "stale-lease",
      sessionUuid: "session-b",
      overrides: { whipEndpoint: ENDPOINT },
    });
    expect(recovered.streamId).toBe(first.streamId);
    expect(recovered.lease?.id).not.toBe("stale-lease");
    expect(recovered.lease?.id).not.toBe(first.lease?.id);
    expect(recovered.consumerCount).toBe(2);
    await expect(
      startWebRtcStream({
        device: ANDROID,
        leaseId: first.lease?.id,
        sessionUuid: "session-b",
        overrides: { whipEndpoint: ENDPOINT },
      }),
    ).rejects.toThrow(ActionableError);
  });

  test("start recovers with a fresh lease after the old stream is reaped", async () => {
    const timer = new FakeTimer();
    installFakes();
    setWebRtcStreamManagerDependencies({ timer, isSessionLive: () => true });
    const first = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "session-a",
      overrides: { whipEndpoint: ENDPOINT },
    });
    timer.advanceTime(WEBRTC_STREAM_LEASE_TTL_MS);
    expect(listWebRtcStreams()).toHaveLength(0);
    const recovered = await startWebRtcStream({
      device: ANDROID,
      leaseId: first.lease?.id,
      sessionUuid: "session-a",
      overrides: { whipEndpoint: ENDPOINT },
    });
    expect(recovered.streamId).not.toBe(first.streamId);
    expect(recovered.lease?.id).not.toBe(first.lease?.id);
    expect(recovered.consumerCount).toBe(1);
  });

  test("status and await still reject unknown lease ids", async () => {
    installFakes();
    const started = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    expect(() => getWebRtcStreamDescriptor(started.streamId, "stale-lease")).toThrow(
      ActionableError,
    );
    await expect(
      waitForWebRtcStreamReadiness(started.streamId, "capture_ready", 100, "stale-lease"),
    ).rejects.toThrow(ActionableError);
    expect(getWebRtcStreamDescriptor(started.streamId)?.consumerCount).toBe(1);
  });

  test("renews its own lease and refreshes the deadline", async () => {
    const timer = new FakeTimer();
    installFakes();
    setWebRtcStreamManagerDependencies({
      timer,
      now: () => new Date(Date.parse("2026-07-11T00:00:00.000Z") + timer.now()),
      isSessionLive: () => true,
    });
    const started = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "session-a",
      overrides: { whipEndpoint: ENDPOINT },
    });
    timer.advanceTime(1_000);
    const renewed = getWebRtcStreamDescriptor(started.streamId, started.lease?.id, "session-a");
    expect(renewed?.lease?.id).toBe(started.lease?.id);
    expect(
      Date.parse(renewed?.lease?.expiresAt ?? "") - Date.parse(started.lease?.expiresAt ?? ""),
    ).toBe(1_000);
    timer.advanceTime(WEBRTC_STREAM_LEASE_TTL_MS - 1_000);
    expect(listWebRtcStreams()).toHaveLength(1);
  });

  test("allows a fresh lease after explicit release", async () => {
    installFakes();
    setWebRtcStreamManagerDependencies({ isSessionLive: () => true });
    const a = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "session-a",
      overrides: { whipEndpoint: ENDPOINT },
    });
    const keeper = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "session-a",
      overrides: { whipEndpoint: ENDPOINT },
    });
    await stopWebRtcStream(a.streamId, a.lease?.id, "session-a");
    const b = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "session-b",
      overrides: { whipEndpoint: ENDPOINT },
    });
    expect(b.lease?.id).not.toBe(a.lease?.id);
    expect(b.lease?.id).not.toBe(keeper.lease?.id);
    expect(b.consumerCount).toBe(2);
  });

  test("allows a fresh lease after the old lease is reaped", async () => {
    const timer = new FakeTimer();
    installFakes();
    setWebRtcStreamManagerDependencies({ timer, isSessionLive: () => true });
    const a = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "session-a",
      overrides: { whipEndpoint: ENDPOINT },
    });
    timer.advanceTime(1);
    await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "session-a",
      overrides: { whipEndpoint: ENDPOINT },
    });
    timer.advanceTime(WEBRTC_STREAM_LEASE_TTL_MS - 1);
    expect(getWebRtcStreamDescriptor(a.streamId)?.consumerCount).toBe(1);
    const b = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "session-b",
      overrides: { whipEndpoint: ENDPOINT },
    });
    expect(b.lease?.id).not.toBe(a.lease?.id);
    expect(b.consumerCount).toBe(2);
  });

  test("takes over a dead owner's lease before its TTL", async () => {
    installFakes();
    const live = new Set(["session-a", "session-b"]);
    setWebRtcStreamManagerDependencies({ isSessionLive: (uuid) => live.has(uuid) });
    const a = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "session-a",
      overrides: { whipEndpoint: ENDPOINT },
    });
    live.delete("session-a");
    const b = getWebRtcStreamDescriptor(a.streamId, a.lease?.id, "session-b");
    expect(b?.lease?.id).toBe(a.lease?.id);
    expect(b?.consumerCount).toBe(1);
    live.add("session-a");
    expect(() => getWebRtcStreamDescriptor(a.streamId, a.lease?.id, "session-a")).toThrow(
      ActionableError,
    );
  });

  test("allows releasing a dead owner's lease", async () => {
    installFakes();
    setWebRtcStreamManagerDependencies({ isSessionLive: () => false });
    const a = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "session-a",
      overrides: { whipEndpoint: ENDPOINT },
    });
    const stopped = await stopWebRtcStream(a.streamId, a.lease?.id, "session-b");
    expect(stopped.state).toBe("stopped");
  });

  test("rejects a guessed or reaped lease without adding a consumer", async () => {
    installFakes();
    const started = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    expect(() => getWebRtcStreamDescriptor(started.streamId, "not-a-real-lease")).toThrow(
      ActionableError,
    );
    expect(() => getWebRtcStreamDescriptor(started.streamId, "")).toThrow(ActionableError);
    expect(getWebRtcStreamDescriptor(started.streamId)?.consumerCount).toBe(1);
  });

  test("claims an unowned lease on a session renewal", async () => {
    installFakes();
    setWebRtcStreamManagerDependencies({ isSessionLive: () => true });
    const started = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    expect(
      getWebRtcStreamDescriptor(started.streamId, started.lease?.id, "session-a")?.lease?.id,
    ).toBe(started.lease?.id);
    expect(() =>
      getWebRtcStreamDescriptor(started.streamId, started.lease?.id, "session-b"),
    ).toThrow(ActionableError);
    expect(getWebRtcStreamDescriptor(started.streamId, started.lease?.id)?.lease?.id).toBe(
      started.lease?.id,
    );
  });

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
    // The dead record never became live, so it is discarded rather than
    // retained for a later startWebRtcStream call to find and re-lease (#7555).
    expect(listWebRtcStreams()).toHaveLength(0);
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
    // The dead record never became live, so it is discarded rather than
    // retained for a later startWebRtcStream call to find and re-lease (#7555).
    expect(listWebRtcStreams()).toHaveLength(0);
  });

  test("retries with a fresh stream after an initial capture start fails (#7555)", async () => {
    const publishers: AsyncConnectedPublisher[] = [];
    const sources: FakeSource[] = [];
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
            throw new Error("REMOTE_SUBMIX failed");
          };
        }
        sources.push(source);
        return source as unknown as AndroidH264Source;
      },
      resolveVideoJar: async () => "/verified/automobile-video.jar",
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    const failed = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT, audioEnabled: true },
    });
    expect(failed.lifecycleState).toBe("degraded");
    expect(failed.failure?.code).toBe("capture_start_failed");
    // The dead record is discarded rather than retained for reuse.
    expect(listWebRtcStreams()).toHaveLength(0);

    const retried = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT, audioEnabled: true },
    });

    expect(createSourceCalls).toBe(2);
    expect(retried.streamId).not.toBe(failed.streamId);
    expect(retried.lifecycleState).toBe("capture_ready");
    expect(retried.failure).toBeNull();
    expect(listWebRtcStreams()).toHaveLength(1);
  });

  test("keeps a raced caller's capture start failure observable through status, readiness, and stop", async () => {
    const timer = new FakeTimer();
    let rejectStart: ((error: Error) => void) | undefined;
    let sourceCalls = 0;
    let sourceStarting!: () => void;
    const sourceStartingPromise = new Promise<void>((resolve) => {
      sourceStarting = resolve;
    });
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) =>
        new FakePublisher(config, deps) as unknown as WebRtcPublisher,
      createSource: () => {
        const source = new FakeSource();
        sourceCalls++;
        if (sourceCalls === 1) {
          source.start = () => {
            sourceStarting();
            return new Promise<void>((_resolve, reject) => {
              rejectStart = reject;
            });
          };
        }
        return source as unknown as AndroidH264Source;
      },
      resolveVideoJar: async () => null,
      timer,
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    const firstStart = startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    await sourceStartingPromise;
    const second = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    expect(second.lease?.id).toBeDefined();
    expect(second.lifecycleState).toBe("preparing");

    rejectStart?.(new Error("capture source rejected"));
    const failed = await firstStart;
    expect(failed.failure?.code).toBe("capture_start_failed");
    expect(getWebRtcStreamDescriptor(second.streamId, second.lease?.id)?.failure?.code).toBe(
      "capture_start_failed",
    );
    expect(
      (await waitForWebRtcStreamReadiness(second.streamId, "capture_ready", 100, second.lease?.id))
        .failure?.code,
    ).toBe("capture_start_failed");
    const retried = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    expect(retried.streamId).not.toBe(second.streamId);
    expect(retried.lifecycleState).toBe("capture_ready");
    expect(sourceCalls).toBe(2);

    expect((await stopWebRtcStream(second.streamId, second.lease?.id)).failure?.code).toBe(
      "capture_start_failed",
    );
    expect(getWebRtcStreamDescriptor(second.streamId)?.failure?.code).toBe("capture_start_failed");
    expect((await stopWebRtcStream(second.streamId, failed.lease?.id)).failure?.code).toBe(
      "capture_start_failed",
    );
  });

  test("clears the failed record's lease timer instead of extending it (#7555)", async () => {
    const timer = new FakeTimer();
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) =>
        new AsyncConnectedPublisher(config, deps) as unknown as WebRtcPublisher,
      createSource: () => {
        const source = new FakeSource();
        source.start = async () => {
          source.started = true;
          throw new Error("REMOTE_SUBMIX failed");
        };
        return source as unknown as AndroidH264Source;
      },
      resolveVideoJar: async () => "/verified/automobile-video.jar",
      timer,
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT, audioEnabled: true },
    });

    // A live record's lease would still be pending at this point; the dead
    // record's timer was cleared on failure, so advancing time triggers
    // nothing and leaves no scheduled callback behind.
    expect(timer.getPendingTimeoutCount()).toBe(0);
    timer.advanceTime(WEBRTC_STREAM_LEASE_TTL_MS);
    expect(listWebRtcStreams()).toHaveLength(0);
  });

  test("concurrent callers racing a pending start share one record", async () => {
    let releaseJar: ((path: string | null) => void) | undefined;
    let createSourceCalls = 0;
    setWebRtcStreamManagerDependencies({
      idGenerator: new CountingIdGenerator("id"),
      createPublisher: (config, deps) =>
        new FakePublisher(config, deps) as unknown as WebRtcPublisher,
      createSource: () => {
        createSourceCalls++;
        return new FakeSource() as unknown as AndroidH264Source;
      },
      resolveVideoJar: () =>
        new Promise((resolve) => {
          releaseJar = resolve;
        }),
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    const first = startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } });
    const second = startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } });
    const third = startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } });

    releaseJar?.(null);
    const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third]);

    expect(createSourceCalls).toBe(1);
    expect(secondResult.streamId).toBe(firstResult.streamId);
    expect(thirdResult.streamId).toBe(firstResult.streamId);
    expect(thirdResult.consumerCount).toBe(3);
    expect(listWebRtcStreams()).toHaveLength(1);
  });

  test("a previously-live record that later degrades keeps current semantics (not discarded)", async () => {
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
    // Runtime failure after the source was already live.
    sourceOptions.onError?.(new Error("adb forward lost"));

    const degraded = await waitForWebRtcStreamReadiness(started.streamId, "publishing", 100);
    expect(degraded.lifecycleState).toBe("degraded");
    expect(degraded.failure?.code).toBe("capture_runtime_failed");
    // Unlike a dead initial-start failure, a runtime-degraded record is kept
    // and returned to a later caller for the same device (reconnect path can
    // still recover it).
    expect(listWebRtcStreams()).toHaveLength(1);

    const reused = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    expect(reused.streamId).toBe(started.streamId);
    expect(reused.consumerCount).toBe(2);
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

describe("WebRTC ended lease tombstones", () => {
  test.each(["device_restored", "device_removed"] as const)(
    "%s retains the reason and kind and logs each lease once",
    async (reason) => {
      installFakes();
      const info = spyOn(logger, "info").mockImplementation(() => {});
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const stream = await startWebRtcStream({
          device: ANDROID,
          subscriptionKind: "viewer",
          overrides: { whipEndpoint: ENDPOINT },
        });
        const listener = createWebRtcStreamDeviceIncarnationListener();
        if (reason === "device_restored") {
          await listener.prepareForIncarnationChange?.(ANDROID.deviceId);
          await listener.onDeviceIncarnationChanged(ANDROID.deviceId);
        } else {
          await endWebRtcStreamsForDevice({ deviceId: ANDROID.deviceId, reason });
          await endWebRtcStreamsForDevice({ deviceId: ANDROID.deviceId, reason });
        }
        expect(() => getWebRtcStreamDescriptor(stream.streamId, stream.lease?.id)).toThrow(reason);
        try {
          getWebRtcStreamDescriptor(stream.streamId, stream.lease?.id);
        } catch (error) {
          expect(error).toMatchObject({ reason, subscriptionKind: "viewer" });
        }
        const expected = reason === "device_restored" ? info : warn;
        const other = expected === info ? warn : info;
        expect(
          expected.mock.calls.filter(([message]) => String(message).includes(`reason=${reason}`)),
        ).toHaveLength(1);
        expect(
          other.mock.calls.filter(([message]) => String(message).includes(`reason=${reason}`)),
        ).toHaveLength(0);
      } finally {
        info.mockRestore();
        warn.mockRestore();
      }
    },
  );

  test("retains 256 newest ends, expires lazily at the lease TTL, and reset clears ends", async () => {
    installFakes();
    const timer = new FakeTimer();
    setWebRtcStreamManagerDependencies({ timer });
    const leases: string[] = [];
    let streamId = "";
    for (let i = 0; i < 257; i++) {
      const stream = await startWebRtcStream({
        device: ANDROID,
        overrides: { whipEndpoint: ENDPOINT },
      });
      streamId = stream.streamId;
      leases.push(stream.lease!.id);
    }
    await stopAllWebRtcStreams("daemon_shutdown");
    expect(() => getWebRtcStreamDescriptor(streamId, leases[0])).not.toThrow();
    expect(() => getWebRtcStreamDescriptor(streamId, leases[1])).toThrow("daemon_shutdown");
    expect(() => getWebRtcStreamDescriptor(streamId, leases[256])).toThrow("daemon_shutdown");
    timer.advanceTime(WEBRTC_STREAM_LEASE_TTL_MS);
    expect(() => getWebRtcStreamDescriptor(streamId, leases[256])).not.toThrow();
    const next = await startWebRtcStream({
      device: ANDROID,
      overrides: { whipEndpoint: ENDPOINT },
    });
    await stopAllWebRtcStreams("daemon_shutdown");
    expect(() => getWebRtcStreamDescriptor(next.streamId, next.lease?.id)).toThrow(
      "daemon_shutdown",
    );
    resetWebRtcStreamManager();
    expect(() => getWebRtcStreamDescriptor(next.streamId, next.lease?.id)).not.toThrow();
  });
});

describe("WebRTC own-lease and owner control regressions", () => {
  test("non-owner leaseless release preserves anonymous and even dead foreign leases", async () => {
    const { publishers } = installFakes();
    setWebRtcStreamManagerDependencies({ timer: new FakeTimer(), isSessionLive: () => false });
    const first = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "a",
      subscriptionKind: "viewer",
      overrides: { whipEndpoint: ENDPOINT },
    });
    await startWebRtcStream({ device: ANDROID, overrides: { whipEndpoint: ENDPOINT } });
    await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "b",
      subscriptionKind: "viewer",
      overrides: { whipEndpoint: ENDPOINT },
    });
    expect(typeof manager.releaseWebRtcStreamOwnLeases).toBe("function");
    const result = await manager.releaseWebRtcStreamOwnLeases({
      streamId: first.streamId,
      sessionUuid: "a",
    });
    expect(result.consumerCount).toBe(2);
    expect(listWebRtcStreams()).toHaveLength(1);
    expect(publishers[0].stopped).toBe(false);
  });
  test("owner stop wakes a pending viewer waiter and releases every caller lease", async () => {
    const { publishers, sources } = installFakes();
    const timer = new FakeTimer();
    setWebRtcStreamManagerDependencies({
      timer,
      isSessionLive: () => true,
      createPublisher: (config, deps) => {
        const publisher = new FakePublisher(config, deps);
        publisher.start = async () => {};
        publishers.push(publisher);
        return publisher as unknown as WebRtcPublisher;
      },
    });
    const first = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "a",
      subscriptionKind: "viewer",
      overrides: { whipEndpoint: ENDPOINT },
    });
    await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "b",
      overrides: { whipEndpoint: ENDPOINT },
    });
    await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "b",
      overrides: { whipEndpoint: ENDPOINT },
    });
    expect(typeof manager.stopWebRtcStreamAsOwner).toBe("function");
    const waiting = waitForWebRtcStreamReadiness(
      first.streamId,
      "publishing",
      1000,
      first.lease?.id,
      "a",
    );
    const ended = waiting.catch((error: unknown) => error);
    const stopped = await manager.stopWebRtcStreamAsOwner({
      streamId: first.streamId,
      sessionUuid: "b",
    });
    expect(await ended).toMatchObject({ reason: "stopped_by_owner", subscriptionKind: "viewer" });
    expect(stopped).toMatchObject({ state: "stopped", consumerCount: 0 });
    expect(sources[0].stopped).toBe(true);
    expect(publishers[0].stopped).toBe(true);
    expect(listWebRtcStreams()).toEqual([]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
  test("owner stop retains the five-second cleanup bound", async () => {
    const { sources, publishers } = installFakes();
    const timer = new FakeTimer();
    setWebRtcStreamManagerDependencies({ timer });
    const first = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "a",
      overrides: { whipEndpoint: ENDPOINT },
    });
    sources[0].stop = () => new Promise<void>(() => {});
    expect(typeof manager.stopWebRtcStreamAsOwner).toBe("function");
    let settled = false;
    const stopping = manager
      .stopWebRtcStreamAsOwner({ streamId: first.streamId, sessionUuid: "b" })
      .then(() => {
        settled = true;
      });
    await flushPublisherStart();
    expect(listWebRtcStreams()).toEqual([]);
    expect(publishers[0].stopped).toBe(true);
    timer.advanceTime(WEBRTC_STREAM_STOP_TIMEOUT_MS - 1);
    await flushPublisherStart();
    expect(settled).toBe(false);
    timer.advanceTime(1);
    await stopping;
    expect(settled).toBe(true);
  });
  test.each([
    { whipEndpoint: "https://elsewhere.example/private" },
    { bearerToken: "secret" },
    { iceServers: [{ urls: "turn:private", credential: "secret" }] },
    { bitrateKbps: 777 },
    { size: { width: 640, height: 480 } },
    { androidFps: 24 },
    { iosSimulatorFps: 24 },
    { audioEnabled: true },
    { trickleIce: true },
  ])("all resolved config fields yield to new owner attach: %j", async (overrides) => {
    installFakes();
    setWebRtcStreamManagerDependencies({ timer: new FakeTimer() });
    await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "a",
      subscriptionKind: "viewer",
      overrides: { whipEndpoint: ENDPOINT },
    });
    const owner = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "b",
      ownsDevice: true,
      overrides: { whipEndpoint: ENDPOINT, ...overrides },
    });
    expect(owner.failure).toBeNull();
    expect(listWebRtcStreams()[0].consumerCount).toBe(1);
  });
  test("owner parameters replace capture even with an existing lease", async () => {
    installFakes();
    setWebRtcStreamManagerDependencies({ timer: new FakeTimer() });
    const first = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "a",
      subscriptionKind: "viewer",
      overrides: { whipEndpoint: ENDPOINT },
    });
    const second = await startWebRtcStream({
      device: ANDROID,
      sessionUuid: "a",
      ownsDevice: true,
      overrides: { whipEndpoint: ENDPOINT, bitrateKbps: 777 },
    });
    expect(second.streamId).not.toBe(first.streamId);
    expect(second.consumerCount).toBe(1);
  });
});
