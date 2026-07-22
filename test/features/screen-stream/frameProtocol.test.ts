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

describe("FrameDecoder corrupt-header resynchronization", () => {
  // A corrupt header carries no usable payload length, so the decoder cannot
  // know where the frame ends. It must scan forward for the next plausible
  // header rather than re-walking the payload as if it were headers.

  test("a corrupt header at stream start discards the frame, not just its 16 header bytes", () => {
    const decoder = new FrameDecoder();
    // Corrupt header claiming zero width, followed by a payload of pseudo-random
    // bytes and then a genuinely valid frame.
    const corrupt = Buffer.concat([encodeHeader(0, 1, 4, 0), pseudoRandomPayload(4_000)]);
    const good = makeFrameBytes(2, 2, 8, 777, 0x5a);

    const errors: MalformedFrameError[] = [];
    const out = decoder.push(Buffer.concat([corrupt, good]), err => errors.push(err));

    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toBe("header_width_zero");
    expect(out).toHaveLength(1);
    expect(out[0].header.timestampMs).toBe(777);
    expect(out[0].pixels[0]).toBe(0x5a);
  });

  test("a corrupt header mid-stream costs one callback and both good frames survive", () => {
    const decoder = new FrameDecoder();
    const before = makeFrameBytes(1, 1, 4, 11, 0x11);
    const corrupt = Buffer.concat([encodeHeader(1, 0, 4, 0), pseudoRandomPayload(8_000)]);
    const after = makeFrameBytes(1, 1, 4, 22, 0x22);

    const errors: MalformedFrameError[] = [];
    const out = decoder.push(Buffer.concat([before, corrupt, after]), err => errors.push(err));

    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toBe("header_height_zero");
    expect(out.map(f => f.header.timestampMs)).toEqual([11, 22]);
  });

  test("a corrupt header at the tail emits one callback and resyncs on the next push", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];

    const tail = Buffer.concat([encodeHeader(0, 0, 0, 0), pseudoRandomPayload(2_048)]);
    expect(decoder.push(tail, err => errors.push(err))).toHaveLength(0);
    expect(errors).toHaveLength(1);

    // The stream resumes with a valid frame in a later chunk.
    const out = decoder.push(makeFrameBytes(1, 1, 4, 33, 0x33), err => errors.push(err));
    expect(errors).toHaveLength(1);
    expect(out).toHaveLength(1);
    expect(out[0].header.timestampMs).toBe(33);
  });

  test("a large corrupt frame does not amplify into a flood of callbacks", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];
    // The audit's shape: one corrupt header followed by a full-size payload.
    const out = decoder.push(
      Buffer.concat([
        encodeHeader(0, 1080, 7680, 0),
        pseudoRandomPayload(16_000),
        makeFrameBytes(1, 1, 4, 88, 0x88),
      ]),
      err => errors.push(err)
    );
    expect(errors).toHaveLength(1);
    // Not just quiet — actually back in sync.
    expect(out.map(f => f.header.timestampMs)).toEqual([88]);
  });

  test("implausible dimensions are rejected so payload bytes rarely look like headers", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];
    // width*4 <= bytesPerRow, but both are absurd for a real display.
    decoder.push(encodeHeader(1_000_000, 1_000_000, 8_000_000, 0), err => errors.push(err));
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toBe("header_dimensions_out_of_range");
  });

  test("payload bytes that form a plausible header resync deterministically", () => {
    const decoder = new FrameDecoder();
    // Payload containing an embedded, structurally valid header. This is
    // genuinely ambiguous on the wire; what matters is that the decoder is
    // deterministic, bounded, and still lands on the real trailing frame.
    const embedded = Buffer.concat([encodeHeader(1, 1, 4, 555), Buffer.alloc(4, 0x77)]);
    const corrupt = Buffer.concat([
      encodeHeader(0, 1, 4, 0),
      Buffer.alloc(64, 0x00),
      embedded,
      Buffer.alloc(64, 0x00),
    ]);
    const good = makeFrameBytes(1, 1, 4, 444, 0x44);

    const errors: MalformedFrameError[] = [];
    const out = decoder.push(Buffer.concat([corrupt, good]), err => errors.push(err));

    // The embedded header is not corroborated by what follows its payload, so
    // the scan rejects it and lands on the real frame. One report, no flood.
    expect(errors).toHaveLength(1);
    expect(out.map(f => f.header.timestampMs)).toEqual([444]);
  });

  test("resynchronizes across a chunk boundary that splits the recovery header", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];
    const corrupt = Buffer.concat([encodeHeader(0, 1, 4, 0), pseudoRandomPayload(1_000)]);
    const good = makeFrameBytes(1, 1, 4, 66, 0x66);
    const all = Buffer.concat([corrupt, good]);
    const split = corrupt.length + 7;

    expect(decoder.push(all.subarray(0, split), err => errors.push(err))).toHaveLength(0);
    const out = decoder.push(all.subarray(split), err => errors.push(err));

    expect(errors).toHaveLength(1);
    expect(out).toHaveLength(1);
    expect(out[0].header.timestampMs).toBe(66);
  });

  test("waits for more bytes rather than locking onto an unconfirmed candidate", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];
    // The recovery frame is large, so its payload cannot be corroborated until
    // the rest of it arrives. The decoder must not lock onto earlier garbage.
    const corrupt = Buffer.concat([encodeHeader(0, 1, 4, 0), pseudoRandomPayload(3_000)]);
    const good = makeFrameBytes(64, 64, 256, 121, 0xee);
    const all = Buffer.concat([corrupt, good]);
    const half = corrupt.length + 1_000;

    expect(decoder.push(all.subarray(0, half), err => errors.push(err))).toHaveLength(0);
    const out = decoder.push(all.subarray(half), err => errors.push(err));

    expect(errors).toHaveLength(1);
    expect(out).toHaveLength(1);
    expect(out[0].header.timestampMs).toBe(121);
    expect(out[0].pixels.length).toBe(64 * 256);
  });

  test("audio records with an implausible payload length are rejected", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];
    decoder.push(encodeHeader(0, 8_000, 1, 0xffffffff), err => errors.push(err));
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toBe("audio_payload_too_large");
  });

  test("valid audio records still decode after a corrupt frame", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];
    const audio: Buffer[] = [];
    const corrupt = Buffer.concat([encodeHeader(0, 1, 4, 0), pseudoRandomPayload(512)]);
    const record = Buffer.concat([encodeHeader(0, 8_000, 1, 32), Buffer.alloc(32, 0x09)]);

    decoder.push(
      Buffer.concat([corrupt, record]),
      err => errors.push(err),
      a => audio.push(a.pcm16le)
    );

    expect(errors).toHaveLength(1);
    expect(audio).toHaveLength(1);
    expect(audio[0].length).toBe(32);
  });
});

/** Deterministic pseudo-random filler — reproducible across runs. */
function pseudoRandomPayload(length: number): Buffer {
  const buf = Buffer.alloc(length);
  let state = 0x12345678;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = (state >>> 16) & 0xff;
  }
  return buf;
}
