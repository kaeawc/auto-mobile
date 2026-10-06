import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { RTCPeerConnection } from "werift";
import { WebRtcPublisher } from "../../src/features/webrtc/WebRtcPublisher";
import type { WhipClient } from "../../src/features/webrtc/WhipClient";
import {
  getWebRtcStreamDescriptor,
  resetWebRtcStreamManager,
  setWebRtcStreamManagerDependencies,
  startWebRtcStream,
} from "../../src/server/webrtcStreamManager";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { logger } from "../../src/utils/logger";
import type { BootedDevice } from "../../src/models";
import type { AndroidH264Source } from "../../src/features/webrtc";
import type { AndroidH264SourceOptions } from "../../src/features/webrtc/H264CaptureSource";
import { FakeTimer } from "../fakes/FakeTimer";
import { capturedH264AsDevicePackets } from "../helpers/capturedH264Stream";

// Interaction of the initial-publish teardown (#10149) with the end-of-packet delivery (#10150),
// run through the REAL WebRtcPublisher and RTP writer fed the repo's captured x264 stream.

// The captured x264 stream is Constrained Baseline, which is the profile the manager negotiates
// for iOS sources; an Android record would negotiate Main and reject this SPS.
const IOS: BootedDevice = {
  deviceId: "4DA8AF35-C59B-43D3-A8FE-5640A7B0B8C1",
  platform: "ios",
  name: "iPhone 16",
} as BootedDevice;
const ENDPOINT = "https://coord.example.com/whip";
const NAL_TYPE_SPS = 7;

