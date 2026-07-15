import { describe, expect, test } from "bun:test";
import type { RtpPacket } from "werift";
import { RtpPcmuTrackWriter } from "../../../src/features/webrtc/RtpPcmuTrackWriter";

describe("RtpPcmuTrackWriter", () => {
  test("encodes 8kHz mono PCM16LE as PCMU RTP packets", () => {
    const packets: RtpPacket[] = [];
    const writer = new RtpPcmuTrackWriter({
      sink: { writeRtp: packet => packets.push(packet) },
      ssrc: 0x1234,
      initialSequenceNumber: 7,
    });

    writer.writePcm16Chunk(Buffer.from([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80]));

    expect(packets).toHaveLength(1);
    expect(packets[0].header.payloadType).toBe(0);
    expect(packets[0].header.sequenceNumber).toBe(7);
    expect(packets[0].header.timestamp).toBe(0);
    expect(packets[0].header.ssrc).toBe(0x1234);
    expect(packets[0].payload).toHaveLength(3);
    expect(writer.stats).toEqual({ packetsWritten: 1, samplesWritten: 3 });
  });

  test("splits large PCM chunks on the RTP payload limit and advances timestamps", () => {
    const packets: RtpPacket[] = [];
    const writer = new RtpPcmuTrackWriter({
      sink: { writeRtp: packet => packets.push(packet) },
      ssrc: 1,
      mtu: 2,
    });

    writer.writePcm16Chunk(Buffer.alloc(10));

    expect(packets.map(packet => packet.payload.length)).toEqual([2, 2, 1]);
    expect(packets.map(packet => packet.header.timestamp)).toEqual([0, 2, 4]);
    expect(writer.stats).toEqual({ packetsWritten: 3, samplesWritten: 5 });
  });
});
