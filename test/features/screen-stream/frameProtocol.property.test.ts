import { describe, test } from "bun:test";
import fc from "fast-check";
import {
  crc32,
  encodeFrameHeader,
  FRAME_HEADER_SIZE,
  FRAME_MAGIC,
  type FrameHeader,
} from "../../../src/features/screen-stream/frameProtocol";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const bytes = fc.uint8Array({ maxLength: 256 }).map((a) => Buffer.from(a));
// Header fields are coerced with `>>> 0`; use the full int range to exercise it.
const u32ish = fc.integer();
const header: fc.Arbitrary<FrameHeader> = fc.record({
  width: u32ish,
  height: u32ish,
  bytesPerRow: u32ish,
  timestampMs: u32ish,
});

describe("crc32 (property-based)", () => {
  test("is deterministic", () => {
    fc.assert(
      fc.property(bytes, (data) => {
        const first = crc32(data);
        const second = crc32(data);
        return first === second;
      }),
      RUN_OPTIONS,
    );
  });

  test("is an unsigned 32-bit integer", () => {
    fc.assert(
      fc.property(bytes, (data) => {
        const c = crc32(data);
        return Number.isInteger(c) && c >= 0 && c <= 0xffff_ffff;
      }),
      RUN_OPTIONS,
    );
  });

  test("the empty buffer checksums to 0", () => {
    fc.assert(
      fc.property(fc.constant(null), () => crc32(Buffer.alloc(0)) === 0),
      RUN_OPTIONS,
    );
  });

  test('matches the canonical CRC-32 check vector for "123456789"', () => {
    fc.assert(
      fc.property(fc.constant(null), () => crc32(Buffer.from("123456789")) === 0xcbf4_3926),
      RUN_OPTIONS,
    );
  });
});

describe("encodeFrameHeader (property-based)", () => {
  test("produces a fixed-size buffer beginning with the frame magic", () => {
    fc.assert(
      fc.property(header, (h) => {
        const buf = encodeFrameHeader(h);
        return buf.length === FRAME_HEADER_SIZE && buf.readUInt32LE(0) === FRAME_MAGIC;
      }),
      RUN_OPTIONS,
    );
  });

  test("round-trips each field as its uint32 (>>> 0) value", () => {
    fc.assert(
      fc.property(header, (h) => {
        const buf = encodeFrameHeader(h);
        return (
          buf.readUInt32LE(8) === h.width >>> 0 &&
          buf.readUInt32LE(12) === h.height >>> 0 &&
          buf.readUInt32LE(16) === h.bytesPerRow >>> 0 &&
          buf.readUInt32LE(20) === h.timestampMs >>> 0
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("the stored checksum is the CRC-32 of the field region", () => {
    fc.assert(
      fc.property(header, (h) => {
        const buf = encodeFrameHeader(h);
        return buf.readUInt32LE(4) === crc32(buf.subarray(8, FRAME_HEADER_SIZE));
      }),
      RUN_OPTIONS,
    );
  });

  test("is deterministic — the same header encodes to identical bytes", () => {
    fc.assert(
      fc.property(header, (h) => encodeFrameHeader(h).equals(encodeFrameHeader(h))),
      RUN_OPTIONS,
    );
  });
});
