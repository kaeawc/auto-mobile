import { describe, expect, test } from "bun:test";
import type { RTCPeerConnection } from "werift";
import { WebRtcPublisher } from "../../../src/features/webrtc/WebRtcPublisher";
import type { WhipClient, WhipClientOptions } from "../../../src/features/webrtc/WhipClient";

const ACCEPTED_VIDEO_ANSWER = [
  "v=0",
  "m=video 9 UDP/TLS/RTP/SAVPF 102",
  "a=recvonly",
  "a=rtpmap:102 H264/90000",
  "a=fmtp:102 packetization-mode=1;profile-level-id=42e01f",
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
  addTransceiver() {
    return { sender: { ssrc: 1 } };
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
    return { sender: { ssrc: this.transceiverKinds.length } };
  }
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
});

describe("WebRtcPublisher.notifySourceFailed", () => {
  test("is a no-op after close (does not throw)", async () => {
    const publisher = new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip" },
      { createWhipClient: () => ({}) as unknown as WhipClient }
    );
    await publisher.stop();
    expect(() => publisher.notifySourceFailed()).not.toThrow();
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
