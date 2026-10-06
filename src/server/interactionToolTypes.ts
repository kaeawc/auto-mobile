import type { SwipeOnOptions } from "../models/SwipeOnOptions";
import type { ElementContainerSelector } from "../models/PinchOnOptions";
import type { TapAtOptions } from "../models/TapAtOptions";
import type { DragAndDropTarget } from "../models/DragAndDropOptions";
/**
 * Type definitions for interaction tools.
 * Extracted from interactionTools.ts for maintainability.
 */
import type { Platform, ElementSelectionStrategy } from "../models";
import type { ObserveWaitForOptions, SettledOptions } from "./observeTools";
import type {
  SendKeysCommand,
  SendKeysSelector,
  SendKeysFocusOptions,
} from "../features/action/SendKeys";

// ============================================================================
// Tool Argument Types
// ============================================================================

// #6154: `platform` is optional on every one of these tools' wire schemas
// (resolved from deviceId/session when omitted), so the hand-written arg
// types below must match it — a typed caller could not otherwise omit it.
// `TapOnArgs.platform` (below) is left as-is: tapOn's schema has been
// optional since #5870, predating this pass, and fixing that pre-existing
// mismatch is out of scope here.
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
  action: "open" | "close" | "list" | "find" | "tap" | "dismiss" | "clearAll";
  notification?: SystemTrayNotificationArgs;
  awaitTimeout?: number;
  platform?: Platform;
}

export interface SendKeysArgs extends SendKeysFocusOptions {
  display?: string;
  commands: SendKeysCommand[];
  selector?: SendKeysSelector;
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
  acceptOpenAlert?: boolean;
  chooserAppPackage?: string;
  waitFor?: ObserveWaitForOptions;
  settled?: SettledOptions;
}

export interface TapOnArgs {
  display?: string;
  selector: {
    elementId?: string;
    testTag?: string;
    text?: string;
    textAny?: string[];
    accessibilityLink?: string;
  };
  sibling?: boolean;
  container?: ElementContainerSelector;
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
  ensureChecked?: boolean;
  subtext?: {
    text: string;
    occurrence?: number;
  };
  raw?: boolean;
  project?: "full" | "skeleton";
}

export type TapAtArgs = TapAtOptions & {
  platform?: Platform;
  raw?: boolean;
  project?: "full" | "skeleton";
};

export interface TapAnyArgs {
  display?: string;
  container?: ElementContainerSelector;
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
  display?: string;
  source: DragAndDropTarget;
  target: DragAndDropTarget;
  pressDurationMs?: number;
  dragDurationMs?: number;
  holdDurationMs?: number;
  platform?: Platform;
}

export interface SwipeOnArgs {
  display?: string;
  includeSystemInsets?: boolean;
  container?: ElementContainerSelector;
  autoTarget?: boolean;
  direction: "up" | "down" | "left" | "right";
  gestureType?: "swipeFingerTowardsDirection" | "scrollTowardsDirection";
  lookFor?: Omit<NonNullable<SwipeOnOptions["lookFor"]>, "maxTime">;
  boomerang?: boolean;
  apexPause?: number;
  returnSpeed?: number;
  speed?: "slow" | "normal" | "fast";
  platform?: Platform;
}

export interface PinchOnArgs {
  display?: string;
  direction: "in" | "out";
  distanceStart?: number;
  distanceEnd?: number;
  scale?: number;
  duration?: number;
  rotationDegrees?: number;
  includeSystemInsets?: boolean;
  container?: ElementContainerSelector;
  autoTarget?: boolean;
  platform?: Platform;
}

export interface ShakeArgs {
  duration?: number;
  intensity?: number;
  platform?: Platform;
}

export interface KeyboardArgs {
  action:
    | "open"
    | "close"
    | "detect"
    | "setProfile"
    | "listProfiles"
    | "listImes"
    | "setIme"
    | "tapImeKey";
  profile?: import("../features/action/keyboardProfiles").KeyboardProfileId;
  imeId?: string;
  key?: string;
  platform?: Platform;
}

export interface RecentAppsArgs {
  platform?: Platform;
}

export interface RotateArgs {
  sessionUuid?: string; // Existing device-targeting input supplied by the tool registry.
  orientation: "portrait" | "landscape";
  /**
   * Android only. Session omission or `true` holds until `false` or release
   * (omission leaves unreadable initial auto-rotate unchanged). Direct omission
   * restores at call end; `true` persists. `false` enables automatic rotation even
   * if originally locked, restores the session's original user_rotation, and clears ownership.
   */
  lockOrientation?: boolean;
  platform?: Platform;
}

export interface ClipboardArgs {
  action: "copy" | "paste" | "clear" | "get";
  text?: string;
  platform?: Platform;
}
