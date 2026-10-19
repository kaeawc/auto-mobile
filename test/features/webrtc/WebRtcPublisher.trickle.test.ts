import { describe, expect, test } from "bun:test";
import { fakeWhipClient } from "../../helpers/fakeWhipClient";
import { FakePublisherPeerConnection } from "../../fakes/FakePublisherPeerConnection";
import { WebRtcPublisher } from "../../../src/features/webrtc/WebRtcPublisher";
import { VIDEO_ONLY_WHIP_ANSWER } from "../../helpers/webrtcFakes";

/**
 * Fake peer connection whose ICE gathering NEVER completes, so a publisher that
 * (incorrectly) waited on gathering would hang. Drives the trickle path through
 * `emitCandidate`.
 */
function createTricklePc(): FakePublisherPeerConnection {
  const pc = new FakePublisherPeerConnection();
  pc.connectionState = "connected";
  pc.iceGatheringState = "gathering";
  pc.gatheringNeverCompletes = true;
  pc.localDescription = {
    sdp: ["v=0", "m=video 9 UDP/TLS/RTP/SAVPF 102", "a=mid:0", "a=ice-ufrag:u", "a=ice-pwd:p"].join(
      "\r\n",
    ),
  };
  return pc;
}

function makePublisher(pc: FakePublisherPeerConnection, trickleIce: boolean) {
  const patched: Array<{ url: string; fragment: string }> = [];
  const publisher = new WebRtcPublisher(
    { streamId: "s", whipEndpoint: "https://coord/whip", trickleIce, maxReconnectAttempts: 1 },
    {
      createPeerConnection: () => pc,
      createWhipClient: () =>
        fakeWhipClient({
          publish: async () => ({
            answerSdp: VIDEO_ONLY_WHIP_ANSWER,
            resourceUrl: "https://coord/whip/s",
            etag: '"etag"',
          }),
          patchCandidate: async (url: string, _etag: string, fragment: string) => {
            patched.push({ url, fragment });
          },
          delete: async () => {},
        }),
    },
  );
  return { publisher, patched };
}

describe("WebRtcPublisher trickle ICE", () => {
  test("buffers a candidate emitted during local-description setup until WHIP accepts the resource", async () => {
    const pc = createTricklePc();
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
    const pc = createTricklePc();
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
    const pc = createTricklePc();
    const { publisher, patched } = makePublisher(pc, true);
    await publisher.start();
    await publisher.stop();

    pc.emitCandidate({ candidate: "candidate:2 1 udp 1 1.2.3.4 6000 typ host", sdpMid: "0" });
    expect(patched).toHaveLength(0);
  });

  test("ignores late candidates from a replaced peer and forwards end-of-candidates for the current peer", async () => {
    const first = createTricklePc();
    const second = createTricklePc();
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
        createPeerConnection: () => peers[peerIndex++],
        createWhipClient: () =>
          fakeWhipClient({
            publish: async () => ({
              answerSdp: VIDEO_ONLY_WHIP_ANSWER,
              resourceUrl: `https://coord/whip/session-${++publishIndex}`,
              etag: '"etag"',
            }),
            patchCandidate: async (url: string, _etag: string, fragment: string) => {
              patched.push({ url, fragment });
            },
            delete: async () => {},
          }),
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
