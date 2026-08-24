/**
 * Single-source drift-guard helpers for the cross-platform pinch golden vectors (issue #2997).
 *
 * The Android (`PinchGeometryTest.kt`) and iOS (`PinchGeometryTests.swift`) runners each pin the
 * two-finger pinch endpoint geometry with an inline golden-vector table. Historically those two
 * tables were hand-duplicated and kept in sync only by a cross-reference comment, so a
 * *coordinated one-sided edit* (change one platform's math AND its golden literals) could leave the
 * runners diverging in production while both test suites stayed green.
 *
 * This module closes that gap by parsing both platforms' committed literals out of source and
 * verifying them against the canonical single source, `test/fixtures/pinch-golden-vectors.json`.
 * It is deliberately build-system-agnostic — it reads the test files as plain text, so it needs no
 * SPM / xcodegen / Gradle resource wiring and runs offline under `bun test` in well under 100ms.
 */
import { readFileSync } from "fs";
import { join } from "path";

/** Repo root, relative to this file (`test/parity/pinchGoldenVectors.ts`). */
export const REPO_ROOT = join(import.meta.dir, "..", "..");

export const CANONICAL_JSON_PATH = join(REPO_ROOT, "test", "fixtures", "pinch-golden-vectors.json");
export const SWIFT_TEST_PATH = join(
  REPO_ROOT,
  "ios",
  "control-proxy",
  "Tests",
  "CtrlProxyTests",
  "PinchGeometryTests.swift",
);
export const KOTLIN_TEST_PATH = join(
  REPO_ROOT,
  "android",
  "control-proxy",
  "src",
  "test",
  "kotlin",
  "dev",
  "jasonpearson",
  "automobile",
  "ctrlproxy",
  "PinchGeometryTest.kt",
);

/** One golden row: five inputs plus the expected *unordered* set of four endpoints. */
export interface GoldenVector {
  centerX: number;
  centerY: number;
  distanceStart: number;
  distanceEnd: number;
  rotationDegrees: number;
  expected: Array<[number, number]>;
}

/** 5 scalar inputs + 4 endpoints × 2 coords. Every golden row has exactly this shape. */
const NUMBERS_PER_ROW = 13;

