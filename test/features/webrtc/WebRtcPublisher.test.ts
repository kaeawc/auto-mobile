import { describe, expect, test } from "bun:test";
import type { RTCPeerConnection } from "werift";
import {
  KEYFRAME_REQUEST_MIN_INTERVAL_MS,
  WebRtcPublisher,
} from "../../../src/features/webrtc/WebRtcPublisher";
import type { WhipClient, WhipClientOptions } from "../../../src/features/webrtc/WhipClient";
import { FakeTimer } from "../../fakes/FakeTimer";

const ACCEPTED_VIDEO_ANSWER = [
  "v=0",
  "m=video 9 UDP/TLS/RTP/SAVPF 102",
  "a=recvonly",
  "a=rtpmap:102 H264/90000",
  "a=fmtp:102 packetization-mode=1;profile-level-id=42e02a",
].join("\r\n");
const ACCEPTED_VIDEO_AND_AUDIO_ANSWER = [
  ACCEPTED_VIDEO_ANSWER,
  "m=audio 9 UDP/TLS/RTP/SAVPF 0",
  "a=recvonly",
].join("\r\n");

/** Minimal fake peer connection whose media/offer path succeeds up to publish. */
class FakePeerConnection {
  closed = false;
  connectionState = "new";
  iceGatheringState = "complete";
  connectionStateChange = { subscribe: () => {} };
  iceGatheringStateChange = { watch: async () => {} };
  localDescription = { sdp: "v=0" };
  /** PLI callbacks the publisher subscribed on video senders (fire to simulate a relayed PLI). */
  pliSubscribers: Array<() => void> = [];
  addTransceiver() {
    return {
      sender: {
        ssrc: 1,
        onPictureLossIndication: { subscribe: (cb: () => void) => this.pliSubscribers.push(cb) },
      },
    };
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

class RecordingPeerConnection extends FakePeerConnection {
  transceiverKinds: string[] = [];
  addTransceiver(track: { kind: string }) {
    this.transceiverKinds.push(track.kind);
    return {
      sender: {
        ssrc: this.transceiverKinds.length,
        onPictureLossIndication: { subscribe: (cb: () => void) => this.pliSubscribers.push(cb) },
      },
    };
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/**
 * Unit tests for publisher wiring that can be asserted without a real peer
 * connection. The full media path is covered by WebRtcPublisher.loopback.test.ts
 * and the coordination-server e2e test.
 */
describe("WebRtcPublisher WHIP endpoint", () => {
  function captureEndpoint(whipEndpoint: string, streamId: string): string {
    let captured: WhipClientOptions | undefined;

    new WebRtcPublisher(
      { streamId, whipEndpoint },
      {
        createWhipClient: options => {
          captured = options;
          return {} as unknown as WhipClient;
        },
      }
    );
    return captured!.endpoint;
  }

  test("appends the stream id as a query parameter", () => {
    expect(captureEndpoint("https://coord.example.com/whip", "ci-run-42")).toBe(
      "https://coord.example.com/whip?streamId=ci-run-42"
    );
  });

  test("preserves an existing streamId query parameter", () => {
    expect(captureEndpoint("https://coord.example.com/whip?streamId=explicit", "generated")).toBe(
      "https://coord.example.com/whip?streamId=explicit"
    );
  });

  test("keeps other query parameters intact", () => {
    const endpoint = captureEndpoint("https://coord.example.com/whip?region=us", "s1");
    expect(endpoint).toContain("region=us");
    expect(endpoint).toContain("streamId=s1");
  });
});

describe("WebRtcPublisher establish failure", () => {
  test("closes the peer connection when WHIP publish fails on the last attempt", async () => {
    const pc = new FakePeerConnection();
    const publisher = new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip", maxReconnectAttempts: 1 },
      {
        createPeerConnection: () => pc as unknown as RTCPeerConnection,
        createWhipClient: () =>
          ({
            publish: async () => {
              throw new Error("ingest rejected");
            },
            delete: async () => {},
          }) as unknown as WhipClient,
      }
    );

    // Terminal failure (single attempt) must not leak the open peer connection.
    await expect(publisher.start()).rejects.toThrow();
    expect(pc.closed).toBe(true);
    expect(publisher.getDescriptor().resourceUrl).toBeNull();
  });

  test("stop during pre-establish does not create a WHIP session or overwrite stopped", async () => {
    const gate = deferred();
    let peerConnections = 0;
    let publishes = 0;
    const publisher = new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip" },
      {
        onBeforeEstablish: () => gate.promise,
        createPeerConnection: () => {
          peerConnections++;
          return new FakePeerConnection() as unknown as RTCPeerConnection;
        },
        createWhipClient: () => ({
          publish: async () => { publishes++; return { answerSdp: ACCEPTED_VIDEO_ANSWER, resourceUrl: "https://coord/whip/s" }; },
          delete: async () => {},
        }) as unknown as WhipClient,
      }
    );

    const start = publisher.start();
    await Promise.resolve();
    await publisher.stop();
    gate.resolve();
    await start;

    expect(peerConnections).toBe(0);
    expect(publishes).toBe(0);
    expect(publisher.getState()).toBe("stopped");
  });
});

describe("WebRtcPublisher WHIP answer validation", () => {
  async function expectRejectedAnswer(answerSdp: string): Promise<void> {
    const pc = new FakePeerConnection();
    const publisher = new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip", maxReconnectAttempts: 1 },
      {
        createPeerConnection: () => pc as unknown as RTCPeerConnection,
        createWhipClient: () => ({
          publish: async () => ({ answerSdp, resourceUrl: "https://coord/whip/s" }),
          delete: async () => {},
        }) as unknown as WhipClient,
      }
    );
    await expect(publisher.start()).rejects.toThrow(/WHIP answer did not accept/);
    expect(pc.closed).toBe(true);
  }

  test("rejects H.264 at a non-RFC-6184 clock rate", async () => {
    await expectRejectedAnswer(ACCEPTED_VIDEO_ANSWER.replace("H264/90000", "H264/8000"));
  });

  test("rejects a WHIP answer that is not recvonly", async () => {
    await expectRejectedAnswer(ACCEPTED_VIDEO_ANSWER.replace("a=recvonly", "a=sendrecv"));
  });

  test("rejects an H.264 profile incompatible with the constrained-baseline sender", async () => {
    await expectRejectedAnswer(ACCEPTED_VIDEO_ANSWER.replace("42e02a", "64001f"));
  });

  test("accepts every RFC 6184 constrained-baseline profile representation", async () => {
    const pc = new FakePeerConnection();
    const publisher = new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip" },
      {
        createPeerConnection: () => pc as unknown as RTCPeerConnection,
        createWhipClient: () => ({
          publish: async () => ({
            answerSdp: ACCEPTED_VIDEO_ANSWER.replace("42e02a", "42c02a"),
            resourceUrl: "https://coord/whip/s",
          }),
          delete: async () => {},
        }) as unknown as WhipClient,
      }
    );

    await publisher.start();
    expect(publisher.getState()).toBe("connected");
    await publisher.stop();
  });

  test("accepts a conforming Baseline level-1b profile variation with a sufficient receive ceiling", async () => {
    const pc = new FakePeerConnection();
    const publisher = new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip" },
      {
        createPeerConnection: () => pc as unknown as RTCPeerConnection,
        createWhipClient: () => ({
          publish: async () => ({
            answerSdp: ACCEPTED_VIDEO_ANSWER.replace(
              "profile-level-id=42e02a",
              "profile-level-id=42f00b;level-asymmetry-allowed=1;max-recv-level=f02a"
            ),
            resourceUrl: "https://coord/whip/s",
          }),
          delete: async () => {},
        }) as unknown as WhipClient,
      }
    );

    await publisher.start();
    expect(publisher.getState()).toBe("connected");
    await publisher.stop();
  });

