import { beforeEach, describe, expect, test } from "bun:test";
import { VisionFallback, MAX_VISION_CACHE_ENTRIES } from "../../src/vision/VisionFallback";
import type {
  VisionFallbackConfig,
  VisionFallbackResult,
  ElementSearchCriteria,
} from "../../src/vision/VisionTypes";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeChecksumCalculator } from "../fakes/FakeChecksumCalculator";

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
  let checksums: FakeChecksumCalculator;

  beforeEach(() => {
    timer = new FakeTimer();
    // Screenshots are keyed by content; give each path its own digest so the
    // fixtures behave like distinct screens without touching the disk.
    checksums = new FakeChecksumCalculator();
    // Each fixture path stands for a different screen.
    checksums.distinctPerFile = true;
  });

  test("throws when vision fallback is disabled", async () => {
    const fb = new VisionFallback(config({ enabled: false }), timer, undefined, checksums);
    await expect(fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"))).rejects.toThrow(
      /not enabled/,
    );
  });

  test("rejects an unsupported provider before attempting a paid analysis", async () => {
    const fallback = new VisionFallback(
      config({ provider: "unsupported" as any }),
      timer,
      undefined,
      checksums,
    );

    await expect(
      fallback.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login")),
    ).rejects.toThrow("Unsupported vision provider: unsupported");
  });

  test("caches a result: an identical query hits the analyzer only once", async () => {
    const fb = new VisionFallback(config(), timer, undefined, checksums);
    const count = stubAnalyzer(fb, result());

    const first = await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    const second = await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));

    expect(count()).toBe(1);
    expect(second).toEqual(first);
    expect(fb.getCacheStats().size).toBe(1);
  });

  test("re-analyzes after the cache entry passes cacheTtlMinutes", async () => {
    const fb = new VisionFallback(config({ cacheTtlMinutes: 60 }), timer, undefined, checksums);
    const count = stubAnalyzer(fb, result());

    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    // Just under the TTL: still cached.
    timer.advanceTime(59 * 60 * 1000);
    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    expect(count()).toBe(1);

    // The exact TTL remains a cache hit; expiry starts one millisecond later.
    timer.advanceTime(1 * 60 * 1000);
    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    expect(count()).toBe(1);

    timer.advanceTime(1);
    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    expect(count()).toBe(2);
  });

  test("caches distinct search criteria separately", async () => {
    const fb = new VisionFallback(config(), timer, undefined, checksums);
    const count = stubAnalyzer(fb, result());

    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Signup"));
    expect(count()).toBe(2);
    expect(fb.getCacheStats().size).toBe(2);

    // Repeating the first is still a cache hit.
    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    expect(count()).toBe(2);
  });

  test("criteria written with keys in a different order hit the cache: the paid analyzer runs once", async () => {
    const fb = new VisionFallback(config(), timer, undefined, checksums);
    const count = stubAnalyzer(fb, result());

    // Semantically identical searches, keys typed in a different order.
    await fb.analyzeAndSuggest("/s.png", HIERARCHY, { text: "Login", resourceId: "btn" });
    await fb.analyzeAndSuggest("/s.png", HIERARCHY, { resourceId: "btn", text: "Login" });

    expect(count()).toBe(1);
    expect(fb.getCacheStats().size).toBe(1);
  });

  test("control: criteria with the same keys but different values are still analyzed separately", async () => {
    const fb = new VisionFallback(config(), timer, undefined, checksums);
    const count = stubAnalyzer(fb, result());

    await fb.analyzeAndSuggest("/s.png", HIERARCHY, { text: "Login", resourceId: "btn" });
    await fb.analyzeAndSuggest("/s.png", HIERARCHY, { resourceId: "btn2", text: "Login" });

    expect(count()).toBe(2);
    expect(fb.getCacheStats().size).toBe(2);
  });

  test("control: the same criteria against a different screenshot is not a cache hit", async () => {
    const fb = new VisionFallback(config(), timer, undefined, checksums);
    const count = stubAnalyzer(fb, result());

    await fb.analyzeAndSuggest("/a.png", HIERARCHY, criteria("Login"));
    await fb.analyzeAndSuggest("/b.png", HIERARCHY, criteria("Login"));

    expect(count()).toBe(2);
  });

  test("clearCache forces re-analysis", async () => {
    const fb = new VisionFallback(config(), timer, undefined, checksums);
    const count = stubAnalyzer(fb, result());

    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    fb.clearCache();
    expect(fb.getCacheStats().size).toBe(0);
    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    expect(count()).toBe(2);
  });

  test("does not cache when cacheResults is false", async () => {
    const fb = new VisionFallback(config({ cacheResults: false }), timer, undefined, checksums);
    const count = stubAnalyzer(fb, result());

    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    expect(count()).toBe(2);
    expect(fb.getCacheStats().size).toBe(0);
  });

  test("a cost above maxCostUsd is a warning, not a failure — the result is still returned", async () => {
    const fb = new VisionFallback(config({ maxCostUsd: 0.01 }), timer, undefined, checksums);
    stubAnalyzer(fb, result({ costUsd: 5.0 }));

    const res = await fb.analyzeAndSuggest("/s.png", HIERARCHY, criteria("Login"));
    expect(res.found).toBe(true);
    expect(res.costUsd).toBe(5.0);
  });

  // The cache now outlives a single tool call (issue #4207), so it has to be
  // bounded or a long-running daemon retains every query it ever made.
  test("caps retained entries at MAX_VISION_CACHE_ENTRIES", async () => {
    const fb = new VisionFallback(config(), timer, undefined, checksums);
    stubAnalyzer(fb, result());

    for (let i = 0; i < MAX_VISION_CACHE_ENTRIES + 10; i++) {
      await fb.analyzeAndSuggest(`/s-${i}.png`, HIERARCHY, criteria("Login"));
    }

    expect(fb.getCacheStats().size).toBe(MAX_VISION_CACHE_ENTRIES);
    // Oldest-write-first eviction: the earliest screenshots are gone.
    expect(fb.getCacheStats().keys.some((k) => k.startsWith("sha256(/s-0.png):"))).toBe(false);
    expect(fb.getCacheStats().keys.some((k) => k.startsWith("sha256(/s-73.png):"))).toBe(true);
  });

  test("sweeps entries past their TTL on write, not only on read", async () => {
    const fb = new VisionFallback(config({ cacheTtlMinutes: 10 }), timer, undefined, checksums);
    stubAnalyzer(fb, result());

    await fb.analyzeAndSuggest("/stale.png", HIERARCHY, criteria("Login"));
    expect(fb.getCacheStats().size).toBe(1);

    timer.advanceTime(11 * 60 * 1000);
    // A write for a *different* key must still retire the expired entry.
    await fb.analyzeAndSuggest("/fresh.png", HIERARCHY, criteria("Login"));

    expect(fb.getCacheStats().keys).toEqual(
      expect.arrayContaining([expect.stringContaining("sha256(/fresh.png)")]),
    );
    expect(fb.getCacheStats().size).toBe(1);
  });
});
