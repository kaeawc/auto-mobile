import { describe, test } from "bun:test";
import fc from "fast-check";
import { combineApkDigests, extractApkDigests, parsePmPathOutput } from "../../src/utils/ContentHashProvider";

// Property-based tests. See test/utils/Backoff.property.test.ts for the
// pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const hexDigest = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map(bytes => Buffer.from(bytes).toString("hex"));

const sha256sumLine = fc
  .tuple(hexDigest, fc.stringMatching(/^[a-zA-Z0-9_./-]{1,20}$/))
  .map(([digest, path]) => `${digest}  ${path}`);

const sha256sumStdout = fc
  .array(sha256sumLine, { minLength: 1, maxLength: 8 })
  .map(lines => lines.join("\n"));

// Pairs original stdout with a shuffled reordering of its own lines, so the
// commutativity check below compares two genuinely different orderings of
// the exact same digest set (not just two independent samples).
const stdoutWithShuffledLines = sha256sumStdout.chain(stdout => {
  const lines = stdout.split("\n");
  return fc
    .shuffledSubarray(lines, { minLength: lines.length, maxLength: lines.length })
    .map(shuffled => [stdout, shuffled.join("\n")] as const);
});

describe("combineApkDigests (property-based)", () => {
  test("commutative: any permutation of the same lines combines to the same hash", () => {
    fc.assert(
      fc.property(
        stdoutWithShuffledLines,
        ([stdout, shuffled]) => combineApkDigests(stdout) === combineApkDigests(shuffled)
      ),
      RUN_OPTIONS
    );
  });

  test("deterministic: combining the same stdout twice yields the same hash", () => {
    fc.assert(
      fc.property(sha256sumStdout, stdout => {
        const first = combineApkDigests(stdout);
        const second = combineApkDigests(stdout);
        return first === second;
      }),
      RUN_OPTIONS
    );
  });

  test("always a 64-char lowercase hex sha256, or '' when no valid digest is present", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), stdout => {
        const result = combineApkDigests(stdout);
        return result === "" || /^[0-9a-f]{64}$/.test(result);
      }),
      RUN_OPTIONS
    );
  });

  test("extractApkDigests result is always sorted and only contains valid hex digests", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), stdout => {
        const digests = extractApkDigests(stdout);
        const sorted = [...digests].sort();
        return (
          digests.every(d => /^[0-9a-f]{64}$/i.test(d)) &&
          digests.every((d, i) => d === sorted[i])
        );
      }),
      RUN_OPTIONS
    );
  });
});

describe("parsePmPathOutput (property-based)", () => {
  test("result is always sorted and every entry ends with .apk", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), stdout => {
        const paths = parsePmPathOutput(stdout);
        const sorted = [...paths].sort();
        return paths.every(p => p.endsWith(".apk")) && paths.every((p, i) => p === sorted[i]);
      }),
      RUN_OPTIONS
    );
  });
});