// Strip block and line comments so digits inside them never leak into number extraction. (Written
// as line comments so the delimiter tokens below can be described without closing this comment.)
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Assert the carved-out golden-table region contains no string-literal delimiters (Item 2, issue
 * #3021). Today no string literal exists inside either platform's `let vectors` / `listOf(...)`
 * region — assertion-message strings live OUTSIDE it. A future edit that placed a digit-bearing
 * string literal inside the region (e.g. an inline label like `"row 1"`) could corrupt number
 * extraction. The `NUMBERS_PER_ROW` alignment check usually fails closed, but a label with the
 * "right" number of digits could slip through and silently mis-parse. Rather than attempt correct
 * language-aware string stripping (Swift interpolation `\( )`, Kotlin `$`, escapes — brittle to get
 * right for two languages), fail LOUDLY with a targeted message so the ambiguity is fixed at the
 * source. Comments have already been stripped, so a `"` here is genuinely inside the literal.
 */
export function assertNoStringLiterals(region: string, label: string): void {
  const quote = region.match(/["']/);
  if (quote) {
    throw new Error(
      `${label}: golden-table region contains a string-literal delimiter (${quote[0]}) at index ` +
        `${quote.index}. The parser extracts numbers positionally and cannot safely handle string ` +
        `literals inside the table; move any label/message strings outside the 'vectors' literal.`,
    );
  }
}

/**
 * Return the balanced substring that starts at the first `open` delimiter at or after `fromIndex`
 * and ends at its matching `close` delimiter (inclusive). Used to carve out just the golden table
 * literal from a larger test function body.
 */
function extractBalanced(source: string, fromIndex: number, open: string, close: string): string {
  const start = source.indexOf(open, fromIndex);
  if (start < 0) {
    throw new Error(`could not find '${open}' after index ${fromIndex}`);
  }
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === open) {
      depth++;
    } else if (source[i] === close) {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`unbalanced '${open}${close}' starting at index ${start}`);
}

/** Every numeric literal in `source`, in order. Handles plain integers and decimals, negatives,
 *  and trailing type suffixes (`0f` -> `0`, `433.9f` -> `433.9`), which is every form the golden
 *  tables use. Exotic forms the tables never contain (exponent `2e2`, underscore `6_0`, hex
 *  `0x10`) are deliberately NOT parsed specially: they split into extra tokens and trip the
 *  per-row alignment check in `rowsFromNumbers` (or a sibling suite's chunker), which fails
 *  closed rather than silently mis-parsing. Exported for the coordinate-mapping golden-vector
 *  suite (issue #4547), which reuses this exact parsing pipeline for its own tables. */
export function extractNumbers(source: string): number[] {
  const matches = source.match(/-?\d+(?:\.\d+)?/g) ?? [];
  return matches.map(Number);
}

/**
 * Shared front half of the golden-table parsing pipeline: read a platform test file, strip
 * comments, carve out the balanced table literal after `assignmentMarker`, and assert it contains
 * no string literals. Returns the raw table region text; callers extract and chunk the numbers
 * according to their own row shapes. Extracted so the coordinate-mapping golden-vector suite
 * (issue #4547) reuses the exact same drift-guard mechanics as the pinch suite.
 */
export function extractNumericTableRegion(
  filePath: string,
  assignmentMarker: string,
  open: string,
  close: string,
): string {
  // Strip comments BEFORE the balanced-delimiter scan so a stray `[`/`]`/`(`/`)` inside a comment
  // between the marker and the literal (or within it) can never mis-terminate the walk.
  const source = stripComments(readFileSync(filePath, "utf8"));
  const markerIndex = source.indexOf(assignmentMarker);
  if (markerIndex < 0) {
    throw new Error(`marker '${assignmentMarker}' not found in ${filePath}`);
  }
  // Start after the marker so a type annotation in the marker (e.g. Swift's `[Vector]`) is not
  // mistaken for the opening delimiter of the literal.
  const region = extractBalanced(source, markerIndex + assignmentMarker.length, open, close);
  // Fail loudly if a string literal ever appears inside the table region so a digit-bearing label
  // can never silently corrupt positional number extraction (Item 2, issue #3021).
  assertNoStringLiterals(region, filePath);
  return region;
}

/** Chunk a flat number sequence into golden rows, asserting a clean multiple of the row width. */
function rowsFromNumbers(numbers: number[], label: string): GoldenVector[] {
  if (numbers.length === 0 || numbers.length % NUMBERS_PER_ROW !== 0) {
    throw new Error(
      `${label}: expected a positive multiple of ${NUMBERS_PER_ROW} numbers, got ${numbers.length}`,
    );
  }
  const rows: GoldenVector[] = [];
  for (let i = 0; i < numbers.length; i += NUMBERS_PER_ROW) {
    const [cx, cy, ds, de, rot, ...pts] = numbers.slice(i, i + NUMBERS_PER_ROW);
    rows.push({
      centerX: cx,
      centerY: cy,
      distanceStart: ds,
      distanceEnd: de,
      rotationDegrees: rot,
      expected: [
        [pts[0], pts[1]],
        [pts[2], pts[3]],
        [pts[4], pts[5]],
        [pts[6], pts[7]],
      ],
    });
  }
  return rows;
}

/**
 * Parse the golden table out of a platform test file. `assignmentMarker` anchors the search to the
 * table (e.g. `let vectors` / `val vectors`); `open`/`close` are the array delimiters that platform
 * uses (`[` `]` for Swift, `(` `)` for Kotlin's `listOf`).
 */
export function parseGoldenTable(
  filePath: string,
  assignmentMarker: string,
  open: string,
  close: string,
): GoldenVector[] {
  const region = extractNumericTableRegion(filePath, assignmentMarker, open, close);
  const numbers = extractNumbers(region);
  return rowsFromNumbers(numbers, filePath);
}

export function parseSwiftGoldenTable(): GoldenVector[] {
  // Anchor past the `[Vector]` type annotation to the `= [ ... ]` literal.
  return parseGoldenTable(SWIFT_TEST_PATH, "let vectors: [Vector] =", "[", "]");
}

export function parseKotlinGoldenTable(): GoldenVector[] {
  // `val vectors =` is followed by the `listOf( ... )` literal.
  return parseGoldenTable(KOTLIN_TEST_PATH, "val vectors =", "(", ")");
}

export function loadCanonicalVectors(): GoldenVector[] {
  const parsed = JSON.parse(readFileSync(CANONICAL_JSON_PATH, "utf8")) as {
    vectors: GoldenVector[];
  };
  if (!Array.isArray(parsed.vectors) || parsed.vectors.length === 0) {
    throw new Error(`${CANONICAL_JSON_PATH}: missing non-empty "vectors" array`);
  }
  return parsed.vectors;
}

/**
 * Reference TypeScript port of the pinch endpoint geometry (Item 1, issue #3021). Mirrors, opcode
 * for opcode, `PinchGeometry.kt` `computePinchPoints` (Android) and `computePinchPoints` (iOS): the
 * two fingers sit on a diameter through the center — one at `angle`, the other at `angle + PI`. The
 * start axis is horizontal (angle 0); the end axis is rotated by `rotationDegrees`. Radius is half
 * the finger distance.
 *
 * This turns the canonical JSON from a THIRD hand-maintained copy into a genuinely *derived* source:
 * a test recomputes every row's `expected` endpoints from its inputs and asserts they match, so a
 * bad hand-edit to the JSON's expected values is caught at the root (not just cross-checked against
 * two equally-hand-maintained platform tables). The platform inline tables remain verified-against
 * the JSON (they keep their hand-authored design-rationale comments; regenerating them in place
 * would be lossy — see issue #3021 Item 1 discussion).
 */
export function referencePinchEndpoints(
  centerX: number,
  centerY: number,
  distanceStart: number,
  distanceEnd: number,
  rotationDegrees: number,
): Array<[number, number]> {
  const startRadius = distanceStart / 2;
  const endRadius = distanceEnd / 2;
  const startAngle = 0;
  const endAngle = (rotationDegrees * Math.PI) / 180;
  const pointAt = (radius: number, angleRad: number): [number, number] => [
    centerX + radius * Math.cos(angleRad),
    centerY + radius * Math.sin(angleRad),
  ];
  return [
    pointAt(startRadius, startAngle),
    pointAt(startRadius, Math.PI + startAngle),
    pointAt(endRadius, endAngle),
    pointAt(endRadius, Math.PI + endAngle),
  ];
}

/** Deterministic order-independent point sort — mirrors the Swift/Kotlin `sortedPoints` helpers so
 *  the parity comparison ignores which finger each runner labels "first". */
function sortPoints(points: Array<[number, number]>): Array<[number, number]> {
  return [...points].sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
}

/**
 * Compare two golden tables and return human-readable mismatch strings (empty array === identical).
 * Inputs are matched in order; the four expected endpoints are matched as an order-independent set
 * (same semantics the runtime assertions use). This is the drift detector: feed it a table with a
 * one-sided edit and it reports exactly what diverged.
 */
export function diffGoldenTables(
  actual: GoldenVector[],
  expected: GoldenVector[],
  tolerance = 1e-3,
): string[] {
  const diffs: string[] = [];
  if (actual.length !== expected.length) {
    diffs.push(`row count ${actual.length} !== ${expected.length}`);
    return diffs;
  }
  const near = (a: number, b: number) => Math.abs(a - b) <= tolerance;
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i];
    const e = expected[i];
    for (const key of [
      "centerX",
      "centerY",
      "distanceStart",
      "distanceEnd",
      "rotationDegrees",
    ] as const) {
      if (!near(a[key], e[key])) {
        diffs.push(`row ${i} input ${key}: ${a[key]} !== ${e[key]}`);
      }
    }
    const ap = sortPoints(a.expected);
    const ep = sortPoints(e.expected);
    for (let j = 0; j < ep.length; j++) {
      if (!near(ap[j][0], ep[j][0]) || !near(ap[j][1], ep[j][1])) {
        diffs.push(`row ${i} point ${j}: (${ap[j]}) !== (${ep[j]})`);
      }
    }
  }
  return diffs;
}
