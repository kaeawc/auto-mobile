import { Element } from "./Element";
import { ElementBounds } from "./ElementBounds";
import { ElementSelectionStrategy } from "./ElementSelectionStrategy";
import { ObserveResult } from "./ObserveResult";
import { ToolDebugInfo } from "../utils/DebugContextBuilder";

/**
 * One injection attempt for a tap (ctrl-proxy gesture, adb, TalkBack path, etc.).
 * Helps diagnose "tap reported success but UI did not change."
 */
export interface TapOnInjectionAttempt {
  method: string;
  success: boolean;
  error?: string;
}

/** Deepest accessibility node at a screen point (from CtrlProxy hit test). */
export interface TapOnHitTestDebug {
  x: number;
  y: number;
  success: boolean;
  error?: string;
  totalTimeMs?: number;
  deepest?: {
    resourceId?: string;
    className?: string;
    text?: string;
    clickable?: string;
    focused?: string;
    bounds?: { left: number; top: number; right: number; bottom: number };
  };
  /** All windows whose root contains (x,y), before APPLICATION-first / clickable ranking. */
  layers?: TapOnHitTestLayerDebug[];
  chosenWindowZIndex?: number;
  activeWindowZIndex?: number | null;
  windowCount?: number;
  hitTestSource?: string;
}

/** One window layer at the hit-test coordinates (multi-window hit-test). */
export interface TapOnHitTestLayerDebug {
  windowIndex: number;
  windowType: string;
  windowLayer: number;
  active: boolean;
  focused: boolean;
  rootBounds: { left: number; top: number; right: number; bottom: number };
  deepest: NonNullable<TapOnHitTestDebug["deepest"]>;
}

/** Input/accessibility focus snapshot around a tap (diagnostics). */
export interface TapOnFocusDebug {
  resourceId?: string;
  className?: string;
  text?: string;
  focused?: boolean;
  error?: string;
}

/** Pre/post tap CtrlProxy diagnostics (focus + hit-testing at tap coordinates). */
export interface TapOnTapDiagnostics {
  focusBeforeTap?: TapOnFocusDebug | null;
  focusAfterTap?: TapOnFocusDebug | null;
  hitTestBeforeTap?: TapOnHitTestDebug;
  hitTestAfterTap?: TapOnHitTestDebug;
}

/** tapClickableParent / semantic click geometry sent to CtrlProxy vs used for coordinate taps. */
export interface TapOnAndroidTapGeometryDebug {
  rowBounds: { left: number; top: number; right: number; bottom: number };
  labelRowOverlapBounds?: { left: number; top: number; right: number; bottom: number };
  semanticDisambiguationBounds: { left: number; top: number; right: number; bottom: number };
  coordinateTapPoint: { x: number; y: number };
}

/** Timing along the Android tap path (same observe callback). */
export interface TapOnAndroidTimingDebug {
  /** Epoch ms when the observe→tap callback started. */
  tapPathStartedAtMs: number;
  /** ms from {@link tapPathStartedAtMs} to after the Android hierarchy refresh attempt. */
  elapsedMsAfterAndroidHierarchyRefresh: number;
  /** ms from {@link tapPathStartedAtMs} to immediately before {@code executeTap}. */
  elapsedMsBeforeExecuteTap: number;
}

/**
 * Diagnostic payload attached to successful tapOn results.
 */
export interface TapOnTapDebug {
  platform: "android";
  action: string;
  tapPoint: { x: number; y: number };
  tapTargetBounds: { left: number; top: number; right: number; bottom: number };
  tapTargetResourceId?: string;
  tapTargetClass?: string;
  usedClickableParent: boolean;
  injectionAttempts: TapOnInjectionAttempt[];
  observationAfter?: {
    updatedAt?: string | number;
    freshnessWarning?: string;
  };
  /** Focus and hit-test snapshots when CtrlProxy is available (Android). */
  diagnostics?: TapOnTapDiagnostics;
  /** Set for Android tapClickableParent + text when overlap / semantic bounds differ from row-only. */
  androidTapGeometry?: TapOnAndroidTapGeometryDebug;
  androidTimingMs?: TapOnAndroidTimingDebug;
  /** CtrlProxy `performAction` resolution (semantic click attempt). */
  androidSemanticResolution?: {
    imeWindowsExcludedForBounds: boolean;
    inputMethodWindowPresent: boolean;
    applicationWindowPresent: boolean;
    windowsScannedForFind: number;
    findResolutionPhase?: string;
    bruteForceMaxIntersectingCandidates: number;
    successPath: string;
  };
}

export interface TapOnSelectedElementBounds extends ElementBounds {
  centerX: number;
  centerY: number;
}

export interface TapOnSelectedElement {
  text: string;
  resourceId: string;
  bounds: TapOnSelectedElementBounds;
  indexInMatches: number;
  totalMatches: number;
  selectionStrategy: ElementSelectionStrategy;
}

/**
 * Result of a tap on text operation
 */
export interface TapOnElementResult {
  success: boolean;
  action: string;
  element: Element;
  selectedElement?: TapOnSelectedElement;
  observation?: ObserveResult;
  error?: string;
  debug?: ToolDebugInfo;
  /** Where the tap landed and how it was injected (success path). */
  tapDebug?: TapOnTapDebug;
  pressRecognized?: boolean;
  contextMenuOpened?: boolean;
  selectionStarted?: boolean;
  searchUntil?: {
    durationMs: number;
    requestCount: number;
    changeCount: number;
  };
}
