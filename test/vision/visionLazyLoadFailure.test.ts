import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../src/models/ActionableError";
import { getVisionEnrichedError } from "../../src/vision/applyVisionFallback";
import {
  LazyClaudeVisionClient,
  type ClaudeVisionClientModule,
} from "../../src/vision/lazyClaudeVisionClient";
import { VisionFallback } from "../../src/vision/VisionFallback";
import type {
  VisionClient,
  VisionFallbackConfig,
  VisionFallbackResult,
} from "../../src/vision/VisionTypes";
import { FakeTimer } from "../fakes/FakeTimer";
import { LAZY_IMPORT_FAILURE, recoveringLazyModule } from "../helpers/recoveringLazyModule";

const CONFIG: VisionFallbackConfig = {
  enabled: true,
  provider: "claude",
  confidenceThreshold: "high",
  maxCostUsd: 1,
  cacheResults: false,
  cacheTtlMinutes: 60,
};

const RESULT: VisionFallbackResult = {
  found: false,
  confidence: "low",
  costUsd: 0.01,
  durationMs: 0,
  screenshotPath: "/s.png",
  provider: "claude",
  reason: "Button is behind the menu",
};

function claudeModule(): ClaudeVisionClientModule {
  return {
    ClaudeVisionClient: class implements VisionClient {
      async analyzeUIElement(): Promise<VisionFallbackResult> {
        return RESULT;
      }
    },
  };
}

function fallbackWith(lazy: ReturnType<typeof recoveringLazyModule<ClaudeVisionClientModule>>) {
  return new VisionFallback(CONFIG, new FakeTimer(), new LazyClaudeVisionClient(lazy.module));
}

describe("vision SDK import failure (#17721)", () => {
  test("an analysis rejects with the load error and the next one loads the client", async () => {
    const lazy = recoveringLazyModule("vision", claudeModule);
    const fallback = fallbackWith(lazy);

    const failed = fallback.analyzeAndSuggest("/s.png", {}, { text: "OK" });
    await expect(failed).rejects.toBeInstanceOf(ActionableError);
    await expect(failed).rejects.toThrow(
      `Failed to load the vision module: ${LAZY_IMPORT_FAILURE}`,
    );

    lazy.recover();
    expect(await fallback.analyzeAndSuggest("/s.png", {}, { text: "OK" })).toBe(RESULT);
    expect(lazy.attempts()).toBe(2);
  });

  test("a tool's element-not-found error keeps its base text, then is enriched once the SDK loads", async () => {
    const lazy = recoveringLazyModule("vision", claudeModule);
    const visionAnalyzer = fallbackWith(lazy);
    const capturer = { capture: async () => "/s.png" };
    const enrich = () =>
      getVisionEnrichedError(
        capturer,
        {},
        { text: "OK" },
        {
          visionConfig: CONFIG,
          baseError: "Element not found",
          visionAnalyzer,
        },
      );

    // Vision only enriches a tool's error, so a failed SDK import leaves the tool's own error.
    expect(await enrich()).toBe("Element not found");
    lazy.recover();
    expect(await enrich()).toBe(
      "Element not found. Button is behind the menu\n\n(Cost: $0.0100, Confidence: low)",
    );
  });
});
