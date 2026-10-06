import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  getWebRtcStreamDescriptor,
  listWebRtcStreams,
  resetWebRtcStreamManager,
  setWebRtcStreamManagerDependencies,
  startWebRtcStream,
  stopWebRtcStream,
  WEBRTC_STREAM_LEASE_TTL_MS,
} from "../../src/server/webrtcStreamManager";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import type { BootedDevice } from "../../src/models";
import type {
  AndroidH264Source,
  WebRtcPublisher,
  WebRtcStreamDescriptor,
} from "../../src/features/webrtc";

// Initial WHIP publish failure teardown (#10149). The capture-start twin of this
// path (#7555) is covered in webrtcStreamManager.test.ts; both go through the
// same retirement helper.

const ANDROID: BootedDevice = {
  deviceId: "emulator-5554",
  platform: "android",
  name: "a",
} as BootedDevice;
const ENDPOINT = "https://coord.example.com/whip";
const WHIP_503 = "WHIP ingest failed: expected 201 Created, got 503";

/** Publisher whose `start` outcome the test controls; never touches the network. */
class ScriptedPublisher {
  stopCalls = 0;
  stopError: Error | null = null;
  private settle: { resolve: () => void; reject: (error: Error) => void } | null = null;
  constructor(
    private readonly streamId: string,
    private readonly mode: "reject-now" | "gated",
  ) {}
  async start(): Promise<void> {
    if (this.mode === "reject-now") {
      throw new Error(WHIP_503);
    }
    await new Promise<void>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
  }
  failStart(message = WHIP_503): void {
    this.settle?.reject(new Error(message));
  }
  async stop(): Promise<void> {
    this.stopCalls++;
    if (this.stopError) {
      throw this.stopError;
    }
  }
  writeH264Chunk(): void {}
  primeH264ParameterSets(): void {}
  writePcmAudioChunk(): void {}
  notifySourceFailed(): void {}
  getDescriptor(): WebRtcStreamDescriptor {
    return {
      streamId: this.streamId,
      state: this.stopCalls > 0 ? "stopped" : "idle",
      whipEndpoint: ENDPOINT,
      resourceUrl: `${ENDPOINT}/r/${this.streamId}`,
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

class CountingSource {
  startCalls = 0;
  stopCalls = 0;
  stopError: Error | null = null;
  stopNeverSettles = false;
  async start(): Promise<void> {
    this.startCalls++;
  }
  async stop(): Promise<void> {
    this.stopCalls++;
    if (this.stopNeverSettles) {
      await new Promise<void>(() => {});
    }
    if (this.stopError) {
      throw this.stopError;
    }
  }
  requestKeyFrame(): boolean {
    return true;
  }
}

/** Installs fakes; the first publisher uses `firstMode`, later ones always succeed. */
function installFakes(firstMode: "reject-now" | "gated") {
  const publishers: ScriptedPublisher[] = [];
  const sources: CountingSource[] = [];
  const timer = new FakeTimer();
  setWebRtcStreamManagerDependencies({
    idGenerator: new CountingIdGenerator("id"),
    createPublisher: (config) => {
      const publisher = new ScriptedPublisher(
        config.streamId,
        publishers.length === 0 ? firstMode : "gated",
      );
      publishers.push(publisher);
      return publisher as unknown as WebRtcPublisher;
    },
    createSource: () => {
      const source = new CountingSource();
      sources.push(source);
      return source as unknown as AndroidH264Source;
    },
    resolveVideoJar: async () => null,
    timer,
    now: () => new Date("2026-07-11T00:00:00.000Z"),
  });
  return { publishers, sources, timer };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

const startRequest = { device: ANDROID, overrides: { whipEndpoint: ENDPOINT } };

beforeEach(() => {
  spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
  resetWebRtcStreamManager();
  (logger.warn as unknown as { mockRestore(): void }).mockRestore();
});

describe("webrtcStreamManager initial publish failure (#10149)", () => {
  test("publish failing before any frame stops the capture and lets the next start build a fresh stream", async () => {
    const { publishers, sources, timer } = installFakes("reject-now");

    const first = await startWebRtcStream(startRequest);
    expect(first.lifecycleState).toBe("capture_ready");
    await settle();

    // The creator's lease still reads the failure; the dead record is not reused.
    const failed = getWebRtcStreamDescriptor(first.streamId, first.lease?.id);
    expect(failed?.failure?.code).toBe("whip_publish_failed");
    expect(failed?.failure?.message).toContain("got 503");
    expect(failed?.lifecycleState).toBe("failed");
    expect(failed?.sourceStarted).toBe(false);
    expect(sources[0].stopCalls).toBe(1);
    expect(publishers[0].stopCalls).toBe(1);

    timer.advanceTime(WEBRTC_STREAM_LEASE_TTL_MS - 1_000);
    const second = await startWebRtcStream({ ...startRequest, leaseId: first.lease?.id });
    expect(second.streamId).not.toBe(first.streamId);
    expect(second.lifecycleState).toBe("capture_ready");
    expect(second.failure).toBeNull();
    expect(sources).toHaveLength(2);
    expect(publishers).toHaveLength(2);

    // The dead record's lease expiring later does not stop its source again.
    await timer.advanceTimeAsync(2_000);
    await settle();
    expect(getWebRtcStreamDescriptor(first.streamId)).toBeNull();
    expect(sources[0].stopCalls).toBe(1);
    expect(sources[1].stopCalls).toBe(0);
  });

  test("publish failing after capture started releases the running capture exactly once", async () => {
    const { publishers, sources } = installFakes("gated");

    const first = await startWebRtcStream(startRequest);
    expect(first.sourceStarted).toBe(true);
    expect(sources[0].startCalls).toBe(1);
    expect(sources[0].stopCalls).toBe(0);

    publishers[0].failStart("WHIP request timed out");
    await settle();

    const failed = getWebRtcStreamDescriptor(first.streamId, first.lease?.id);
    expect(failed?.failure?.code).toBe("whip_publish_failed");
    expect(failed?.sourceStarted).toBe(false);
    expect(sources[0].stopCalls).toBe(1);
    expect(publishers[0].stopCalls).toBe(1);

    // Releasing the creator's lease afterwards does not stop anything twice.
    await stopWebRtcStream(first.streamId, first.lease?.id);
    expect(sources[0].stopCalls).toBe(1);
    expect(listWebRtcStreams()).toHaveLength(0);

    const second = await startWebRtcStream(startRequest);
    expect(second.streamId).not.toBe(first.streamId);
    expect(sources).toHaveLength(2);
  });

  test("cancelling during the publish tears down once and the late publish failure is ignored", async () => {
    const { publishers, sources } = installFakes("gated");

    const first = await startWebRtcStream(startRequest);
    await stopWebRtcStream(first.streamId, first.lease?.id);
    expect(sources[0].stopCalls).toBe(1);
    expect(publishers[0].stopCalls).toBe(1);

    publishers[0].failStart("aborted by stop");
    await settle();

    expect(sources[0].stopCalls).toBe(1);
    expect(publishers[0].stopCalls).toBe(1);
    expect(listWebRtcStreams()).toHaveLength(0);
    const second = await startWebRtcStream(startRequest);
    expect(second.streamId).not.toBe(first.streamId);
    expect(second.failure).toBeNull();
  });

  test("two starts racing a failing publish share one teardown and the next start is fresh", async () => {
    const { publishers, sources } = installFakes("gated");

    const first = await startWebRtcStream(startRequest);
    const raced = await startWebRtcStream(startRequest);
    expect(raced.streamId).toBe(first.streamId);
    expect(publishers).toHaveLength(1);
    expect(sources).toHaveLength(1);

    publishers[0].failStart();
    await settle();

    // Both lease holders still read the failure from the retained record.
    for (const lease of [first.lease, raced.lease]) {
      expect(getWebRtcStreamDescriptor(first.streamId, lease?.id)?.failure?.code).toBe(
        "whip_publish_failed",
      );
    }
    expect(sources[0].stopCalls).toBe(1);
    expect(publishers[0].stopCalls).toBe(1);

    const fresh = await startWebRtcStream(startRequest);
    expect(fresh.streamId).not.toBe(first.streamId);
    expect(fresh.failure).toBeNull();
    expect(sources).toHaveLength(2);
    expect(publishers).toHaveLength(2);

    // Releasing both leases on the dead record never stops its source again.
    await stopWebRtcStream(first.streamId, first.lease?.id);
    await stopWebRtcStream(first.streamId, raced.lease?.id);
    expect(sources[0].stopCalls).toBe(1);
    expect(getWebRtcStreamDescriptor(first.streamId)).toBeNull();
    expect(sources[1].stopCalls).toBe(0);
  });

  test("a teardown failure still retires the record so the next start is fresh", async () => {
    const { publishers, sources } = installFakes("gated");

    const first = await startWebRtcStream(startRequest);
    sources[0].stopError = new Error("screenrecord would not die");
    publishers[0].stopError = new Error("whip delete failed");
    publishers[0].failStart();
    await settle();

    expect(sources[0].stopCalls).toBe(1);
    expect(publishers[0].stopCalls).toBe(1);
    expect(getWebRtcStreamDescriptor(first.streamId, first.lease?.id)?.failure?.code).toBe(
      "whip_publish_failed",
    );
    const second = await startWebRtcStream(startRequest);
    expect(second.streamId).not.toBe(first.streamId);
    expect(second.failure).toBeNull();
    expect(sources).toHaveLength(2);
  });

  test("a capture stop that never settles does not block the publisher teardown", async () => {
    const { publishers, sources } = installFakes("gated");

    const first = await startWebRtcStream(startRequest);
    sources[0].stopNeverSettles = true;
    publishers[0].failStart();
    await settle();

    expect(sources[0].stopCalls).toBe(1);
    expect(publishers[0].stopCalls).toBe(1);
    expect(getWebRtcStreamDescriptor(first.streamId, first.lease?.id)?.failure?.code).toBe(
      "whip_publish_failed",
    );
  });

  test("a publisher stop rejection is logged and the capture is still stopped", async () => {
    const { publishers, sources } = installFakes("gated");

    await startWebRtcStream(startRequest);
    publishers[0].stopError = new Error("whip delete failed");
    publishers[0].failStart();
    await settle();

    expect(publishers[0].stopCalls).toBe(1);
    expect(sources[0].stopCalls).toBe(1);
    const warnings = (logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(warnings.some((call) => String(call[0]).includes("whip delete failed"))).toBe(true);
  });

  test("a stop without a streamId addresses the live retry, not the failed record", async () => {
    const { publishers, sources } = installFakes("gated");

    const first = await startWebRtcStream(startRequest);
    publishers[0].failStart();
    await settle();

    const retry = await startWebRtcStream(startRequest);
    expect(retry.streamId).not.toBe(first.streamId);

    // The failed record is still queryable by its own lease holder.
    expect(getWebRtcStreamDescriptor(first.streamId, first.lease?.id)?.failure?.code).toBe(
      "whip_publish_failed",
    );
    const stopped = await stopWebRtcStream();
    expect(stopped.streamId).toBe(retry.streamId);
    expect(sources[1].stopCalls).toBe(1);
    expect(publishers[1].stopCalls).toBe(1);
  });

  test("a lone failed record is still addressable without a streamId", async () => {
    const { publishers } = installFakes("gated");

    const first = await startWebRtcStream(startRequest);
    publishers[0].failStart();
    await settle();

    const stopped = await stopWebRtcStream();
    expect(stopped.streamId).toBe(first.streamId);
    expect(listWebRtcStreams()).toHaveLength(0);
  });

  test("a retry may reuse the failed stream's explicit streamId immediately", async () => {
    const { publishers, sources, timer } = installFakes("gated");

    await startWebRtcStream({ ...startRequest, streamId: "stream-a" });
    publishers[0].failStart();
    await settle();

    const retry = await startWebRtcStream({ ...startRequest, streamId: "stream-a" });
    expect(retry.streamId).toBe("stream-a");
    expect(retry.failure).toBeNull();
    expect(retry.lifecycleState).toBe("capture_ready");
    expect(sources).toHaveLength(2);
    expect(publishers).toHaveLength(2);
    expect(listWebRtcStreams()).toHaveLength(1);

    // The replaced record's lease timer must not stop the live retry's capture.
    await timer.advanceTimeAsync(WEBRTC_STREAM_LEASE_TTL_MS / 2);
    await settle();
    expect(sources[1].stopCalls).toBe(0);
    expect(publishers[1].stopCalls).toBe(0);
  });

  test("a healthy publish keeps its record and capture running", async () => {
    const { publishers, sources } = installFakes("gated");

    const first = await startWebRtcStream(startRequest);
    const again = await startWebRtcStream(startRequest);
    await settle();

    expect(again.streamId).toBe(first.streamId);
    expect(sources[0].stopCalls).toBe(0);
    expect(publishers[0].stopCalls).toBe(0);
    expect(listWebRtcStreams()).toHaveLength(1);
  });
});
