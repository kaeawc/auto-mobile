import { afterEach, describe, expect, test } from "bun:test";
import { RtpHeader, RtpPacket } from "werift";
import {
  CoordinationServer,
  SubscriberRtpForwarder,
  type RtpOutboundTrack,
} from "../../examples/webrtc-coordination-server/coordinationServer";

/** Lightweight tests for the coordination server's registry / error paths. */

function rtp(sequenceNumber: number, timestamp: number, marker: boolean, payload: Buffer): RtpPacket {
  return new RtpPacket(
    new RtpHeader({ version: 2, payloadType: 96, sequenceNumber, timestamp, ssrc: 0xdeadbeef, marker }),
    payload
  );
}

describe("SubscriberRtpForwarder", () => {
  test("rewrites the replay->live seam into one gap-free sequence space", () => {
    const sent: RtpPacket[] = [];
    const sink: RtpOutboundTrack = { writeRtp: packet => sent.push(packet) };
    const forwarder = new SubscriberRtpForwarder(sink);

    // Cached keyframe replay carries the publisher's OLD sequence numbers...
    for (const seq of [1000, 1001, 1002]) {
      forwarder.writeRtp(rtp(seq, 90_000, seq === 1002, Buffer.from([0x65])));
    }
    // ...then live forwarding resumes at the publisher's CURRENT (much larger)
    // numbers. A browser would see 1002 -> 5000 as ~4000 lost packets.
    for (const seq of [5000, 5001, 5002]) {
      forwarder.writeRtp(rtp(seq, 96_000, seq === 5002, Buffer.from([0x41])));
    }

    // Output is contiguous: no gap for the browser to interpret as loss.
    expect(sent.map(packet => packet.header.sequenceNumber)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("preserves timestamp, ssrc, marker, and payload (only the sequence changes)", () => {
    const sent: RtpPacket[] = [];
    const forwarder = new SubscriberRtpForwarder({ writeRtp: packet => sent.push(packet) }, 40_000);
    const payload = Buffer.from([0x67, 0x42, 0xe0, 0x2a]);

    forwarder.writeRtp(rtp(9, 123_456, true, payload));

    expect(sent[0].header.sequenceNumber).toBe(40_000);
    expect(sent[0].header.timestamp).toBe(123_456);
    expect(sent[0].header.ssrc).toBe(0xdeadbeef);
    expect(sent[0].header.marker).toBe(true);
    expect(sent[0].payload).toEqual(payload);
  });

  test("wraps the 16-bit sequence space", () => {
    const sent: RtpPacket[] = [];
    const forwarder = new SubscriberRtpForwarder({ writeRtp: packet => sent.push(packet) }, 0xffff);
    forwarder.writeRtp(rtp(1, 0, false, Buffer.from([0x41])));
    forwarder.writeRtp(rtp(2, 0, false, Buffer.from([0x41])));
    expect(sent.map(packet => packet.header.sequenceNumber)).toEqual([0xffff, 0x0000]);
  });
});

let server: CoordinationServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("CoordinationServer", () => {
  test("lists no streams initially and returns null for unknown ids", () => {
    server = new CoordinationServer({ iceServers: [] });
    expect(server.listStreams()).toEqual([]);
    expect(server.getStream("nope")).toBeNull();
  });

  test("subscribing to an unknown stream throws", async () => {
    server = new CoordinationServer({ iceServers: [] });
    await expect(server.subscribe("missing", "v=0")).rejects.toThrow(/No such stream/);
  });

  test("stopIngest / stopSubscriber are safe no-ops for unknown ids", async () => {
    server = new CoordinationServer({ iceServers: [] });
    await expect(server.stopIngest("missing")).resolves.toBeUndefined();
    await expect(server.stopSubscriber("missing", "sub")).resolves.toBeUndefined();
  });
});
