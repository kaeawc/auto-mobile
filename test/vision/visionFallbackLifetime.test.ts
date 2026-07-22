/**
 * Pins the *lifetime* of the vision result cache (issue #4207).
 *
 * These tests deliberately do NOT inject `visionAnalyzer` into
 * `getVisionEnrichedError`, because that seam is the thing that hid the bug:
 * holding one `VisionFallback` across calls is exactly the lifetime production
 * did not have. The only substitution is the paid provider client, so the real
 * orchestrator, the real cache key and the real TTL logic all run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getVisionEnrichedError } from "../../src/vision/applyVisionFallback";
import { VisionFallback } from "../../src/vision/VisionFallback";
import {
  VisionFallbackRegistry,
  setSharedVisionFallbackRegistry,
} from "../../src/vision/VisionFallbackRegistry";
import type {
  VisionClient,
  VisionFallbackConfig,
  VisionFallbackResult,
} from "../../src/vision/VisionTypes";
import { FakeScreenshotCapturer } from "../fakes/FakeScreenshotCapturer";
import { FakeTimer } from "../fakes/FakeTimer";

const config = (overrides: Partial<VisionFallbackConfig> = {}): VisionFallbackConfig => ({
  enabled: true,
  provider: "claude",
  confidenceThreshold: "high",
  maxCostUsd: 1.0,
  cacheResults: true,
  cacheTtlMinutes: 60,
  ...overrides,
});

const CANNED: VisionFallbackResult = {
  found: false,
  confidence: "low",
  reason: "Element appears to be off-screen",
  costUsd: 0.02,
  durationMs: 10,
  screenshotPath: "/s.png",
  provider: "claude",
};

/** Counts the paid provider calls that a real VisionFallback would make. */
class CountingVisionClient implements VisionClient {
  calls = 0;
  async analyzeUIElement(): Promise<VisionFallbackResult> {
    this.calls += 1;
    return CANNED;
  }
}

describe("vision result cache lifetime across tool calls", () => {
  let timer: FakeTimer;
  let client: CountingVisionClient;

  beforeEach(() => {
    timer = new FakeTimer();
    client = new CountingVisionClient();
    // Real VisionFallback, real cache, real TTL — only the paid client is faked.
    setSharedVisionFallbackRegistry(
      new VisionFallbackRegistry(cfg => new VisionFallback(cfg, timer, client))
    );
  });

  afterEach(() => {
    setSharedVisionFallbackRegistry(null);
  });

  const enrich = async (
    capturer: FakeScreenshotCapturer,
    cfg: VisionFallbackConfig
  ): Promise<string> =>
    getVisionEnrichedError(capturer, null, { text: "Login" }, cfg, "Element not found");

  const capturerFor = (paths: string[]): FakeScreenshotCapturer => {
    const capturer = new FakeScreenshotCapturer();
    capturer.setPaths(paths);
    return capturer;
  };

  test("two separate tool calls with the same screenshot and criteria pay once", async () => {
    // Two independent capturers stand in for two independent tool calls: no
    // object is shared between them except the process-wide registry.
    const first = await enrich(capturerFor(["/s.png"]), config());
    const second = await enrich(capturerFor(["/s.png"]), config());

    expect(client.calls).toBe(1);
    expect(second).toBe(first);
  });

  test("cacheResults: false still bypasses the cache", async () => {
    await enrich(capturerFor(["/s.png"]), config({ cacheResults: false }));
    await enrich(capturerFor(["/s.png"]), config({ cacheResults: false }));

    expect(client.calls).toBe(2);
  });

  test("cacheTtlMinutes still evicts across tool calls", async () => {
    await enrich(capturerFor(["/s.png"]), config({ cacheTtlMinutes: 10 }));
    expect(client.calls).toBe(1);

    timer.advanceTime(11 * 60 * 1000);

    await enrich(capturerFor(["/s.png"]), config({ cacheTtlMinutes: 10 }));
    expect(client.calls).toBe(2);
  });

  test("an entry within the TTL is still served after time advances", async () => {
    await enrich(capturerFor(["/s.png"]), config({ cacheTtlMinutes: 10 }));
    timer.advanceTime(9 * 60 * 1000);
    await enrich(capturerFor(["/s.png"]), config({ cacheTtlMinutes: 10 }));

    expect(client.calls).toBe(1);
  });

  test("entries are not shared across differing configs", async () => {
    await enrich(capturerFor(["/s.png"]), config({ cacheTtlMinutes: 10 }));
    await enrich(capturerFor(["/s.png"]), config({ cacheTtlMinutes: 30 }));

    expect(client.calls).toBe(2);
  });

  test("config key is order-insensitive, so equivalent configs share a cache", async () => {
    const a: VisionFallbackConfig = {
      enabled: true,
      provider: "claude",
      confidenceThreshold: "high",
      maxCostUsd: 1.0,
      cacheResults: true,
      cacheTtlMinutes: 60,
    };
    const b: VisionFallbackConfig = {
      cacheTtlMinutes: 60,
      cacheResults: true,
      maxCostUsd: 1.0,
      confidenceThreshold: "high",
      provider: "claude",
      enabled: true,
    };

    await enrich(capturerFor(["/s.png"]), a);
    await enrich(capturerFor(["/s.png"]), b);

    expect(client.calls).toBe(1);
  });

  test("different screenshots do not share an entry", async () => {
    await enrich(capturerFor(["/a.png"]), config());
    await enrich(capturerFor(["/b.png"]), config());

    expect(client.calls).toBe(2);
  });
});

describe("VisionFallbackRegistry", () => {
  afterEach(() => {
    setSharedVisionFallbackRegistry(null);
  });

  test("returns the same instance for an equivalent config", () => {
    const registry = new VisionFallbackRegistry(cfg => new VisionFallback(cfg, new FakeTimer(), new CountingVisionClient()));

    expect(registry.get(config())).toBe(registry.get(config()));
    expect(registry.size).toBe(1);
  });

  test("bounds how many instances it retains", () => {
    const registry = new VisionFallbackRegistry(cfg => new VisionFallback(cfg, new FakeTimer(), new CountingVisionClient()));

    for (let i = 0; i < 20; i++) {
      registry.get(config({ cacheTtlMinutes: i }));
    }

    expect(registry.size).toBe(8);
  });
});
