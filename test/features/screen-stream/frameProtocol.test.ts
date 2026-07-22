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
    // Recovery is confirmed by the header that follows the recovered frame, so
    // the stream carries one more frame after it.
    const out = decoder.push(
      Buffer.concat([bad, good, confirmingFrame()]),
      err => errors.push(err)
    );
    expect(errors).toHaveLength(1);
    expect(out.map(f => f.header.timestampMs)).toEqual([99, CONFIRM_TS]);
    expect(out[0].pixels[0]).toBe(0xcd);
  });

  test("handles empty chunks without emitting frames", () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(Buffer.alloc(0))).toHaveLength(0);
  });
});

describe("FrameDecoder corrupt-header resynchronization", () => {
  // A corrupt header carries no usable payload length, so the decoder cannot
  // know where the damaged frame ends. It must scan forward for the next frame
  // boundary rather than re-walking the payload as if it were headers.
  //
  // A recovery point is only accepted once the header that follows it confirms
  // it, so each case below carries one extra frame on the wire; `CONFIRM_TS`
  // marks it.

  test("a corrupt header at stream start discards the frame, not just its 16 header bytes", () => {
    const decoder = new FrameDecoder();
    // Corrupt header claiming zero width, followed by a payload of pseudo-random
    // bytes and then a genuinely valid frame.
    const corrupt = Buffer.concat([encodeHeader(0, 1, 4, 0), pseudoRandomPayload(4_000)]);
    const good = makeFrameBytes(2, 2, 8, 777, 0x5a);

    const errors: MalformedFrameError[] = [];
    const out = decoder.push(
      Buffer.concat([corrupt, good, confirmingFrameLike(2, 2, 8)]),
      err => errors.push(err)
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toBe("header_width_zero");
    expect(out.map(f => f.header.timestampMs)).toEqual([777, CONFIRM_TS]);
    expect(out[0].pixels[0]).toBe(0x5a);
  });

  test("a corrupt header mid-stream costs one callback and both good frames survive", () => {
    const decoder = new FrameDecoder();
    const before = makeFrameBytes(1, 1, 4, 11, 0x11);
    const corrupt = Buffer.concat([encodeHeader(1, 0, 4, 0), pseudoRandomPayload(8_000)]);
    const after = makeFrameBytes(1, 1, 4, 22, 0x22);

    const errors: MalformedFrameError[] = [];
    const out = decoder.push(
      Buffer.concat([before, corrupt, after, confirmingFrame()]),
      err => errors.push(err)
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toBe("header_height_zero");
    expect(out.map(f => f.header.timestampMs)).toEqual([11, 22, CONFIRM_TS]);
  });

  test("a corrupt header at the tail emits one callback and resyncs on a later push", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];

    const tail = Buffer.concat([encodeHeader(0, 0, 0, 0), pseudoRandomPayload(2_048)]);
    expect(decoder.push(tail, err => errors.push(err))).toHaveLength(0);
    expect(errors).toHaveLength(1);

    // The stream resumes with valid frames in a later chunk.
    const out = decoder.push(
      Buffer.concat([makeFrameBytes(1, 1, 4, 33, 0x33), confirmingFrame()]),
      err => errors.push(err)
    );
    expect(errors).toHaveLength(1);
    expect(out.map(f => f.header.timestampMs)).toEqual([33, CONFIRM_TS]);
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
        confirmingFrame(),
      ]),
      err => errors.push(err)
    );
    expect(errors).toHaveLength(1);
    // Not just quiet — actually back in sync.
    expect(out.map(f => f.header.timestampMs)).toEqual([88, CONFIRM_TS]);
  });

  test("a sustained garbage stream stays quiet instead of amplifying", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];
    // 1 MiB of noise arriving in realistic chunks, then real frames. The old
    // decoder failed this two ways depending on the bytes: a callback per 16
    // discarded bytes, or a silent stall once it locked onto a bogus header
    // claiming a huge payload. Quiet is only half the requirement — the stream
    // has to come back.
    const frames: number[] = [];
    const stream = Buffer.concat([
      pseudoRandomPayload(1024 * 1024),
      makeFrameBytes(4, 4, 16, 909, 0x0f),
      confirmingFrameLike(4, 4, 16),
    ]);
    for (let offset = 0; offset < stream.length; offset += 65_536) {
      const out = decoder.push(stream.subarray(offset, offset + 65_536), err =>
        errors.push(err)
      );
      frames.push(...out.map(f => f.header.timestampMs));
    }
    expect(errors.length).toBeLessThanOrEqual(4);
    expect(frames).toEqual([909, CONFIRM_TS]);
  });

  test("implausible dimensions are rejected so payload bytes rarely look like headers", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];
    // width*4 <= bytesPerRow, but both are absurd for a real display.
    decoder.push(encodeHeader(1_000_000, 1_000_000, 8_000_000, 0), err => errors.push(err));
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toBe("header_dimensions_out_of_range");
  });

  test("payload bytes that form a plausible header do not become a frame", () => {
    const decoder = new FrameDecoder();
    // Payload containing an embedded, structurally valid header. Nothing
    // corroborates it, so the scan rejects it and lands on the real frame.
    const embedded = Buffer.concat([encodeHeader(1, 1, 4, 555), Buffer.alloc(4, 0x77)]);
    const corrupt = Buffer.concat([
      encodeHeader(0, 1, 4, 0),
      Buffer.alloc(64, 0x00),
      embedded,
      Buffer.alloc(64, 0x00),
    ]);
    const good = makeFrameBytes(1, 1, 4, 444, 0x44);

    const errors: MalformedFrameError[] = [];
    const out = decoder.push(
      Buffer.concat([corrupt, good, confirmingFrame()]),
      err => errors.push(err)
    );

    expect(errors).toHaveLength(1);
    expect(out.map(f => f.header.timestampMs)).toEqual([444, CONFIRM_TS]);
  });

  test("a chunk boundary is not treated as proof of a frame boundary", () => {
    const decoder = new FrameDecoder();
    // The corrupt payload ends with bytes that spell a valid 1x1 header whose
    // payload runs exactly to the end of the chunk. stdout splits wherever the
    // pipe flushes, so that alignment is a coincidence, not corroboration —
    // emitting it would fabricate a frame out of payload bytes.
    const errors: MalformedFrameError[] = [];
    const out = decoder.push(
      Buffer.concat([
        encodeHeader(0, 1, 4, 0),
        Buffer.alloc(40, 0x00),
        encodeHeader(1, 1, 4, 4242),
        Buffer.alloc(4, 0xaa),
      ]),
      err => errors.push(err)
    );

    expect(errors).toHaveLength(1);
    expect(out).toHaveLength(0);
  });

  test("drops a recovered frame when a second corrupt header follows it", () => {
    const decoder = new FrameDecoder();
    // Deliberate trade-off, pinned so it stays deliberate: accepting a
    // candidate whose successor is not a valid header is the same rule that
    // fabricates frames out of payload bytes (see the test above). One dropped
    // frame during back-to-back corruption is the cheaper error.
    const errors: MalformedFrameError[] = [];
    const out = decoder.push(
      Buffer.concat([
        encodeHeader(0, 1, 4, 0),
        Buffer.alloc(200, 0x31),
        makeFrameBytes(1, 1, 4, 777, 0xbb),
        encodeHeader(0, 1, 4, 0),
        Buffer.alloc(200, 0x31),
        makeFrameBytes(1, 1, 4, 888, 0xcc),
        confirmingFrame(),
      ]),
      err => errors.push(err)
    );

    expect(out.map(f => f.header.timestampMs)).toEqual([888, CONFIRM_TS]);
    expect(out.map(f => f.header.timestampMs)).not.toContain(777);
  });

  test("two coordinated header-shaped ranges in a payload do not fabricate a frame", () => {
    const decoder = new FrameDecoder();
    // The payload of the damaged frame carries two header-shaped byte ranges,
    // spaced by exactly the first one's declared payload length, so the second
    // corroborates the first. Structural corroboration alone therefore accepts
    // it and emits payload bytes as a 32x32 frame — dimensions of the attacker's
    // choosing, fed straight to the encoder. The payload is BGRA pixel data, so
    // its bytes reflect what is on the captured screen; probability bounds do
    // not apply to a byte sequence someone can choose.
    const errors: MalformedFrameError[] = [];
    const out = decoder.push(
      Buffer.concat([
        encodeHeader(0, 1, 4, 0),
        encodeHeader(32, 32, 128, 4242),
        Buffer.alloc(32 * 128, 0xa5),
        encodeHeader(1, 1, 4, 7),
      ]),
      err => errors.push(err)
    );

    expect(errors).toHaveLength(1);
    expect(out).toHaveLength(0);
  });

  test("resync cannot introduce a geometry the stream was not already using", () => {
    const decoder = new FrameDecoder();
    // Once a frame has decoded on the synchronized path its geometry is the
    // stream's geometry, and resync is locked to it. A crafted pair of matching
    // header-shaped ranges therefore cannot poison the encoder's frame size,
    // however self-consistent the pair is.
    const errors: MalformedFrameError[] = [];
    const established = decoder.push(makeFrameBytes(4, 4, 16, 1, 0x01));
    expect(established.map(f => f.header.width)).toEqual([4]);

    const out = decoder.push(
      Buffer.concat([
        encodeHeader(0, 1, 4, 0),
        encodeHeader(32, 32, 128, 4242),
        Buffer.alloc(32 * 128, 0xa5),
        encodeHeader(32, 32, 128, 4243),
        Buffer.alloc(32 * 128, 0xa5),
        encodeHeader(32, 32, 128, 4244),
      ]),
      err => errors.push(err)
    );

    expect(errors).toHaveLength(1);
    expect(out).toHaveLength(0);
  });

  test("an audio-shaped record in the damaged bytes is not a way around the anchor", () => {
    const decoder = new FrameDecoder();
    // Audio records carry no geometry, so they are admissible on their own.
    // That made them a handoff point: resync could end at the audio record and
    // let the synchronized path — which does not consult the anchor — decode
    // whatever video header followed. The successor is checked for exactly
    // this reason.
    const errors: MalformedFrameError[] = [];
    const audio: Buffer[] = [];
    expect(decoder.push(makeFrameBytes(4, 4, 16, 1, 0x01))).toHaveLength(1);

    const out = decoder.push(
      Buffer.concat([
        encodeHeader(0, 1, 4, 0),
        Buffer.alloc(32, 0x00),
        encodeHeader(0, 8_000, 1, 8),
        Buffer.alloc(8, 0x07),
        makeFrameBytes(32, 32, 128, 4242, 0xa5),
        encodeHeader(32, 32, 128, 4243),
      ]),
      err => errors.push(err),
      rec => audio.push(rec.pcm16le)
    );

    expect(errors).toHaveLength(1);
    expect(out).toHaveLength(0);
    expect(audio).toHaveLength(0);
  });

  test("resynchronizes through interleaved audio on an anchored stream", () => {
    const decoder = new FrameDecoder();
    // The real helper (`SimulatorCaptureSession`) writes screen and audio to one
    // queue, so a recovered video frame's immediate successor is routinely an
    // audio header, not another video header. An audio record is a valid
    // corroborator — it proves the candidate's payload ran to a real boundary —
    // and audio does not disturb the anchor-locked recovery point. Holding the
    // successor to video-only geometry instead would leave this common stream
    // unable to resync at all: no video frame is ever immediately followed by a
    // video header, so nothing would corroborate and the stream would stall.
    const errors: MalformedFrameError[] = [];
    const audio: Buffer[] = [];
    expect(decoder.push(makeFrameBytes(4, 4, 16, 1, 0x01))).toHaveLength(1);

    const audioRecord = (fill: number): Buffer =>
      Buffer.concat([encodeHeader(0, 8_000, 1, 16), Buffer.alloc(16, fill)]);

    const out = decoder.push(
      Buffer.concat([
        encodeHeader(0, 1, 4, 0), // corruption
        makeFrameBytes(4, 4, 16, 2, 0x02), // V — recovery point, anchor geometry
        audioRecord(0xa1), // A — the successor that corroborates it
        makeFrameBytes(4, 4, 16, 3, 0x03), // V
        audioRecord(0xa2), // A
        makeFrameBytes(4, 4, 16, 4, 0x04), // V
      ]),
      err => errors.push(err),
      rec => audio.push(rec.pcm16le)
    );

    expect(errors).toHaveLength(1);
    expect(out.map(f => f.header.timestampMs)).toEqual([2, 3, 4]);
    expect(audio).toHaveLength(2);
  });

  test("an audio successor does not let a different-size video through resync", () => {
    const decoder = new FrameDecoder();
    // The fabrication path an audio successor must not open: an anchor-geometry
    // candidate whose successor is audio cannot be accepted on the audio alone,
    // because the video frame *after* the audio is where synchronized decoding
    // resumes and it is emitted unchecked. If that video is a different size,
    // accepting the candidate hands a fabricated-geometry frame to the encoder
    // from one damaged frame. Corroboration must scan through the audio and hold
    // the next video boundary to the anchor.
    const errors: MalformedFrameError[] = [];
    const audio: Buffer[] = [];
    expect(decoder.push(makeFrameBytes(4, 4, 16, 1, 0x01))).toHaveLength(1);

    const audioRecord = (fill: number): Buffer =>
      Buffer.concat([encodeHeader(0, 8_000, 1, 16), Buffer.alloc(16, fill)]);

    const out = decoder.push(
      Buffer.concat([
        encodeHeader(0, 1, 4, 0), // corruption
        makeFrameBytes(4, 4, 16, 2, 0x02), // V — anchor-geometry candidate
        audioRecord(0xa1), // A — must not corroborate the candidate by itself
        makeFrameBytes(32, 32, 128, 3, 0x03), // V — different size, would-be fabrication
      ]),
      err => errors.push(err),
      rec => audio.push(rec.pcm16le)
    );

    // The 32x32 frame must never surface, and the anchor-mismatched candidate is
    // not corroborated, so resync stalls rather than emitting anything.
    expect(errors).toHaveLength(1);
    expect(out.map(f => `${f.header.width}x${f.header.height}`)).not.toContain("32x32");
    expect(out).toHaveLength(0);
  });

  test("does not resynchronize when the capture geometry changes inside the corruption", () => {
    const decoder = new FrameDecoder();
    // Deliberate trade, pinned so it stays deliberate. The helper does change
    // geometry mid-stream — SimulatorCaptureSession reconfigures SCStream when
    // the simulator window resizes — and a change landing inside a corruption
    // window leaves the decoder unable to resync, so the stream needs a
    // restart. There is no safe way to allow it: on a wire with no sync marker
    // a genuine reconfigure and a crafted run of frames at a new size are the
    // same bytes, so any rule that readmits the first readmits the second.
    const errors: MalformedFrameError[] = [];
    expect(decoder.push(makeFrameBytes(4, 4, 16, 1, 0x01))).toHaveLength(1);
    decoder.push(Buffer.concat([encodeHeader(0, 1, 4, 0), Buffer.alloc(50, 0x00)]), err =>
      errors.push(err)
    );

    let recovered = 0;
    for (let i = 0; i < 20; i++) {
      recovered += decoder.push(makeFrameBytes(8, 8, 32, 10 + i, 0x02), err =>
        errors.push(err)
      ).length;
    }

    // Corruption reported once, then silence — not a fabricated 8x8 frame.
    expect(errors).toHaveLength(1);
    expect(recovered).toBe(0);
  });

  test("resynchronizes across a chunk boundary that splits the recovery header", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];
    const corrupt = Buffer.concat([encodeHeader(0, 1, 4, 0), pseudoRandomPayload(1_000)]);
    const good = makeFrameBytes(1, 1, 4, 66, 0x66);
    const all = Buffer.concat([corrupt, good, confirmingFrame()]);
    const split = corrupt.length + 7;

    expect(decoder.push(all.subarray(0, split), err => errors.push(err))).toHaveLength(0);
    const out = decoder.push(all.subarray(split), err => errors.push(err));

    expect(errors).toHaveLength(1);
    expect(out.map(f => f.header.timestampMs)).toEqual([66, CONFIRM_TS]);
  });

  test("waits for more bytes rather than locking onto an unconfirmed candidate", () => {
    const decoder = new FrameDecoder();
    const errors: MalformedFrameError[] = [];
    // The recovery frame is large, so its payload cannot be corroborated until
    // the rest of it arrives. The decoder must not lock onto earlier garbage.
    const corrupt = Buffer.concat([encodeHeader(0, 1, 4, 0), pseudoRandomPayload(3_000)]);
    const good = makeFrameBytes(64, 64, 256, 121, 0xee);
    const all = Buffer.concat([corrupt, good, confirmingFrameLike(64, 64, 256)]);
    const half = corrupt.length + 1_000;

    expect(decoder.push(all.subarray(0, half), err => errors.push(err))).toHaveLength(0);
    const out = decoder.push(all.subarray(half), err => errors.push(err));

    expect(errors).toHaveLength(1);
    expect(out.map(f => f.header.timestampMs)).toEqual([121, CONFIRM_TS]);
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

    const out = decoder.push(
      Buffer.concat([corrupt, record, confirmingFrame()]),
      err => errors.push(err),
      a => audio.push(a.pcm16le)
    );

    expect(errors).toHaveLength(1);
    expect(audio).toHaveLength(1);
    expect(audio[0].length).toBe(32);
    expect(out.map(f => f.header.timestampMs)).toEqual([CONFIRM_TS]);
  });

  test("an unsettled candidate does not make later chunks rescan the retained bytes", () => {
    // The adversarial shape: a corrupt header whose payload begins with a
    // plausible header declaring a 256 MiB payload. That candidate cannot be
    // corroborated until 256 MiB have arrived, so it is retained across every
    // subsequent chunk. Scanning must resume where it left off — restarting at
    // offset 0 each push makes one corrupt frame cost quadratic CPU, which is
    // the disproportionate-work shape this whole change exists to remove.
    const decoder = new FrameDecoder();
    const decoy = encodeHeader(8_192, 8_192, 32_768, 0);
    decoder.push(Buffer.concat([encodeHeader(0, 0, 0, 0), decoy]), () => {});

    const chunks = 12;
    const chunk = Buffer.alloc(8 * 1024, 0);
    const parses = countHeaderParses(() => {
      for (let i = 0; i < chunks; i++) {decoder.push(chunk);}
    });

    // Linear: each byte offset is examined once overall, plus the retained
    // candidate re-asked once per chunk. Rescanning from zero would cost
    // ~chunks/2 times this.
    expect(parses).toBeLessThan(chunks * chunk.length * 1.1);
  });
});

/**
 * Count `parseHeader` calls inside `body`, via the four header-word reads each
 * one makes. Measures scan work directly instead of timing it, so the bound is
 * deterministic under load.
 */
function countHeaderParses(body: () => void): number {
  let reads = 0;
  const original = Buffer.prototype.readUInt32LE;
  Buffer.prototype.readUInt32LE = function(this: Buffer, offset?: number): number {
    reads++;
    return original.call(this, offset as number);
  };
  try {
    body();
  } finally {
    Buffer.prototype.readUInt32LE = original;
  }
  return reads / 4;
}

/** Timestamp of the frame whose header confirms a recovery point. */
const CONFIRM_TS = 1000;

/** The frame that corroborates the recovered one preceding it. */
function confirmingFrame(): Buffer {
  return confirmingFrameLike(1, 1, 4);
}
/**
 * The confirming frame for a recovery frame of a given geometry. A capture
 * session emits one frame size for its lifetime, and resync now requires the
 * corroborating successor to agree, so a confirming frame has to match the
 * frame it confirms.
 */
function confirmingFrameLike(width: number, height: number, bytesPerRow: number): Buffer {
  return makeFrameBytes(width, height, bytesPerRow, CONFIRM_TS, 0x01);
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
