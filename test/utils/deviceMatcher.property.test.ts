import { describe, test } from "bun:test";
import fc from "fast-check";
import type { BootedDevice, Platform } from "../../src/models";
import type { MatchingStrategy } from "../../src/models/DeviceMatchCriteria";
import { compareVersions, DefaultDeviceMatcher } from "../../src/utils/deviceMatcher";
import { SeededRandom } from "../fakes/SeededRandom";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Dotted numeric versions are the comparator's realistic domain — non-numeric
// components make parseVersion produce NaN, which is out of contract.
const versionParts = fc.array(fc.nat(99), { minLength: 1, maxLength: 4 });
const versionOf = (parts: number[]): string => parts.join(".");

// Independent oracle: compare component-wise, treating missing trailing
// components as 0 (exactly the contract compareVersions documents).
const refCompareSign = (a: number[], b: number[]): number => {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) {
      return Math.sign(delta);
    }
  }
  return 0;
};

describe("compareVersions (property-based)", () => {
  test("is reflexive: a version compares equal to itself", () => {
    fc.assert(
      fc.property(
        versionParts,
        (parts) => compareVersions(versionOf(parts), versionOf(parts)) === 0,
      ),
      RUN_OPTIONS,
    );
  });

  test("is sign-antisymmetric", () => {
    fc.assert(
      fc.property(versionParts, versionParts, (a, b) => {
        const va = versionOf(a);
        const vb = versionOf(b);
        return Math.sign(compareVersions(va, vb)) === -Math.sign(compareVersions(vb, va));
      }),
      RUN_OPTIONS,
    );
  });

  test("agrees in sign with a component-wise numeric oracle", () => {
    fc.assert(
      fc.property(versionParts, versionParts, (a, b) => {
        return Math.sign(compareVersions(versionOf(a), versionOf(b))) === refCompareSign(a, b);
      }),
      RUN_OPTIONS,
    );
  });

  test("trailing zero components do not change the ordering", () => {
    fc.assert(
      fc.property(versionParts, fc.integer({ min: 0, max: 3 }), (parts, extraZeros) => {
        const padded = versionOf([...parts, ...Array(extraZeros).fill(0)]);
        return compareVersions(versionOf(parts), padded) === 0;
      }),
      RUN_OPTIONS,
    );
  });

  test("ordering is transitive", () => {
    fc.assert(
      fc.property(versionParts, versionParts, versionParts, (a, b, c) => {
        const va = versionOf(a);
        const vb = versionOf(b);
        const vc = versionOf(c);
        // a <= b <= c  ⇒  a <= c
        return (
          !(compareVersions(va, vb) <= 0 && compareVersions(vb, vc) <= 0) ||
          compareVersions(va, vc) <= 0
        );
      }),
      RUN_OPTIONS,
    );
  });
});

// Lettered/QPR release qualifiers (#6182). A dedicated generator + independent
// oracle over the full (components, letter, qpr) triple, rather than only
// example-based tests, per the tracking issue's explicit ask -- the
// interactions between the three parts are easy to under-specify by hand.
const letterOrUndefined = fc.option(fc.constantFrom("A", "L", "Q", "Z"), { nil: undefined });
const qprOrUndefined = fc.option(fc.nat(5), { nil: undefined });
const releaseQualifier = fc.record({
  parts: versionParts,
  letter: letterOrUndefined,
  qpr: qprOrUndefined,
});
type ReleaseQualifier = { parts: number[]; letter: string | undefined; qpr: number | undefined };

const qualifierToString = (q: ReleaseQualifier): string =>
  `${versionOf(q.parts)}${q.letter ?? ""}${q.qpr === undefined ? "" : `-QPR${q.qpr}`}`;

// Independent oracle: components first (missing trailing components as 0),
// then the letter qualifier (absent sorts before any letter, otherwise
// alphabetical), then the QPR suffix (absent treated as 0).
const refQualifierCompareSign = (a: ReleaseQualifier, b: ReleaseQualifier): number => {
  const componentsSign = refCompareSign(a.parts, b.parts);
  if (componentsSign !== 0) {
    return componentsSign;
  }
  if (a.letter !== b.letter) {
    if (a.letter === undefined) {
      return -1;
    }
    if (b.letter === undefined) {
      return 1;
    }
    return a.letter < b.letter ? -1 : 1;
  }
  return Math.sign((a.qpr ?? 0) - (b.qpr ?? 0));
};

