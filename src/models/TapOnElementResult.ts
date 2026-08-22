import { Element } from "./Element";
import { ElementBounds } from "./ElementBounds";
import { ElementSelectionStrategy } from "./ElementSelectionStrategy";
import { BaseActionResult } from "./BaseActionResult";
import { ToolDebugInfo } from "../utils/DebugContextBuilder";
import type { ScreenReaderNavigationResult } from "../features/talkback/TalkBackTapStrategy";

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
export interface TapOnElementResult extends BaseActionResult {
  action: string;
  element: Element;
  /** Resolved horizontal target coordinate for a successful interaction. */
  x?: number;
  /** Resolved vertical target coordinate for a successful interaction. */
  y?: number;
  selectedElement?: TapOnSelectedElement;
  debug?: ToolDebugInfo;
  pressRecognized?: boolean;
  contextMenuOpened?: boolean;
  selectionStarted?: boolean;
  searchUntil?: {
    durationMs: number;
    requestCount: number;
    changeCount: number;
  };
  screenReaderNavigation?: ScreenReaderNavigationResult;
}
