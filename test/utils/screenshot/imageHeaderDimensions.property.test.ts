import { describe, test } from "bun:test";
import fc from "fast-check";
import { readImageHeaderDimensions } from "../../../src/utils/screenshot/imageHeaderDimensions";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

/** Build a minimal well-formed PNG header (signature + IHDR) declaring the given size. */
function buildPng(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8); // IHDR data length, fixed by the PNG spec
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

/**
 * Build a minimal well-formed JPEG: SOI immediately followed by a single SOF0 segment whose
 * declared length (8) is exactly precision(1) + height(2) + width(2) + component count(1) + the
 * 2-byte length field itself, so no trailing component-spec bytes are required to reach it.
 */
function buildJpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8, // SOI
    0xff,
    0xc0, // SOF0 marker
    0x00,
    0x08, // segment length = 8
    0x08, // precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01, // number of components
  ]);
}

// Biased toward the two dangerous signature bytes (0x89 for PNG, 0xFF for JPEG) so the search does
// not rely on plain randomness happening to land on them: these are the inputs that pass the first
// signature check and then risk an out-of-bounds read on truncated garbage.
const arbitraryBytes = fc.oneof(
  fc.uint8Array({ minLength: 0, maxLength: 64 }),
  fc.uint8Array({ minLength: 1, maxLength: 64 }).map((bytes) => {
    bytes[0] = 0x89;
    return bytes;
  }),
  fc.uint8Array({ minLength: 1, maxLength: 64 }).map((bytes) => {
    bytes[0] = 0xff;
    return bytes;
  }),
);

const dimension = fc.integer({ min: 1, max: 65535 });

describe("readImageHeaderDimensions (property-based)", () => {
  test("never throws over arbitrary byte buffers of any length or content", () => {
    fc.assert(
      fc.property(arbitraryBytes, (bytes) => {
        const buffer = Buffer.from(bytes);
        try {
          readImageHeaderDimensions(buffer);
          return true;
        } catch {
          return false;
        }
      }),
      RUN_OPTIONS,
    );
  });

  test("round-trips width/height for a well-formed synthetic PNG header", () => {
    fc.assert(
      fc.property(dimension, dimension, (width, height) => {
        const result = readImageHeaderDimensions(buildPng(width, height));
        return result !== null && result.width === width && result.height === height;
      }),
      RUN_OPTIONS,
    );
  });

  test("a PNG header truncated anywhere before its full 24 bytes returns null, never throws", () => {
    fc.assert(
      fc.property(dimension, dimension, fc.integer({ min: 0, max: 23 }), (width, height, n) => {
        const truncated = buildPng(width, height).subarray(0, n);
        return readImageHeaderDimensions(truncated) === null;
      }),
      RUN_OPTIONS,
    );
  });

  test("round-trips width/height for a well-formed synthetic minimal JPEG (SOI + SOF0)", () => {
    fc.assert(
      fc.property(dimension, dimension, (width, height) => {
        const result = readImageHeaderDimensions(buildJpeg(width, height));
        return result !== null && result.width === width && result.height === height;
      }),
      RUN_OPTIONS,
    );
  });

  test("a JPEG truncated mid-SOF0-segment returns null, never throws or reads garbage", () => {
    // buildJpeg's SOF0 segment starts at offset 2 and its height/width fields live at offsets
    // 7..10 (inclusive); truncating to 10 bytes or fewer always cuts into or before those fields,
    // so the reader must refuse rather than hand back a partial or wrong pair of dimensions.
    fc.assert(
      fc.property(dimension, dimension, fc.integer({ min: 0, max: 10 }), (width, height, n) => {
        const truncated = buildJpeg(width, height).subarray(0, n);
        return readImageHeaderDimensions(truncated) === null;
      }),
      RUN_OPTIONS,
    );
  });
});
