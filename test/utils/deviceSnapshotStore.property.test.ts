import { describe, test } from "bun:test";
import fc from "fast-check";
import * as path from "path";
import * as os from "os";
import {
  DeviceSnapshotStore,
  SNAPSHOT_REPLACING_SUFFIX,
  type SnapshotPathOptions,
} from "../../src/utils/DeviceSnapshotStore";
import { assertSafeSnapshotName } from "../../src/utils/snapshotNameValidation";
import { ActionableError } from "../../src/models";

// Property-based tests for the RESOLVED snapshot path (issue #6493).
//
// `assertSafeSnapshotName` only validates the snapshot name itself
// (property-tested in test/utils/snapshotNameValidation.property.test.ts).
// `DeviceSnapshotStore.getSnapshotPathWithOptions` composes the final on-disk
// path from TWO more segments that were never validated: the Android AVD name
// (sourced from `adb emu avd name` output) and the iOS device UDID (sourced
// from simctl) — see SnapshotPathOptions. Both are external-tool output, not a
// validated caller-supplied name, so a hostile or malformed value can carry a
// '..' or path-separator component straight into `path.join(basePath, scope,
// name)`.
//
// The one promise every caller relies on — captures, deletes, eviction,
// settings/metadata/app-data writes all funnel through this one function — is
// CONTAINMENT: the resolved path must stay strictly inside `basePath`. This
// suite pins that invariant across a large, adversarial input space, exercising
// the REAL `DeviceSnapshotStore` (not a reimplementation of path.join).
//
// A pinned seed keeps CI deterministic (see test/utils/Backoff.property.test.ts
// for the rationale). On failure fast-check prints the seed and the shrunk
// counterexample; bump `numRuns` locally to widen the search.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const basePath = path.join(os.tmpdir(), "am-device-snapshot-store-property-test");
const store = new DeviceSnapshotStore(basePath);

// Snapshot names accepted by the real name validator. `DeviceSnapshotStore`
// itself does not re-validate the name (that is the caller's job), so this
// generator exercises the store the way a validated caller does, without
// reimplementing `assertSafeSnapshotName`'s acceptance logic.
function isAcceptedName(name: string): boolean {
  try {
    assertSafeSnapshotName(name);
    return true;
  } catch {
    return false;
  }
}

const nameUnit = fc.oneof(
  fc.constantFrom("a", "b", "1", "-", "_", ".", " ", "/", "\\", "\0"),
  fc.integer({ min: 0x20, max: 0x7e }).map((code) => String.fromCharCode(code)),
);
const acceptedName = fc
  .string({ unit: nameUnit, minLength: 0, maxLength: 16 })
  .filter(isAcceptedName);

// Units biased toward the characters that make a scope segment escape
// basePath: separators, dot segments, NUL, drive-letter/home prefixes — mixed
// with ordinary characters so a meaningful fraction of samples are plain.
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
    "a",
    "b",
    "1",
    "-",
    "_",
    "é",
  ),
  fc.integer({ min: 0x20, max: 0x7e }).map((code) => String.fromCharCode(code)),
);
const hostileSegment = fc.string({ unit: hostileUnit, maxLength: 24 });

// Segments deliberately constructed to escape `basePath` once joined the way
// `getSnapshotPathWithOptions` does — a leading `..` component, an embedded
// separator, or an absolute-path prefix — the exact shapes `avdName`/
// `deviceId` could take if the underlying tool ever emits unexpected output.
//
// A SINGLE leading '..' only cancels the fixed "android"/"ios" prefix segment
// and lands back inside basePath at the current nesting depth (a scoping
// bypass, not an outright escape today) — but TWO OR MORE leading '..'
// components climb past basePath itself onto the real filesystem, and even a
// single '..' would escape the moment a future change adds another scope
// level (exactly the fragility issue #6493 flags). Both shapes belong here:
// the validator must reject the segment on its own shape, not on whether it
// happens to still resolve inside basePath at today's fixed nesting depth.
const dotDotDepth = fc.integer({ min: 1, max: 4 });
const escapingSegment = fc.oneof(
  fc.constant(".."),
  fc.constant("."),
  fc
    .tuple(dotDotDepth, fc.string({ unit: hostileUnit, maxLength: 8 }))
    .map(([depth, s]) => `${Array(depth).fill("..").join("/")}/${s || "x"}`),
  fc
    .tuple(dotDotDepth, fc.string({ unit: hostileUnit, maxLength: 8 }))
    .map(([depth, s]) => `${Array(depth).fill("..").join("\\")}\\${s || "x"}`),
  fc.string({ unit: hostileUnit, maxLength: 8 }).map((s) => `/${s}`),
  fc.string({ unit: hostileUnit, maxLength: 8 }).map((s) => `C:\\${s}`),
  fc.string({ unit: hostileUnit, maxLength: 8 }).map((s) => `${s || "a"}/${s || "b"}`),
);

