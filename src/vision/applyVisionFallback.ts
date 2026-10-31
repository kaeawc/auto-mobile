/**
 * Shared utility for applying vision fallback error enrichment across tools.
 */

import { getSharedVisionFallback } from "./VisionFallbackRegistry";
import type { VisionFallbackConfig, ElementSearchCriteria, VisionAnalyzer } from "./VisionTypes";
import type { ScreenshotCapturer } from "../features/navigation/SelectionStateTracker";
import { logger } from "../utils/logger";

export interface VisionEnrichedErrorOptions {
  /** Vision fallback configuration; a disabled config returns `baseError` unchanged. */
  visionConfig: VisionFallbackConfig;
  /** The message returned unchanged when vision is disabled, unavailable, or fails. */
  baseError: string;
  signal?: AbortSignal;
  visionAnalyzer?: VisionAnalyzer;
}

/**
 * Attempts to enrich an error message using vision fallback (AI-based element search).
 * If vision is disabled, screenshot unavailable, or vision fails, returns baseError unchanged.
 *
 * @param options.visionConfig - Vision fallback configuration.
 * @param options.baseError - Message returned unchanged when vision cannot help.
 */
export async function getVisionEnrichedError(
  screenshotCapturer: ScreenshotCapturer,
  viewHierarchy: unknown,
  searchCriteria: ElementSearchCriteria,
  options: VisionEnrichedErrorOptions,
): Promise<string> {
  const { visionConfig, baseError, signal, visionAnalyzer } = options;
  if (!visionConfig.enabled) {
    return baseError;
  }

  try {
    const screenshotPath = await screenshotCapturer.capture(signal);
    if (!screenshotPath) {
      logger.error("Failed to capture screenshot for vision fallback");
      return baseError;
    }

    // Must be the shared, config-keyed orchestrator: constructing one here
    // would discard its result cache after a single call, making every vision
    // fallback a fresh paid analyzer invocation.
    const analyzer: VisionAnalyzer = visionAnalyzer ?? getSharedVisionFallback(visionConfig);
    const visionResult = await analyzer.analyzeAndSuggest(
      screenshotPath,
      viewHierarchy,
      searchCriteria,
    );

    if (
      visionResult.confidence === "high" &&
      visionResult.navigationSteps &&
      visionResult.navigationSteps.length > 0
    ) {
      const stepsText = visionResult.navigationSteps
        .map((step, i) => `${i + 1}. ${step.description}`)
        .join("\n");
      return (
        `Element not found, but AI suggests these steps:\n${stepsText}\n\n` +
        `(Cost: $${visionResult.costUsd.toFixed(4)}, Confidence: ${visionResult.confidence})`
      );
    }

    if (visionResult.alternativeSelectors && visionResult.alternativeSelectors.length > 0) {
      const suggestions = visionResult.alternativeSelectors
        .map((alt) => `- ${alt.type}: "${alt.value}" (${alt.reasoning})`)
        .join("\n");
      return (
        `Element not found. AI suggests trying:\n${suggestions}\n\n` +
        `(Cost: $${visionResult.costUsd.toFixed(4)}, Confidence: ${visionResult.confidence})`
      );
    }

    return (
      `${baseError}. ${visionResult.reason || "No clear path found."}\n\n` +
      `(Cost: $${visionResult.costUsd.toFixed(4)}, Confidence: ${visionResult.confidence})`
    );
  } catch (error) {
    logger.error("Vision fallback failed:", error);
    return baseError;
  }
}
