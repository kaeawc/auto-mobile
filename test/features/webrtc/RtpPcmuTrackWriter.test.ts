import { describe, expect, test } from "bun:test";
import type { RtpPacket } from "werift";
import { RtpPcmuTrackWriter } from "../../../src/features/webrtc/RtpPcmuTrackWriter";

describe("RtpPcmuTrackWriter", () => {
  test("encodes 8kHz mono PCM16LE as PCMU RTP packets", () => {
    const packets: RtpPacket[] = [];
    const writer = new RtpPcmuTrackWriter({
      sink: { writeRtp: (packet) => packets.push(packet) },
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
      sink: { writeRtp: (packet) => packets.push(packet) },
      ssrc: 1,
      mtu: 2,
    });

    writer.writePcm16Chunk(Buffer.alloc(10));

    expect(packets.map((packet) => packet.payload.length)).toEqual([2, 2, 1]);
    expect(packets.map((packet) => packet.header.timestamp)).toEqual([0, 2, 4]);
    expect(writer.stats).toEqual({ packetsWritten: 3, samplesWritten: 5 });
  });

  // Pin the actual encoded mu-law byte per sample, not just the packet count.
  // A silent regression in linear16ToMuLaw (wrong bias, exponent, or sign) would
  // otherwise ship undetected. Values verified against the G.711 mu-law encoder.
  test.each([
    [0, 0xff],
    [1, 0xff],
    [-1, 0x7f],
    [32767, 0x80],
    [-32768, 0x00],
    [8031, 0xa0],
    [-8031, 0x20],
  ])("encodes PCM16 sample %p to mu-law byte", (sample, expectedByte) => {
    const packets: RtpPacket[] = [];
    const writer = new RtpPcmuTrackWriter({
      sink: { writeRtp: (packet) => packets.push(packet) },
      ssrc: 1,
    });
    const chunk = Buffer.alloc(2);
    chunk.writeInt16LE(sample, 0);

    writer.writePcm16Chunk(chunk);

    expect(packets).toHaveLength(1);
    expect(packets[0].payload[0]).toBe(expectedByte);
  });

  // A zero / negative / non-finite MTU would make the packetization loop never
  // advance and wedge the daemon (issue #4170). The guard rejects them at
  // construction. A small positive MTU (e.g. 2) stays legitimate — one PCMU
  // sample is a single byte — and is exercised above.
  test.each([
    [0, "zero MTU cannot advance the payload loop"],
    [-1, "negative MTU cannot advance the payload loop"],
    [Number.NaN, "non-finite MTU cannot advance the payload loop"],
  ])("rejects a non-advancing mtu %p at construction", (mtu, _why) => {
    expect(
      () => new RtpPcmuTrackWriter({ sink: { writeRtp: () => undefined }, ssrc: 1, mtu }),
    ).toThrow(/MTU/i);
  });

  test("preserves a PCM16 sample split across arbitrary chunk boundaries", () => {
    const packets: RtpPacket[] = [];
    const writer = new RtpPcmuTrackWriter({
      sink: { writeRtp: (packet) => packets.push(packet) },
      ssrc: 1,
    });

    writer.writePcm16Chunk(Buffer.from([0x00]));
    expect(packets).toHaveLength(0);
    writer.writePcm16Chunk(Buffer.from([0x00]));

    expect(packets).toHaveLength(1);
    expect(packets[0].payload).toEqual(Buffer.from([0xff]));
    expect(writer.stats).toEqual({ packetsWritten: 1, samplesWritten: 1 });
  });
});