describe("compareVersions over lettered/QPR release qualifiers (property-based)", () => {
  test("is reflexive", () => {
    fc.assert(
      fc.property(
        releaseQualifier,
        (q) => compareVersions(qualifierToString(q), qualifierToString(q)) === 0,
      ),
      RUN_OPTIONS,
    );
  });

  test("is sign-antisymmetric", () => {
    fc.assert(
      fc.property(releaseQualifier, releaseQualifier, (a, b) => {
        const sa = qualifierToString(a);
        const sb = qualifierToString(b);
        return Math.sign(compareVersions(sa, sb)) === -Math.sign(compareVersions(sb, sa));
      }),
      RUN_OPTIONS,
    );
  });

  test("agrees in sign with the independent (components, letter, qpr) oracle", () => {
    fc.assert(
      fc.property(releaseQualifier, releaseQualifier, (a, b) => {
        return (
          Math.sign(compareVersions(qualifierToString(a), qualifierToString(b))) ===
          refQualifierCompareSign(a, b)
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("ordering is transitive", () => {
    fc.assert(
      fc.property(releaseQualifier, releaseQualifier, releaseQualifier, (a, b, c) => {
        const sa = qualifierToString(a);
        const sb = qualifierToString(b);
        const sc = qualifierToString(c);
        return (
          !(compareVersions(sa, sb) <= 0 && compareVersions(sb, sc) <= 0) ||
          compareVersions(sa, sc) <= 0
        );
      }),
      RUN_OPTIONS,
    );
  });
});

const platform = fc.constantFrom<Platform>("android", "ios");
const device: fc.Arbitrary<BootedDevice> = fc.record({
  name: fc.string({ maxLength: 12 }),
  platform,
  deviceId: fc.string({ minLength: 1, maxLength: 8 }),
  osVersion: fc.option(versionParts.map(versionOf), { nil: undefined }),
});
const deviceList = fc.array(device, { maxLength: 16 });

describe("DefaultDeviceMatcher.matchBootedDevice (property-based)", () => {
  test("returns null or a device from the list matching the requested platform", () => {
    const strategy = fc.constantFrom<MatchingStrategy>("LATEST", "MINIMUM", "RANDOM");
    fc.assert(
      fc.property(deviceList, platform, strategy, (devices, p, s) => {
        const result = new DefaultDeviceMatcher(new SeededRandom(1)).matchBootedDevice(
          { platform: p },
          devices,
          s,
        );
        return result === null || (devices.includes(result) && result.platform === p);
      }),
      RUN_OPTIONS,
    );
  });

  test("returns null exactly when no device has the requested platform", () => {
    const strategy = fc.constantFrom<MatchingStrategy>("LATEST", "MINIMUM", "RANDOM");
    fc.assert(
      fc.property(deviceList, platform, strategy, (devices, p, s) => {
        const result = new DefaultDeviceMatcher(new SeededRandom(1)).matchBootedDevice(
          { platform: p },
          devices,
          s,
        );
        const hasMatch = devices.some((d) => d.platform === p);
        return (result === null) === !hasMatch;
      }),
      RUN_OPTIONS,
    );
  });

  test("LATEST/MINIMUM select an extremal version among the platform matches", () => {
    const extremum = fc.constantFrom<MatchingStrategy>("LATEST", "MINIMUM");
    fc.assert(
      fc.property(deviceList, platform, extremum, (devices, p, s) => {
        const result = new DefaultDeviceMatcher(new SeededRandom(1)).matchBootedDevice(
          { platform: p },
          devices,
          s,
        );
        if (result === null) {
          return true;
        }
        const matches = devices.filter((d) => d.platform === p);
        const resultVersion = result.osVersion ?? "0";
        return matches.every((d) => {
          const cmp = compareVersions(resultVersion, d.osVersion ?? "0");
          return s === "LATEST" ? cmp >= 0 : cmp <= 0;
        });
      }),
      RUN_OPTIONS,
    );
  });

  test("RANDOM selection is deterministic under a fixed seed", () => {
    fc.assert(
      fc.property(deviceList, platform, fc.integer({ min: 1, max: 1_000 }), (devices, p, seed) => {
        const a = new DefaultDeviceMatcher(new SeededRandom(seed)).matchBootedDevice(
          { platform: p },
          devices,
          "RANDOM",
        );
        const b = new DefaultDeviceMatcher(new SeededRandom(seed)).matchBootedDevice(
          { platform: p },
          devices,
          "RANDOM",
        );
        return a === b;
      }),
      RUN_OPTIONS,
    );
  });
});
