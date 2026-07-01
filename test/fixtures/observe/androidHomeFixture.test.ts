import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import type { ObserveResult } from "../../../src/models/ObserveResult";

/**
 * Baseline fixture for the MCP output-context reduction effort (issue #2755).
 *
 * `android-home-66k.json` is a real `observe` result captured from an Android
 * home screen. It is the fixed baseline every later reduction is measured
 * against, so these tests guard that it stays a valid, complete observe result
 * that later unit tests can import.
 */
describe("android-home observe baseline fixture", () => {
  const fixturePath = join(import.meta.dir, "android-home-66k.json");
  const raw = readFileSync(fixturePath, "utf8");

  test("is valid JSON importable by unit tests", () => {
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test("is a large home-screen observe result that exceeds the inline cap", () => {
    // The whole point of the baseline is that it is big enough to spill to a
    // file instead of returning inline. Guard against accidental shrinkage.
    expect(raw.length).toBeGreaterThan(40_000);
  });

  test("parses into an ObserveResult with the fields the reduction targets", () => {
    const observe = JSON.parse(raw) as ObserveResult;

    // Structural fields that must always be present on an observe result.
    expect(observe.screenSize).toBeDefined();
    expect(observe.systemInsets).toBeDefined();
    expect(observe.viewHierarchy).toBeDefined();
    expect(observe.viewHierarchy?.hierarchy).toBeDefined();

    // The three heavy fields the reduction effort will trim.
    expect(observe.elements).toBeDefined();
    expect(observe.performanceAudit).toBeDefined();
    expect(observe.perfTiming).toBeDefined();
  });

  test("embeds the gfxinfo dump twice — the documented duplication", () => {
    const observe = JSON.parse(raw) as ObserveResult;
    const gfxinfoRaw = observe.performanceAudit?.metrics.gfxinfoRaw;
    const diagnostics = observe.performanceAudit?.diagnostics;

    expect(typeof gfxinfoRaw).toBe("string");
    expect(gfxinfoRaw!.length).toBeGreaterThan(0);
    // The raw dump is also inlined inside the diagnostics string.
    expect(diagnostics).toContain(gfxinfoRaw!);
  });
});
