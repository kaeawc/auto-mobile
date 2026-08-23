/**
 * Reusable measurement harness for the MCP output-context reduction effort
 * (issue #2755). Later reduction issues import these helpers to quantify a
 * change against the fixed baseline instead of re-implementing the math.
 *
 * The reduction effort exists because an observe result exceeds the MCP
 * tool-output *token* cap, so token count — not just bytes — is the quantity
 * the constraint is enforced in. `measureObserveBreakdown` reports both, using
 * the same cl100k_base tokenizer the rest of the repo's context tooling uses
 * (see scripts/estimate-context-usage.ts) so numbers line up across tools.
 *
 * Baseline fixture: `android-home.json` — a real Android home-screen `observe`
 * result captured from an emulator (Medium_Phone_API_35, sdk 35) with
 * performance auditing enabled. Regenerate with the `observe` MCP tool (or
 * `homeScreen`, unwrapping `.observation`) against an Android home screen and
 * re-commit the pretty-printed JSON. It is meant to be a frozen baseline, so
 * only refresh it deliberately when the observe output format changes.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import { stringifyToolResponse } from "../../../src/utils/toolUtils";

const tokenizer = new Tiktoken(cl100k_base);

/** Absolute path to the committed baseline home-screen observe fixture. */
export const ANDROID_HOME_FIXTURE_PATH = join(import.meta.dir, "android-home.json");

/** Load the baseline fixture as raw text and a parsed `ObserveResult`. */
export function loadAndroidHomeObserve(): { raw: string; observe: ObserveResult } {
  const raw = readFileSync(ANDROID_HOME_FIXTURE_PATH, "utf8");
  return { raw, observe: JSON.parse(raw) as ObserveResult };
}

/**
 * iOS observe fixture with fractional point coordinates (issue #3206).
 *
 * No real iOS capture exists in-tree, so this is a HAND-BUILT representative —
 * not a device capture. It mirrors the shape
 * `CtrlProxyHierarchy.convertToViewHierarchyResult` produces (root
 * `hierarchy.bounds` with optional left/top in points,
 * `screenScale`/`screenWidth`/`screenHeight`, XCUIElement class names) and
 * carries the fractional values the iOS points coordinate space legitimately
 * produces (thirds from @3x retina, `.5` sub-point layout). It pins that the
 * advertised output schemas never claim `integer` for a points-based
 * coordinate. Replace with a real simulator capture when one is taken (needs
 * hardware; see issue #3206 verification notes).
 */
export const IOS_FRACTIONAL_FIXTURE_PATH = join(import.meta.dir, "ios-fractional-bounds.json");

/** Load the iOS fractional-bounds fixture as a parsed `ObserveResult`. */
export function loadIosFractionalObserve(): ObserveResult {
  return JSON.parse(readFileSync(IOS_FRACTIONAL_FIXTURE_PATH, "utf8")) as ObserveResult;
}

/**
 * Representative iOS Reminders observe pair for XCTest/UIKit structural-noise
 * cleanup (#3317). The `before` fixture preserves duplicated UIKit/XCTest noise
 * around Reminders rows, toolbar buttons, scroll bars, and keyboard accessory
 * controls; the `after` fixture is the same hierarchy after CtrlProxy cleanup.
 */
export const IOS_REMINDERS_NOISE_BEFORE_FIXTURE_PATH = join(
  import.meta.dir,
  "ios-reminders-xctest-noise-before.json",
);
export const IOS_REMINDERS_NOISE_AFTER_FIXTURE_PATH = join(
  import.meta.dir,
  "ios-reminders-xctest-noise-after.json",
);

/** Load the Reminders XCTest/UIKit noise before/after pair for #3317 size tests. */
export function loadIosRemindersNoiseObservePair(): {
  before: ObserveResult;
  after: ObserveResult;
} {
  return {
    before: JSON.parse(
      readFileSync(IOS_REMINDERS_NOISE_BEFORE_FIXTURE_PATH, "utf8"),
    ) as ObserveResult,
    after: JSON.parse(
      readFileSync(IOS_REMINDERS_NOISE_AFTER_FIXTURE_PATH, "utf8"),
    ) as ObserveResult,
  };
}

