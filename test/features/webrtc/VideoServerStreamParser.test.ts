import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  MAX_PACKET_BYTES,
  MAX_TRACK_COUNT,
  VIDEO_SERVER_CODEC_ID_AMUX,
  VIDEO_SERVER_CODEC_ID_H264,
  VIDEO_SERVER_CODEC_ID_PCM16,
  VIDEO_SERVER_TRACK_ID_AUDIO,
  VIDEO_SERVER_TRACK_ID_VIDEO,
  VideoServerStreamParser,
  type VideoServerPacket,
  type VideoServerStreamHeader,
} from "../../../src/features/webrtc/VideoServerStreamParser";

const FLAG_CONFIG = 1n << 63n;
const FLAG_KEY_FRAME = 1n << 62n;
const FLAG_REPLAYED = 1n << 61n;
const PTS_MASK = FLAG_REPLAYED - 1n;

function streamHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(12);
  buf.writeUInt32BE(VIDEO_SERVER_CODEC_ID_H264, 0);
  buf.writeUInt32BE(width, 4);
  buf.writeUInt32BE(height, 8);
  return buf;
}

function packet(payload: Buffer, flags: bigint, ptsUs: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeBigUInt64BE(flags | (BigInt(ptsUs) & PTS_MASK), 0);
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

function muxHeader(): Buffer {
  const header = Buffer.alloc(12 + 16 + 16);
  header.writeUInt32BE(VIDEO_SERVER_CODEC_ID_AMUX, 0);
  header.writeUInt32BE(1, 4);
  header.writeUInt32BE(2, 8);
  header.writeUInt32BE(VIDEO_SERVER_TRACK_ID_VIDEO, 12);
  header.writeUInt32BE(VIDEO_SERVER_CODEC_ID_H264, 16);
  header.writeUInt32BE(720, 20);
  header.writeUInt32BE(1280, 24);
  header.writeUInt32BE(VIDEO_SERVER_TRACK_ID_AUDIO, 28);
  header.writeUInt32BE(VIDEO_SERVER_CODEC_ID_PCM16, 32);
  header.writeUInt32BE(8000, 36);
  header.writeUInt32BE(1, 40);
  return header;
}

function muxPacket(trackId: number, payload: Buffer, flags: bigint, ptsUs: number): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(trackId, 0);
  header.writeBigUInt64BE(flags | (BigInt(ptsUs) & PTS_MASK), 4);
  header.writeUInt32BE(payload.length, 12);
  return Buffer.concat([header, payload]);
}

function collect(): {
  parser: VideoServerStreamParser;
  headers: VideoServerStreamHeader[];
  packets: VideoServerPacket[];
  } {
  const headers: VideoServerStreamHeader[] = [];
  const packets: VideoServerPacket[] = [];
  const parser = new VideoServerStreamParser({
    onHeader: header => headers.push(header),
    onPacket: packet => packets.push(packet),
  });
  return { parser, headers, packets };
}

