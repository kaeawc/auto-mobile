import { describe, expect, test } from "bun:test";
import {
  crc32,
  encodeFrameHeader,
  FRAME_HEADER_SIZE,
  FRAME_MAGIC,
  FrameDecoder,
  type MalformedFrameError,
} from "../../../src/features/screen-stream/frameProtocol";

function encodeHeader(
  width: number,
  height: number,
  bytesPerRow: number,
  timestampMs: number,
): Buffer {
  return encodeFrameHeader({ width, height, bytesPerRow, timestampMs });
}

function makeFrameBytes(
  width: number,
  height: number,
  bytesPerRow: number,
  timestampMs: number,
  fill: number,
): Buffer {
  const pixels = Buffer.alloc(height * bytesPerRow, fill);
  return Buffer.concat([encodeHeader(width, height, bytesPerRow, timestampMs), pixels]);
}

/** A 24-byte block that is NOT a valid header: correct marker, wrong checksum. */
function corruptHeader(): Buffer {
  const bytes = encodeHeader(1, 1, 4, 0);
  bytes.writeUInt32LE((bytes.readUInt32LE(4) ^ 0xffffffff) >>> 0, 4); // flip the checksum
  return bytes;
}

describe("crc32", () => {
  test("matches the standard IEEE check vector (pins cross-language agreement)", () => {
    // The canonical CRC-32 check value for the ASCII string "123456789".
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});

describe("FrameDecoder", () => {
  test("decodes a complete frame delivered in one chunk", () => {
    const decoder = new FrameDecoder();
    const frame = makeFrameBytes(2, 2, 8, 100, 0xab);
    const out = decoder.push(frame);
    expect(out).toHaveLength(1);
    expect(out[0].header).toEqual({ width: 2, height: 2, bytesPerRow: 8, timestampMs: 100 });
    expect(out[0].pixels.length).toBe(16);
    expect(out[0].pixels[0]).toBe(0xab);
  });

  test("the encoded header carries the marker and a matching checksum", () => {
    const header = encodeHeader(2, 2, 8, 100);
    expect(header.readUInt32LE(0)).toBe(FRAME_MAGIC);
    expect(header.readUInt32LE(4)).toBe(crc32(header.subarray(8, FRAME_HEADER_SIZE)));
  });

  test("buffers across multiple chunks split mid-header", () => {
    const decoder = new FrameDecoder();
    const frame = makeFrameBytes(1, 1, 4, 50, 0x12);

    expect(decoder.push(frame.subarray(0, 3))).toHaveLength(0);
    expect(decoder.push(frame.subarray(3, 20))).toHaveLength(0);
    const out = decoder.push(frame.subarray(20));
    expect(out).toHaveLength(1);
    expect(out[0].header.timestampMs).toBe(50);
  });

  test("emits multiple frames from a single concatenated buffer", () => {
    const decoder = new FrameDecoder();
    const a = makeFrameBytes(1, 1, 4, 10, 0x01);
    const b = makeFrameBytes(1, 1, 4, 20, 0x02);
    const out = decoder.push(Buffer.concat([a, b]));
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.header.timestampMs)).toEqual([10, 20]);
    expect(out[0].pixels[0]).toBe(0x01);
    expect(out[1].pixels[0]).toBe(0x02);
  });

  test("rejects a header whose checksum does not match its fields", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];
    const out = decoder.push(corruptHeader(), (err) => errors.push(err));
    expect(out).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toBe("header_checksum_mismatch");
  });

  test("rejects bytes with no marker as a magic mismatch", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];
    decoder.push(Buffer.alloc(FRAME_HEADER_SIZE, 0x5a), (err) => errors.push(err));
    expect(errors[0].reason).toBe("header_magic_mismatch");
  });

  test("rejects an implausible zero-width frame even with a valid checksum", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];
    // Valid marker + checksum, but width 0 is not a real video frame.
    decoder.push(encodeHeader(0, 1, 4, 0), (err) => errors.push(err));
    expect(errors[0].reason).toBe("header_width_zero");
  });

  test("handles empty chunks without emitting frames", () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(Buffer.alloc(0))).toHaveLength(0);
  });

  test("emitted pixels are copied out of the input chunk, not aliased into it", () => {
    // The decoded frame outlives its stdout chunk. If a "just subarray it"
    // optimization replaced the detaching copy, the emitted pixels would pin —
    // and be corrupted by reuse of — the whole socket buffer. Mutating the
    // input after push() must not change the decoded pixels.
    const decoder = new FrameDecoder();
    const frame = makeFrameBytes(2, 2, 8, 100, 0xab);
    const out = decoder.push(frame);
    expect(out).toHaveLength(1);
    expect(out[0].pixels[0]).toBe(0xab);

    frame.fill(0x00);

    expect(out[0].pixels[0]).toBe(0xab);
    expect(out[0].pixels.every((byte) => byte === 0xab)).toBe(true);
  });
});

