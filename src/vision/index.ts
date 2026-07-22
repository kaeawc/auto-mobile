/**
 * Vision-based element detection fallback module
 */

export { VisionFallback, DEFAULT_VISION_CONFIG } from "./VisionFallback";
export { ClaudeVisionClient } from "./ClaudeVisionClient";
export { getVisionEnrichedError } from "./applyVisionFallback";
export {
  VisionFallbackRegistry,
  getSharedVisionFallback,
  setSharedVisionFallbackRegistry,
} from "./VisionFallbackRegistry";
export type {
  VisionFallbackConfig,
  VisionFallbackResult,
  ElementSearchCriteria,
  NavigationStep,
  AlternativeSelector,
  ClaudeVisionAnalysis,
  VisionAnalyzer,
  VisionClient,
} from "./VisionTypes";
