import type {
  BootedDevice,
  Element,
  ObserveResult,
  SwipeDirection,
  SwipeOnOptions,
  SwipeResult,
  ViewHierarchyResult,
} from "../../../models";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { Timer } from "../../../utils/SystemTimer";
import type { AccessibilityDetector } from "../../accessibility/interfaces/AccessibilityDetector";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { FeatureFlagReader } from "../../featureFlags/FeatureFlagService";
import type { ObserveScreen } from "../../observe/interfaces/ObserveScreen";
import type { StaleDisplayDetails } from "../../observe/StaleDisplayError";
import type { DisplayFence, ProgressCallback } from "../BaseVisualChange";
import type { AndroidSearchDragState } from "./androidSearchDrag";
import type { ScrollUntilVisible, ScrollUntilVisibleStrategy } from "./ScrollUntilVisible";
import type { SwipeCounter } from "./searchCancellation";
import type { SwipeOnResolvedOptions } from "./types";

export interface ScrollSearchArgs {
  options: SwipeOnResolvedOptions;
  progress?: ProgressCallback;
  perf?: PerformanceTracker;
  signal?: AbortSignal;
  strategy?: ScrollUntilVisibleStrategy;
  swipes: SwipeCounter;
}

export type SearchCoordinates = {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  warning?: string;
};

export interface SearchSwipeDispatchOptions {
  coordinates: { startX: number; startY: number; endX: number; endY: number };
  direction: SwipeDirection;
  duration: number;
  options: SwipeOnResolvedOptions;
  containerElement: Element;
  observation: ObserveResult;
  observationFence?: DisplayFence;
  strategy?: ScrollUntilVisibleStrategy;
  scrollIteration: number;
  perf: PerformanceTracker;
  progress?: ProgressCallback;
  signal?: AbortSignal;
  onSearchFallback: () => void;
  searchDragState: AndroidSearchDragState;
  swipes: SwipeCounter;
}

/** Existing class operations stay behind callbacks so injected resolvers and timers remain authoritative. */
export interface ScrollSearchOperations extends Pick<
  ScrollUntilVisible,
  "findScrollableContainer" | "findElementInHierarchy" | "computeHierarchyFingerprint"
> {
  deps: {
    device: BootedDevice;
    timer: Timer;
    observeScreen: ObserveScreen;
    accessibilityDetector: AccessibilityDetector;
    adb: AdbExecutor;
    featureFlags?: FeatureFlagReader;
    getDuration: (options: SwipeOnResolvedOptions) => number;
    captureDisplayFence?: () => DisplayFence;
    captureTerminalObservationScreenshot?: (
      observation: ObserveResult | undefined,
      perf: PerformanceTracker,
    ) => Promise<void>;
  };
  screenBoundsContainer: (args: {
    observation: ObserveResult;
    includeSystemInsets?: boolean;
  }) => Element;
  resolveLookForOptions: (
    options: SwipeOnResolvedOptions,
    containerElement: Element,
    observation: ObserveResult,
  ) => SwipeOnResolvedOptions;
  isElementWithinContainer: (
    element: Element,
    bounds: Element["bounds"],
    observation: ObserveResult,
  ) => boolean;
  setAccessibilityFocusOnElement: (element: Element, perf: PerformanceTracker) => Promise<void>;
  resolveContainerSwipeCoordinates: (
    options: SwipeOnResolvedOptions,
    hierarchy: ViewHierarchyResult,
    containerElement: Element,
    observation: ObserveResult,
  ) => SearchCoordinates;
  resolveReverseBounds: (
    options: SwipeOnResolvedOptions,
    containerElement: Element,
    observation: ObserveResult,
  ) => Element["bounds"];
  computeHalfScreenReverseCoords: (
    direction: SwipeDirection,
    bounds: Element["bounds"],
  ) => SearchCoordinates;
  dispatchSearchSwipe: (args: SearchSwipeDispatchOptions) => Promise<SwipeResult>;
  matchInterruptedDisplaySearch: (
    options: SwipeOnOptions,
    observation: ObserveResult,
    container: Element,
    details: StaleDisplayDetails,
  ) => Promise<Element>;
  findVisibleSearchTarget: (
    options: SwipeOnResolvedOptions,
    observation: ObserveResult,
    previousContainer: Element,
  ) => Promise<Element | null>;
  shouldGuardSearchStep: (options: {
    failedAndroidSwipe: boolean;
    reverseMode: boolean;
    overlapRecoveryUsed: boolean;
    searchDragState: AndroidSearchDragState;
  }) => boolean;
  recoverSearchObservation: (args: {
    previousKeys: Map<string, number>;
    dispatch: SearchSwipeDispatchOptions;
    observe: () => Promise<ObserveResult>;
    deadline: number;
    onRecovery: () => void;
  }) => Promise<{ observation: ObserveResult; staleDisplay?: StaleDisplayDetails }>;
}

export interface ScrollSearchContext extends ScrollSearchOperations, ScrollSearchArgs {
  perf: PerformanceTracker;
}

export interface ScrollSearchState {
  observe: ScrollUntilVisibleStrategy["observe"];
  observationFence?: DisplayFence;
  lastObservation: ObserveResult;
  containerElement: Element;
  lookForOptions: SwipeOnResolvedOptions;
  onSearchFallback: () => void;
  maxTime: number;
  maxSwipes: number;
  startTime: number;
  foundElement: Element | null;
  scrollIteration: number;
  lastFingerprint: string;
  unchangedScrollCount: number;
  maxUnchangedScrolls: number;
  scopeDescription: string;
  target: string;
  accessibilityWarnings: Set<string>;
}

export interface ScrollSearchIterationState extends ScrollSearchState {
  searchDragState: AndroidSearchDragState;
  overlapRecoveryUsed: boolean;
  interruptedDisplay?: StaleDisplayDetails;
  swipeWarning?: string;
  lastAndroidSwipeError?: string;
  reverseMode: boolean;
  reverseDirection: SwipeDirection;
  reverseOptions: SwipeOnResolvedOptions;
}
