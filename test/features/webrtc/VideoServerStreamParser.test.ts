import { describe, expect, test } from "bun:test";
import {
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

function streamHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(12);
  buf.writeUInt32BE(VIDEO_SERVER_CODEC_ID_H264, 0);
  buf.writeUInt32BE(width, 4);
  buf.writeUInt32BE(height, 8);
  return buf;
}

function packet(payload: Buffer, flags: bigint, ptsUs: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeBigUInt64BE(flags | (BigInt(ptsUs) & (FLAG_KEY_FRAME - 1n)), 0);
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
  header.writeBigUInt64BE(flags | (BigInt(ptsUs) & (FLAG_KEY_FRAME - 1n)), 4);
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
      ptsUs: 0,
    });
    expect(packets[1]).toEqual({
      trackId: VIDEO_SERVER_TRACK_ID_VIDEO,
      codecId: VIDEO_SERVER_CODEC_ID_H264,
      data: Buffer.from([0, 0, 0, 1, 0x65]),
      config: false,
      keyFrame: true,
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

  test("parses muxed video and audio packets", () => {
    const { parser, headers, packets } = collect();
    parser.push(Buffer.concat([
      muxHeader(),
      muxPacket(VIDEO_SERVER_TRACK_ID_AUDIO, Buffer.from([1, 2, 3, 4]), 0n, 10),
      muxPacket(VIDEO_SERVER_TRACK_ID_VIDEO, Buffer.from([0, 0, 0, 1, 0x65]), FLAG_KEY_FRAME, 20),
    ]));

    expect(headers).toEqual([{ codecId: VIDEO_SERVER_CODEC_ID_H264, width: 720, height: 1280 }]);
    expect(packets.map(packet => [packet.trackId, packet.codecId, packet.ptsUs])).toEqual([
      [VIDEO_SERVER_TRACK_ID_AUDIO, VIDEO_SERVER_CODEC_ID_PCM16, 10],
      [VIDEO_SERVER_TRACK_ID_VIDEO, VIDEO_SERVER_CODEC_ID_H264, 20],
    ]);
  });
});
