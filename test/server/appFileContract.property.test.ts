import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { normalizeAppFileRelativePath } from "../../src/server/appFileContract";

// Property-based tests for the path-traversal guard that gates file writes into
// on-device app containers. A single unfuzzed encoding that slips past this guard
// is a security bug, not just a test gap. See test/utils/Backoff.property.test.ts
// for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 500 } as const;

/** A path component that is safe on its own (no separators, not `.`/`..`, non-empty). */
const safeSegment = fc
  .stringMatching(/^[a-zA-Z0-9_. -]+$/)
  .filter((s) => s.length > 0 && s !== "." && s !== "..");

/** A dangerous component the guard must reject as a path segment. */
const dangerousSegment = fc.constantFrom(".", "..", "");

const separator = fc.constantFrom("/", "\\");

/** Join segments with an independently-chosen separator at each gap (mixes `/` and `\`). */
function joinMixed(segments: string[], seps: string[]): string {
  return segments.reduce((acc, seg, i) => (i === 0 ? seg : acc + seps[i - 1] + seg), "");
}

/** The output-safety contract: what a non-throwing return value must always satisfy. */
function isSafeOutput(out: string): boolean {
  if (typeof out !== "string" || out.length === 0) {
    return false;
  }
  if (out.startsWith("/") || out.includes("\\")) {
    return false;
  }
  // AC3 is about `.`/`..` *segments*, not the substring `..` — `a..b` is a legal name.
  return out.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

describe("normalizeAppFileRelativePath (property-based)", () => {
  // AC1 (totality) + AC3 (safe output) + AC4 (idempotence) over the whole input space.
  test("totality: any string either throws an Error or returns a safe normalized path", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        let out: string;
        try {
          out = normalizeAppFileRelativePath(input);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          return;
        }
        // AC3 — safe output.
        expect(isSafeOutput(out)).toBe(true);
        // AC4 — idempotence: re-normalizing a normalized path is a fixpoint.
        expect(normalizeAppFileRelativePath(out)).toBe(out);
      }),
      RUN_OPTIONS,
    );
  });

  // AC2 — a dangerous segment at an ARBITRARY depth, behind an arbitrary all-safe
  // prefix, must throw. The prefix is >= 1 so the danger is never leading (hence never
  // strippable / never mistaken for a leading slash), and the suffix is all-safe so the
  // inserted segment is the *only* dangerous one — this precisely exercises deep
  // traversal like `safe/safe/../secret` that a first-component-only guard would miss.
  test("rejection: a `.`/`..`/empty segment at any depth behind a safe prefix always throws", () => {
    const arb = fc
      .tuple(
        fc.array(safeSegment, { minLength: 1, maxLength: 4 }),
        dangerousSegment,
        fc.array(safeSegment, { maxLength: 4 }),
      )
      .chain(([prefix, danger, suffix]) => {
        const segments = [...prefix, danger, ...suffix];
        return fc
          .array(separator, { minLength: segments.length - 1, maxLength: segments.length - 1 })
          .map((seps) => joinMixed(segments, seps));
      });
    fc.assert(
      fc.property(arb, (path) => {
        expect(() => normalizeAppFileRelativePath(path)).toThrow();
      }),
      RUN_OPTIONS,
    );
  });

  // AC2 — any leading-slash form (before or after `\`->`/` normalization) must throw.
  test("rejection: leading absolute separators always throw", () => {
    const arb = fc
      .tuple(
        fc.constantFrom("/", "\\", "//", "\\\\", "/\\"),
        safeSegment,
        fc.array(safeSegment, { maxLength: 3 }),
      )
      .map(([prefix, lead, rest]) => prefix + [lead, ...rest].join("/"));
    fc.assert(
      fc.property(arb, (path) => {
        expect(() => normalizeAppFileRelativePath(path)).toThrow();
      }),
      RUN_OPTIONS,
    );
  });

  // Complements AC2: a path built only from safe segments must NOT throw and must
  // recover its exact segment set (guards against over-rejection AND against a guard
  // that returns a different-but-safe path — e.g. truncating, reordering, or a fixed
  // value — by asserting `out === segments.join("/")`, the sole legal normalization).
  test("acceptance: safe relative paths normalize to their exact segment set", () => {
    const arb = fc
      .tuple(
        fc.boolean(), // optional leading `./` (stripped by the guard)
        fc.array(safeSegment, { minLength: 1, maxLength: 6 }),
        fc.array(separator, { maxLength: 6 }),
      )
      .map(([dotSlash, segments, seps]) => {
        const body = joinMixed(
          segments,
          Array.from({ length: Math.max(0, segments.length - 1) }, (_, i) => seps[i] ?? "/"),
        );
        // Separators all normalize to `/`, segments carry none, and a leading `./` is
        // stripped, so the only correct result is the segments rejoined with `/`.
        return { path: dotSlash ? `./${body}` : body, expected: segments.join("/") };
      });
    fc.assert(
      fc.property(arb, ({ path, expected }) => {
        const out = normalizeAppFileRelativePath(path);
        expect(out).toBe(expected);
        expect(isSafeOutput(out)).toBe(true);
        expect(normalizeAppFileRelativePath(out)).toBe(out);
      }),
      RUN_OPTIONS,
    );
  });
});
