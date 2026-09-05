/**
 * Type definitions for interaction tools.
 * Extracted from interactionTools.ts for maintainability.
 */
import type { Platform, ElementSelectionStrategy, ImeAction } from "../models";
import type { ObserveWaitForOptions, SettledOptions } from "./observeTools";

// ============================================================================
// Tool Argument Types
// ============================================================================

// #6154: `platform` is optional on every one of these tools' wire schemas
// (resolved from deviceId/session when omitted), so the hand-written arg
// types below must match it — a typed caller could not otherwise omit it.
// `TapOnArgs.platform` (below) is left as-is: tapOn's schema has been
// optional since #5870, predating this pass, and fixing that pre-existing
// mismatch is out of scope here.
export interface ClearTextArgs {
  platform?: Platform;
}

export interface SelectAllTextArgs {
  platform?: Platform;
}

export interface PressButtonArgs {
  button: "home" | "back" | "menu" | "power" | "volume_up" | "volume_down" | "recent";
  platform?: Platform;
}

export interface SystemTrayNotificationArgs {
  title?: string;
  body?: string;
  appId?: string;
  tapActionLabel?: string;
}

export interface SystemTrayArgs {
  action: "open" | "close" | "find" | "tap" | "dismiss" | "clearAll";
  notification?: SystemTrayNotificationArgs;
  awaitTimeout?: number;
  platform?: Platform;
}

/** Selector variants that focus an input field before typing (issue #5872). */
export interface InputTextSelector {
  elementId?: string;
  testTag?: string;
  text?: string;
  textAny?: string[];
}

export interface InputTextArgs {
  text: string;
  selector?: InputTextSelector;
  mode?: "a11y" | "eventLast" | "eventAll" | "eventOnly";
  imeAction?: ImeAction;
  dismissKeyboard?: boolean;
  platform?: Platform;
  raw?: boolean;
  project?: "full" | "skeleton";
}

export interface WakeAndUnlockArgs {
  pin?: string;
  platform?: Platform;
}

export interface OpenLinkArgs {
  url: string;
  platform?: Platform;
  waitFor?: ObserveWaitForOptions;
  settled?: SettledOptions;
}

export interface TapOnArgs {
  selector: {
    elementId?: string;
    testTag?: string;
    text?: string;
    textAny?: string[];
    accessibilityLink?: string;
  };
  sibling?: boolean;
  container?: {
    elementId?: string;
    text?: string;
  };
  selectionStrategy?: ElementSelectionStrategy;
  index?: number;
  action: "tap" | "doubleTap" | "longPress" | "focus";
  duration?: number;
  searchUntil?: {
    duration?: number;
  };
  platform: Platform;
  preTapStability?: boolean;
  retryIfNoChange?: boolean;
  ensureTap?: boolean;
  subtext?: {
    text: string;
    occurrence?: number;
  };
  raw?: boolean;
  project?: "full" | "skeleton";
}

export interface TapAnyArgs {
  container?: {
    elementId?: string;
    text?: string;
  };
  selectionStrategy?: ElementSelectionStrategy;
  action: "tap" | "doubleTap" | "longPress";
  duration?: number;
  searchUntil?: {
    duration?: number;
  };
  scrollableContainer?: boolean;
  platform?: Platform;
}

export interface DragAndDropArgs {
  source: {
    text?: string;
    elementId?: string;
  };
  target: {
    text?: string;
    elementId?: string;
  };
  pressDurationMs?: number;
  dragDurationMs?: number;
  holdDurationMs?: number;
  platform?: Platform;
}

export interface SwipeOnArgs {
  includeSystemInsets?: boolean;
  container?: {
    elementId?: string;
    text?: string;
  };
  autoTarget?: boolean;
  direction: "up" | "down" | "left" | "right";
  gestureType?: "swipeFingerTowardsDirection" | "scrollTowardsDirection";
  lookFor?: {
    elementId?: string;
    text?: string;
  };
  boomerang?: boolean;
  apexPause?: number;
  returnSpeed?: number;
  speed?: "slow" | "normal" | "fast";
  platform?: Platform;
}

export interface PinchOnArgs {
  direction: "in" | "out";
  distanceStart?: number;
  distanceEnd?: number;
  scale?: number;
  duration?: number;
  rotationDegrees?: number;
  includeSystemInsets?: boolean;
  container?: {
    elementId?: string;
    text?: string;
  };
  autoTarget?: boolean;
  platform?: Platform;
}

export interface ShakeArgs {
  duration?: number;
  intensity?: number;
  platform?: Platform;
}

export interface ImeActionArgs {
  action: ImeAction;
  platform?: Platform;
}

export interface KeyboardArgs {
  action: "open" | "close" | "detect";
  platform?: Platform;
}

export interface RecentAppsArgs {
  platform?: Platform;
}

export interface RotateArgs {
  orientation: "portrait" | "landscape";
  platform?: Platform;
}

export interface ClipboardArgs {
  action: "copy" | "paste" | "clear" | "get";
  text?: string;
  platform?: Platform;
}