/**
 * Excerpt from a real Android uiautomator hierarchy capture of the Playground
 * app. It intentionally preserves the Android direct-attribute runtime shape
 * that reaches output trimming before `cleanNodeProperties` removes default
 * values: default-false booleans, default-true `enabled`, and empty strings.
 * Each node still includes an empty `$` bag so it remains compatible with the
 * declared `ViewHierarchyNode` contract.
 */
export const ANDROID_RAW_TRIM_CANDIDATES_FIXTURE_PATH = join(
  import.meta.dir,
  "android-playground-raw-trim-candidates.json",
);

/** Load the raw Android trim-candidate fixture as a parsed `ObserveResult`. */
export function loadAndroidRawTrimCandidatesObserve(): ObserveResult {
  return JSON.parse(
    readFileSync(ANDROID_RAW_TRIM_CANDIDATES_FIXTURE_PATH, "utf8"),
  ) as ObserveResult;
}

/**
 * Real-device before/after observation pairs captured for the `--actions-diff-observe`
 * sign-off (issue #3051; see
 * `docs/design-docs/plat/android/actions-diff-observe-signoff.md`). Each file is a
 * genuine emulator capture of the AutoMobile Playground app, in the *post-sanitize*
 * form `finalizeToolResponse` diffs (`sanitizeObserveResult(obs, {dropElements:true})`),
 * with diff-irrelevant heavy fields (`elements`, `performanceAudit`, `perfTiming`,
 * `backStack`) removed to keep the fixtures lean — the diff reads none of them, so
 * their absence cannot change any diff outcome. Load a pair and feed directly to
 * `diffObserveResult` (no re-sanitize needed).
 */
export const DIFF_FIXTURE_DIR = join(import.meta.dir, "diff");

/** Parse one committed diff-sign-off fixture into an `ObserveResult`. */
export function loadDiffFixture(name: string): ObserveResult {
  return JSON.parse(readFileSync(join(DIFF_FIXTURE_DIR, `${name}.json`), "utf8")) as ObserveResult;
}

/** UTF-8 byte length and cl100k_base token count of a value serialized exactly
 *  the way the observe tool emits it: `stringifyToolResponse` — compact
 *  (non-pretty) JSON with `extras` keys stripped, the production formatter used by
 *  `createStructuredToolResponse` in src/utils/toolUtils.ts (compact serialization
 *  is now an unconditional default). Measuring the real formatter is what makes a
 *  reduction test's "does this fit under the cap?" check trustworthy. */
export function measureValue(value: unknown): { bytes: number; tokens: number } {
  const serialized = stringifyToolResponse(value) ?? "";
  return {
    bytes: Buffer.byteLength(serialized, "utf8"),
    tokens: tokenizer.encode(serialized).length,
  };
}

export interface FieldMeasurement {
  key: string;
  bytes: number;
  tokens: number;
}

export interface ObserveBreakdown {
  totalBytes: number;
  totalTokens: number;
  /** Top-level fields, largest first (by bytes). */
  fields: FieldMeasurement[];
  /** viewHierarchy sub-keys, largest first (by bytes). Empty when absent. */
  viewHierarchy: FieldMeasurement[];
}

function breakdownOf(obj: Record<string, unknown> | undefined): FieldMeasurement[] {
  if (!obj || typeof obj !== "object") {
    return [];
  }
  return Object.entries(obj)
    .map(([key, value]) => ({ key, ...measureValue(value) }))
    .sort((a, b) => b.bytes - a.bytes);
}

/**
 * Byte + token breakdown of an observe result by top-level field and by
 * viewHierarchy sub-key. Mirrors what `scripts/observe-byte-breakdown.sh`
 * prints, but returns structured data (with tokens) that unit tests can assert.
 */
export function measureObserveBreakdown(observe: ObserveResult): ObserveBreakdown {
  const total = measureValue(observe);
  const viewHierarchy = (observe as { viewHierarchy?: Record<string, unknown> }).viewHierarchy;
  return {
    totalBytes: total.bytes,
    totalTokens: total.tokens,
    fields: breakdownOf(observe as unknown as Record<string, unknown>),
    viewHierarchy: breakdownOf(viewHierarchy),
  };
}
