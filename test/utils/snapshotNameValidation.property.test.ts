import { describe, test } from "bun:test";
import fc from "fast-check";
import * as path from "path";
import { assertSafeSnapshotName } from "../../src/utils/snapshotNameValidation";
import { ActionableError } from "../../src/models";

// Property-based tests for the snapshot-name path-traversal guard (issue #5705).
//
// `DeviceSnapshotStore` builds every on-disk path with `path.join(basePath,
// snapshotName, …)` and the Android VM path forwards the raw name to
// `adb emu avd snapshot save <name>`. The one promise `assertSafeSnapshotName`
// exists to keep is CONTAINMENT: any name it accepts must resolve to a single
// direct child of the base directory and can never escape it. The example-based
// suite pins down individual attack strings; these properties assert the
// invariant across a large, adversarial input space.
//
// A pinned seed keeps CI deterministic (matching the repo's reproducibility
// conventions — see Backoff.property.test.ts). On failure fast-check prints the
// seed and the shrunk counterexample; bump `numRuns` locally to widen the search.
const RUN_OPTIONS = { seed: 5_705_001, numRuns: 500 } as const;

// Bases used to probe containment on both path flavors, independent of the CI
// host's platform. Both are absolute so a traversal in `name` would be visible
// as the joined path's parent no longer being the base.
const POSIX_BASE = "/snapshots";
const WIN32_BASE = "C:\\snaps";

function accepts(name: string): boolean {
  try {
    assertSafeSnapshotName(name);
    return true;
  } catch {
    return false;
  }
}

function rejectionOf(name: string): unknown {
  try {
    assertSafeSnapshotName(name);
    return undefined;
  } catch (error) {
    return error;
  }
}

// Units deliberately biased toward the characters that make traversal possible:
// separators, dot segments, NUL, drive-letter and home prefixes — mixed with a
// few ordinary characters so a meaningful fraction of samples are accepted.
const hostileUnit = fc.oneof(
  fc.constantFrom(
    "/",
    "\\",
    ".",
    "..",
    "\0",
    ":",
    "~",
    "C:",
    " ",
    "\t",
    "\n",
    "a",
    "b",
    "1",
    "-",
    "_",
    "é",
  ),
  fc.integer({ min: 0x20, max: 0x7e }).map((code) => String.fromCharCode(code)),
);
const hostileName = fc.string({ unit: hostileUnit, maxLength: 24 });

// Ordinary single-segment names — the accepted domain the store relies on.
const safeUnit = fc.constantFrom(..."abcdefghijABCDEFGHIJ0123456789 ._-".split(""));
const safeName = fc
  .string({ unit: safeUnit, minLength: 1, maxLength: 20 })
  // Exclude the strings the guard legitimately rejects even under a safe
  // alphabet: whitespace-only names and the bare traversal segments.
  .filter((s) => s.trim().length > 0 && s !== "." && s !== "..");

describe("assertSafeSnapshotName (property-based, #5705)", () => {
  test("soundness: every accepted name joins to a direct child of the base directory", () => {
    fc.assert(
      fc.property(fc.oneof(safeName, hostileName), (name) => {
        // Only accepted names carry the containment promise.
        fc.pre(accepts(name));

        const posixJoined = path.posix.join(POSIX_BASE, name);
        const win32Joined = path.win32.join(WIN32_BASE, name);

        return (
          // The joined path's parent is exactly the base — no descent, no escape.
          path.posix.dirname(posixJoined) === POSIX_BASE &&
          path.win32.dirname(win32Joined) === WIN32_BASE &&
          // ...and it actually descended into a child rather than collapsing to
          // the base itself (which "." / "" would do).
          posixJoined !== POSIX_BASE &&
          win32Joined !== WIN32_BASE &&
          // No parent-directory segment survives normalization on either flavor.
          !path.posix.normalize(posixJoined).split(path.posix.sep).includes("..") &&
          !path.win32.normalize(win32Joined).split(path.win32.sep).includes("..")
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("completeness: a name containing a path separator is always rejected", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: hostileUnit, maxLength: 12 }),
        fc.constantFrom("/", "\\"),
        fc.string({ unit: hostileUnit, maxLength: 12 }),
        (prefix, sep, suffix) => accepts(prefix + sep + suffix) === false,
      ),
      RUN_OPTIONS,
    );
  });

  test("completeness: a name containing a NUL byte is always rejected", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: hostileUnit, maxLength: 12 }),
        fc.string({ unit: hostileUnit, maxLength: 12 }),
        (prefix, suffix) => accepts(`${prefix}\0${suffix}`) === false,
      ),
      RUN_OPTIONS,
    );
  });

  test("completeness: absolute paths and bare traversal segments are always rejected", () => {
    const alwaysRejected = fc.oneof(
      fc.constantFrom(".", "..", "", "   ", "\t", "\n"),
      // POSIX absolute: any leading-slash path.
      fc.string({ unit: hostileUnit, maxLength: 12 }).map((rest) => `/${rest}`),
      // Windows drive-absolute path.
      fc.string({ unit: hostileUnit, maxLength: 12 }).map((rest) => `C:\\${rest}`),
    );
    fc.assert(
      fc.property(alwaysRejected, (name) => accepts(name) === false),
      RUN_OPTIONS,
    );
  });

  test("acceptance: ordinary single-segment names are never rejected", () => {
    fc.assert(
      fc.property(safeName, (name) => accepts(name) === true),
      RUN_OPTIONS,
    );
  });

  test("error contract: every rejection throws an ActionableError naming the input", () => {
    fc.assert(
      fc.property(fc.oneof(safeName, hostileName), (name) => {
        const error = rejectionOf(name);
        if (error === undefined) {
          return true; // accepted — nothing to assert here
        }
        // Rejections must be actionable (not a bare Error) and echo the offending
        // name so the caller can see exactly what was refused.
        return error instanceof ActionableError && String(error.message).includes(name);
      }),
      RUN_OPTIONS,
    );
  });

  test("determinism: the accept/reject decision does not vary between calls", () => {
    fc.assert(
      fc.property(fc.oneof(safeName, hostileName), (name) => {
        const first = accepts(name);
        const second = accepts(name);
        return first === second;
      }),
      RUN_OPTIONS,
    );
  });
});