  test("rejects an answer whose receive level is below AutoMobile's source capability", async () => {
    await expectRejectedAnswer(ACCEPTED_VIDEO_ANSWER.replace("42e02a", "42e01f"));
  });

  test("accepts an asymmetric answer that explicitly supports the source level", async () => {
    const pc = new FakePeerConnection();
    const publisher = new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip" },
      {
        createPeerConnection: () => pc as unknown as RTCPeerConnection,
        createWhipClient: () =>
          ({
            publish: async () => ({
              resourceUrl: "https://coord/resource",
              answerSdp: ACCEPTED_VIDEO_ANSWER.replace(
                "profile-level-id=42e02a",
                "profile-level-id=42e01f;level-asymmetry-allowed=1;max-recv-level=e02a"
              ),
            }),
            delete: async () => {},
          }) as unknown as WhipClient,
      }
    );

    await publisher.start();
    expect(publisher.getDescriptor().resourceUrl).toBe("https://coord/resource");
  });

  test("rejects a decimal max-recv-level because RFC 6184 requires hexadecimal SPS bytes", async () => {
    await expectRejectedAnswer(
      ACCEPTED_VIDEO_ANSWER.replace(
        "profile-level-id=42e02a",
        "profile-level-id=42e01f;level-asymmetry-allowed=1;max-recv-level=42"
      )
    );
  });
});

