import type { FencedGestureOptions } from "../ExecuteGesture";
import type { Timer } from "../../../utils/SystemTimer";
import {
  Element,
  ObserveResult,
  SwipeDirection,
  SwipeOnOptions,
  ViewHierarchyQueryOptions,
  ViewHierarchyResult,
} from "../../../models";
import { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { SwipeResult } from "../../../models/SwipeResult";
import type { ObserveScreen } from "../../observe/interfaces/ObserveScreen";
import { AccessibilityDetector } from "../../accessibility/interfaces/AccessibilityDetector";
import type { IosVoiceOverDetector } from "../../accessibility/interfaces/IosVoiceOverDetector";
import type { DisplayFenceDependencies } from "../BaseVisualChange";
import type { RenderedObservationReader } from "../TargetDisplayAction";

export type SwipeOnResolvedOptions = SwipeOnOptions & { direction: SwipeDirection };

export type SwipeInterval = { start: number; end: number; length: number };

export type BoomerangConfig = { apexPauseMs: number; returnSpeed: number };

export type OverlayCandidate = {
  bounds: Element["bounds"];
  overlapBounds: Element["bounds"];
  coverage: number;
  zOrder: { windowRank: number; nodeOrder: number };
};

export interface VoiceOverSwipeRunner {
  executeSwipeGesture(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    direction: SwipeDirection,
    containerElement: Element | null,
    gestureOptions?: FencedGestureOptions,
    perf?: PerformanceTracker,
    boomerang?: BoomerangConfig,
    signal?: AbortSignal,
  ): Promise<SwipeResult>;
}

export interface AutoTargetSelectorService {
  selectAutoTargetScrollable(
    scrollables: Element[],
    screenBounds: Element["bounds"] | null,
    direction: SwipeDirection,
  ): Element | null;

  getScreenBounds(
    observeResult: ObserveResult,
    options?: { platform?: "android" | "ios"; includeSystemInsets?: boolean },
  ): Element["bounds"] | null;

  describeContainer(container: SwipeOnOptions["container"]): string;

  mergeWarnings(...warnings: Array<string | undefined>): string | undefined;
}

export interface TalkBackSwipeRunner {
  executeSwipeGesture(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    direction: SwipeDirection,
    containerElement: Element | null,
    gestureOptions?: FencedGestureOptions,
    perf?: PerformanceTracker,
    boomerang?: BoomerangConfig,
    signal?: AbortSignal,
  ): Promise<SwipeResult>;
}

export interface OverlayAnalyzer {
  collectOverlayCandidates(
    viewHierarchy: ViewHierarchyResult,
    containerElement: Element,
  ): OverlayCandidate[];

  computeSafeSwipeCoordinates(
    direction: SwipeDirection,
    bounds: Element["bounds"],
    overlayBounds: Element["bounds"][],
  ): { startX: number; startY: number; endX: number; endY: number; warning?: string } | null;
}

export interface GestureExecutor {
  swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    options?: FencedGestureOptions,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<SwipeResult>;
}

export interface ScrollAccessibilityService {
  requestAction(
    action: string,
    resourceId?: string,
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<{ success: boolean; error?: string }>;

  getAccessibilityHierarchy(
    queryOptions?: ViewHierarchyQueryOptions,
    perf?: PerformanceTracker,
    skipWaitForFresh?: boolean,
    minTimestamp?: number,
    disableAllFiltering?: boolean,
  ): Promise<ViewHierarchyResult | null>;
}

export interface SwipeOnDependencies extends DisplayFenceDependencies {
  timer?: Timer;
  skipCallerDisplayFence?: boolean;
  /** Avoid post-action runner reads after an iOS lock-screen gesture fails. */
  stopAfterIosGestureFailure?: boolean;
  /** Only the unlocker opts into an app-independent iOS swipe. */
  iosLockScreenSwipe?: boolean;
  /** Cap the iOS gesture request inside a caller's remaining action budget. */
  iosGestureTimeoutMs?: () => number;
  lastRenderedObservation?: RenderedObservationReader;
  resolver?: Pick<import("../../utility/ElementResolver").ElementResolver, "resolve">;
  executeGesture?: GestureExecutor;
  observeScreen?: ObserveScreen;
  finder?: import("../../../utils/interfaces/ElementTraitQueries").ScrollableElementsQuery;
  geometry?: import("../../../utils/interfaces/ElementGeometry").ElementGeometry;
  parser?: import("../../../utils/interfaces/ElementParser").ElementParser;
  accessibilityDetector?: AccessibilityDetector;
  iosVoiceOverDetector?: IosVoiceOverDetector;
  featureFlags?: import("../../featureFlags/FeatureFlagService").FeatureFlagService;
  voiceOverExecutor?: VoiceOverSwipeRunner;
  autoTargetSelector?: AutoTargetSelectorService;
  visionConfig?: import("../../../vision/VisionTypes").VisionFallbackConfig;
  screenshotCapturer?: import("../../navigation/SelectionStateTracker").ScreenshotCapturer;
  visionAnalyzer?: import("../../../vision/VisionTypes").VisionAnalyzer;
}
