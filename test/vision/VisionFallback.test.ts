import { beforeEach, describe, expect, test } from "bun:test";
import { VisionFallback } from "../../src/vision/VisionFallback";
import type {
  VisionFallbackConfig,
  VisionFallbackResult,
  ElementSearchCriteria,
} from "../../src/vision/VisionTypes";
import { FakeTimer } from "../fakes/FakeTimer";

// VisionFallback constructs a ClaudeVisionClient internally (provider "claude"),
// whose Anthropic client needs *some* key at construction. A dummy is fine — we
// override the client with a counting stub before any call, so no request is
// ever made.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key-not-used";

const config = (overrides: Partial<VisionFallbackConfig> = {}): VisionFallbackConfig => ({
  enabled: true,
  provider: "claude",
  confidenceThreshold: "high",
  maxCostUsd: 1.0,
  cacheResults: true,
  cacheTtlMinutes: 60,
  ...overrides,
});

const result = (overrides: Partial<VisionFallbackResult> = {}): VisionFallbackResult => ({
  found: true,
  confidence: "high",
  costUsd: 0.02,
  durationMs: 100,
  screenshotPath: "/s.png",
  provider: "claude",
  ...overrides,
});

const criteria = (text: string): ElementSearchCriteria => ({ text });
const HIERARCHY = {} as any;

/**
 * Replace the internal Claude client with a stub that counts calls and returns
 * a fixed result, so we exercise the orchestrator's cache/cost logic without a
 * network call. Returns a getter for the call count.
 */
function stubAnalyzer(fallback: VisionFallback, canned: VisionFallbackResult): () => number {
  let calls = 0;
  (fallback as any).claudeClient = {
    analyzeUIElement: async () => {
      calls += 1;
      return canned;
    },
  };
  return () => calls;
}

describe("VisionFallback orchestrator", () => {
  let timer: FakeTimer;

  beforeEach(() => {
    timer = new FakeTimer();
  });

  test("throws when vision fallback is disabled", async () => {
    const fb = new VisionFallback(config({ enabled: false }), timer);
    await expect(
      fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"))
    ).rejects.toThrow(/not enabled/);
  });

  test("caches a result: an identical query hits the analyzer only once", async () => {
    const fb = new VisionFallback(config(), timer);
    const count = stubAnalyzer(fb, result());

    const first = await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    const second = await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));

    expect(count()).toBe(1);
    expect(second).toEqual(first);
    expect(fb.getCacheStats().size).toBe(1);
  });

  test("re-analyzes after the cache entry passes cacheTtlMinutes", async () => {
    const fb = new VisionFallback(config({ cacheTtlMinutes: 60 }), timer);
    const count = stubAnalyzer(fb, result());

    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    // Just under the TTL: still cached.
    timer.advanceTime(59 * 60 * 1000);
    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    expect(count()).toBe(1);

    // Past the TTL: the stale entry is evicted and the analyzer runs again.
    timer.advanceTime(2 * 60 * 1000);
    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    expect(count()).toBe(2);
  });

  test("caches distinct search criteria separately", async () => {
    const fb = new VisionFallback(config(), timer);
    const count = stubAnalyzer(fb, result());

    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Signup"));
    expect(count()).toBe(2);
    expect(fb.getCacheStats().size).toBe(2);

    // Repeating the first is still a cache hit.
    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    expect(count()).toBe(2);
  });

  test("clearCache forces re-analysis", async () => {
    const fb = new VisionFallback(config(), timer);
    const count = stubAnalyzer(fb, result());

    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    fb.clearCache();
    expect(fb.getCacheStats().size).toBe(0);
    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    expect(count()).toBe(2);
  });

  test("does not cache when cacheResults is false", async () => {
    const fb = new VisionFallback(config({ cacheResults: false }), timer);
    const count = stubAnalyzer(fb, result());

    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    expect(count()).toBe(2);
    expect(fb.getCacheStats().size).toBe(0);
  });

  test("a cost above maxCostUsd is a warning, not a failure — the result is still returned", async () => {
    const fb = new VisionFallback(config({ maxCostUsd: 0.01 }), timer);
    stubAnalyzer(fb, result({ costUsd: 5.0 }));

    const res = await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    expect(res.found).toBe(true);
    expect(res.costUsd).toBe(5.0);
  });
});