describe("WebRtcPublisher.notifySourceFailed", () => {
  test("suppresses the source-failure callback and reconnect after close", async () => {
    // After stop() a late capture-source failure must not trigger recovery — it
    // must neither invoke onSourceFailure nor kick the reconnect controller,
    // otherwise a torn-down publisher resurrects itself.
    const failures: Array<Error | undefined> = [];
    const publisher = new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip" },
      {
        createWhipClient: () => ({}) as unknown as WhipClient,
        onSourceFailure: error => failures.push(error),
      }
    );
    await publisher.stop();

    expect(() => publisher.notifySourceFailed()).not.toThrow();
    expect(failures).toHaveLength(0);
  });

  test("routes a synchronously throwing connected hook through recovery", async () => {
    const pc = new FakePeerConnection();
    const publisher = new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip" },
      {
        onConnected: () => { throw new Error("capture start failed"); },
        createWhipClient: () => ({}) as unknown as WhipClient,
      }
    );
    const internals = publisher as unknown as {
      pc: RTCPeerConnection | null;
      fireConnected(connection: RTCPeerConnection): void;
      notifySourceFailed: () => void;
    };
    let recoveries = 0;
    internals.pc = pc as unknown as RTCPeerConnection;
    internals.notifySourceFailed = () => { recoveries++; };

    // A synchronous hook failure used to escape `Promise.resolve(hook())` and
    // reject start. The asynchronous boundary now routes it to recovery.
    expect(() => internals.fireConnected(pc as unknown as RTCPeerConnection)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(recoveries).toBe(1);
  });

  test("recovers instead of forwarding an SPS incompatible with the advertised H.264 profile", async () => {
    const pc = new FakePeerConnection();
    const publisher = new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip" },
      {
        createPeerConnection: () => pc as unknown as RTCPeerConnection,
        createWhipClient: () =>
          ({
            publish: async () => ({ answerSdp: ACCEPTED_VIDEO_ANSWER, resourceUrl: "https://coord/whip/s" }),
            delete: async () => {},
          }) as unknown as WhipClient,
      }
    );
    await publisher.start();
    const internals = publisher as unknown as { notifySourceFailed: () => void };
    let recoveries = 0;
    internals.notifySourceFailed = () => { recoveries++; };

    // A High-profile SPS must not be forwarded under the constrained-baseline
    // profile-level-id advertised in the negotiated SDP.
    publisher.writeH264Chunk(Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0, 0, 0, 1]));

    expect(recoveries).toBe(1);
  });

  test("notifies the manager when packetization rejects source H.264", async () => {
    const pc = new FakePeerConnection();
    let failure: Error | undefined;
    const publisher = new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip", maxReconnectAttempts: 1 },
      {
        onSourceFailure: error => {
          failure = error;
        },
        createPeerConnection: () => pc as unknown as RTCPeerConnection,
        createWhipClient: () =>
          ({
            publish: async () => ({ answerSdp: ACCEPTED_VIDEO_ANSWER, resourceUrl: "https://coord/whip/s" }),
            delete: async () => {},
          }) as unknown as WhipClient,
      }
    );
    await publisher.start();

    publisher.writeH264Chunk(Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0, 0, 0, 1]));

    expect(failure?.message).toContain("incompatible with negotiated constrained-baseline");
    await publisher.stop();
  });

  test("records first RTP only after the peer connection is connected", async () => {
    const pc = new FakePeerConnection();
    const events: string[] = [];
    const publisher = new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip" },
      {
        onLifecycleEvent: event => events.push(event),
        createPeerConnection: () => pc as unknown as RTCPeerConnection,
        createWhipClient: () =>
          ({
            publish: async () => ({ answerSdp: ACCEPTED_VIDEO_ANSWER, resourceUrl: "https://coord/whip/s" }),
            delete: async () => {},
          }) as unknown as WhipClient,
      }
    );
    await publisher.start();
    const startCode = Buffer.from([0, 0, 0, 1]);
    const pFrame = Buffer.from([0x41, 0x80]);

    publisher.writeH264Chunk(Buffer.concat([
      startCode, Buffer.from([0x67, 0x42, 0xe0, 0x2a]),
      startCode, Buffer.from([0x68, 0xce, 0x3c, 0x80]),
      startCode, Buffer.from([0x65, 0x80, 0x00]),
      startCode, pFrame,
      startCode, pFrame,
    ]));
    expect(events).not.toContain("first_rtp_sent");

    pc.connectionState = "connected";
    publisher.writeH264Chunk(Buffer.concat([startCode, pFrame]));
    expect(events.filter(event => event === "first_rtp_sent")).toHaveLength(1);

    await publisher.stop();
  });
});

