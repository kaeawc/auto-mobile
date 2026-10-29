import type { AndroidCtrlProxyClient } from "../../observe/android";
import type { TalkBackSwipeCtrlProxy } from "./TalkBackSwipeExecutor";
import type { FencedGestureOptions } from "../ExecuteGesture";
import type { ActionCall } from "../ActionCall";
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
import { AccessibilityDetector } from "../../../ctrlProxy/accessibility/interfaces/AccessibilityDetector";
import type { IosVoiceOverDetector } from "../../accessibility/interfaces/IosVoiceOverDetector";
import type { DisplayFenceDependencies } from "../BaseVisualChange";
import type { RenderedObservationReader } from "../TargetDisplayAction";
import type { AccessibilityHierarchyRequest } from "../../observe/hierarchyReadArgs";

export type SwipeOnResolvedOptions = SwipeOnOptions & { direction: SwipeDirection };

export type SwipeInterval = { start: number; end: number; length: number };

export type BoomerangConfig = { apexPauseMs: number; returnSpeed: number };

export type SwipeGestureRequest = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  direction: SwipeDirection;
  containerElement: Element | null;
  gestureOptions?: FencedGestureOptions;
  perf?: PerformanceTracker;
  boomerang?: BoomerangConfig;
  signal?: AbortSignal;
  /**
   * iOS: the observation the swipe was resolved against, so it can go through the SDK observation
   * bridge (#5159). Omitted for edge swipes and scroll searches, which stay on XCTest.
   */
  sdkObservation?: Pick<ObserveResult, "viewHierarchy">;
};

export type BoomerangGestureRequest = Omit<
  SwipeGestureRequest,
  "direction" | "containerElement" | "boomerang"
> & { boomerang: BoomerangConfig };

export type AnnounceSwipeableRequest = Omit<SwipeGestureRequest, "direction" | "boomerang">;

export type AndroidAccessibilitySwipeRequest = Omit<SwipeGestureRequest, "boomerang">;

export type OverlayCandidate = {
  bounds: Element["bounds"];
  overlapBounds: Element["bounds"];
  coverage: number;
  zOrder: { windowRank: number; nodeOrder: number };
};

export interface VoiceOverSwipeRunner {
  executeSwipeGesture(request: SwipeGestureRequest): Promise<SwipeResult>;
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
  executeSwipeGesture(request: SwipeGestureRequest): Promise<SwipeResult>;
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
    call?: ActionCall,
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
    request?: AccessibilityHierarchyRequest,
  ): Promise<ViewHierarchyResult | null>;
}

/** The CtrlProxy surface SwipeOn itself and its swipe/scroll/drag collaborators call. */
export type SwipeOnCtrlProxy = TalkBackSwipeCtrlProxy &
  ScrollAccessibilityService &
  Pick<
    AndroidCtrlProxyClient,
    | "requestSwipe"
    | "requestDrag"
    | "requestDeviceInfo"
    | "supportsCommand"
    | "getSdkScreenIdentityReceivedAtMs"
    | "awaitSdkScreenIdentityAfter"
  >;

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
  scrollables?: import("../../../utils/interfaces/ElementTraitQueries").ScrollableElementsQuery;
  geometry?: import("../../../utils/interfaces/ElementGeometry").ElementGeometry;
  parser?: import("../../../utils/interfaces/ElementParser").ElementParser;
  /** Android CtrlProxy client; defaults to the device's shared `AndroidCtrlProxyClient`. */
  accessibilityService?: SwipeOnCtrlProxy;
  accessibilityDetector?: AccessibilityDetector;
  iosVoiceOverDetector?: IosVoiceOverDetector;
  featureFlags?: import("../../featureFlags/FeatureFlagService").FeatureFlagReader;
  voiceOverExecutor?: VoiceOverSwipeRunner;
  autoTargetSelector?: AutoTargetSelectorService;
  visionConfig?: import("../../../vision/VisionTypes").VisionFallbackConfig;
  screenshotCapturer?: import("../../navigation/SelectionStateTracker").ScreenshotCapturer;
  visionAnalyzer?: import("../../../vision/VisionTypes").VisionAnalyzer;
  /** Android SDK route store; defaults to the device's existing CtrlProxy client. */
  sdkRouteSource?: import("./sdkRouteSettle").SdkRouteSource;
}
