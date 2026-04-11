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
