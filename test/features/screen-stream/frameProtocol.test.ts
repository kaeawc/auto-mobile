import { describe, expect, test } from "bun:test";
import {
  FRAME_HEADER_SIZE,
  FrameDecoder,
  type MalformedFrameError,
} from "../../../src/features/screen-stream/frameProtocol";

function encodeHeader(
  width: number,
  height: number,
  bytesPerRow: number,
  timestampMs: number
): Buffer {
  const buf = Buffer.alloc(FRAME_HEADER_SIZE);
  buf.writeUInt32LE(width, 0);
  buf.writeUInt32LE(height, 4);
  buf.writeUInt32LE(bytesPerRow, 8);
  buf.writeUInt32LE(timestampMs, 12);
  return buf;
}

function makeFrameBytes(
  width: number,
  height: number,
  bytesPerRow: number,
  timestampMs: number,
  fill: number
): Buffer {
  const header = encodeHeader(width, height, bytesPerRow, timestampMs);
  const pixels = Buffer.alloc(height * bytesPerRow, fill);
  return Buffer.concat([header, pixels]);
}

describe("FrameDecoder", () => {
  test("decodes a complete frame delivered in one chunk", () => {
    const decoder = new FrameDecoder();
    const frame = makeFrameBytes(2, 2, 8, 100, 0xab);
    const out = decoder.push(frame);
    expect(out).toHaveLength(1);
    expect(out[0].header).toEqual({
      width: 2,
      height: 2,
      bytesPerRow: 8,
      timestampMs: 100,
    });
    expect(out[0].pixels.length).toBe(16);
    expect(out[0].pixels[0]).toBe(0xab);
  });

  test("buffers across multiple chunks split mid-header", () => {
    const decoder = new FrameDecoder();
    const frame = makeFrameBytes(1, 1, 4, 50, 0x12);

    expect(decoder.push(frame.subarray(0, 3))).toHaveLength(0);
    expect(decoder.push(frame.subarray(3, 10))).toHaveLength(0);
    const out = decoder.push(frame.subarray(10));
    expect(out).toHaveLength(1);
    expect(out[0].header.timestampMs).toBe(50);
  });

  test("emits multiple frames from a single concatenated buffer", () => {
    const decoder = new FrameDecoder();
    const a = makeFrameBytes(1, 1, 4, 10, 0x01);
    const b = makeFrameBytes(1, 1, 4, 20, 0x02);
    const out = decoder.push(Buffer.concat([a, b]));
    expect(out).toHaveLength(2);
    expect(out[0].header.timestampMs).toBe(10);
    expect(out[1].header.timestampMs).toBe(20);
    expect(out[0].pixels[0]).toBe(0x01);
    expect(out[1].pixels[0]).toBe(0x02);
  });

  test("rejects malformed header (zero width)", () => {
    const decoder = new FrameDecoder();
    const malformed = encodeHeader(0, 1, 4, 0);
    const errors: MalformedFrameError[] = [];
    const out = decoder.push(malformed, err => errors.push(err));
    expect(out).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toBe("header_width_zero");
  });

  test("rejects bytesPerRow smaller than width*4", () => {
    const decoder = new FrameDecoder();
    const malformed = encodeHeader(10, 1, 8, 0); // 10*4 = 40 > 8
    const errors: MalformedFrameError[] = [];
    decoder.push(malformed, err => errors.push(err));
    expect(errors[0].reason).toBe("header_bytes_per_row_too_small");
  });

  test("recovers after malformed header and decodes next valid frame", () => {
    const decoder = new FrameDecoder();
    const bad = encodeHeader(0, 1, 4, 0);
    const good = makeFrameBytes(1, 1, 4, 99, 0xcd);
    const errors: MalformedFrameError[] = [];
    const out = decoder.push(Buffer.concat([bad, good]), err => errors.push(err));
    expect(errors).toHaveLength(1);
    expect(out).toHaveLength(1);
    expect(out[0].header.timestampMs).toBe(99);
  });

  test("handles empty chunks without emitting frames", () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(Buffer.alloc(0))).toHaveLength(0);
  });
});