class FakePeerConnection {
  closed = false;
  connectionState = "new";
  iceGatheringState = "complete";
  connectionStateChange = { subscribe: () => {} };
  iceGatheringStateChange = { watch: async () => {} };
  localDescription = { sdp: "v=0" };
  addTransceiver() {
    return { sender: { ssrc: 1, onPictureLossIndication: { subscribe: () => {} } } };
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async close() {
    this.closed = true;
  }
}

/** The real publisher, recording every media call that reaches it after `stop()`. */
class RecordingPublisher extends WebRtcPublisher {
  stopCalls = 0;
  readonly callsAfterStop: string[] = [];
  async stop(): Promise<void> {
    this.stopCalls++;
    await super.stop();
  }
  writeH264Chunk(chunk: Buffer): void {
    if (this.stopCalls > 0) {
      this.callsAfterStop.push("writeH264Chunk");
    }
    super.writeH264Chunk(chunk);
  }
  endOfH264Packet(): void {
    if (this.stopCalls > 0) {
      this.callsAfterStop.push("endOfH264Packet");
    }
    super.endOfH264Packet();
  }
}

class GatedSource {
  stopCalls = 0;
  private stopGate: (() => void) | null = null;
  gateStop = false;
  async start(): Promise<void> {}
  async stop(): Promise<void> {
    this.stopCalls++;
    if (this.gateStop) {
      await new Promise<void>((resolve) => {
        this.stopGate = resolve;
      });
    }
  }
  releaseStop(): void {
    this.stopGate?.();
  }
  requestKeyFrame(): boolean {
    return true;
  }
}

function installFakes() {
  const timer = new FakeTimer();
  const publishers: RecordingPublisher[] = [];
  const sources: Array<{ source: GatedSource; options: AndroidH264SourceOptions }> = [];
  const failPublish: Array<(error: Error) => void> = [];
  setWebRtcStreamManagerDependencies({
    idGenerator: new CountingIdGenerator("id"),
    createPublisher: (config, deps) => {
      const attempt = publishers.length;
      const publisher = new RecordingPublisher(
        { ...config, maxReconnectAttempts: 1 },
        {
          ...deps,
          timer,
          createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
          createWhipClient: () =>
            ({
              publish: () =>
                new Promise((_resolve, reject) => {
                  // The first WHIP publish is rejected on demand; later ones stay pending.
                  if (attempt === 0) {
                    failPublish.push(reject);
                  }
                }),
              delete: async () => {},
            }) as unknown as WhipClient,
        },
      );
      publishers.push(publisher);
      return publisher;
    },
    createSource: (options: AndroidH264SourceOptions) => {
      const source = new GatedSource();
      sources.push({ source, options });
      return source as unknown as AndroidH264Source;
    },
    resolveVideoJar: async () => null,
    timer,
    now: () => new Date("2026-07-11T00:00:00.000Z"),
  });
  return { publishers, sources, failPublish };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

const startRequest = { device: IOS, overrides: { whipEndpoint: ENDPOINT } };

beforeEach(() => {
  spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
  resetWebRtcStreamManager();
  (logger.warn as unknown as { mockRestore(): void }).mockRestore();
});

describe("a publish that fails after packet boundaries were delivered (#10149, #10150)", () => {
  test("late source callbacks after the teardown never reach the stopped publisher and do not throw", async () => {
    const { publishers, sources, failPublish } = installFakes();
    const [config, idr, firstP] = capturedH264AsDevicePackets();

    const first = await startWebRtcStream(startRequest);
    await settle();
    const { options } = sources[0];

    // Config and key-frame packets are delivered with their boundaries while WHIP is pending.
    options.onData(config);
    options.onEncodedAccessUnit?.();
    options.onData(idr);
    options.onEncodedAccessUnit?.();
    expect(getWebRtcStreamDescriptor(first.streamId)?.telemetry?.firstIdr).toBeDefined();
    expect(publishers[0].callsAfterStop).toEqual([]);

    failPublish[0](new Error("WHIP ingest failed: expected 201 Created, got 503"));
    await settle();

    expect(publishers[0].stopCalls).toBe(1);
    expect(sources[0].source.stopCalls).toBe(1);
    expect(getWebRtcStreamDescriptor(first.streamId, first.lease?.id)?.failure?.code).toBe(
      "whip_publish_failed",
    );

    // The dead source's pending output arrives after the teardown: ignored, never written through.
    expect(() => {
      options.onData(firstP);
      options.onEncodedAccessUnit?.();
      options.onError(new Error("late encoder error"));
    }).not.toThrow();
    await settle();

    expect(publishers[0].callsAfterStop).toEqual([]);
    expect(publishers[0].stopCalls).toBe(1);
    // A late source error does not rewrite the failure the lease holder reads.
    expect(getWebRtcStreamDescriptor(first.streamId, first.lease?.id)?.failure?.code).toBe(
      "whip_publish_failed",
    );
  });

  test("callbacks arriving while the dead source is still stopping are ignored too", async () => {
    const { publishers, sources, failPublish } = installFakes();
    const [config, idr] = capturedH264AsDevicePackets();

    const first = await startWebRtcStream(startRequest);
    await settle();
    const { source, options } = sources[0];
    source.gateStop = true;
    options.onData(config);
    options.onEncodedAccessUnit?.();

    failPublish[0](new Error("WHIP request timed out"));
    await settle();
    // The source's stop is parked, yet the publisher is stopped concurrently (#10160 review).
    expect(source.stopCalls).toBe(1);
    expect(publishers[0].stopCalls).toBe(1);

    options.onData(idr);
    options.onEncodedAccessUnit?.();
    source.releaseStop();
    await settle();

    expect(publishers[0].stopCalls).toBe(1);
    expect(publishers[0].callsAfterStop).toEqual([]);
    expect(getWebRtcStreamDescriptor(first.streamId, first.lease?.id)?.telemetry?.firstIdr).toBe(
      undefined,
    );
    // Only the pre-failure config packet reached the writer; the late key frame did not.
    expect(publishers[0].getDescriptor().framesSent).toBe(0);
  });

  test("a fresh start after the failure carries no partial NAL from the dead record", async () => {
    const { publishers, sources, failPublish } = installFakes();
    const [config, idr] = capturedH264AsDevicePackets();

    const first = await startWebRtcStream(startRequest);
    await settle();
    // Config packet complete, then the first half of the key frame with NO boundary: the dead
    // record's splitter and the writer's access-unit assembler both hold the incomplete slice.
    sources[0].options.onData(config);
    sources[0].options.onEncodedAccessUnit?.();
    sources[0].options.onData(idr.subarray(0, Math.floor(idr.length / 2)));
    expect(getWebRtcStreamDescriptor(first.streamId)?.telemetry?.firstIdr).toBeUndefined();

    failPublish[0](new Error("WHIP ingest failed: expected 201 Created, got 503"));
    await settle();

    const second = await startWebRtcStream(startRequest);
    await settle();
    expect(second.streamId).not.toBe(first.streamId);
    expect(sources).toHaveLength(2);
    expect(publishers).toHaveLength(2);

    // The new record starts from an empty parser and writer: a config-only packet stamps nothing,
    // and the dead record's half slice is never emitted into the new publisher.
    sources[1].options.onData(config);
    sources[1].options.onEncodedAccessUnit?.();
    const afterConfig = getWebRtcStreamDescriptor(second.streamId);
    expect(afterConfig?.telemetry?.firstIdr).toBeUndefined();
    expect(publishers[1].getDescriptor().framesSent).toBe(0);

    // Its own complete key frame, released by its own boundary, is the first IDR it sees.
    sources[1].options.onData(idr);
    sources[1].options.onEncodedAccessUnit?.();
    expect(getWebRtcStreamDescriptor(second.streamId)?.telemetry?.firstIdr).toBeDefined();
    expect(publishers[1].getDescriptor().framesSent).toBe(1);
    // The old publisher saw none of the new record's media.
    expect(publishers[0].getDescriptor().framesSent).toBe(0);
    expect(publishers[0].callsAfterStop).toEqual([]);
    // Sanity: the captured config packet really starts with an SPS.
    expect(config[config.indexOf(1) + 1] & 0x1f).toBe(NAL_TYPE_SPS);
  });
});
