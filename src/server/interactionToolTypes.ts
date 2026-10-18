import type { z } from "zod/v4";
import type { tapAtSchema } from "./interactionTools";
import type {
  keyboardTool,
  selectAllTextTool,
  pressButtonTool,
  wakeAndUnlockTool,
  shakeTool,
  recentAppsTool,
  rotateTool,
} from "./interactionTools";
import type { SwipeEdge, SwipeOnOptions } from "../models/SwipeOnOptions";
import type { ElementContainerSelector } from "../models/PinchOnOptions";
import type { DragAndDropTarget } from "../models/DragAndDropOptions";
import type { HierarchyLayer } from "../models/HierarchyLayer";
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
// `TapOnArgs.platform` is optional too (#11824: the registry now checks handler
// arguments against the schema output).
export type SelectAllTextArgs = z.output<typeof selectAllTextTool.schema>;

export type PressButtonArgs = z.output<typeof pressButtonTool.schema>;

export interface SendKeysArgs extends SendKeysFocusOptions {
  display?: string;
  commands: SendKeysCommand[];
  selector?: SendKeysSelector;
  platform?: Platform;
  raw?: boolean;
  project?: "full" | "skeleton";
}

export type WakeAndUnlockArgs = z.output<typeof wakeAndUnlockTool.schema>;

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
  platform?: Platform;
  preTapStability?: boolean;
  retryIfNoChange?: boolean;
  ensureTap?: boolean;
  ensureChecked?: boolean;
  subtext?: {
    text: string;
    occurrence?: number;
  };
  layer?: HierarchyLayer;
  raw?: boolean;
  project?: "full" | "skeleton";
}

// The parsed wire schema; its exclusivity refinement (image xor x/y) is narrowed where the
// options are built.
export type TapAtArgs = z.output<typeof tapAtSchema> & {
  __tapAtPlanContext?: import("../models/TapAtGeometry").TapAtPlanContext;
  __tapAtRecordingContext?: import("../models/TapAtGeometry").TapAtPlanContext;
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
  layer?: HierarchyLayer;
  platform?: Platform;
}

export interface DragAndDropArgs {
  display?: string;
  source: DragAndDropTarget;
  target: DragAndDropTarget;
  layer?: HierarchyLayer;
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
  durationMs?: number;
  fromEdge?: SwipeEdge;
  edgeInset?: number;
  at?: number;
  layer?: HierarchyLayer;
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
  layer?: HierarchyLayer;
  platform?: Platform;
}

export type ShakeArgs = z.output<typeof shakeTool.schema>;

export type KeyboardArgs = z.output<typeof keyboardTool.schema>;

export type RecentAppsArgs = z.output<typeof recentAppsTool.schema>;

export type RotateArgs = z.output<typeof rotateTool.schema>;

export interface ClipboardArgs {
  action: "copy" | "paste" | "clear" | "get";
  text?: string;
  platform?: Platform;
}

export type {
  SystemTrayNotificationArgs,
  SystemTrayArgs,
} from "../features/systemTray/systemTrayTypes";
