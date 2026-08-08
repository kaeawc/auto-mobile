import { describe, test } from "bun:test";
import fc from "fast-check";
import { normalizeAppFileRelativePath } from "../../src/server/appFileContract";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// A single traversal-relevant segment: ".", "..", or an ordinary name, mixed
// with both separator styles so the generator can build "../secret",
// "a/../b", "a\\..\\b", leading/trailing slashes, and doubled separators.
const segment = fc.oneof(
  fc.constantFrom(".", ".."),
  fc.stringMatching(/^[a-zA-Z0-9_-]{1,6}$/)
);
const separator = fc.constantFrom("/", "\\", "//", "\\\\");

// A path built from 0-5 segments joined by (possibly doubled) separators,
// with an optional leading separator/"./" prefix — the shapes
// normalizeAppFileRelativePath's guard must classify correctly regardless of
// which separator style or traversal depth is used.
const traversalPath = fc
  .array(segment, { minLength: 0, maxLength: 5 })
  .chain(segments =>
    fc.tuple(
      fc.array(separator, { minLength: Math.max(segments.length - 1, 0), maxLength: Math.max(segments.length - 1, 0) }),
      fc.constantFrom("", "/", "\\", "./")
    ).map(([seps, prefix]) => {
      let path = prefix;
      segments.forEach((seg, i) => {
        path += seg;
        if (i < seps.length) {
          path += seps[i];
        }
      });
      return path;
    })
  );

/** Does `path` contain a "." or ".." path segment under either separator style? */
function hasDotOrDotDotSegment(path: string): boolean {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .some(seg => seg === "." || seg === "..");
}

// Mirrors the ONE documented normalization exemption: a single leading "./"
// (or "././" -> "./", collapsing one dot + one-or-more slashes) is stripped
// before segment validation, so e.g. "./p" is accepted, not rejected as a
// "." segment. Anything past that single strip must still be traversal-free.
function hasRejectedSegmentAfterLeadingStrip(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
  return (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").some(seg => seg.length === 0 || seg === "." || seg === "..")
  );
}

describe("normalizeAppFileRelativePath (property-based)", () => {
  test("any path with a rejected segment (after the one leading './' exemption) always throws", () => {
    fc.assert(
      fc.property(
        traversalPath.filter(hasRejectedSegmentAfterLeadingStrip),
        path => {
          try {
            normalizeAppFileRelativePath(path);
            return false;
          } catch {
            return true;
          }
        }
      ),
      RUN_OPTIONS
    );
  });

  test("a result that doesn't throw is always relative, forward-slashed, and traversal-free", () => {
    fc.assert(
      fc.property(traversalPath, path => {
        let normalized: string;
        try {
          normalized = normalizeAppFileRelativePath(path);
        } catch {
          return true; // rejection is always an acceptable outcome
        }
        return (
          normalized.length > 0 &&
          !normalized.startsWith("/") &&
          !normalized.includes("\\") &&
          !hasDotOrDotDotSegment(normalized) &&
          !normalized.split("/").some(seg => seg.length === 0)
        );
      }),
      RUN_OPTIONS
    );
  });

  test("idempotent on its own output: re-normalizing an accepted path is a no-op", () => {
    fc.assert(
      fc.property(traversalPath, path => {
        let normalized: string;
        try {
          normalized = normalizeAppFileRelativePath(path);
        } catch {
          return true;
        }
        return normalizeAppFileRelativePath(normalized) === normalized;
      }),
      RUN_OPTIONS
    );
  });
});
