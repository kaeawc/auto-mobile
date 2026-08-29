import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `test-plan.schema.json` exists twice: the canonical copy under `schemas/`
 * (the source of truth every TypeScript-side validator and feature PR edits)
 * and a hand-maintained duplicate bundled as an Android classpath resource
 * under `android/test-plan-validation/src/main/resources/schemas/`, loaded at
 * runtime by `TestPlanValidator`/`TestPlanSchemaStore`. Nothing copies one from
 * the other, so they silently drift — by #5784 the Android copy had already
 * fallen behind (missing the `optional` step field and several `$defs`).
 *
 * This gate compares the two copies STRUCTURALLY (parse then deep-equal) rather
 * than byte-for-byte, so a purely cosmetic formatting difference is tolerated
 * while a real divergence — a missing field, a changed enum, an added `$def` —
 * fails CI (#5819). The Android tree is excluded from `oxfmt`, so the copies are
 * free to differ in whitespace; only their meaning must match.
 */

const repoRoot = join(import.meta.dir ?? ".", "..");

export const CANONICAL_SCHEMA_PATH = join(repoRoot, "schemas/test-plan.schema.json");
export const ANDROID_SCHEMA_PATH = join(
  repoRoot,
  "android/test-plan-validation/src/main/resources/schemas/test-plan.schema.json",
);

type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function isObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collect every structural difference between two parsed JSON documents as a
 * list of human-readable paths. Object keys are compared order-insensitively
 * (JSON objects are unordered), arrays element-wise in order (order is
 * significant in JSON Schema constructs like `allOf`/`anyOf`). An empty result
 * means the documents are structurally identical.
 */
export function structuralDiffPaths(
  canonical: JsonValue,
  android: JsonValue,
  path = "$",
): string[] {
  if (Array.isArray(canonical) && Array.isArray(android)) {
    if (canonical.length !== android.length) {
      return [
        `${path}: array length ${canonical.length} (canonical) vs ${android.length} (android)`,
      ];
    }
    const diffs: string[] = [];
    for (let i = 0; i < canonical.length; i++) {
      diffs.push(...structuralDiffPaths(canonical[i], android[i], `${path}[${i}]`));
    }
    return diffs;
  }

  if (isObject(canonical) && isObject(android)) {
    const diffs: string[] = [];
    const keys = new Set([...Object.keys(canonical), ...Object.keys(android)]);
    for (const key of [...keys].sort()) {
      const childPath = `${path}.${key}`;
      const inCanonical = Object.prototype.hasOwnProperty.call(canonical, key);
      const inAndroid = Object.prototype.hasOwnProperty.call(android, key);
      if (inCanonical && !inAndroid) {
        diffs.push(`${childPath}: present in canonical, missing from android`);
      } else if (!inCanonical && inAndroid) {
        diffs.push(`${childPath}: present in android, missing from canonical`);
      } else {
        diffs.push(...structuralDiffPaths(canonical[key], android[key], childPath));
      }
    }
    return diffs;
  }

  if (canonical !== android) {
    // Distinguish type mismatches from value mismatches only in the message.
    return [
      `${path}: ${JSON.stringify(canonical)} (canonical) vs ${JSON.stringify(android)} (android)`,
    ];
  }

  return [];
}

export function schemasStructurallyEqual(canonical: JsonValue, android: JsonValue): boolean {
  return structuralDiffPaths(canonical, android).length === 0;
}

// Integers beyond 2^53 lose precision as IEEE-754 doubles, so `JSON.parse`
// collapses distinct large-integer literals (e.g. a `const` or `enum` bound)
// to the same `number` — which would let a real divergence slip past the
// structural comparison. `JSON.parse`'s reviver `context.source` (TC39
// JSON-parse-with-source, supported by Bun's engine) hands back the original
// numeric token, so we preserve any unsafe integer as a NUL-tagged sentinel
// string: distinct tokens then compare unequal and identical ones compare
// equal, losslessly. Normal (safe) numbers and floats are left untouched, and
// on a runtime that does not expose `source` this degrades to plain parsing.
const BIGINT_SENTINEL_PREFIX = `${String.fromCharCode(0)}bigint:`;

export function parseSchemaJson(text: string): JsonValue {
  return JSON.parse(text, function (_key, value, context?: { source?: string }) {
    if (
      typeof value === "number" &&
      !Number.isSafeInteger(value) &&
      typeof context?.source === "string" &&
      /^-?\d+$/.test(context.source)
    ) {
      return `${BIGINT_SENTINEL_PREFIX}${context.source}`;
    }
    return value;
  }) as JsonValue;
}

function readJson(filePath: string): JsonValue {
  return parseSchemaJson(readFileSync(filePath, "utf8"));
}

/**
 * Compare the two on-disk copies. Returns the list of structural differences
 * (empty when they match). Throws if either file is missing or unparseable.
 */
export function diffSchemaCopies(
  canonicalPath: string = CANONICAL_SCHEMA_PATH,
  androidPath: string = ANDROID_SCHEMA_PATH,
): string[] {
  return structuralDiffPaths(readJson(canonicalPath), readJson(androidPath));
}

if (import.meta.main) {
  const [canonicalArg, androidArg] = process.argv.slice(2);
  const canonicalPath = canonicalArg ?? CANONICAL_SCHEMA_PATH;
  const androidPath = androidArg ?? ANDROID_SCHEMA_PATH;

  let diffs: string[];
  try {
    diffs = diffSchemaCopies(canonicalPath, androidPath);
  } catch (error) {
    console.error(
      `error: could not compare test-plan.schema.json copies (${canonicalPath} vs ${androidPath}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }

  if (diffs.length > 0) {
    console.error("error: the two copies of test-plan.schema.json have structurally diverged:");
    console.error(`  canonical: ${canonicalPath}`);
    console.error(`  android:   ${androidPath}`);
    for (const diff of diffs) {
      console.error(`  - ${diff}`);
    }
    console.error(
      "Resync the Android copy by replacing it with the canonical schema, then re-run this check.",
    );
    process.exit(1);
  }

  console.log(
    "schema-copy-drift: the two test-plan.schema.json copies are structurally identical.",
  );
}
