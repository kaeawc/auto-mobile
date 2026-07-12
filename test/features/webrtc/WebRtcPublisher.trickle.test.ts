import { describe, expect, test } from "bun:test";
import type { RTCPeerConnection } from "werift";
import { WebRtcPublisher } from "../../../src/features/webrtc/WebRtcPublisher";
import type { WhipClient } from "../../../src/features/webrtc/WhipClient";

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
  connectionStateChange = { subscribe: () => ({ unSubscribe: () => {} }) };
  // Never resolves: proves the trickle path does not block on gathering.
  iceGatheringStateChange = { watch: () => new Promise<void>(() => {}) };
  onIceCandidate = {
    subscribe: (cb: (candidate: unknown) => void) => {
      this.candidateCb = cb;
      return { unSubscribe: () => {} };
    },
  };
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
  emitCandidate(candidate: { candidate: string; sdpMid?: string; sdpMLineIndex?: number }): void {
    this.candidateCb?.(candidate);
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
          publish: async () => ({ answerSdp: "v=0", resourceUrl: "https://coord/whip/s" }),
          patchCandidate: async (url: string, fragment: string) => {
            patched.push({ url, fragment });
          },
          delete: async () => {},
        }) as unknown as WhipClient,
    }
  );
  return { publisher, patched };
}

describe("WebRtcPublisher trickle ICE", () => {
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
});
