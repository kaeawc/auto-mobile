import { describe, test } from "bun:test";
import fc from "fast-check";
import nodeCrypto from "crypto";
import { NodeCryptoService } from "../../src/utils/crypto";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const service = new NodeCryptoService();
const bytes = fc.uint8Array({ maxLength: 128 }).map((a) => Buffer.from(a));
const data = fc.oneof(fc.string({ maxLength: 128 }), bytes);
const md5Hex = (d: string | Buffer): string => nodeCrypto.createHash("md5").update(d).digest("hex");
const sha256Hex = (buffer: Buffer): string =>
  nodeCrypto.createHash("sha256").update(buffer).digest("hex");

describe("NodeCryptoService.generateCacheKey (property-based)", () => {
  test("equals an independently-computed MD5 of the input", () => {
    // Oracle check: a regression returning a constant or truncated SHA-256 would
    // still satisfy determinism + 32-hex + static≡instance, so pin it to real MD5.
    fc.assert(
      fc.property(data, (d) => service.generateCacheKey(d) === md5Hex(d)),
      RUN_OPTIONS,
    );
  });

  test("is deterministic — the same input yields the same key", () => {
    fc.assert(
      fc.property(data, (d) => {
        const first = service.generateCacheKey(d);
        const second = service.generateCacheKey(d);
        return first === second;
      }),
      RUN_OPTIONS,
    );
  });

  test("is always a 32-character lowercase hex string (MD5)", () => {
    fc.assert(
      fc.property(data, (d) => /^[0-9a-f]{32}$/.test(service.generateCacheKey(d))),
      RUN_OPTIONS,
    );
  });

  test("the static convenience method equals the instance method", () => {
    fc.assert(
      fc.property(
        data,
        (d) => NodeCryptoService.generateCacheKey(d) === service.generateCacheKey(d),
      ),
      RUN_OPTIONS,
    );
  });
});

describe("NodeCryptoService.verifyChecksum (property-based)", () => {
  test("accepts the matching SHA-256 checksum, case-insensitively", () => {
    fc.assert(
      fc.property(bytes, (buffer) => {
        const checksum = sha256Hex(buffer);
        return (
          service.verifyChecksum(buffer, checksum) &&
          service.verifyChecksum(buffer, checksum.toUpperCase())
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("rejects a checksum that differs by a single digit", () => {
    fc.assert(
      fc.property(bytes, (buffer) => {
        const correct = sha256Hex(buffer);
        // Flip the first hex digit to a guaranteed-different value.
        const wrong = (correct[0] === "0" ? "1" : "0") + correct.slice(1);
        return service.verifyChecksum(buffer, wrong) === false;
      }),
      RUN_OPTIONS,
    );
  });

  test("never throws and returns a boolean for an arbitrary expected string", () => {
    fc.assert(
      fc.property(bytes, fc.string({ maxLength: 80 }), (buffer, expected) => {
        return typeof service.verifyChecksum(buffer, expected) === "boolean";
      }),
      RUN_OPTIONS,
    );
  });
});
