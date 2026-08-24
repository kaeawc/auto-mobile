import { describe, expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { MediaStreamTrack, RTCPeerConnection, RtpPacket, useH264 } from "werift";
import { WebRtcPublisher } from "../../../src/features/webrtc/WebRtcPublisher";
import { WhipClient, type FetchLike } from "../../../src/features/webrtc/WhipClient";
import { defaultTimer } from "../../../src/utils/SystemTimer";

/**
 * End-to-end loopback: a real werift publisher POSTs a WHIP offer to an
 * in-process werift receiver (standing in for the coordination server's ingest
 * endpoint). This exercises RTP packetization + DTLS/ICE + media transport
 * without a device or a real HTTP server — the true proof that the publish path
 * works.
 *
 * Deliberately opt-in, like the MediaMTX integration suite: the DTLS/ICE
 * handshake runs over REAL loopback UDP sockets, which under CI runner
 * contention can stall — exactly the real-I/O hang class the macos "Run Tests"
 * watchdog (#5391) guards against, and one a fakes-based unit test cannot
 * cover. It runs in the dedicated `webrtc-integration-test` CI job (and
 * locally) via `bun run test:integration:webrtc-mediamtx`; the fakes-based
 * WebRtcPublisher.test.ts / WebRtcPublisher.trickle.test.ts suites keep the
 * publisher logic covered in the default `bun test` run.
 */
const RUN_INTEGRATION = process.env.AUTOMOBILE_MEDIAMTX_WEBRTC_INTEGRATION === "1";
const describeLoopback = RUN_INTEGRATION ? describe : describe.skip;

/** Bound a real-I/O step so a stalled DTLS/ICE exchange fails with a diagnostic. */
async function withDeadline<T>(step: string, timeoutMs: number, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = defaultTimer.setTimeout(
      () =>
        reject(
          new Error(
            `${step} did not complete within ${timeoutMs}ms — bounded real-I/O deadline hit`,
          ),
        ),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    if (timer !== undefined) {
      defaultTimer.clearTimeout(timer);
    }
  }
}

const START = Buffer.from([0x00, 0x00, 0x00, 0x01]);

function nal(type: number, size: number, fill: number): Buffer {
  const buffer = Buffer.alloc(size, fill);
  buffer[0] = 0x60 | (type & 0x1f); // nal_ref_idc=3
  // VCL slices need first_mb_in_slice == 0 so each is a new-picture boundary.
  if (type >= 1 && type <= 5 && size > 1) {
    buffer[1] = 0x80;
  }
  return buffer;
}

/** A keyframe access unit (SPS + PPS + large IDR) followed by the next start code. */
function keyframeStream(): Buffer {
  return Buffer.concat([
    // Constrained-baseline Level 4.2, matching the publisher's SDP contract.
    START,
    Buffer.from([0x67, 0x42, 0xe0, 0x2a, 0x11, 0x11, 0x11, 0x11]),
    START,
    nal(8, 6, 0x22), // PPS
    START,
    nal(5, 4000, 0x33), // IDR large enough to force FU-A fragmentation
    START, // trailing start code so the IDR NAL is emitted immediately
  ]);
}

function pFrameStream(fill: number): Buffer {
  return Buffer.concat([nal(1, 1200, fill), START]);
}

async function waitForIceComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") {
    return;
  }
  await pc.iceGatheringStateChange.watch((state) => state === "complete", 5000);
}

describeLoopback("WebRtcPublisher loopback", () => {
  test("publishes an H.264 stream over WHIP and the receiver gets RTP frames", async () => {
    const receiver = new RTCPeerConnection({ codecs: { video: [useH264()] } });
    const receivedPackets: RtpPacket[] = [];
    let sawMarker = false;

    receiver.onTrack.subscribe((track: MediaStreamTrack) => {
      track.onReceiveRtp.subscribe((rtp: RtpPacket) => {
        receivedPackets.push(rtp);
        if (rtp.header.marker) {
          sawMarker = true;
        }
      });
    });

    // Fake fetch that drives the in-process receiver as a WHIP ingest server.
    const fetchImpl: FetchLike = async (url, init) => {
      if (init.method === "DELETE") {
        return jsonlessResponse(200, "");
      }
      await receiver.setRemoteDescription({ type: "offer", sdp: init.body ?? "" });
      const answer = await receiver.createAnswer();
      await receiver.setLocalDescription(answer);
      await waitForIceComplete(receiver);
      return {
        status: 201,
        ok: true,
        headers: {
          get: (name: string) => (name.toLowerCase() === "location" ? "/whip/loopback" : null),
        },
        text: async () => receiver.localDescription?.sdp ?? "",
      };
    };

    const publisher = new WebRtcPublisher(
      {
        streamId: "loopback-test",
        whipEndpoint: "https://ingest.local/whip",
      },
      {
        createWhipClient: (options) => new WhipClient({ ...options, fetchImpl }),
      },
    );

    try {
      await withDeadline("publisher.start (WHIP offer/answer + ICE)", 10_000, () =>
        publisher.start(),
      );
      expect(publisher.getState()).toBe("connected");

      // Wait for the DTLS/ICE transport to connect before pumping media.
      await waitForConnected(receiver, 8000);

      // Pump a keyframe then a series of P-frames.
      publisher.writeH264Chunk(keyframeStream());
      for (let i = 0; i < 20; i++) {
        publisher.writeH264Chunk(pFrameStream(0x40 + i));
        await sleep(20);
      }

      await waitFor(() => receivedPackets.length > 5, 5000);

      expect(receivedPackets.length).toBeGreaterThan(5);
      expect(sawMarker).toBe(true);

      const descriptor = publisher.getDescriptor();
      expect(descriptor.resourceUrl).toBe("https://ingest.local/whip/loopback");
      expect(descriptor.framesSent).toBeGreaterThan(0);
    } finally {
      // Teardown must be bounded too: a hung stop/close would leak the real
      // UDP sockets and keep the worker process alive after the test fails.
      await withDeadline("publisher.stop", 5_000, () => publisher.stop());
      await withDeadline("receiver.close", 5_000, async () => {
        await receiver.close();
      });
    }
  }, 20000);
});

function jsonlessResponse(status: number, body: string) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => body,
  };
}

async function waitForConnected(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.connectionState === "connected") {
    return;
  }
  await waitFor(() => pc.connectionState === "connected", timeoutMs);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(50);
  }
  if (!predicate()) {
    throw new Error("Timed out waiting for condition");
  }
}
