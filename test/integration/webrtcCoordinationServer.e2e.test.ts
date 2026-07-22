import { describe, expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpPacket,
  useH264,
  usePCMU,
} from "werift";
import { forwardRtpToOutboundTracks } from "../../examples/webrtc-coordination-server/coordinationServer";
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

function rtpPacket(sequenceNumber: number, timestamp: number, ssrc: number): RtpPacket {
  const buffer = Buffer.alloc(12);
  buffer[0] = 0x80;
  buffer[1] = 96;
  buffer.writeUInt16BE(sequenceNumber, 2);
  buffer.writeUInt32BE(timestamp, 4);
  buffer.writeUInt32BE(ssrc, 8);
  return RtpPacket.deSerialize(buffer);
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
  test("clones RTP before forwarding to each subscriber track", () => {
    const packet = rtpPacket(0x1234, 0x01020304, 0x05060708);
    const secondTrackPackets: Array<{ sequenceNumber: number; timestamp: number; ssrc: number }> = [];

    forwardRtpToOutboundTracks(
      [
        {
          writeRtp: forwarded => {
            forwarded.header.sequenceNumber = 1;
            forwarded.header.timestamp = 2;
            forwarded.header.ssrc = 3;
          },
        },
        {
          writeRtp: forwarded => {
            secondTrackPackets.push({
              sequenceNumber: forwarded.header.sequenceNumber,
              timestamp: forwarded.header.timestamp,
              ssrc: forwarded.header.ssrc,
            });
          },
        },
      ],
      packet
    );

    expect(secondTrackPackets).toEqual([
      { sequenceNumber: 0x1234, timestamp: 0x01020304, ssrc: 0x05060708 },
    ]);
    expect(packet.header.sequenceNumber).toBe(0x1234);
    expect(packet.header.timestamp).toBe(0x01020304);
    expect(packet.header.ssrc).toBe(0x05060708);
  });

  test("rejects an oversized SDP request without taking down the HTTP server", async () => {
    const http = new HttpCoordinationServer({ iceServers: [] });
    const port = await http.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    try {
      const response = await fetch(`${base}/whip`, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: "v=0\r\n" + "x".repeat(1_000_000),
      });
      expect(response.status).toBe(413);
      expect((await fetch(`${base}/api/streams`)).status).toBe(200);
    } finally {
      await http.close();
    }
  });

  test("advertises the CORS and SDP contract required by browser WHIP clients", async () => {
    const http = new HttpCoordinationServer({ iceServers: [] });
    const port = await http.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    try {
      const response = await fetch(`${base}/whip`, { method: "OPTIONS" });
      expect(response.status).toBe(200);
      expect(response.headers.get("accept-post")).toBe("application/sdp");
      expect(response.headers.get("access-control-allow-headers")).toContain("If-Match");
      expect(response.headers.get("access-control-expose-headers")).toContain("Location");
      expect(response.headers.get("access-control-expose-headers")).toContain("ETag");
    } finally {
      await http.close();
    }
  });

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
        const whepAnswer = await whepRes.text();
        // RFC 9725 / WHEP require rtcp-mux-only on each bundled m-section;
        // werift needs this signalled explicitly by the reference server.
        expect(whepAnswer).toContain("a=rtcp-mux\r\na=rtcp-mux-only\r\n");
        await viewer.setRemoteDescription({ type: "answer", sdp: whepAnswer });

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

  test(
    "replays cached SPS/PPS and a complete multi-slice IDR to a late WHEP viewer",
    async () => {
      const http = new HttpCoordinationServer({ iceServers: [] });
      const port = await http.listen(0, "127.0.0.1");
      const base = `http://127.0.0.1:${port}`;
      const publisher = new WebRtcPublisher({
        streamId: "late-viewer",
        whipEndpoint: `${base}/whip?streamId=late-viewer`,
      });
      const primingViewer = new RTCPeerConnection({ codecs: { video: [useH264()] } });
      const viewer = new RTCPeerConnection({ codecs: { video: [useH264()] } });
      const received: RtpPacket[] = [];
      viewer.onTrack.subscribe((track: MediaStreamTrack) => {
        track.onReceiveRtp.subscribe((rtp: RtpPacket) => received.push(rtp));
      });

      try {
        await publisher.start();
        await waitFor(() => publisher.getState() === "connected", 8000);
        primingViewer.addTransceiver("video", { direction: "recvonly" });
        await primingViewer.setLocalDescription(await primingViewer.createOffer());
        await waitForIce(primingViewer);
        const primingResponse = await fetch(`${base}/whep/late-viewer`, {
          method: "POST",
          headers: { "Content-Type": "application/sdp" },
          body: primingViewer.localDescription?.sdp ?? "",
        });
        await primingViewer.setRemoteDescription({ type: "answer", sdp: await primingResponse.text() });
        await waitFor(() => primingViewer.connectionState === "connected", 8000);
        // Two IDR slices prove the cache retains the complete marked access unit.
        const secondIdrSlice = nal(5, 1200, 0x44);
        secondIdrSlice[1] = 0x40; // first_mb_in_slice > 0: same access unit as the first IDR.
        publisher.writeH264Chunk(Buffer.concat([
          START, nal(7, 8, 0x11),
          START, nal(8, 6, 0x22),
          START, nal(5, 1200, 0x33),
          START, secondIdrSlice,
          START,
        ]));
        publisher.writeH264Chunk(pFrame(0x55)); // Terminates and sends the cached IDR access unit.
        publisher.writeH264Chunk(pFrame(0x56)); // Terminates the first P-frame parser buffer.
        await sleep(200);
        const cachedStream = (await (await fetch(`${base}/api/streams/late-viewer`)).json()) as {
          framesForwarded: number;
        };
        expect(cachedStream.framesForwarded).toBeGreaterThan(0);
        await primingViewer.close();

        viewer.addTransceiver("video", { direction: "recvonly" });
        await viewer.setLocalDescription(await viewer.createOffer());
        await waitForIce(viewer);
        const response = await fetch(`${base}/whep/late-viewer`, {
          method: "POST",
          headers: { "Content-Type": "application/sdp" },
          body: viewer.localDescription?.sdp ?? "",
        });
        expect(response.status).toBe(201);
        await viewer.setRemoteDescription({ type: "answer", sdp: await response.text() });
        await waitFor(() => viewer.connectionState === "connected", 8000);
        await waitFor(() => received.some(rtp => rtp.header.marker), 5000);

        expect(received.some(rtp => (rtp.payload[0] & 0x1f) === 7)).toBe(true);
        expect(received.some(rtp => (rtp.payload[0] & 0x1f) === 8)).toBe(true);
        expect(received.filter(rtp => (rtp.payload[0] & 0x1f) === 5).length).toBeGreaterThanOrEqual(2);
      } finally {
        await publisher.stop();
        await primingViewer.close();
        await viewer.close();
        await http.close();
      }
    },
    30000
  );

  test(
    "trickle ICE: publisher PATCHes candidates and frames still forward end-to-end",
    async () => {
      const http = new HttpCoordinationServer({ iceServers: [] });
      const port = await http.listen(0, "127.0.0.1");
      const base = `http://127.0.0.1:${port}`;

      // trickleIce: publish the offer immediately and PATCH candidates as they
      // gather; the reference server applies them via addIngestCandidates.
      const publisher = new WebRtcPublisher({
        streamId: "e2e-trickle",
        whipEndpoint: `${base}/whip?streamId=e2e-trickle`,
        trickleIce: true,
      });

      const viewer = new RTCPeerConnection({ codecs: { video: [useH264()] } });
      const received: RtpPacket[] = [];
      viewer.onTrack.subscribe((track: MediaStreamTrack) => {
        track.onReceiveRtp.subscribe((rtp: RtpPacket) => received.push(rtp));
      });

      try {
        await publisher.start();
        expect(publisher.getState()).toBe("connected");

        viewer.addTransceiver("video", { direction: "recvonly" });
        const offer = await viewer.createOffer();
        await viewer.setLocalDescription(offer);
        await waitForIce(viewer);
        const whepRes = await fetch(`${base}/whep/e2e-trickle`, {
          method: "POST",
          headers: { "Content-Type": "application/sdp" },
          body: viewer.localDescription?.sdp ?? "",
        });
        expect(whepRes.status).toBe(201);
        await viewer.setRemoteDescription({ type: "answer", sdp: await whepRes.text() });
        await waitFor(() => viewer.connectionState === "connected", 8000);

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
      } finally {
        await publisher.stop();
        await viewer.close();
        await http.close();
      }
    },
    30000
  );

  test(
    "audio enabled: publisher -> WHIP ingest -> WHEP subscriber forwards audio RTP",
    async () => {
      const http = new HttpCoordinationServer({ iceServers: [] });
      const port = await http.listen(0, "127.0.0.1");
      const base = `http://127.0.0.1:${port}`;

      const publisher = new WebRtcPublisher({
        streamId: "e2e-audio",
        whipEndpoint: `${base}/whip?streamId=e2e-audio`,
        audioEnabled: true,
      });

      const viewer = new RTCPeerConnection({
        codecs: { video: [useH264()], audio: [usePCMU()] },
      });
      const audioPackets: RtpPacket[] = [];
      viewer.onTrack.subscribe((track: MediaStreamTrack) => {
        if (track.kind === "audio") {
          track.onReceiveRtp.subscribe((rtp: RtpPacket) => audioPackets.push(rtp));
        }
      });

      try {
        await publisher.start();

        viewer.addTransceiver("video", { direction: "recvonly" });
        viewer.addTransceiver("audio", { direction: "recvonly" });
        const offer = await viewer.createOffer();
        await viewer.setLocalDescription(offer);
        await waitForIce(viewer);
        const whepRes = await fetch(`${base}/whep/e2e-audio`, {
          method: "POST",
          headers: { "Content-Type": "application/sdp" },
          body: viewer.localDescription?.sdp ?? "",
        });
        expect(whepRes.status).toBe(201);
        await viewer.setRemoteDescription({ type: "answer", sdp: await whepRes.text() });
        await waitFor(() => viewer.connectionState === "connected", 8000);

        publisher.writePcmAudioChunk(Buffer.alloc(320));
        await waitFor(() => audioPackets.length > 0, 5000);

        const streamRes = await fetch(`${base}/api/streams/e2e-audio`);
        const descriptor = (await streamRes.json()) as { audio: boolean; audioPacketsForwarded: number };
        expect(descriptor.audio).toBe(true);
        expect(descriptor.audioPacketsForwarded).toBeGreaterThan(0);
      } finally {
        await publisher.stop();
        await viewer.close();
        await http.close();
      }
    },
    30000
  );
});