describe("WebRtcPublisher keyframe requests", () => {
  test("forwards a relayed PLI to onKeyFrameRequest, throttled", async () => {
    const pc = new FakePeerConnection();
    const timer = new FakeTimer();
    let requests = 0;
    const publisher = new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip" },
      {
        timer,
        createPeerConnection: () => pc as unknown as RTCPeerConnection,
        createWhipClient: () =>
          ({
            publish: async () => ({ answerSdp: ACCEPTED_VIDEO_ANSWER, resourceUrl: "https://coord/whip/s" }),
            delete: async () => {},
          }) as unknown as WhipClient,
        onKeyFrameRequest: () => {
          requests++;
          return true;
        },
      }
    );
    await publisher.start();
    expect(pc.pliSubscribers).toHaveLength(1);

    // A relayed WHEP viewer PLI requests a keyframe from the source.
    pc.pliSubscribers[0]();
    expect(requests).toBe(1);
    // A second PLI within the throttle window is coalesced away.
    pc.pliSubscribers[0]();
    expect(requests).toBe(1);
    // After the throttle interval, the next PLI is honored.
    timer.advanceTime(KEYFRAME_REQUEST_MIN_INTERVAL_MS);
    pc.pliSubscribers[0]();
    expect(requests).toBe(2);
  });

  test("reports IDR completion and RTP publication readiness after a relayed PLI", async () => {
    const pc = new FakePeerConnection();
    const timer = new FakeTimer();
    const publisher = new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip" },
      {
        timer,
        createPeerConnection: () => pc as unknown as RTCPeerConnection,
        createWhipClient: () =>
          ({
            publish: async () => ({ answerSdp: ACCEPTED_VIDEO_ANSWER, resourceUrl: "https://coord/whip/s" }),
            delete: async () => {},
          }) as unknown as WhipClient,
        onKeyFrameRequest: () => true,
      }
    );
    await publisher.start();
    pc.pliSubscribers[0]();

    const start = Buffer.from([0, 0, 0, 1]);
    publisher.writeH264Chunk(
      Buffer.concat([
        start, Buffer.from([0x67, 0x42, 0xe0, 0x2a]),
        start, Buffer.from([0x68, 0xce, 0x3c, 0x80]),
        start, Buffer.from([0x65, 0x80, 0x00]),
        start, Buffer.from([0x41, 0x80, 0x01]),
        start, Buffer.from([0x41, 0x80, 0x02]),
      ])
    );

    expect(publisher.getDescriptor().readiness).toMatchObject({
      lastEncodedFrameTimestampUs: 0,
      lastIdrTimestampUs: 0,
      idrRequestCount: 1,
      idrCompletionCount: 1,
      encodedAccessUnitCount: 1,
    });
    expect(publisher.getDescriptor().readiness.publisherRtpPacketCount).toBeGreaterThan(0);
    await publisher.stop();
  });
});

