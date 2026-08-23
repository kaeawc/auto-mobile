import { describe, test } from "bun:test";
import fc from "fast-check";
import {
  h264MacroblocksPerFrame,
  h264SpsLevelIdc,
  h264SpsProfileLevelId,
  isCompatibleConstrainedBaselineProfile,
} from "../../../src/features/webrtc/h264Level";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const dim = fc.integer({ min: 1, max: 8192 });
const byte = fc.integer({ min: 0, max: 255 });
// A NAL header byte whose low 5 bits are 7 (SPS type), any high 3 bits.
const spsHeader = fc.integer({ min: 0, max: 7 }).map((hi) => (hi << 5) | 7);

const validSps = fc
  .record({ b0: spsHeader, p: byte, c: byte, l: byte, extra: fc.uint8Array({ maxLength: 8 }) })
  .map(({ b0, p, c, l, extra }) => ({ nal: Buffer.from([b0, p, c, l, ...extra]), p, c, l }));

describe("h264MacroblocksPerFrame (property-based)", () => {
  test("is a positive integer", () => {
    fc.assert(
      fc.property(dim, dim, (w, h) => {
        const mb = h264MacroblocksPerFrame(w, h);
        return Number.isInteger(mb) && mb > 0;
      }),
      RUN_OPTIONS,
    );
  });

  test("is monotonic non-decreasing in each dimension", () => {
    const delta = fc.integer({ min: 0, max: 1000 });
    fc.assert(
      fc.property(
        dim,
        dim,
        delta,
        delta,
        (w, h, dw, dh) =>
          h264MacroblocksPerFrame(w + dw, h) >= h264MacroblocksPerFrame(w, h) &&
          h264MacroblocksPerFrame(w, h + dh) >= h264MacroblocksPerFrame(w, h),
      ),
      RUN_OPTIONS,
    );
  });

  test("equals a*b for 16-multiple dimensions", () => {
    const factor = fc.integer({ min: 1, max: 512 });
    fc.assert(
      fc.property(factor, factor, (a, b) => h264MacroblocksPerFrame(16 * a, 16 * b) === a * b),
      RUN_OPTIONS,
    );
  });
});

describe("h264SpsProfileLevelId / h264SpsLevelIdc (property-based)", () => {
  test("round-trips the 3 bytes after the SPS header, and reads the level byte", () => {
    fc.assert(
      fc.property(validSps, ({ nal, p, c, l }) => {
        const expected = Buffer.from([p, c, l]).toString("hex");
        return h264SpsProfileLevelId(nal) === expected && h264SpsLevelIdc(nal) === l;
      }),
      RUN_OPTIONS,
    );
  });

  test("returns undefined for a non-SPS or too-short NAL", () => {
    const nonSps = fc.oneof(
      fc.uint8Array({ maxLength: 3 }).map((a) => Buffer.from(a)),
      fc
        .record({
          b0: byte.filter((b) => (b & 0x1f) !== 7),
          rest: fc.uint8Array({ minLength: 3, maxLength: 8 }),
        })
        .map(({ b0, rest }) => Buffer.from([b0, ...rest])),
    );
    fc.assert(
      fc.property(
        nonSps,
        (nal) => h264SpsProfileLevelId(nal) === undefined && h264SpsLevelIdc(nal) === undefined,
      ),
      RUN_OPTIONS,
    );
  });
});

describe("isCompatibleConstrainedBaselineProfile (property-based)", () => {
  test("accepts exactly the Baseline family (first byte 0x42) parsed from an SPS", () => {
    fc.assert(
      fc.property(validSps, ({ nal, p }) => {
        const id = h264SpsProfileLevelId(nal)!;
        return isCompatibleConstrainedBaselineProfile(id) === (p === 0x42);
      }),
      RUN_OPTIONS,
    );
  });

  test("accepts any 0x42-prefixed profile-level-id, including plain-Baseline (#reconnect-loop fix)", () => {
    const suffix = fc.string({
      unit: fc.constantFrom("0", "2", "8", "a", "e", "f"),
      minLength: 4,
      maxLength: 4,
    });
    fc.assert(
      fc.property(suffix, (s) => isCompatibleConstrainedBaselineProfile(`42${s}`)),
      RUN_OPTIONS,
    );
  });

  test("rejects non-Baseline profiles (Main 0x4d, High 0x64, and any non-0x42 first byte)", () => {
    const nonBaselineByte = fc.integer({ min: 0, max: 255 }).filter((b) => b !== 0x42);
    const suffix = fc.string({
      unit: fc.constantFrom("0", "1", "e", "a", "f"),
      minLength: 4,
      maxLength: 4,
    });
    fc.assert(
      fc.property(
        nonBaselineByte,
        suffix,
        (b, s) =>
          isCompatibleConstrainedBaselineProfile(`${b.toString(16).padStart(2, "0")}${s}`) ===
          false,
      ),
      RUN_OPTIONS,
    );
  });
});
