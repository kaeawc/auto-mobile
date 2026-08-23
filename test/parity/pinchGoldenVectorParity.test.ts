/**
 * Drift guard for the cross-platform pinch golden vectors (issue #2997).
 *
 * Before this guard, the Android and iOS golden-vector tables were hand-duplicated and kept in
 * sync only by a comment. That caught the *common* regression (edit one platform's math without
 * updating its own literals -> that platform's assertion fails) but NOT a *coordinated one-sided
 * edit* (change one platform's math AND its golden literals): the other platform kept its stale
 * math + stale literals and both suites stayed green while the runners diverged in production.
 *
 * These tests establish a single source of truth — `test/fixtures/pinch-golden-vectors.json` — and
 * assert that BOTH platforms' committed literals match it. A coordinated one-sided edit now leaves
 * the untouched platform's literals disagreeing with the JSON, failing here regardless of which
 * side was changed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import {
  assertNoStringLiterals,
  diffGoldenTables,
  KOTLIN_TEST_PATH,
  loadCanonicalVectors,
  parseKotlinGoldenTable,
  parseSwiftGoldenTable,
  referencePinchEndpoints,
  SWIFT_TEST_PATH,
  type GoldenVector,
} from "./pinchGoldenVectors";

describe("pinch golden vector parity (issue #2997)", function () {
  const canonical = loadCanonicalVectors();
  const swift = parseSwiftGoldenTable();
  const kotlin = parseKotlinGoldenTable();

  test("canonical JSON exposes the full golden table", function () {
    // Parsing succeeded and the fixture is non-trivial. Guards against an empty/renamed fixture
    // silently making every parity assertion vacuous.
    expect(canonical.length).toBeGreaterThanOrEqual(5);
    for (const row of canonical) {
      expect(row.expected.length).toBe(4);
    }
  });

  test("both platform tables parse to the same number of rows as the source", function () {
    // If a platform table drops or gains rows relative to the canonical source, the parser row
    // count diverges — a coarse but decisive first-line check.
    expect(swift.length).toBe(canonical.length);
    expect(kotlin.length).toBe(canonical.length);
  });

  test("AC1: iOS golden literals are verified against the single source", function () {
    const diffs = diffGoldenTables(swift, canonical);
    expect(diffs).toEqual([]);
  });

  test("AC1: Android golden literals are verified against the single source", function () {
    const diffs = diffGoldenTables(kotlin, canonical);
    expect(diffs).toEqual([]);
  });

  test("transitively, the two platform tables agree with each other", function () {
    expect(diffGoldenTables(swift, kotlin)).toEqual([]);
  });

  test("AC2: a coordinated one-sided convention edit is detected", function () {
    // Simulate the exact failure mode the issue targets: someone changes ONE platform's endpoint
    // math and updates ONLY that platform's golden literals (here modeled as a mutation to the
    // parsed Swift table). The untouched canonical source no longer matches, so the guard trips.
    const tampered: GoldenVector[] = swift.map((row) => ({ ...row, expected: [...row.expected] }));
    // Nudge one endpoint of the first row well past tolerance — a plausible "flipped rotation
    // sign" / "swapped sin & cos" convention drift.
    tampered[0] = {
      ...tampered[0],
      expected: [
        [tampered[0].expected[0][0] + 5, tampered[0].expected[0][1] - 5],
        ...tampered[0].expected.slice(1),
      ],
    };

    const diffs = diffGoldenTables(tampered, canonical);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.some((d) => d.includes("row 0 point"))).toBe(true);
  });

  test("AC2: an input-tuple divergence is also detected", function () {
    // The other half of a one-sided edit: changing an input row (e.g. a different rotationDegrees)
    // on one platform only. The set-based point comparison must not mask an input mismatch.
    const tampered: GoldenVector[] = kotlin.map((row) => ({ ...row }));
    tampered[1] = { ...tampered[1], rotationDegrees: tampered[1].rotationDegrees + 15 };

    const diffs = diffGoldenTables(tampered, canonical);
    expect(diffs.some((d) => d.includes("rotationDegrees"))).toBe(true);
  });

  test("the per-platform math<->literals runtime golden loops still exist", function () {
    // This guard only proves literals <-> JSON. The other half of the parity chain — that each
    // platform's endpoint MATH is asserted against those literals — lives in the runtime golden
    // loops of the platform test files (`computePinchPoints`/`ObjCExceptionCatcher_computePinchPoints`
    // driving `assertEquals`/`XCTAssertEqual`). If someone deleted those loops but kept the literal
    // tables, this guard would still pass and the math could silently drift. Assert the
    // assertion-driving symbols are present so the math<->literals half cannot be quietly neutered.
    const swiftSource = readFileSync(SWIFT_TEST_PATH, "utf8");
    const kotlinSource = readFileSync(KOTLIN_TEST_PATH, "utf8");
    expect(swiftSource).toContain("ObjCExceptionCatcher_computePinchPoints(");
    expect(swiftSource).toContain("XCTAssertEqual");
    expect(kotlinSource).toContain("computePinchPoints(");
    expect(kotlinSource).toContain("assertEquals");
  });

  test("Item 1 (#3021): every canonical row's expected endpoints are DERIVABLE from its inputs", function () {
    // Makes the JSON a derived source, not a third hand-copy: recompute each row's four endpoints
    // from (center, distances, rotation) via the reference port of the platform math and assert they
    // match the committed `expected` set (order-independent, same tolerance as the runtime loops).
    for (let i = 0; i < canonical.length; i++) {
      const row = canonical[i];
      const computed = referencePinchEndpoints(
        row.centerX,
        row.centerY,
        row.distanceStart,
        row.distanceEnd,
        row.rotationDegrees,
      );
      const diffs = diffGoldenTables([{ ...row, expected: computed }], [row]);
      expect(diffs).toEqual([]);
    }
  });

  test("Item 1 (#3021): the reference math catches a corrupted expected value in the source", function () {
    // Negative control: if a row's expected endpoint were mis-typed, the derivation check must trip.
    const row = canonical[0];
    const computed = referencePinchEndpoints(
      row.centerX,
      row.centerY,
      row.distanceStart,
      row.distanceEnd,
      row.rotationDegrees,
    );
    const corrupted: GoldenVector = {
      ...row,
      expected: [
        [row.expected[0][0] + 7, row.expected[0][1]],
        ...row.expected.slice(1),
      ] as GoldenVector["expected"],
    };
    expect(diffGoldenTables([{ ...row, expected: computed }], [corrupted]).length).toBeGreaterThan(
      0,
    );
  });

  test("Item 2 (#3021): current platform golden regions contain no string literals", function () {
    // The live guard: parsing already runs assertNoStringLiterals; assert it passes for today's
    // tables (both parsed above without throwing) and that the checker is wired.
    expect(swift.length).toBeGreaterThan(0);
    expect(kotlin.length).toBeGreaterThan(0);
  });

  test("Item 2 (#3021): a string literal inside the table region fails loudly", function () {
    // A digit-bearing inline label like `"row 1"` inside the literal would corrupt positional number
    // extraction; the checker must throw a targeted error rather than silently mis-parse.
    expect(() => assertNoStringLiterals('60, 200, "row 1", 140', "fake.kt")).toThrow(
      /string-literal delimiter/,
    );
    // A clean numeric region passes.
    expect(() => assertNoStringLiterals("60, 200, 140, 200", "fake.kt")).not.toThrow();
  });

  test("the guard ignores finger-label ordering differences (no false drift)", function () {
    // The two runners label which finger is "first" oppositely. Reversing a row's point order must
    // NOT register as drift, or the guard would flag a cosmetic, semantically-identical change.
    const reordered: GoldenVector[] = canonical.map((row) => ({
      ...row,
      expected: [...row.expected].reverse() as GoldenVector["expected"],
    }));
    expect(diffGoldenTables(reordered, canonical)).toEqual([]);
  });
});
