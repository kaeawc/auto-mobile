import { describe, expect, test } from "bun:test";
import type { RTCPeerConnection } from "werift";
import { WebRtcPublisher } from "../../../src/features/webrtc/WebRtcPublisher";
import type { WhipClient } from "../../../src/features/webrtc/WhipClient";
import { VIDEO_ONLY_WHIP_ANSWER } from "../../helpers/webrtcFakes";

/**
 * Fake peer connection whose ICE gathering NEVER completes, so a publisher that
 * (incorrectly) waited on gathering would hang. Exposes `emitCandidate` to drive
 * the trickle path.
 */
class FakeTricklePc {
  closed = false;
  connectionState = "connected";
  iceGatheringState = "gathering";
  private candidateCb?: (candidate: unknown) => void;
  private connectionStateCb?: (state: string) => void;
  candidateDuringSetLocalDescription?: {
    candidate: string;
    sdpMid?: string;
    sdpMLineIndex?: number;
  };
  connectionStateChange = {
    subscribe: (callback: (state: string) => void) => {
      this.connectionStateCb = callback;
      return {
        unSubscribe: () => {
          this.connectionStateCb = undefined;
        },
      };
    },
  };
  // Never resolves: proves the trickle path does not block on gathering.
  iceGatheringStateChange = { watch: () => new Promise<void>(() => {}) };
  onIceCandidate = {
    subscribe: (cb: (candidate: unknown) => void) => {
      this.candidateCb = cb;
      return { unSubscribe: () => {} };
    },
  };
  localDescription = {
    sdp: ["v=0", "m=video 9 UDP/TLS/RTP/SAVPF 102", "a=mid:0", "a=ice-ufrag:u", "a=ice-pwd:p"].join(
      "\r\n",
    ),
  };
  addTransceiver() {
    return { sender: { ssrc: 1, onPictureLossIndication: { subscribe: () => {} } } };
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0" };
  }
  async setLocalDescription() {
    if (this.candidateDuringSetLocalDescription) {
      this.emitCandidate(this.candidateDuringSetLocalDescription);
    }
  }
  async setRemoteDescription() {}
  async close() {
    this.closed = true;
  }
  emitCandidate(
    candidate: { candidate: string; sdpMid?: string; sdpMLineIndex?: number } | null,
  ): void {
    this.candidateCb?.(candidate);
  }
  emitConnectionState(state: "connected" | "failed" | "disconnected"): void {
    this.connectionState = state;
    this.connectionStateCb?.(state);
  }
}

function makePublisher(pc: FakeTricklePc, trickleIce: boolean) {
  const patched: Array<{ url: string; fragment: string }> = [];
  const publisher = new WebRtcPublisher(
    { streamId: "s", whipEndpoint: "https://coord/whip", trickleIce, maxReconnectAttempts: 1 },
    {
      createPeerConnection: () => pc as unknown as RTCPeerConnection,
      createWhipClient: () =>
        ({
          publish: async () => ({
            answerSdp: VIDEO_ONLY_WHIP_ANSWER,
            resourceUrl: "https://coord/whip/s",
            etag: '"etag"',
          }),
          patchCandidate: async (url: string, _etag: string, fragment: string) => {
            patched.push({ url, fragment });
          },
          delete: async () => {},
        }) as unknown as WhipClient,
    },
  );
  return { publisher, patched };
}

describe("WebRtcPublisher trickle ICE", () => {
  test("buffers a candidate emitted during local-description setup until WHIP accepts the resource", async () => {
    const pc = new FakeTricklePc();
    pc.candidateDuringSetLocalDescription = {
      candidate: "candidate:early 1 udp 2113 1.2.3.4 4000 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    };
    const { publisher, patched } = makePublisher(pc, true);

    await publisher.start();

    expect(patched).toHaveLength(1);
    expect(patched[0].fragment).toContain("candidate:early");
    await publisher.stop();
  });

  test("publishes without waiting for gathering and PATCHes candidates to the resource", async () => {
    const pc = new FakeTricklePc();
    const { publisher, patched } = makePublisher(pc, true);

    // Would hang here if the publisher blocked on the never-completing gathering.
    await publisher.start();

    pc.emitCandidate({
      candidate: "candidate:1 1 udp 2113 1.2.3.4 5000 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    });

    expect(patched).toHaveLength(1);
    expect(patched[0].url).toBe("https://coord/whip/s");
    expect(patched[0].fragment).toContain("a=candidate:1 1 udp 2113 1.2.3.4 5000 typ host");
    expect(patched[0].fragment).toContain("a=mid:0");

    await publisher.stop();
  });

  test("candidates emitted after stop are not PATCHed", async () => {
    const pc = new FakeTricklePc();
    const { publisher, patched } = makePublisher(pc, true);
    await publisher.start();
    await publisher.stop();

    pc.emitCandidate({ candidate: "candidate:2 1 udp 1 1.2.3.4 6000 typ host", sdpMid: "0" });
    expect(patched).toHaveLength(0);
  });

  test("ignores late candidates from a replaced peer and forwards end-of-candidates for the current peer", async () => {
    const first = new FakeTricklePc();
    const second = new FakeTricklePc();
    const peers = [first, second];
    const patched: Array<{ url: string; fragment: string }> = [];
    let peerIndex = 0;
    let publishIndex = 0;
    const publisher = new WebRtcPublisher(
      {
        streamId: "s",
        whipEndpoint: "https://coord/whip",
        trickleIce: true,
        maxReconnectAttempts: 1,
      },
      {
        createPeerConnection: () => peers[peerIndex++] as unknown as RTCPeerConnection,
        createWhipClient: () =>
          ({
            publish: async () => ({
              answerSdp: VIDEO_ONLY_WHIP_ANSWER,
              resourceUrl: `https://coord/whip/session-${++publishIndex}`,
              etag: '"etag"',
            }),
            patchCandidate: async (url: string, _etag: string, fragment: string) => {
              patched.push({ url, fragment });
            },
            delete: async () => {},
          }) as unknown as WhipClient,
      },
    );

    await publisher.start();
    first.emitConnectionState("failed");
    for (let turn = 0; turn < 12; turn++) {
      await Promise.resolve();
    }

    first.emitCandidate({
      candidate: "candidate:stale 1 udp 1 1.2.3.4 7000 typ host",
      sdpMid: "0",
    });
    second.emitCandidate({
      candidate: "candidate:current 1 udp 1 1.2.3.4 8000 typ host",
      sdpMid: "0",
    });
    second.emitCandidate(null);

    expect(patched).toHaveLength(2);
    expect(patched.every((patch) => patch.url === "https://coord/whip/session-2")).toBe(true);
    expect(patched[0].fragment).toContain("candidate:current");
    expect(patched[1].fragment).toContain("a=end-of-candidates");

    await publisher.stop();
  });
});
