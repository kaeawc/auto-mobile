import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANDROID_SCHEMA_PATH,
  CANONICAL_SCHEMA_PATH,
  diffSchemaCopies,
  parseSchemaJson,
  schemasStructurallyEqual,
  structuralDiffPaths,
} from "../../scripts/check-schema-copy-drift";
import { loadJobSteps, stepNamed } from "../helpers/workflowSteps";

const repoRoot = join(import.meta.dir, "../..");

// AC2: the comparator must judge STRUCTURE, not bytes — a purely cosmetic
// formatting difference is not drift, but a missing field or changed value is.
describe("#5819 structuralDiffPaths — structural, not byte-for-byte", () => {
  test("object key order does not count as drift", () => {
    const a = JSON.parse(`{ "a": 1, "b": 2 }`);
    const b = JSON.parse(`{ "b": 2, "a": 1 }`);
    expect(schemasStructurallyEqual(a, b)).toBe(true);
    expect(structuralDiffPaths(a, b)).toEqual([]);
  });

  test("whitespace/array-formatting differences do not count as drift", () => {
    // The Android copy historically expands inline enums onto multiple lines.
    // Once parsed, the two must be equal.
    const inline = JSON.parse(`{ "enum": ["android", "ios"] }`);
    const expanded = JSON.parse(`{\n  "enum": [\n    "android",\n    "ios"\n  ]\n}`);
    expect(schemasStructurallyEqual(inline, expanded)).toBe(true);
  });

  test("a field present in canonical but missing from android is flagged", () => {
    const canonical = JSON.parse(`{ "optional": { "type": "boolean" }, "tool": {} }`);
    const android = JSON.parse(`{ "tool": {} }`);
    const diffs = structuralDiffPaths(canonical, android);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.some((d) => d.includes("optional") && d.includes("missing from android"))).toBe(
      true,
    );
  });

  test("a changed scalar value is flagged", () => {
    const canonical = JSON.parse(`{ "const": "getAppPermissions" }`);
    const android = JSON.parse(`{ "const": "setAppPermissions" }`);
    expect(schemasStructurallyEqual(canonical, android)).toBe(false);
  });

  test("array order IS significant (ordered constructs like allOf)", () => {
    const a = JSON.parse(`[1, 2, 3]`);
    const b = JSON.parse(`[3, 2, 1]`);
    expect(schemasStructurallyEqual(a, b)).toBe(false);
  });

  test("array length differences are flagged", () => {
    const canonical = JSON.parse(`{ "allOf": [1, 2, 3] }`);
    const android = JSON.parse(`{ "allOf": [1, 2] }`);
    const diffs = structuralDiffPaths(canonical, android);
    expect(diffs.some((d) => d.includes("array length"))).toBe(true);
  });
});

// AC2 (hardening): `JSON.parse` collapses integers beyond 2^53 to the same
// IEEE-754 double, which would let a divergence in a large numeric literal slip
// past the structural comparison. `parseSchemaJson` preserves the original token.
describe("#5819 parseSchemaJson preserves large-integer precision", () => {
  test("two consts differing only past 2^53 are NOT judged equal", () => {
    const canonical = parseSchemaJson(`{ "const": 9007199254740992 }`);
    const android = parseSchemaJson(`{ "const": 9007199254740993 }`);
    // Sanity: a plain JSON.parse would collapse these to the same number.
    expect(JSON.parse(`9007199254740992`)).toBe(JSON.parse(`9007199254740993`));
    expect(schemasStructurallyEqual(canonical, android)).toBe(false);
  });

  test("identical large integers remain equal", () => {
    const a = parseSchemaJson(`{ "const": 9007199254740993 }`);
    const b = parseSchemaJson(`{ "const": 9007199254740993 }`);
    expect(schemasStructurallyEqual(a, b)).toBe(true);
  });

  test("safe integers and floats are left as plain numbers", () => {
    expect(parseSchemaJson(`{ "minItems": 1 }`)).toEqual({ minItems: 1 });
    expect(parseSchemaJson(`{ "x": 1.5 }`)).toEqual({ x: 1.5 });
    // A safe integer compared across two documents still behaves normally.
    expect(
      schemasStructurallyEqual(parseSchemaJson(`{ "n": 42 }`), parseSchemaJson(`{ "n": 42 }`)),
    ).toBe(true);
    expect(
      schemasStructurallyEqual(parseSchemaJson(`{ "n": 42 }`), parseSchemaJson(`{ "n": 43 }`)),
    ).toBe(false);
  });
});

// AC1: the on-disk Android copy must be resynced to the canonical schema.
describe("#5819 the two on-disk copies are in sync", () => {
  test("the canonical and Android copies are structurally identical", () => {
    const diffs = diffSchemaCopies();
    expect(diffs).toEqual([]);
  });

  test("the Android copy carries the `optional` step field (the drift called out in #5784)", () => {
    const android = readFileSync(ANDROID_SCHEMA_PATH, "utf8");
    // The `optional` best-effort step field was the concrete drift flagged in
    // the deferred item; assert it made it back into the Android copy.
    expect(android).toContain(`"optional"`);
    const parsed = JSON.parse(android) as { $defs?: Record<string, unknown> };
    // Structural spot-check: a $def that only exists in the canonical copy
    // before the resync must now be present in the Android copy too.
    expect(parsed.$defs).toBeDefined();
    expect(Object.keys(parsed.$defs ?? {})).toContain("highlightSelector");
  });

  test("both copies exist and parse as JSON", () => {
    expect(() => JSON.parse(readFileSync(CANONICAL_SCHEMA_PATH, "utf8"))).not.toThrow();
    expect(() => JSON.parse(readFileSync(ANDROID_SCHEMA_PATH, "utf8"))).not.toThrow();
  });
});

// AC2: the gate must actually run in CI. It is registered in the fast-validation
// aggregator and included in the required Fast Validation job's `--only` list.
describe("#5819 the drift gate is wired into CI", () => {
  const CHECK_NAME = "schema-copy-drift";

  test("all_fast_validate_checks.sh registers the schema-copy-drift check", () => {
    const aggregator = readFileSync(join(repoRoot, "scripts/all_fast_validate_checks.sh"), "utf8");
    expect(aggregator).toContain(`add_check "${CHECK_NAME}"`);
    expect(aggregator).toContain("scripts/check-schema-copy-drift.ts");
  });

  test("the required Fast Validation job runs the check in its --only list", () => {
    const steps = loadJobSteps(".github/workflows/pull_request.yml", "fast-validation");
    const runStep = stepNamed(steps, "Run fast validation checks");
    expect(runStep).toBeDefined();
    expect(runStep?.run ?? "").toContain(CHECK_NAME);
  });
});
