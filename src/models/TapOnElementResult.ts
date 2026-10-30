import type { ContainerFailure } from "./ActionableError";
import { Element } from "./Element";
import { ElementBounds } from "./ElementBounds";
import { ElementSelectionStrategy } from "./ElementSelectionStrategy";
import { BaseActionResult } from "./BaseActionResult";
import { ToolDebugInfo } from "./ToolDebugInfo";
import type { ScreenReaderNavigationResult } from "./ScreenReaderNavigationResult";

export type TapEffectBasis =
  | "screenIdentity changed"
  | "screenIdentity unchanged"
  | "activeWindow changed"
  | "activeWindow unchanged"
  | "viewHierarchy changed"
  | "viewHierarchy unchanged"
  | "insufficient observation data";

export interface TapEffect {
  screenChanged: boolean;
  basis: TapEffectBasis;
}

export interface TapOnSelectedElementBounds extends ElementBounds {
  centerX: number;
  centerY: number;
}

export interface TapOnSelectedElement {
  /** Original selector match; bounds above describe the action target. */
  matchedElement?: Element;
  captureId?: string;
  text: string;
  resourceId: string;
  /** Compose test tag, when the node exposes one (may be the only stable identity). */
  testTag?: string;
  bounds: TapOnSelectedElementBounds;
  indexInMatches: number;
  totalMatches: number;
  selectionStrategy: ElementSelectionStrategy;
}

/**
 * Result of a tap on text operation
 */
export interface TapOnElementResult extends BaseActionResult {
  action: string;
  element: Element;
  /** Which container level failed to resolve (not found or ambiguous), as dragAndDrop reports. */
  containerFailure?: ContainerFailure;
  skipped?: "already-checked";
  effect?: TapEffect;
  /** Semantic link confirmed by the native runner. */
  activatedSubtext?: {
    text: string;
    occurrence: number;
  };
  selectedElement?: TapOnSelectedElement;
  /**
   * iOS only, for a node merged from the app's SDK observation bridge (#5159): `sdk` when the bridge
   * performed the tap, `xctest` when XCTest stood in.
   */
  backend?: import("./ObserveResult").ObservationBackend;
  /** Why XCTest stood in for the bridge: it was unavailable, or it does not support the action. */
  fallbackReason?: import("./ObserveResult").ObservationFallbackReason;
  debug?: ToolDebugInfo;
  /**
   * Heuristic: a context menu, text selection, or new window root appeared after the long press.
   * False means none of those was seen, not that the press was delivered as a tap.
   */
  pressRecognized?: boolean;
  /**
   * Android long press only: whether the pressed node advertises a long-click accessibility
   * action. False means the node has no long-click handler, so the app handles the hold like a
   * tap on release; handlers built on raw touch input (such as drag-to-reorder) are not visible.
   */
  longClickAdvertised?: boolean;
  contextMenuOpened?: boolean;
  selectionStarted?: boolean;
  /** Whether a focus action was confirmed on the resolved editable target. */
  focusVerified?: boolean;
  searchUntil?: {
    durationMs: number;
    requestCount: number;
    changeCount: number;
  };
  screenReaderNavigation?: ScreenReaderNavigationResult;
}