// Ordinary AVD-name / UDID-shaped segments — the accepted domain real device
// identifiers take. AVD names are typically snake/kebab-ish; simulator UDIDs
// are upper-hex-with-dashes. Neither ever needs a separator, dot segment, or
// absolute-path prefix.
const safeSegmentChars = Array.from(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
);
const safeSegment = fc
  .string({ unit: fc.constantFrom(...safeSegmentChars), minLength: 1, maxLength: 24 })
  .filter((s) => s !== "." && s !== "..");

function isStrictlyInside(base: string, candidate: string): boolean {
  const resolvedBase = path.resolve(base);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate.startsWith(resolvedBase + path.sep);
}

type Attempt = { ok: true; value: string } | { ok: false; error: unknown };

function attempt(fn: () => string): Attempt {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

function androidOptions(avdName: string): SnapshotPathOptions {
  return { platform: "android", avdName };
}

function iosOptions(deviceId: string): SnapshotPathOptions {
  return { platform: "ios", deviceId };
}

describe("DeviceSnapshotStore.getSnapshotPathWithOptions (property-based, #6493)", () => {
  test("containment: every resolved scoped path stays strictly inside basePath, or is rejected", () => {
    fc.assert(
      fc.property(
        acceptedName,
        fc.constantFrom<"android" | "ios">("android", "ios"),
        fc.oneof(safeSegment, hostileSegment, escapingSegment),
        (snapshotName, platform, scopeSegment) => {
          const options =
            platform === "android" ? androidOptions(scopeSegment) : iosOptions(scopeSegment);
          const result = attempt(() => store.getSnapshotPathWithOptions(snapshotName, options));

          if (!result.ok) {
            // Validation rejected the scope segment — nothing escaped.
            return result.error instanceof ActionableError;
          }
          return isStrictlyInside(basePath, result.value);
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("hardening: a scope segment built to escape basePath is always rejected", () => {
    fc.assert(
      fc.property(
        acceptedName,
        fc.constantFrom<"android" | "ios">("android", "ios"),
        escapingSegment,
        (snapshotName, platform, scopeSegment) => {
          const options =
            platform === "android" ? androidOptions(scopeSegment) : iosOptions(scopeSegment);
          const result = attempt(() => store.getSnapshotPathWithOptions(snapshotName, options));
          return result.ok === false && result.error instanceof ActionableError;
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("acceptance: ordinary AVD-name / UDID-shaped scope segments are never rejected", () => {
    fc.assert(
      fc.property(
        acceptedName,
        fc.constantFrom<"android" | "ios">("android", "ios"),
        safeSegment,
        (snapshotName, platform, scopeSegment) => {
          const options =
            platform === "android" ? androidOptions(scopeSegment) : iosOptions(scopeSegment);
          const result = attempt(() => store.getSnapshotPathWithOptions(snapshotName, options));
          return result.ok === true && isStrictlyInside(basePath, result.value);
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("derived-path agreement: settings/metadata/app-data paths sit strictly under the resolved snapshot path", () => {
    fc.assert(
      fc.property(
        acceptedName,
        fc.constantFrom<"android" | "ios">("android", "ios"),
        safeSegment,
        (snapshotName, platform, scopeSegment) => {
          const options =
            platform === "android" ? androidOptions(scopeSegment) : iosOptions(scopeSegment);
          const snapshotPath = store.getSnapshotPathWithOptions(snapshotName, options);
          const settingsPath = store.getSettingsPath(snapshotName, options);
          const metadataPath = store.getMetadataPath(snapshotName, options);
          const appDataPath = store.getAppDataPath(snapshotName, options);
          const replacingPath = `${snapshotPath}${SNAPSHOT_REPLACING_SUFFIX}`;

          return (
            isStrictlyInside(snapshotPath, settingsPath) &&
            isStrictlyInside(snapshotPath, metadataPath) &&
            isStrictlyInside(snapshotPath, appDataPath) &&
            // The set-aside directory is a SIBLING of the snapshot path, not a
            // descendant — but it must still resolve inside basePath, and it
            // must never collide with the snapshot path itself.
            isStrictlyInside(basePath, replacingPath) &&
            path.resolve(replacingPath) !== path.resolve(snapshotPath)
          );
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("non-collision: two distinct safe scope segments on the same platform never resolve to the same path", () => {
    fc.assert(
      fc.property(
        acceptedName,
        fc.constantFrom<"android" | "ios">("android", "ios"),
        safeSegment,
        safeSegment,
        (snapshotName, platform, segmentA, segmentB) => {
          fc.pre(segmentA !== segmentB);
          const optionsA = platform === "android" ? androidOptions(segmentA) : iosOptions(segmentA);
          const optionsB = platform === "android" ? androidOptions(segmentB) : iosOptions(segmentB);
          const pathA = store.getSnapshotPathWithOptions(snapshotName, optionsA);
          const pathB = store.getSnapshotPathWithOptions(snapshotName, optionsB);
          return path.resolve(pathA) !== path.resolve(pathB);
        },
      ),
      RUN_OPTIONS,
    );
  });
});