describe("VideoServerStreamParser", () => {
  test("parses the stream header once, then packets with flags and pts", () => {
    const { parser, headers, packets } = collect();
    parser.push(streamHeader(242, 540));
    parser.push(packet(Buffer.from([0, 0, 0, 1, 0x67]), FLAG_CONFIG, 0));
    parser.push(packet(Buffer.from([0, 0, 0, 1, 0x65]), FLAG_KEY_FRAME, 1234));

    expect(headers).toEqual([{ codecId: VIDEO_SERVER_CODEC_ID_H264, width: 242, height: 540 }]);
    expect(packets).toHaveLength(2);
    expect(packets[0]).toEqual({
      trackId: VIDEO_SERVER_TRACK_ID_VIDEO,
      codecId: VIDEO_SERVER_CODEC_ID_H264,
      data: Buffer.from([0, 0, 0, 1, 0x67]),
      config: true,
      keyFrame: false,
      replayed: false,
      ptsUs: 0,
    });
    expect(packets[1]).toEqual({
      trackId: VIDEO_SERVER_TRACK_ID_VIDEO,
      codecId: VIDEO_SERVER_CODEC_ID_H264,
      data: Buffer.from([0, 0, 0, 1, 0x65]),
      config: false,
      keyFrame: true,
      replayed: false,
      ptsUs: 1234,
    });
  });

  test("reassembles a header split across chunk boundaries", () => {
    const { parser, headers } = collect();
    const header = streamHeader(720, 1280);
    parser.push(header.subarray(0, 5));
    expect(headers).toHaveLength(0);
    parser.push(header.subarray(5));
    expect(headers).toEqual([{ codecId: VIDEO_SERVER_CODEC_ID_H264, width: 720, height: 1280 }]);
  });

  test("reassembles a packet payload split across chunk boundaries", () => {
    const { parser, packets } = collect();
    parser.push(streamHeader(100, 200));
    const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const framed = packet(payload, 0n, 42);
    // Deliver one byte at a time to stress incremental buffering.
    for (const byte of framed) {
      parser.push(Buffer.from([byte]));
    }
    expect(packets).toHaveLength(1);
    expect(packets[0].data).toEqual(payload);
    expect(packets[0].ptsUs).toBe(42);
  });

  test("handles multiple packets arriving in a single chunk", () => {
    const { parser, packets } = collect();
    const combined = Buffer.concat([
      streamHeader(1, 1),
      packet(Buffer.from([0xaa]), FLAG_CONFIG, 0),
      packet(Buffer.from([0xbb]), FLAG_KEY_FRAME, 10),
      packet(Buffer.from([0xcc]), 0n, 20),
    ]);
    parser.push(combined);
    expect(packets.map(p => p.data[0])).toEqual([0xaa, 0xbb, 0xcc]);
  });

  test("reports replayed packets without changing their flags or timestamp", () => {
    const { parser, packets } = collect();
    parser.push(Buffer.concat([
      streamHeader(1, 1),
      packet(Buffer.from([0, 0, 0, 1, 0x65]), FLAG_KEY_FRAME | FLAG_REPLAYED, 20),
    ]));

    expect(packets[0]).toMatchObject({
      keyFrame: true,
      replayed: true,
      ptsUs: 20,
    });
  });

  test("parses muxed video and audio packets", () => {
    const { parser, headers, packets } = collect();
    parser.push(Buffer.concat([
      muxHeader(),
      muxPacket(VIDEO_SERVER_TRACK_ID_AUDIO, Buffer.from([1, 2, 3, 4]), 0n, 10),
      muxPacket(VIDEO_SERVER_TRACK_ID_VIDEO, Buffer.from([0, 0, 0, 1, 0x65]), FLAG_KEY_FRAME, 20),
    ]));

    expect(headers).toEqual([
      {
        codecId: VIDEO_SERVER_CODEC_ID_H264,
        width: 720,
        height: 1280,
        muxed: true,
        audio: true,
      },
    ]);
    expect(packets.map(packet => [packet.trackId, packet.codecId, packet.ptsUs])).toEqual([
      [VIDEO_SERVER_TRACK_ID_AUDIO, VIDEO_SERVER_CODEC_ID_PCM16, 10],
      [VIDEO_SERVER_TRACK_ID_VIDEO, VIDEO_SERVER_CODEC_ID_H264, 20],
    ]);
  });

  test("skips a mux packet for an unknown track yet keeps parsing later packets", () => {
    // The buffer advances by the packet size BEFORE the unknown-track `continue`.
    // A refactor that skipped the advance would spin forever on the unknown
    // packet; here the following known-track packet must still be delivered.
    const { parser, packets } = collect();
    parser.push(Buffer.concat([
      muxHeader(),
      muxPacket(99, Buffer.from([0xde, 0xad]), 0n, 5),
      muxPacket(VIDEO_SERVER_TRACK_ID_VIDEO, Buffer.from([0, 0, 0, 1, 0x65]), FLAG_KEY_FRAME, 20),
    ]));

    expect(packets.map(packet => packet.trackId)).toEqual([VIDEO_SERVER_TRACK_ID_VIDEO]);
    expect(packets[0].ptsUs).toBe(20);
  });

  test("emits a zero-size video packet without stalling the parser", () => {
    const { parser, packets } = collect();
    parser.push(Buffer.concat([
      streamHeader(100, 200),
      packet(Buffer.alloc(0), FLAG_CONFIG, 7),
      packet(Buffer.from([0xaa]), 0n, 8),
    ]));

    expect(packets).toHaveLength(2);
    expect(packets[0].data).toHaveLength(0);
    expect(packets[0].ptsUs).toBe(7);
    expect(packets[1].ptsUs).toBe(8);
  });

  test("throws a bounded parse error when a video packet declares a size over the cap", () => {
    // A framing desync decodes an arbitrary 32-bit size. Rather than buffer the
    // bogus length forever, the parser must fail fast so the socket wiring can
    // reconnect. Only the 12-byte header is fed — no unbounded payload wait.
    const { parser } = collect();
    parser.push(streamHeader(1920, 1080));
    const bogusHeader = Buffer.alloc(12);
    bogusHeader.writeBigUInt64BE(0n, 0);
    bogusHeader.writeUInt32BE(MAX_PACKET_BYTES + 1, 8);
    expect(() => parser.push(bogusHeader)).toThrow(ActionableError);
  });

  test("throws a bounded parse error when a mux header declares a trackCount over the cap", () => {
    const { parser } = collect();
    const bogusMuxHeader = Buffer.alloc(12);
    bogusMuxHeader.writeUInt32BE(VIDEO_SERVER_CODEC_ID_AMUX, 0);
    bogusMuxHeader.writeUInt32BE(0, 4);
    bogusMuxHeader.writeUInt32BE(MAX_TRACK_COUNT + 1, 8);
    expect(() => parser.push(bogusMuxHeader)).toThrow(ActionableError);
  });

  test("throws a bounded parse error when a mux packet declares a size over the cap", () => {
    const { parser } = collect();
    parser.push(muxHeader());
    const bogusMuxPacketHeader = Buffer.alloc(16);
    bogusMuxPacketHeader.writeUInt32BE(VIDEO_SERVER_TRACK_ID_VIDEO, 0);
    bogusMuxPacketHeader.writeBigUInt64BE(0n, 4);
    bogusMuxPacketHeader.writeUInt32BE(MAX_PACKET_BYTES + 1, 12);
    expect(() => parser.push(bogusMuxPacketHeader)).toThrow(ActionableError);
  });

  test("parses a legitimate maximum-size keyframe delivered in large chunks", () => {
    // MAX_PACKET_BYTES must be comfortably above a real keyframe; the boundary
    // itself must still parse, not trip the cap.
    const { parser, packets } = collect();
    parser.push(streamHeader(1920, 1080));
    const payload = Buffer.alloc(MAX_PACKET_BYTES, 0x5a);
    const framed = packet(payload, FLAG_KEY_FRAME, 99);
    const CHUNK = 1024 * 1024;
    for (let offset = 0; offset < framed.length; offset += CHUNK) {
      parser.push(framed.subarray(offset, Math.min(offset + CHUNK, framed.length)));
    }
    expect(packets).toHaveLength(1);
    expect(packets[0].data.length).toBe(MAX_PACKET_BYTES);
    expect(packets[0].keyFrame).toBe(true);
    expect(packets[0].ptsUs).toBe(99);
  });

  test("reassembles a large IDR split across many chunks and drains cleanly", () => {
    // The chunk-list accumulator must not re-copy the whole partial buffer on
    // every segment (the former O(n^2) Buffer.concat). Delivering a large frame
    // one small segment at a time exercises the cursor/compaction path; a
    // trailing packet proves the buffer reset once the frame drained.
    const { parser, packets } = collect();
    parser.push(streamHeader(1280, 720));
    const idr = Buffer.alloc(512 * 1024, 0x41);
    idr[0] = 0x00; idr[1] = 0x00; idr[2] = 0x00; idr[3] = 0x01; idr[4] = 0x65;
    const framed = packet(idr, FLAG_KEY_FRAME, 4242);
    const CHUNK = 1024;
    for (let offset = 0; offset < framed.length; offset += CHUNK) {
      parser.push(framed.subarray(offset, Math.min(offset + CHUNK, framed.length)));
    }
    expect(packets).toHaveLength(1);
    expect(packets[0].data).toEqual(idr);

    // Buffer state is clean after draining: a small trailing packet parses.
    parser.push(packet(Buffer.from([0xbb]), 0n, 4243));
    expect(packets).toHaveLength(2);
    expect(packets[1].data).toEqual(Buffer.from([0xbb]));
    expect(packets[1].ptsUs).toBe(4243);
  });

  test("a mux header declaring zero tracks yields no header and drops later packets", () => {
    // Zero-track amux header: 12-byte stream header, trackCount 0, no track rows.
    const zeroTrackHeader = Buffer.alloc(12);
    zeroTrackHeader.writeUInt32BE(VIDEO_SERVER_CODEC_ID_AMUX, 0);
    zeroTrackHeader.writeUInt32BE(0, 4);
    zeroTrackHeader.writeUInt32BE(0, 8); // trackCount = 0

    const { parser, headers, packets } = collect();
    parser.push(Buffer.concat([
      zeroTrackHeader,
      muxPacket(VIDEO_SERVER_TRACK_ID_VIDEO, Buffer.from([0xaa]), 0n, 1),
    ]));

    expect(headers).toEqual([]);
    expect(packets).toEqual([]);
  });
});
