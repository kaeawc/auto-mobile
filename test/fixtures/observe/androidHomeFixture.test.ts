import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import { loadAndroidHomeObserve, measureObserveBreakdown, measureValue } from "./observeFixture";

/**
 * Baseline fixture for the MCP output-context reduction effort (issue #2755).
 *
 * `android-home.json` is a real `observe` result captured from an Android home
 * screen. It is the fixed baseline every later reduction is measured against,
 * so these tests guard that it stays a valid, complete observe result that
 * later unit tests can import — and pin the canonical baseline numbers (bytes
 * AND tokens) so a silent shrink or format change is caught.
 *
 * Canonical baseline, measured with the production formatter the observe tool
 * actually emits (`stringifyToolResponse`: pretty-printed, `extras` stripped):
 * ~84.5k bytes / ~21.9k tokens. The reduction exists because that exceeds the
 * MCP tool-output token cap. (The 66,560-char figure in the issue was an
 * illustrative earlier sample; this committed capture is the authoritative
 * baseline.)
 */
describe("android-home observe baseline fixture", () => {
  const { raw, observe } = loadAndroidHomeObserve();

  test("is valid JSON importable by unit tests", () => {
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test("is a large home-screen observe result that exceeds the inline cap", () => {
    const { bytes, tokens } = measureValue(observe);
    // The whole point of the baseline is that it is big enough to spill to a
    // file instead of returning inline. Guard against accidental shrinkage.
    expect(bytes).toBeGreaterThan(40_000);
    // Token count is the quantity the MCP output cap is actually enforced in.
    // The production formatter puts the fixture at ~21.9k tokens.
    expect(tokens).toBeGreaterThan(15_000);
  });

  test("parses into an ObserveResult with the fields the reduction targets", () => {
    const parsed = observe as ObserveResult;

    // Structural fields that must always be present on an observe result.
    expect(parsed.screenSize).toBeDefined();
    expect(parsed.systemInsets).toBeDefined();
    expect(parsed.viewHierarchy).toBeDefined();
    expect(parsed.viewHierarchy?.hierarchy).toBeDefined();

    // The three heavy fields the reduction effort will trim.
    expect(parsed.elements).toBeDefined();
    expect(parsed.performanceAudit).toBeDefined();
    expect(parsed.perfTiming).toBeDefined();
  });

  test("embeds the gfxinfo dump twice — the documented duplication", () => {
    const gfxinfoRaw = observe.performanceAudit?.metrics.gfxinfoRaw;
    const diagnostics = observe.performanceAudit?.diagnostics;

    expect(typeof gfxinfoRaw).toBe("string");
    expect(gfxinfoRaw!.length).toBeGreaterThan(0);
    // The raw dump is also inlined inside the diagnostics string.
    expect(diagnostics).toContain(gfxinfoRaw!);
  });

  test("breakdown reports bytes and tokens per field, largest first", () => {
    const breakdown = measureObserveBreakdown(observe);

    expect(breakdown.totalBytes).toBeGreaterThan(40_000);
    expect(breakdown.totalTokens).toBeGreaterThan(15_000);

    // Fields are sorted by descending bytes.
    for (let i = 1; i < breakdown.fields.length; i++) {
      expect(breakdown.fields[i - 1].bytes).toBeGreaterThanOrEqual(breakdown.fields[i].bytes);
    }

    // Every field carries a token count (the reduction's real target metric).
    for (const field of breakdown.fields) {
      expect(field.tokens).toBeGreaterThanOrEqual(0);
    }

    // The three heavy fields dominate the top of the breakdown.
    const heavy = new Set(breakdown.fields.slice(0, 3).map((f) => f.key));
    expect(heavy.has("performanceAudit")).toBe(true);
    expect(heavy.has("elements")).toBe(true);
    expect(heavy.has("viewHierarchy")).toBe(true);

    // viewHierarchy sub-keys are broken out and dominated by the raw hierarchy.
    expect(breakdown.viewHierarchy.length).toBeGreaterThan(0);
    expect(breakdown.viewHierarchy[0].key).toBe("hierarchy");
  });
});