describe("WebRtcPublisher frame-stall watchdog", () => {
  function connectedPublisher(
    frameStallTimeoutMs: number | undefined,
    timer: FakeTimer,
    onConnected?: () => void | Promise<void>
  ) {
    const pc = new FakePeerConnection();
    pc.connectionState = "connected"; // establish() fires the connected hook inline
    return new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip", frameStallTimeoutMs },
      {
        timer,
        onConnected,
        createPeerConnection: () => pc as unknown as RTCPeerConnection,
        createWhipClient: () =>
          ({
            publish: async () => ({ answerSdp: ACCEPTED_VIDEO_ANSWER, resourceUrl: "https://coord/whip/s" }),
            delete: async () => {},
          }) as unknown as WhipClient,
      }
    );
  }

  test("reconnects when a connected stream produces no frames within the timeout", async () => {
    const timer = new FakeTimer();
    const publisher = connectedPublisher(4000, timer);
    const internals = publisher as unknown as { notifySourceFailed: () => void };
    let recoveries = 0;
    internals.notifySourceFailed = () => { recoveries++; };

    await publisher.start();
    // No frames ever written: after the stall timeout the watchdog reconnects.
    timer.advanceTime(4000);
    expect(recoveries).toBe(1);

    await publisher.stop();
  });

  test("does not count capture-source startup time as a frame stall", async () => {
    const timer = new FakeTimer();
    const sourceStarted = deferred();
    const publisher = connectedPublisher(4000, timer, () => sourceStarted.promise);
    const internals = publisher as unknown as { notifySourceFailed: () => void };
    let recoveries = 0;
    internals.notifySourceFailed = () => { recoveries++; };

    await publisher.start();
    timer.advanceTime(60_000);
    expect(recoveries).toBe(0);

    sourceStarted.resolve();
    await Promise.resolve();
    await Promise.resolve();
    timer.advanceTime(4000);
    expect(recoveries).toBe(1);

    await publisher.stop();
  });

  test("does not reconnect while frames keep advancing", async () => {
    const timer = new FakeTimer();
    const publisher = connectedPublisher(4000, timer);
    const internals = publisher as unknown as { notifySourceFailed: () => void };
    let recoveries = 0;
    internals.notifySourceFailed = () => { recoveries++; };

    await publisher.start();
    const START = Buffer.from([0, 0, 0, 1]);
    // SPS(42e02a) + PPS + IDR — a real keyframe the writer accepts.
    publisher.writeH264Chunk(
      Buffer.concat([
        START, Buffer.from([0x67, 0x42, 0xe0, 0x2a]),
        START, Buffer.from([0x68, 0xce, 0x3c, 0x80]),
        START, Buffer.from([0x65, 0x80, 0x00]),
      ])
    );
    // Feed a P-frame each step; each completes the previous access unit, so the
    // frame counter advances well within every timeout window.
    for (let step = 0; step < 6; step++) {
      publisher.writeH264Chunk(Buffer.concat([START, Buffer.from([0x41, 0x80, step + 1])]));
      timer.advanceTime(1500);
    }
    expect(recoveries).toBe(0);

    await publisher.stop();
  });

  test("gives an accepted PLI recovery a fresh bounded watchdog interval", async () => {
    const timer = new FakeTimer();
    const pc = new FakePeerConnection();
    pc.connectionState = "connected";
    const publisher = new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip", frameStallTimeoutMs: 4000 },
      {
        timer,
        onKeyFrameRequest: () => true,
        createPeerConnection: () => pc as unknown as RTCPeerConnection,
        createWhipClient: () =>
          ({
            publish: async () => ({ answerSdp: ACCEPTED_VIDEO_ANSWER, resourceUrl: "https://coord/whip/s" }),
            delete: async () => {},
          }) as unknown as WhipClient,
      }
    );
    const internals = publisher as unknown as { notifySourceFailed: () => void };
    let recoveries = 0;
    internals.notifySourceFailed = () => { recoveries++; };

    await publisher.start();
    timer.advanceTime(3000);
    pc.pliSubscribers[0]();

    // The previous deadline was one second away, but this PLI starts a bounded
    // source recovery and must not be immediately classified as a stalled source.
    timer.advanceTime(3000);
    expect(recoveries).toBe(0);

    // The recovery remains bounded: an encoder that never emits an IDR still
    // follows the normal stalled-source reconnect path.
    timer.advanceTime(2000);
    expect(recoveries).toBe(1);

    await publisher.stop();
  });

  test("does not extend the watchdog when a throttled PLI starts no recovery", async () => {
    const timer = new FakeTimer();
    const pc = new FakePeerConnection();
    pc.connectionState = "connected";
    let recoveryStarts = true;
    const publisher = new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip", frameStallTimeoutMs: 4000 },
      {
        timer,
        onKeyFrameRequest: () => recoveryStarts,
        createPeerConnection: () => pc as unknown as RTCPeerConnection,
        createWhipClient: () =>
          ({
            publish: async () => ({ answerSdp: ACCEPTED_VIDEO_ANSWER, resourceUrl: "https://coord/whip/s" }),
            delete: async () => {},
          }) as unknown as WhipClient,
      }
    );
    const internals = publisher as unknown as { notifySourceFailed: () => void };
    let recoveries = 0;
    internals.notifySourceFailed = () => { recoveries++; };

    await publisher.start();
    timer.advanceTime(3000);
    pc.pliSubscribers[0]();
    recoveryStarts = false;
    timer.advanceTime(KEYFRAME_REQUEST_MIN_INTERVAL_MS * 2);
    pc.pliSubscribers[0]();
    expect(publisher.getDescriptor().readiness.idrRequestCount).toBe(1);

    // The first PLI resets the deadline to t=7000. The second is throttled by
    // the source and must not move it to t=9000. The watchdog checks at t=6000
    // and t=8000, so only the latter can detect the original deadline.
    timer.advanceTime(1000);
    expect(recoveries).toBe(0);
    timer.advanceTime(2000);
    expect(recoveries).toBe(1);

    await publisher.stop();
  });

  test("is disabled when no timeout is configured", async () => {
    const timer = new FakeTimer();
    const publisher = connectedPublisher(undefined, timer);
    const internals = publisher as unknown as { notifySourceFailed: () => void };
    let recoveries = 0;
    internals.notifySourceFailed = () => { recoveries++; };

    await publisher.start();
    timer.advanceTime(60_000);
    expect(recoveries).toBe(0);

    await publisher.stop();
  });
});

