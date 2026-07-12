import { describe, expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpPacket,
  useH264,
} from "werift";
import { HttpCoordinationServer } from "../../examples/webrtc-coordination-server/httpServer";
import { WebRtcPublisher } from "../../src/features/webrtc/WebRtcPublisher";

/**
 * Full end-to-end: a real AutoMobile publisher pushes H.264 to the reference
 * coordination server over WHIP (real HTTP), and a werift "browser" subscribes
 * over WHEP. Proves ingest -> forward -> egress and the reconnect API, all
 * without a device or a browser.
 */

const START = Buffer.from([0x00, 0x00, 0x00, 0x01]);

function nal(type: number, size: number, fill: number): Buffer {
  const buffer = Buffer.alloc(size, fill);
  buffer[0] = 0x60 | (type & 0x1f);
  // VCL slices need first_mb_in_slice == 0 so each is a new-picture boundary.
  if (type >= 1 && type <= 5 && size > 1) {
    buffer[1] = 0x80;
  }
  return buffer;
}

function keyframe(): Buffer {
  return Buffer.concat([
    START, nal(7, 8, 0x11),
    START, nal(8, 6, 0x22),
    START, nal(5, 3000, 0x33),
    START,
  ]);
}

function pFrame(fill: number): Buffer {
  return Buffer.concat([nal(1, 800, fill), START]);
}

async function waitForIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") {
    return;
  }
  await pc.iceGatheringStateChange.watch(state => state === "complete", 5000);
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

describe("WebRTC coordination server e2e", () => {
  test(
    "publisher -> WHIP ingest -> WHEP subscriber forwards frames, reconnect API lists the stream",
    async () => {
      const http = new HttpCoordinationServer({ iceServers: [] });
      const port = await http.listen(0, "127.0.0.1");
      const base = `http://127.0.0.1:${port}`;

      const publisher = new WebRtcPublisher({
        streamId: "e2e",
        whipEndpoint: `${base}/whip?streamId=e2e`,
      });

      // A werift stand-in for the browser WHEP viewer.
      const viewer = new RTCPeerConnection({ codecs: { video: [useH264()] } });
      const received: RtpPacket[] = [];
      let sawMarker = false;
      viewer.onTrack.subscribe((track: MediaStreamTrack) => {
        track.onReceiveRtp.subscribe((rtp: RtpPacket) => {
          received.push(rtp);
          if (rtp.header.marker) {
            sawMarker = true;
          }
        });
      });

      try {
        await publisher.start();
        expect(publisher.getState()).toBe("connected");

        // Reconnect API should list the freshly-ingested stream.
        const listRes = await fetch(`${base}/api/streams`);
        const { streams } = (await listRes.json()) as { streams: Array<{ streamId: string; whepUrl: string }> };
        expect(streams.some(s => s.streamId === "e2e")).toBe(true);
        const whepUrl = streams.find(s => s.streamId === "e2e")!.whepUrl;
        expect(whepUrl).toBe("/whep/e2e");

        // Browser subscribes over WHEP.
        viewer.addTransceiver("video", { direction: "recvonly" });
        const offer = await viewer.createOffer();
        await viewer.setLocalDescription(offer);
        await waitForIce(viewer);
        const whepRes = await fetch(`${base}${whepUrl}`, {
          method: "POST",
          headers: { "Content-Type": "application/sdp" },
          body: viewer.localDescription?.sdp ?? "",
        });
        expect(whepRes.status).toBe(201);
        expect(whepRes.headers.get("location")).toContain("/whep/e2e/");
        await viewer.setRemoteDescription({ type: "answer", sdp: await whepRes.text() });

        await waitFor(() => viewer.connectionState === "connected", 8000);

        // Pump media; frames should forward publisher -> server -> viewer.
        publisher.writeH264Chunk(keyframe());
        for (let i = 0; i < 40; i++) {
          publisher.writeH264Chunk(pFrame(0x40 + (i % 32)));
          await sleep(20);
          if (received.length > 5) {
            break;
          }
        }

        await waitFor(() => received.length > 5, 5000);
        expect(received.length).toBeGreaterThan(5);
        expect(sawMarker).toBe(true);

        // The reconnect API now reports the stream as live with a subscriber.
        const streamRes = await fetch(`${base}/api/streams/e2e`);
        const descriptor = (await streamRes.json()) as { state: string; subscriberCount: number };
        expect(descriptor.state).toBe("live");
        expect(descriptor.subscriberCount).toBeGreaterThanOrEqual(1);
      } finally {
        await publisher.stop();
        await viewer.close();
        await http.close();
      }
    },
    30000
  );
});