describe("FrameDecoder marker-based resynchronization", () => {
  test("recovers after a corrupt header and decodes the next valid frame — no confirming frame needed", () => {
    const decoder = new FrameDecoder();
    const good = makeFrameBytes(1, 1, 4, 99, 0xcd);
    const errors: MalformedFrameError[] = [];
    // The checksum validates the recovered frame on its own, so unlike the old
    // marker-less decoder there is no need for a following frame to confirm it.
    const out = decoder.push(Buffer.concat([corruptHeader(), good]), (err) => errors.push(err));
    expect(errors).toHaveLength(1);
    expect(out.map((f) => f.header.timestampMs)).toEqual([99]);
    expect(out[0].pixels[0]).toBe(0xcd);
  });

  test("a corrupt header discards the whole damaged frame, not just its header bytes", () => {
    const decoder = new FrameDecoder();
    // Corrupt marker followed by pseudo-random payload, then a genuine frame.
    const corrupt = Buffer.concat([corruptHeader(), pseudoRandomPayload(4_000)]);
    const good = makeFrameBytes(2, 2, 8, 777, 0x5a);
    const errors: MalformedFrameError[] = [];
    const out = decoder.push(Buffer.concat([corrupt, good]), (err) => errors.push(err));
    expect(errors).toHaveLength(1);
    expect(out.map((f) => f.header.timestampMs)).toEqual([777]);
    expect(out[0].pixels[0]).toBe(0x5a);
  });

  test("a corrupt header mid-stream costs one callback and both good frames survive", () => {
    const decoder = new FrameDecoder();
    const before = makeFrameBytes(1, 1, 4, 11, 0x11);
    const corrupt = Buffer.concat([corruptHeader(), pseudoRandomPayload(8_000)]);
    const after = makeFrameBytes(1, 1, 4, 22, 0x22);
    const errors: MalformedFrameError[] = [];
    const out = decoder.push(Buffer.concat([before, corrupt, after]), (err) => errors.push(err));
    expect(errors).toHaveLength(1);
    expect(out.map((f) => f.header.timestampMs)).toEqual([11, 22]);
  });

  test("a corrupt header at the tail emits one callback and resyncs on a later push", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];
    const tail = Buffer.concat([corruptHeader(), pseudoRandomPayload(2_048)]);
    expect(decoder.push(tail, (err) => errors.push(err))).toHaveLength(0);
    expect(errors).toHaveLength(1);

    const out = decoder.push(makeFrameBytes(1, 1, 4, 33, 0x33), (err) => errors.push(err));
    expect(errors).toHaveLength(1);
    expect(out.map((f) => f.header.timestampMs)).toEqual([33]);
  });

  test("a large corrupt frame does not amplify into a flood of callbacks", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];
    const out = decoder.push(
      Buffer.concat([
        corruptHeader(),
        pseudoRandomPayload(16_000),
        makeFrameBytes(1, 1, 4, 88, 0x88),
      ]),
      (err) => errors.push(err),
    );
    expect(errors).toHaveLength(1);
    expect(out.map((f) => f.header.timestampMs)).toEqual([88]);
  });

  test("a sustained garbage stream stays quiet and then comes back in sync", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];
    // 1 MiB of noise arriving in realistic chunks, then a real frame. The marker
    // scan stays silent through the noise (one report for the initial corruption)
    // and re-locks the moment a validating marker appears.
    const frames: number[] = [];
    const stream = Buffer.concat([
      corruptHeader(),
      pseudoRandomPayload(1024 * 1024),
      makeFrameBytes(4, 4, 16, 909, 0x0f),
    ]);
    for (let offset = 0; offset < stream.length; offset += 65_536) {
      const out = decoder.push(stream.subarray(offset, offset + 65_536), (err) => errors.push(err));
      frames.push(...out.map((f) => f.header.timestampMs));
    }
    expect(errors).toHaveLength(1);
    expect(frames).toEqual([909]);
  });

  test("payload bytes without a valid marker+checksum are never emitted as a frame", () => {
    const decoder = new FrameDecoder();
    // A structurally plausible header shape embedded in the payload, but with a
    // deliberately broken checksum: it is not a real boundary, so the scan skips
    // it and lands on the genuine frame.
    const embedded = Buffer.concat([corruptHeader(), Buffer.alloc(4, 0x77)]);
    const corrupt = Buffer.concat([
      corruptHeader(),
      Buffer.alloc(64, 0x00),
      embedded,
      Buffer.alloc(64, 0x00),
    ]);
    const good = makeFrameBytes(1, 1, 4, 444, 0x44);
    const errors: MalformedFrameError[] = [];
    const out = decoder.push(Buffer.concat([corrupt, good]), (err) => errors.push(err));
    expect(errors).toHaveLength(1);
    expect(out.map((f) => f.header.timestampMs)).toEqual([444]);
  });

  test("a recovered frame is kept even when a second corrupt header follows it", () => {
    const decoder = new FrameDecoder();
    // With a self-validating marker there is no reason to drop a genuine frame
    // just because corruption follows — the improvement over the marker-less
    // decoder, which had to sacrifice it.
    const errors: MalformedFrameError[] = [];
    const out = decoder.push(
      Buffer.concat([
        corruptHeader(),
        pseudoRandomPayload(200),
        makeFrameBytes(1, 1, 4, 777, 0xbb),
        corruptHeader(),
        pseudoRandomPayload(200),
        makeFrameBytes(1, 1, 4, 888, 0xcc),
      ]),
      (err) => errors.push(err),
    );
    // Both genuine frames survive; each corruption episode reports once.
    expect(out.map((f) => f.header.timestampMs)).toEqual([777, 888]);
    expect(errors).toHaveLength(2);
  });

  test("resynchronizes across a chunk boundary that splits the recovery header", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];
    const corrupt = Buffer.concat([corruptHeader(), pseudoRandomPayload(1_000)]);
    const good = makeFrameBytes(1, 1, 4, 66, 0x66);
    const all = Buffer.concat([corrupt, good]);
    const split = corrupt.length + 10; // mid-way through the recovery header

    expect(decoder.push(all.subarray(0, split), (err) => errors.push(err))).toHaveLength(0);
    const out = decoder.push(all.subarray(split), (err) => errors.push(err));
    expect(errors).toHaveLength(1);
    expect(out.map((f) => f.header.timestampMs)).toEqual([66]);
  });

  test("audio records with an implausible payload length are rejected", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];
    decoder.push(encodeHeader(0, 8_000, 1, 0xffffffff), (err) => errors.push(err));
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toBe("audio_payload_too_large");
  });

  test("valid audio records still decode after a corrupt frame", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];
    const audio: Buffer[] = [];
    const corrupt = Buffer.concat([corruptHeader(), pseudoRandomPayload(512)]);
    const record = Buffer.concat([encodeHeader(0, 8_000, 1, 32), Buffer.alloc(32, 0x09)]);
    const out = decoder.push(
      Buffer.concat([corrupt, record]),
      (err) => errors.push(err),
      (a) => audio.push(a.pcm16le),
    );
    expect(errors).toHaveLength(1);
    expect(audio).toHaveLength(1);
    expect(audio[0].length).toBe(32);
    expect(out).toHaveLength(0);
  });

  test("resynchronization is linear in bytes received under sustained garbage", () => {
    const decoder = new FrameDecoder();
    // Enter resync, then feed many garbage chunks. The marker scan uses
    // Buffer.indexOf and trims the buffer to a marker-prefix each time, so total
    // work is linear in bytes received — not quadratic re-scanning of a retained
    // buffer (the disproportionate-work shape this format exists to remove).
    decoder.push(corruptHeader(), () => {});
    const chunks = 12;
    const chunk = Buffer.alloc(8 * 1024, 0);
    const parses = countMarkerScans(() => {
      for (let i = 0; i < chunks; i++) {
        decoder.push(chunk);
      }
    });
    // A retained buffer rescanned from zero each chunk would be ~chunks/2 times this.
    expect(parses).toBeLessThan(chunks * chunk.length * 1.2);
  });
});

/** Count bytes visited by `Buffer.indexOf` inside `body`, as a proxy for scan work. */
function countMarkerScans(body: () => void): number {
  let visited = 0;
  const original = Buffer.prototype.indexOf;
  Buffer.prototype.indexOf = function (
    this: Buffer,
    value: string | number | Uint8Array,
    byteOffset?: number,
    encoding?: BufferEncoding,
  ): number {
    visited += this.length - (typeof byteOffset === "number" ? byteOffset : 0);
    return original.call(this, value as Uint8Array, byteOffset, encoding);
  } as typeof Buffer.prototype.indexOf;
  try {
    body();
  } finally {
    Buffer.prototype.indexOf = original;
  }
  return visited;
}

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