describe("WebRtcPublisher audio", () => {
  test("adds an audio transceiver only when audio is enabled and writes PCMU packets", async () => {
    const pc = new RecordingPeerConnection();
    const publisher = new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip", audioEnabled: true },
      {
        createPeerConnection: () => pc as unknown as RTCPeerConnection,
        createWhipClient: () =>
          ({
            publish: async () => ({ answerSdp: ACCEPTED_VIDEO_AND_AUDIO_ANSWER, resourceUrl: "https://coord/whip/s" }),
            delete: async () => {},
          }) as unknown as WhipClient,
      }
    );

    await publisher.start();
    publisher.writePcmAudioChunk(Buffer.alloc(4));

    expect(pc.transceiverKinds).toEqual(["video", "audio"]);
    expect(publisher.getDescriptor().audioPacketsSent).toBe(1);

    await publisher.stop();
  });

  test("keeps the default video-only transceiver set", async () => {
    const pc = new RecordingPeerConnection();
    const publisher = new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip" },
      {
        createPeerConnection: () => pc as unknown as RTCPeerConnection,
        createWhipClient: () =>
          ({
            publish: async () => ({ answerSdp: ACCEPTED_VIDEO_ANSWER, resourceUrl: "https://coord/whip/s" }),
            delete: async () => {},
          }) as unknown as WhipClient,
      }
    );

    await publisher.start();
    publisher.writePcmAudioChunk(Buffer.alloc(4));

    expect(pc.transceiverKinds).toEqual(["video"]);
    expect(publisher.getDescriptor().audioPacketsSent).toBe(0);

    await publisher.stop();
  });

  test("rejects a WHIP answer that drops requested audio and deletes the session", async () => {
    const pc = new RecordingPeerConnection();
    const deleted: string[] = [];
    const publisher = new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip", audioEnabled: true },
      {
        createPeerConnection: () => pc as unknown as RTCPeerConnection,
        createWhipClient: () =>
          ({
            publish: async () => ({
              answerSdp: `${ACCEPTED_VIDEO_ANSWER}\r\nm=audio 0 UDP/TLS/RTP/SAVPF 0`,
              resourceUrl: "https://coord/whip/s",
            }),
            delete: async (url: string) => { deleted.push(url); },
          }) as unknown as WhipClient,
      }
    );

    await expect(publisher.start()).rejects.toThrow(/rejected the requested audio/);
    expect(deleted).toEqual(["https://coord/whip/s"]);
    expect(pc.closed).toBe(true);
  });
});
