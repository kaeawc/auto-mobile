import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { isOlderVersion, parseVersion } from "../../../src/utils/plan/PlanMigrator";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const versionPart = fc.integer({ min: 0, max: 99 });

const wellFormedVersion = fc.tuple(versionPart, versionPart, versionPart).map(
  ([major, minor, patch]) => `${major}.${minor}.${patch}`
);

const dirtyBuildVersion = fc.tuple(versionPart, versionPart, versionPart).map(
  ([major, minor, patch]) => `${major}.${minor}.${patch}+gabc123.dirty`
);

// Anything that could plausibly show up in a plan's mcpVersion field, including
// malformed input — isOlderVersion must handle all of it without throwing.
const anyVersionLike = fc.oneof(
  wellFormedVersion,
  dirtyBuildVersion,
  fc.string()
);

const unparseableVersion = fc.oneof(
  fc.constant(undefined),
  fc.constant("unknown"),
  fc.constant("latest"),
  fc.string().filter(s => parseVersion(s) === null)
);

const versionTuple = fc.tuple(
  fc.integer({ min: 0, max: 50 }),
  fc.integer({ min: 0, max: 50 }),
  fc.integer({ min: 0, max: 50 })
);

const compareTuples = (a: number[], b: number[]): number => {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return 0;
};

describe("PlanMigrator version comparison (property-based)", () => {
  test("isOlderVersion never throws and always returns a boolean", () => {
    fc.assert(
      fc.property(anyVersionLike, anyVersionLike, (version, target) => {
        let result: boolean | undefined;
        expect(() => {
          result = isOlderVersion(version, target);
        }).not.toThrow();
        return typeof result === "boolean";
      }),
      RUN_OPTIONS
    );
  });

  test("an unparseable version is always treated as outdated", () => {
    fc.assert(
      fc.property(unparseableVersion, anyVersionLike, (version, target) => {
        return isOlderVersion(version, target) === true;
      }),
      RUN_OPTIONS
    );
  });

  test("well-formed versions compare consistently (reflexive, total order)", () => {
    fc.assert(
      fc.property(versionTuple, versionTuple, (tupleA, tupleB) => {
        const a = tupleA.join(".");
        const b = tupleB.join(".");

        if (isOlderVersion(a, a) !== false) {
          return false;
        }

        if (a === b) {
          return true;
        }

        const cmp = compareTuples(tupleA, tupleB);
        const aOlderThanB = isOlderVersion(a, b);
        const bOlderThanA = isOlderVersion(b, a);

        if (cmp < 0) {
          return aOlderThanB === true && bOlderThanA === false;
        }
        return aOlderThanB === false && bOlderThanA === true;
      }),
      RUN_OPTIONS
    );
  });

  test("build metadata is stripped before comparison", () => {
    fc.assert(
      fc.property(wellFormedVersion, v => {
        return isOlderVersion(`${v}+gabc123.dirty`, v) === false;
      }),
      RUN_OPTIONS
    );
  });
});
